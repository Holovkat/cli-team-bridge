import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { type BridgeConfig, isAgentAvailable, getAvailableModels } from './config'
import { runAcpSession } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'
import { logger } from './logger'

interface ActiveTask {
  id: string
  agent: string
  model: string
  project: string
  prompt: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  completedAt?: string
  output?: string
  error?: string | null
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
  const server = new Server(
    { name: 'cli-team-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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

        const agentConfig = config.agents[agent]
        if (!agentConfig) {
          return {
            content: [{ type: 'text', text: `Unknown agent "${agent}". Available: ${Object.keys(config.agents).join(', ')}` }],
            isError: true,
          }
        }

        if (!isAgentAvailable(agentConfig)) {
          return {
            content: [{ type: 'text', text: `Agent "${agent}" is not available (adapter binary not found on PATH)` }],
            isError: true,
          }
        }

        // Resolve and validate project path
        const projectPath = join(workspaceRoot, project)
        if (!existsSync(projectPath)) {
          return {
            content: [{ type: 'text', text: `Project path does not exist: ${projectPath}` }],
            isError: true,
          }
        }

        const taskId = randomUUID().slice(0, 8)
        const modelId = model ?? agentConfig.defaultModel

        const task: ActiveTask = {
          id: taskId,
          agent,
          model: modelId,
          project,
          prompt,
          status: 'running',
          startedAt: new Date().toISOString(),
        }
        activeTasks.set(taskId, task)

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
            logger.info(`[MCP] Task ${taskId} ${task.status}`)
            pruneCompletedTasks()
          })
          .catch((err) => {
            task.status = 'failed'
            task.completedAt = new Date().toISOString()
            task.error = String(err)
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
        const task = activeTasks.get(task_id)
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
            }, null, 2),
          }],
        }
      }

      case 'get_task_result': {
        const { task_id } = args as { task_id: string }
        const task = activeTasks.get(task_id)
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
