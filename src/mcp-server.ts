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
import { runAcpSession, type AcpResult } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'
import { logger } from './logger'
import { VERSION } from './version'
import { TaskStore } from './persistence'
import { getMetricsSummary, recordTaskAssigned, recordTaskCompleted, recordTaskFailed, recordTaskCancelled, operationalMetrics } from './metrics'
import { MessageBus } from './message-bus'
import { AgentRegistry } from './agent-registry'
// import { MessagingWrapper } from './messaging-wrapper'
import { WorkflowEngine, type WorkflowStep } from './workflow'

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
  team?: string
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

  // Cross-agent messaging infrastructure
  const messagingConfig = config.messaging ?? { enabled: true, failSilently: true }
  const bridgePath = join(workspaceRoot, '.claude', 'bridge')

  let messageBus: MessageBus | null = null
  let agentRegistry: AgentRegistry | null = null

  if (messagingConfig.enabled) {
    try {
      messageBus = new MessageBus(bridgePath)
      agentRegistry = new AgentRegistry(bridgePath)
      logger.info('[MCP] Messaging infrastructure initialized')
    } catch (err) {
      if (messagingConfig.failSilently) {
        logger.warn(`[MCP] Failed to initialize messaging: ${err}`)
      } else {
        throw err
      }
    }
  } else {
    logger.info('[MCP] Messaging is disabled via config')
  }

  // MessagingWrapper available for future use: new MessagingWrapper(messageBus, agentRegistry, messagingConfig)
  const workflowEngine = new WorkflowEngine()

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
          'Assign a coding task to an external agent via ACP. By default returns immediately with a task_id for polling. Set wait=true to block until the agent completes and return the result directly.',
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
            team: {
              type: 'string',
              description: 'Optional team identifier for task isolation',
            },
            wait: {
              type: 'boolean',
              description: 'If true, block until the agent completes and return the full result. Default: false (returns task_id for polling).',
            },
            timeout_seconds: {
              type: 'number',
              description: 'Max seconds to wait when wait=true (default: 300, max: 1800). Ignored when wait=false.',
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
      {
        name: 'get_metrics',
        description: 'Get bridge metrics including task counts, success rates, and per-agent statistics.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'health_check',
        description: 'Get bridge health status including active tasks, agent availability, and system readiness.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      // --- Cross-Agent Messaging Tools (Orchestrator Mode) ---
      {
        name: 'broadcast',
        description: 'Send a message to all active agents.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: { type: 'string', description: 'Message to broadcast to all agents' },
          },
          required: ['content'],
        },
      },
      {
        name: 'send_agent_message',
        description: 'Send a direct message to a specific agent.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            to: { type: 'string', description: 'Target agent name' },
            content: { type: 'string', description: 'Message body' },
          },
          required: ['to', 'content'],
        },
      },
      {
        name: 'get_agent_status',
        description: 'Get health and progress of all active agents, including pending messages and requests.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'shutdown_agent',
        description: 'Send a graceful shutdown request to an agent. Agent finishes current work then exits.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent: { type: 'string', description: 'Agent name to shut down' },
            reason: { type: 'string', description: 'Optional reason for shutdown' },
          },
          required: ['agent'],
        },
      },
      {
        name: 'kill_agent',
        description: 'Force kill an agent. Sends SIGTERM then SIGKILL after 5s.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent: { type: 'string', description: 'Agent name to kill' },
          },
          required: ['agent'],
        },
      },
      {
        name: 'create_workflow',
        description: 'Define a task chain where output flows between agents. Steps can run in parallel when dependencies allow.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Workflow name' },
            project: { type: 'string', description: 'Project directory relative to workspace root' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Step name (unique within workflow)' },
                  agent: { type: 'string', description: 'Agent to run this step' },
                  prompt: { type: 'string', description: 'Task prompt for this step' },
                  model: { type: 'string', description: 'Optional model override' },
                  depends_on: { type: 'array', items: { type: 'string' }, description: 'Step names that must complete first' },
                },
                required: ['name', 'agent', 'prompt'],
              },
              description: 'Workflow steps',
            },
          },
          required: ['name', 'project', 'steps'],
        },
      },
      {
        name: 'get_workflow_status',
        description: 'Get the status and results of a workflow.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            workflow_id: { type: 'string', description: 'Workflow ID returned by create_workflow' },
          },
          required: ['workflow_id'],
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
        const { agent, prompt, project, model, team, wait, timeout_seconds } = args as {
          agent: string
          prompt: string
          project: string
          model?: string
          team?: string
          wait?: boolean
          timeout_seconds?: number
        }
        const MAX_WAIT_SECONDS = 1800 // 30 minutes
        const DEFAULT_WAIT_SECONDS = 300 // 5 minutes
        const waitForResult = wait === true
        const waitTimeout = Math.min(timeout_seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000

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

        // Per-agent concurrency limit (check against effective agent)
        const MAX_PER_AGENT = 3
        const agentRunning = [...activeTasks.values()].filter(t => t.status === 'running' && t.agent === effectiveAgent).length
        if (agentRunning >= MAX_PER_AGENT) {
          return {
            content: [{ type: 'text', text: `Agent "${effectiveAgent}" at capacity (${agentRunning}/${MAX_PER_AGENT} running). Try again later.` }],
            isError: true,
          }
        }

        // Validate model against agent's configured models
        const availableModels = Object.keys(effectiveAgentConfig.models)
        if (model && !availableModels.includes(model)) {
          logger.warn(`[MCP] Requested model "${model}" not available for ${effectiveAgent}. Available: ${availableModels.join(', ')}. Using default: ${effectiveAgentConfig.defaultModel}`)
          // Fall back to default instead of failing — the orchestrator may not know which models are valid
        }
        const modelId = (model && availableModels.includes(model)) ? model : effectiveAgentConfig.defaultModel

        const taskId = randomUUID()

        const task: ActiveTask = {
          id: taskId,
          agent: effectiveAgent,
          model: modelId,
          project,
          prompt,
          status: 'running',
          startedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          toolCallCount: 0,
          outputLength: 0,
          team,
        }
        activeTasks.set(taskId, task)
        recordTaskAssigned(effectiveAgent)
        taskStore.save({ id: taskId, agent: effectiveAgent, model: modelId, project, prompt, status: 'running', startedAt: task.startedAt })

        logger.info(`[MCP] ━━━ ASSIGN TASK ━━━ ${effectiveAgent}/${modelId} on ${project}`)
        logger.info(`[MCP]   Task: ${taskId.slice(0, 8)}  Prompt: "${prompt.slice(0, 100)}"`)

        // Build spawn config with project-specific cwd
        const spawnConfig = buildSpawnConfig(effectiveAgent, effectiveAgentConfig)
        spawnConfig.cwd = projectPath

        // Frame prompt — instruct agents to return text output, not write files
        const framedPrompt = `IMPORTANT: Return your complete response as text output directly. Do NOT write files to disk unless explicitly asked to create a file. Your text response will be captured and returned to the orchestrator.\n\n${prompt}`

        /** Finalize task state after ACP session completes */
        const finalizeTask = (result: AcpResult) => {
          task.status = result.error ? 'failed' : 'completed'
          task.completedAt = new Date().toISOString()
          task.output = result.output
          task.error = result.error
          task.lastUpdate = task.completedAt
          task.outputLength = (result.output ?? '').length
          const durationMs = new Date(task.completedAt!).getTime() - new Date(task.startedAt).getTime()
          if (task.status === 'completed') {
            recordTaskCompleted(effectiveAgent, durationMs)
            operationalMetrics.increment('taskCompleted')
          } else {
            recordTaskFailed(effectiveAgent, durationMs)
            operationalMetrics.increment('taskFailed')
          }
          taskStore.update(taskId, { status: task.status, completedAt: task.completedAt, output: task.output, error: task.error })
          const dur = ((new Date(task.completedAt!).getTime() - new Date(task.startedAt).getTime()) / 1000).toFixed(1)
          logger.info(`[MCP] ━━━ TASK ${task.status.toUpperCase()} ━━━ ${effectiveAgent} task:${taskId.slice(0, 8)} in ${dur}s (${task.outputLength} chars)`)
          pruneCompletedTasks()
        }

        const finalizeError = (err: unknown) => {
          task.status = 'failed'
          task.completedAt = new Date().toISOString()
          task.error = String(err)
          recordTaskFailed(effectiveAgent, Date.now() - new Date(task.startedAt).getTime())
          operationalMetrics.increment('taskFailed')
          taskStore.update(taskId, { status: 'failed', completedAt: task.completedAt, error: task.error })
          logger.error(`[MCP] Task ${taskId} error: ${err}`)
          pruneCompletedTasks()
        }

        const showViewer = config.viewer?.enabled ?? false
        const acpPromise = runAcpSession(spawnConfig, framedPrompt, modelId, {
          bridgePath,
          agentName: effectiveAgent,
          taskId,
          project,
          showViewer,
        })

        if (waitForResult) {
          // Synchronous mode — block until agent completes or timeout
          logger.info(`[MCP] Task ${taskId}: waiting for result (timeout: ${waitTimeout / 1000}s)`)
          try {
            const result = await Promise.race([
              acpPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Task timed out after ${waitTimeout / 1000}s`)), waitTimeout),
              ),
            ])
            finalizeTask(result)
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  task_id: taskId,
                  status: task.status,
                  agent: effectiveAgent,
                  model: modelId,
                  output: task.output ?? '',
                  error: task.error ?? null,
                  duration_ms: task.completedAt
                    ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
                    : null,
                }, null, 2),
              }],
            }
          } catch (err) {
            finalizeError(err)
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  task_id: taskId,
                  status: 'failed',
                  agent: effectiveAgent,
                  error: task.error,
                }, null, 2),
              }],
              isError: true,
            }
          }
        }

        // Async mode (default) — fire and forget, return task_id for polling
        acpPromise.then(finalizeTask).catch(finalizeError)

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: taskId,
              status: 'running',
              agent: effectiveAgent,
              model: modelId,
              project,
              team: team ?? null,
              message: `Task assigned. Use get_task_status("${taskId}") to check progress, or set wait=true to block until completion.`,
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
        recordTaskCancelled(task.agent)
        logger.info(`[MCP] Task ${task_id} cancelled`)
        return {
          content: [{ type: 'text', text: JSON.stringify({ task_id, status: 'cancelled', message: 'Task cancelled successfully' }, null, 2) }],
        }
      }

      case 'get_metrics': {
        return { content: [{ type: 'text', text: JSON.stringify(getMetricsSummary(), null, 2) }] }
      }

      case 'health_check': {
        const runningCount = [...activeTasks.values()].filter(t => t.status === 'running').length
        const availableAgents: string[] = []
        const unavailableAgents: string[] = []

        for (const [agentName, agentConfig] of Object.entries(config.agents)) {
          if (isAgentAvailable(agentConfig)) {
            availableAgents.push(agentName)
          } else {
            unavailableAgents.push(agentName)
          }
        }

        const status = availableAgents.length > 0 ? 'healthy' : 'degraded'
        const healthy = status === 'healthy'

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status,
              healthy,
              timestamp: new Date().toISOString(),
              version: VERSION,
              active_tasks: runningCount,
              agents: {
                available: availableAgents,
                unavailable: unavailableAgents,
                total: availableAgents.length + unavailableAgents.length,
              },
              limits: {
                max_concurrent_tasks: 10,
                max_per_agent: 3,
                max_active_tasks_total: MAX_ACTIVE_TASKS,
              },
            }, null, 2),
          }],
        }
      }

      // --- Cross-Agent Messaging Handlers ---

      case 'broadcast': {
        if (!agentRegistry || !messageBus) {
          return { content: [{ type: 'text', text: 'Messaging not enabled' }], isError: true }
        }
        const { content } = args as { content: string }
        if (!content) {
          return { content: [{ type: 'text', text: 'Missing required field: content' }], isError: true }
        }

        const activeAgents = agentRegistry.getActive()
        const deliveredTo: string[] = []
        const failed: string[] = []

        for (const agent of activeAgents) {
          try {
            messageBus.writeMessage('orchestrator', agent.name, content, { type: 'broadcast' })
            deliveredTo.push(agent.name)
          } catch {
            failed.push(agent.name)
          }
        }

        logger.info(`[MCP] Broadcast to ${deliveredTo.length} agents (${failed.length} failed)`)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ delivered_to: deliveredTo, failed }, null, 2),
          }],
        }
      }

      case 'send_agent_message': {
        if (!agentRegistry || !messageBus) {
          return { content: [{ type: 'text', text: 'Messaging not enabled' }], isError: true }
        }
        const { to, content } = args as { to: string; content: string }
        if (!to || !content) {
          return { content: [{ type: 'text', text: 'Missing required fields: to, content' }], isError: true }
        }

        const targetAgent = agentRegistry.get(to)
        if (!targetAgent) {
          return { content: [{ type: 'text', text: `Agent "${to}" not found in registry` }], isError: true }
        }

        const msg = messageBus.writeMessage('orchestrator', to, content, { type: 'message' })
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ message_id: msg.id, delivered: true }, null, 2),
          }],
        }
      }

      case 'get_agent_status': {
        if (!agentRegistry || !messageBus) {
          return { content: [{ type: 'text', text: 'Messaging not enabled' }], isError: true }
        }
        const agents = agentRegistry.getAll()
        const deadAgents = agentRegistry.detectDead()

        if (deadAgents.length > 0) {
          logger.warn(`[MCP] Detected ${deadAgents.length} dead agents: ${deadAgents.map(a => a.name).join(', ')}`)
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agents: agents.map(a => ({
                name: a.name,
                status: a.status,
                model: a.model,
                task_id: a.currentTask ?? null,
                messages_pending: messageBus.getUnreadCount(a.name),
                requests_pending: messageBus.listOpenRequests().filter(r => r.from === a.name).length,
                uptime_seconds: agentRegistry.getUptimeSeconds(a.name),
                last_activity: a.lastActivity,
                pid: a.pid ?? null,
              })),
            }, null, 2),
          }],
        }
      }

      case 'shutdown_agent': {
        if (!agentRegistry || !messageBus) {
          return { content: [{ type: 'text', text: 'Messaging not enabled' }], isError: true }
        }
        const { agent, reason } = args as { agent: string; reason?: string }
        if (!agent) {
          return { content: [{ type: 'text', text: 'Missing required field: agent' }], isError: true }
        }

        const entry = agentRegistry.get(agent)
        if (!entry) {
          return { content: [{ type: 'text', text: `Agent "${agent}" not found` }], isError: true }
        }

        // Send shutdown message
        messageBus.writeMessage('orchestrator', agent, reason ?? 'Shutdown requested', { type: 'shutdown' })
        logger.info(`[MCP] Shutdown request sent to agent "${agent}"`)

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ acknowledged: true, agent, message: 'Shutdown message sent' }, null, 2),
          }],
        }
      }

      case 'kill_agent': {
        if (!agentRegistry) {
          return { content: [{ type: 'text', text: 'Messaging not enabled' }], isError: true }
        }
        const { agent } = args as { agent: string }
        if (!agent) {
          return { content: [{ type: 'text', text: 'Missing required field: agent' }], isError: true }
        }

        const entry = agentRegistry.get(agent)
        if (!entry || !entry.pid) {
          return { content: [{ type: 'text', text: `Agent "${agent}" not found or no PID recorded` }], isError: true }
        }

        let killed = false
        try {
          process.kill(entry.pid, 'SIGTERM')
          // Wait 5s then SIGKILL
          setTimeout(() => {
            try { process.kill(entry.pid!, 'SIGKILL') } catch { /* already dead */ }
          }, 5000)
          killed = true
          agentRegistry.updateStatus(agent, 'dead')
          logger.info(`[MCP] Force kill sent to agent "${agent}" (pid: ${entry.pid})`)
        } catch {
          agentRegistry.updateStatus(agent, 'dead')
          logger.warn(`[MCP] Agent "${agent}" process already dead`)
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ killed, agent }, null, 2),
          }],
        }
      }

      case 'create_workflow': {
        const { name: wfName, project, steps } = args as {
          name: string
          project: string
          steps: Array<{ name: string; agent: string; prompt: string; model?: string; depends_on?: string[] }>
        }

        if (!wfName || !project || !steps || steps.length === 0) {
          return { content: [{ type: 'text', text: 'Missing required fields: name, project, steps' }], isError: true }
        }

        // Validate project path
        const projectPath = resolve(workspaceRoot, project)
        const resolvedRoot = resolve(workspaceRoot)
        if (!projectPath.startsWith(resolvedRoot + sep) && projectPath !== resolvedRoot) {
          return { content: [{ type: 'text', text: `Project path escapes workspace root: ${project}` }], isError: true }
        }
        if (!existsSync(projectPath)) {
          return { content: [{ type: 'text', text: `Project path does not exist: ${projectPath}` }], isError: true }
        }

        // Convert to WorkflowStep format
        const workflowSteps: WorkflowStep[] = steps.map(s => ({
          name: s.name,
          agent: s.agent,
          prompt: s.prompt,
          model: s.model,
          dependsOn: s.depends_on,
        }))

        try {
          const definition = workflowEngine.createWorkflow(wfName, workflowSteps)

          // Run workflow async
          logger.info(`[Workflow] ━━━ STARTING "${wfName}" ━━━ ${workflowSteps.length} steps on ${project}`)
          for (const s of workflowSteps) {
            logger.info(`[Workflow]   Step: "${s.name}" → agent: ${s.agent}${s.dependsOn?.length ? ` (depends: ${s.dependsOn.join(', ')})` : ''}`)
          }

          const runner = async (agent: string, prompt: string, model?: string) => {
            const agentConfig = config.agents[agent]
            if (!agentConfig) throw new Error(`Unknown agent: ${agent}`)

            const spawnConfig = buildSpawnConfig(agent, agentConfig)
            spawnConfig.cwd = projectPath
            const modelId = model ?? agentConfig.defaultModel
            const taskId = randomUUID()
            const showViewer = config.viewer?.enabled ?? false
            logger.info(`[Workflow] ━━━ STEP RUNNING ━━━ ${agent}/${modelId} task:${taskId.slice(0, 8)}`)
            logger.info(`[Workflow]   Prompt: "${prompt.slice(0, 100)}"`)
            const result = await runAcpSession(spawnConfig, prompt, modelId, {
              bridgePath,
              agentName: agent,
              taskId,
              project: projectPath,
              showViewer,
            })
            const status = result.error ? 'FAILED' : 'COMPLETED'
            logger.info(`[Workflow] ━━━ STEP ${status} ━━━ ${agent} task:${taskId.slice(0, 8)} (${(result.output?.length ?? 0)} chars)`)
            return {
              taskId,
              output: result.output,
              error: result.error,
            }
          }

          workflowEngine.execute(definition, runner).then(() => {
            logger.info(`[Workflow] ━━━ WORKFLOW DONE ━━━ "${wfName}" completed all steps`)
          }).catch(err => {
            logger.error(`[Workflow] ━━━ WORKFLOW FAILED ━━━ "${wfName}" error: ${err}`)
          })

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                workflow_id: definition.id,
                name: wfName,
                steps: definition.steps.length,
                message: `Workflow started. Use get_workflow_status("${definition.id}") to check progress.`,
              }, null, 2),
            }],
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `Workflow creation failed: ${err}` }], isError: true }
        }
      }

      case 'get_workflow_status': {
        const { workflow_id } = args as { workflow_id: string }
        if (!workflow_id) {
          return { content: [{ type: 'text', text: 'Missing required field: workflow_id' }], isError: true }
        }

        const state = workflowEngine.getState(workflow_id)
        if (!state) {
          return { content: [{ type: 'text', text: `Workflow "${workflow_id}" not found` }], isError: true }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              workflow_id: state.id,
              name: state.name,
              status: state.status,
              started_at: state.startedAt ?? null,
              completed_at: state.completedAt ?? null,
              steps: state.steps.map(s => ({
                name: s.stepName,
                status: s.status,
                task_id: s.taskId ?? null,
                output_length: s.output?.length ?? 0,
                error: s.error ?? null,
                started_at: s.startedAt ?? null,
                completed_at: s.completedAt ?? null,
              })),
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
