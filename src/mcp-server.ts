import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { resolve, sep, join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { type BridgeConfig, isAgentAvailable, getAvailableModels } from './config'
import { runAcpSession } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'
import { logger } from './logger'
import { VERSION } from './version'
import { TaskStore } from './persistence'

interface ActiveTask {
  id: string
  agent: string
  model: string
  project: string
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  output?: string
  error?: string | null
  proc?: { kill: (signal?: string) => void }
  lastUpdate?: string
  toolCallCount?: number
  outputLength?: number
}

const activeTasks = new Map<string, ActiveTask>()
const MAX_ACTIVE_TASKS = 100
const TASK_RETENTION_MS = 60 * 60 * 1000 // 1 hour

function pruneCompletedTasks() {
  if (activeTasks.size <= MAX_ACTIVE_TASKS) return
  const now = Date.now()
  for (const [id, task] of activeTasks) {
    if (
      task.status !== 'running' &&
      task.completedAt &&
      now - new Date(task.completedAt).getTime() > TASK_RETENTION_MS
    ) {
      activeTasks.delete(id)
    }
  }
}

export async function startMcpServer(config: BridgeConfig, workspaceRoot: string) {
  const dbPath = join(workspaceRoot, '.bridge-tasks.db')
  const taskStore = new TaskStore(dbPath)
  taskStore.recoverOrphaned()

  const server = new Server(
    { name: 'cli-team-bridge', version: VERSION },
    { capabilities: { tools: {} } },
  )

  // Authentication: For stdio transport, trust parent process (no auth needed).
  // When HTTP/WS transport is added, validate bearer tokens from config.auth.tokens
  // config.auth?.tokens can be checked against request headers in future transport layer

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // MCP tool names use snake_case per protocol convention
    // Internal TypeScript code uses camelCase
    tools: [
      {
        name: 'list_agents',
        description:
          'List available external coding agents and their models. Returns agent names, available models, strengths, and availability status.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'assign_task',
        description:
          'Assign a coding task to an external agent via ACP. The agent will execute the prompt against the specified project workspace and return results.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent: {
              type: 'string',
              description: 'Agent name (e.g. "droid", "codex", "claude-code")',
            },
            prompt: {
              type: 'string',
              description: 'The task prompt for the agent',
            },
            project: {
              type: 'string',
              description:
                'Project directory name relative to workspace root (e.g. "cli-team-bridge", "my-app")',
            },
            model: {
              type: 'string',
              description: 'Optional model override (e.g. "haiku", "custom:kimi-for-coding-[Kimi]-7")',
            },
          },
          required: ['agent', 'prompt', 'project'],
        },
      },
      {
        name: 'get_task_status',
        description: 'Check the status of a previously assigned task by its ID.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'Task ID returned by assign_task' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'get_task_result',
        description:
          'Get the full result of a completed task. Returns output text and any errors.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'Task ID returned by assign_task' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cancel_task',
        description: 'Cancel a running task by its ID. Sends SIGTERM to the agent process.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'Task ID to cancel' },
          },
          required: ['task_id'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'list_agents': {
        const agents: Record<string, unknown> = {}
        for (const [agentName, agentConfig] of Object.entries(config.agents)) {
          agents[agentName] = {
            available: isAgentAvailable(agentConfig),
            defaultModel: agentConfig.defaultModel,
            availableModels: getAvailableModels(agentConfig),
            strengths: agentConfig.strengths,
            type: agentConfig.type,
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] }
      }

      case 'assign_task': {
        const { agent, prompt, project, model } = args as {
          agent: string
          prompt: string
          project: string
          model?: string
        }

        // Validate inputs
        const MAX_PROMPT_LENGTH = 100 * 1024 // 100KB
        const MAX_NAME_LENGTH = 256

        if (!agent || typeof agent !== 'string' || agent.length > MAX_NAME_LENGTH) {
          return { content: [{ type: 'text', text: 'Invalid agent name' }], isError: true }
        }
        if (!prompt || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
          return { content: [{ type: 'text', text: `Prompt too large (max ${MAX_PROMPT_LENGTH} bytes)` }], isError: true }
        }
        if (!project || typeof project !== 'string' || project.length > MAX_NAME_LENGTH) {
          return { content: [{ type: 'text', text: 'Invalid project name' }], isError: true }
        }
        if (/[\x00-\x1f]/.test(project)) {
          return { content: [{ type: 'text', text: 'Project name contains control characters' }], isError: true }
        }
        if (model && (typeof model !== 'string' || model.length > MAX_NAME_LENGTH)) {
          return { content: [{ type: 'text', text: 'Invalid model name' }], isError: true }
        }

        const agentConfig = config.agents[agent]
        if (!agentConfig) {
          return {
            content: [{ type: 'text', text: `Unknown agent "${agent}". Available: ${Object.keys(config.agents).join(', ')}` }],
            isError: true,
          }
        }

        // Fallback agent support
        let effectiveAgent = agent
        let effectiveAgentConfig = agentConfig
        if (!isAgentAvailable(agentConfig) && agentConfig.fallbackAgent) {
          const fbConfig = config.agents[agentConfig.fallbackAgent]
          if (fbConfig && isAgentAvailable(fbConfig)) {
            logger.info(`[MCP] Agent "${agent}" unavailable, falling back to "${agentConfig.fallbackAgent}"`)
            effectiveAgent = agentConfig.fallbackAgent
            effectiveAgentConfig = fbConfig
          }
        }

        if (!isAgentAvailable(effectiveAgentConfig)) {
          return {
            content: [{ type: 'text', text: `Agent "${agent}" is not available (adapter binary not found on PATH)` }],
            isError: true,
          }
        }

        // Path traversal protection — resolve and verify containment
        const projectPath = resolve(workspaceRoot, project)
        const resolvedRoot = resolve(workspaceRoot)
        if (!projectPath.startsWith(resolvedRoot + sep) && projectPath !== resolvedRoot) {
          return {
            content: [{ type: 'text', text: `Project path escapes workspace root: ${project}` }],
            isError: true,
          }
        }
        if (!existsSync(projectPath)) {
          return {
            content: [{ type: 'text', text: `Project path does not exist: ${projectPath}` }],
            isError: true,
          }
        }

        // Enforce concurrent task limit
        const MAX_CONCURRENT_RUNNING = 10
        const runningCount = [...activeTasks.values()].filter(t => t.status === 'running').length
        if (runningCount >= MAX_CONCURRENT_RUNNING) {
          return {
            content: [{ type: 'text', text: `Too many concurrent tasks (${runningCount}/${MAX_CONCURRENT_RUNNING}). Try again later.` }],
            isError: true,
          }
        }

        // Per-agent concurrency limit
        const MAX_PER_AGENT = 3
        const agentRunning = [...activeTasks.values()].filter(t => t.status === 'running' && t.agent === agent).length
        if (agentRunning >= MAX_PER_AGENT) {
          return {
            content: [{ type: 'text', text: `Agent "${agent}" at capacity (${agentRunning}/${MAX_PER_AGENT} running). Try again later.` }],
            isError: true,
          }
        }

        const taskId = randomUUID()
        const modelId = model ?? agentConfig.defaultModel

        const task: ActiveTask = {
          id: taskId,
          agent,
          model: modelId,
          project,
          prompt,
          status: 'running',
          startedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          toolCallCount: 0,
          outputLength: 0,
        }
        activeTasks.set(taskId, task)
        taskStore.save({ id: taskId, agent, model: modelId, project, prompt, status: 'running', startedAt: task.startedAt })

        logger.info(`[MCP] Task ${taskId}: ${agent}/${modelId} on ${project} — "${prompt.slice(0, 80)}"`)

        // Build spawn config with project-specific cwd
        const spawnConfig = buildSpawnConfig(agent, agentConfig)
        spawnConfig.cwd = projectPath

        // Run async — don't block the MCP response
        runAcpSession(spawnConfig, prompt, modelId)
          .then((result) => {
            task.status = result.error ? 'failed' : 'completed'
            task.completedAt = new Date().toISOString()
            task.output = result.output
            task.error = result.error
            task.lastUpdate = task.completedAt
            task.outputLength = (result.output ?? '').length
            taskStore.update(taskId, { status: task.status, completedAt: task.completedAt, output: task.output, error: task.error })
            logger.info(`[MCP] Task ${taskId} ${task.status}`)
            pruneCompletedTasks()
          })
          .catch((err) => {
            task.status = 'failed'
            task.completedAt = new Date().toISOString()
            task.error = String(err)
            taskStore.update(taskId, { status: 'failed', completedAt: task.completedAt, error: task.error })
            logger.error(`[MCP] Task ${taskId} error: ${err}`)
            pruneCompletedTasks()
          })

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: taskId,
              status: 'running',
              agent,
              model: modelId,
              project,
              message: `Task assigned. Use get_task_status("${taskId}") to check progress.`,
            }, null, 2),
          }],
        }
      }

      case 'get_task_status': {
        const { task_id } = args as { task_id: string }
        if (!task_id || typeof task_id !== 'string' || !/^[a-f0-9-]{8,36}$/.test(task_id)) {
          return { content: [{ type: 'text', text: 'Invalid task_id format' }], isError: true }
        }
        const task = activeTasks.get(task_id) ?? (() => {
          const persisted = taskStore.get(task_id)
          if (!persisted) return undefined
          return { id: persisted.id, agent: persisted.agent, model: persisted.model, project: persisted.project, prompt: persisted.prompt, status: persisted.status, startedAt: persisted.startedAt, completedAt: persisted.completedAt, output: persisted.output, error: persisted.error } as ActiveTask
        })()
        if (!task) {
          return { content: [{ type: 'text', text: `Task "${task_id}" not found` }], isError: true }
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: task.id,
              status: task.status,
              agent: task.agent,
              model: task.model,
              project: task.project,
              startedAt: task.startedAt,
              completedAt: task.completedAt ?? null,
              lastUpdate: task.lastUpdate ?? null,
              toolCallCount: task.toolCallCount ?? 0,
              outputLength: task.outputLength ?? 0,
            }, null, 2),
          }],
        }
      }

      case 'get_task_result': {
        const { task_id } = args as { task_id: string }
        if (!task_id || typeof task_id !== 'string' || !/^[a-f0-9-]{8,36}$/.test(task_id)) {
          return { content: [{ type: 'text', text: 'Invalid task_id format' }], isError: true }
        }
        const task = activeTasks.get(task_id) ?? (() => {
          const persisted = taskStore.get(task_id)
          if (!persisted) return undefined
          return { id: persisted.id, agent: persisted.agent, model: persisted.model, project: persisted.project, prompt: persisted.prompt, status: persisted.status, startedAt: persisted.startedAt, completedAt: persisted.completedAt, output: persisted.output, error: persisted.error } as ActiveTask
        })()
        if (!task) {
          return { content: [{ type: 'text', text: `Task "${task_id}" not found` }], isError: true }
        }
        if (task.status === 'running') {
          return {
            content: [{ type: 'text', text: `Task "${task_id}" is still running. Check back later.` }],
          }
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: task.id,
              status: task.status,
              agent: task.agent,
              model: task.model,
              project: task.project,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              output: task.output ?? '',
              error: task.error ?? null,
            }, null, 2),
          }],
        }
      }

      case 'cancel_task': {
        const { task_id } = args as { task_id: string }
        if (!task_id || typeof task_id !== 'string' || !/^[a-f0-9-]{8,36}$/.test(task_id)) {
          return { content: [{ type: 'text', text: 'Invalid task_id format' }], isError: true }
        }
        const task = activeTasks.get(task_id)
        if (!task) {
          return { content: [{ type: 'text', text: `Task "${task_id}" not found` }], isError: true }
        }
        if (task.status !== 'running') {
          return { content: [{ type: 'text', text: `Task "${task_id}" is not running (status: ${task.status})` }], isError: true }
        }
        if (task.proc) {
          try {
            task.proc.kill('SIGTERM')
          } catch {
            // Process may have already exited
          }
        }
        task.status = 'cancelled'
        task.completedAt = new Date().toISOString()
        task.error = 'Cancelled by user'
        logger.info(`[MCP] Task ${task_id} cancelled`)
        return {
          content: [{ type: 'text', text: JSON.stringify({ task_id, status: 'cancelled', message: 'Task cancelled successfully' }, null, 2) }],
        }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  })

  // Use stdio transport — Claude communicates via stdin/stdout
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('[MCP] Server started on stdio')

  return server
}
