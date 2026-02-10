import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'
import { type BridgeConfig, isAgentAvailable, getAvailableModels } from './config'
import { runAcpSession, type AcpResult } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'
import { logger } from './logger'
import { VERSION } from './version'
import { TaskStore } from './persistence'
import { isPathSafe } from './path-validation'
import { getMetricsSummary, recordTaskAssigned, recordTaskCompleted, recordTaskFailed, recordTaskCancelled, operationalMetrics } from './metrics'
import { MessageBus } from './message-bus'
import { AgentRegistry } from './agent-registry'
// import { MessagingWrapper } from './messaging-wrapper'
import { WorkflowEngine, type WorkflowStep } from './workflow'
import {
  MAX_ACTIVE_TASKS,
  TASK_RETENTION_MS,
  TASK_GRACE_PERIOD_MS,
  MAX_WAIT_SECONDS,
  DEFAULT_WAIT_SECONDS,
  MAX_PROMPT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_CONCURRENT_RUNNING,
  MAX_PER_AGENT,
  SIGKILL_DELAY_MS,
} from './constants'

// Tool handler types and context
type ToolResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
type ToolHandler = (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<ToolResponse>

interface ToolHandlerContext {
  config: BridgeConfig
  workspaceRoot: string
  taskStore: TaskStore
  messageBus: MessageBus | null
  agentRegistry: AgentRegistry | null
  workflowEngine: WorkflowEngine
  activeTasks: Map<string, ActiveTask>
}

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
  proc?: ChildProcess
  lastUpdate?: string
  toolCallCount?: number
  outputLength?: number
  team?: string
}

const activeTasks = new Map<string, ActiveTask>()

function pruneCompletedTasks(activeTasks: Map<string, ActiveTask>) {
  if (activeTasks.size <= MAX_ACTIVE_TASKS) return
  const now = Date.now()
  for (const [id, task] of activeTasks) {
    if (task.status !== 'running' && task.completedAt) {
      const age = now - new Date(task.completedAt).getTime()
      // Only prune if older than grace period AND retention period
      if (age > TASK_GRACE_PERIOD_MS && age > TASK_RETENTION_MS) {
        activeTasks.delete(id)
      }
    }
  }
}

// Validation helpers
function validateTaskId(task_id: unknown): task_id is string {
  return typeof task_id === 'string' && /^[a-f0-9-]{8,36}$/.test(task_id)
}

function validateProjectPath(project: string, workspaceRoot: string): { valid: boolean; resolvedPath?: string; error?: string } {
  if (/[\x00-\x1f]/.test(project)) {
    return { valid: false, error: 'Project name contains control characters' }
  }

  const projectPath = resolve(workspaceRoot, project)

  if (!isPathSafe(workspaceRoot, project)) {
    return { valid: false, error: `Project path escapes workspace root: ${project}` }
  }

  if (!existsSync(projectPath)) {
    return { valid: false, error: `Project path does not exist: ${projectPath}` }
  }

  return { valid: true, resolvedPath: projectPath }
}

function checkConcurrencyLimits(activeTasks: Map<string, ActiveTask>, agent?: string): { allowed: boolean; error?: string } {
  const runningCount = [...activeTasks.values()].filter(t => t.status === 'running').length
  if (runningCount >= MAX_CONCURRENT_RUNNING) {
    return { allowed: false, error: `Too many concurrent tasks (${runningCount}/${MAX_CONCURRENT_RUNNING}). Try again later.` }
  }

  if (agent) {
    const agentRunning = [...activeTasks.values()].filter(t => t.status === 'running' && t.agent === agent).length
    if (agentRunning >= MAX_PER_AGENT) {
      return { allowed: false, error: `Agent "${agent}" at capacity (${agentRunning}/${MAX_PER_AGENT} running). Try again later.` }
    }
  }

  return { allowed: true }
}

function getTaskFromStorage(task_id: string, activeTasks: Map<string, ActiveTask>, taskStore: TaskStore): ActiveTask | undefined {
  const task = activeTasks.get(task_id)
  if (task) return task

  const persisted = taskStore.get(task_id)
  if (!persisted) return undefined

  return {
    id: persisted.id,
    agent: persisted.agent,
    model: persisted.model,
    project: persisted.project,
    prompt: persisted.prompt,
    status: persisted.status,
    startedAt: persisted.startedAt,
    completedAt: persisted.completedAt,
    output: persisted.output,
    error: persisted.error,
  } as ActiveTask
}

function jsonResponse(data: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResponse(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// Tool handler implementations

async function handleListAgents(_args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const agents: Record<string, unknown> = {}
  for (const [agentName, agentConfig] of Object.entries(ctx.config.agents)) {
    agents[agentName] = {
      available: isAgentAvailable(agentConfig),
      defaultModel: agentConfig.defaultModel,
      availableModels: getAvailableModels(agentConfig),
      strengths: agentConfig.strengths,
      type: agentConfig.type,
    }
  }
  return jsonResponse(agents)
}

async function handleGetTaskStatus(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { task_id } = args as { task_id: string }
  if (!validateTaskId(task_id)) {
    return errorResponse('Invalid task_id format')
  }

  const task = getTaskFromStorage(task_id, ctx.activeTasks, ctx.taskStore)
  if (!task) {
    return errorResponse(`Task "${task_id}" not found. It may have been pruned or never existed.`)
  }

  return jsonResponse({
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
  })
}

async function handleGetTaskResult(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { task_id } = args as { task_id: string }
  if (!validateTaskId(task_id)) {
    return errorResponse('Invalid task_id format')
  }

  const task = getTaskFromStorage(task_id, ctx.activeTasks, ctx.taskStore)
  if (!task) {
    return errorResponse(`Task "${task_id}" not found. It may have been pruned. Check get_task_status first.`)
  }

  if (task.status === 'running') {
    return { content: [{ type: 'text', text: `Task "${task_id}" is still running. Check back later.` }] }
  }

  return jsonResponse({
    task_id: task.id,
    status: task.status,
    agent: task.agent,
    model: task.model,
    project: task.project,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    output: task.output ?? '',
    error: task.error ?? null,
  })
}

async function handleCancelTask(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { task_id } = args as { task_id: string }
  if (!validateTaskId(task_id)) {
    return errorResponse('Invalid task_id format')
  }

  const task = ctx.activeTasks.get(task_id)
  if (!task) {
    return errorResponse(`Task "${task_id}" not found`)
  }

  if (task.status !== 'running') {
    return errorResponse(`Task "${task_id}" is not running (status: ${task.status})`)
  }

  if (task.proc) {
    try {
      logger.info(`[MCP] Sending SIGTERM to task ${task_id} process`)
      task.proc.kill('SIGTERM')
      // Schedule SIGKILL after delay if still alive
      setTimeout(() => {
        try {
          if (task.proc && task.proc.exitCode === null && task.proc.signalCode === null) {
            logger.warn(`[MCP] Process ${task_id} did not respond to SIGTERM, sending SIGKILL`)
            task.proc.kill('SIGKILL')
          }
        } catch (err) {
          // Process already dead or kill failed
          logger.warn(`[MCP] Failed to send SIGKILL to task ${task_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }, SIGKILL_DELAY_MS)
    } catch (err) {
      logger.warn(`[MCP] Failed to kill task ${task_id}: ${err}`)
    }
  } else {
    logger.warn(`[MCP] Task ${task_id} has no process handle to kill`)
  }

  task.status = 'cancelled'
  task.completedAt = new Date().toISOString()
  task.error = 'Cancelled by user'
  recordTaskCancelled(task.agent)
  logger.info(`[MCP] Task ${task_id} cancelled`)

  return jsonResponse({ task_id, status: 'cancelled', message: 'Task cancelled successfully' })
}

async function handleGetMetrics(_args: Record<string, unknown>, _ctx: ToolHandlerContext): Promise<ToolResponse> {
  return jsonResponse(getMetricsSummary())
}

async function handleHealthCheck(_args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const runningCount = [...ctx.activeTasks.values()].filter(t => t.status === 'running').length
  const availableAgents: string[] = []
  const unavailableAgents: string[] = []

  for (const [agentName, agentConfig] of Object.entries(ctx.config.agents)) {
    if (isAgentAvailable(agentConfig)) {
      availableAgents.push(agentName)
    } else {
      unavailableAgents.push(agentName)
    }
  }

  const status = availableAgents.length > 0 ? 'healthy' : 'degraded'
  const healthy = status === 'healthy'

  return jsonResponse({
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
      max_concurrent_tasks: MAX_CONCURRENT_RUNNING,
      max_per_agent: MAX_PER_AGENT,
      max_active_tasks_total: MAX_ACTIVE_TASKS,
    },
  })
}

async function handleBroadcast(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  if (!ctx.agentRegistry || !ctx.messageBus) {
    return errorResponse('Messaging not enabled')
  }

  const { content } = args as { content: string }
  if (!content) {
    return errorResponse('Missing required field: content')
  }

  const activeAgents = ctx.agentRegistry.getActive()
  const deliveredTo: string[] = []
  const failed: string[] = []

  for (const agent of activeAgents) {
    try {
      ctx.messageBus.writeMessage('orchestrator', agent.name, content, { type: 'broadcast' })
      deliveredTo.push(agent.name)
    } catch (err) {
      logger.warn(`[MCP] Failed to broadcast message to agent "${agent.name}": ${err instanceof Error ? err.message : String(err)}`)
      failed.push(agent.name)
    }
  }

  logger.info(`[MCP] Broadcast to ${deliveredTo.length} agents (${failed.length} failed)`)
  return jsonResponse({ delivered_to: deliveredTo, failed })
}

async function handleSendAgentMessage(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  if (!ctx.agentRegistry || !ctx.messageBus) {
    return errorResponse('Messaging not enabled')
  }

  const { to, content } = args as { to: string; content: string }
  if (!to || !content) {
    return errorResponse('Missing required fields: to, content')
  }

  const targetAgent = ctx.agentRegistry.get(to)
  if (!targetAgent) {
    return errorResponse(`Agent "${to}" not found in registry`)
  }

  const msg = ctx.messageBus.writeMessage('orchestrator', to, content, { type: 'message' })
  return jsonResponse({ message_id: msg.id, delivered: true })
}

async function handleGetAgentStatus(_args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  if (!ctx.agentRegistry || !ctx.messageBus) {
    return errorResponse('Messaging not enabled')
  }

  const agents = ctx.agentRegistry.getAll()
  const deadAgents = ctx.agentRegistry.detectDead()

  if (deadAgents.length > 0) {
    logger.warn(`[MCP] Detected ${deadAgents.length} dead agents: ${deadAgents.map(a => a.name).join(', ')}`)
  }

  return jsonResponse({
    agents: agents.map(a => ({
      name: a.name,
      status: a.status,
      model: a.model,
      task_id: a.currentTask ?? null,
      messages_pending: ctx.messageBus!.getUnreadCount(a.name),
      requests_pending: ctx.messageBus!.listOpenRequests().filter(r => r.from === a.name).length,
      uptime_seconds: ctx.agentRegistry!.getUptimeSeconds(a.name),
      last_activity: a.lastActivity,
      pid: a.pid ?? null,
    })),
  })
}

async function handleShutdownAgent(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  if (!ctx.agentRegistry || !ctx.messageBus) {
    return errorResponse('Messaging not enabled')
  }

  const { agent, reason } = args as { agent: string; reason?: string }
  if (!agent) {
    return errorResponse('Missing required field: agent')
  }

  const entry = ctx.agentRegistry.get(agent)
  if (!entry) {
    return errorResponse(`Agent "${agent}" not found`)
  }

  ctx.messageBus.writeMessage('orchestrator', agent, reason ?? 'Shutdown requested', { type: 'shutdown' })
  logger.info(`[MCP] Shutdown request sent to agent "${agent}"`)

  return jsonResponse({ acknowledged: true, agent, message: 'Shutdown message sent' })
}

async function handleKillAgent(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  if (!ctx.agentRegistry) {
    return errorResponse('Messaging not enabled')
  }

  const { agent } = args as { agent: string }
  if (!agent) {
    return errorResponse('Missing required field: agent')
  }

  const entry = ctx.agentRegistry.get(agent)
  if (!entry || !entry.pid) {
    return errorResponse(`Agent "${agent}" not found or no PID recorded`)
  }

  let killed = false
  try {
    process.kill(entry.pid, 'SIGTERM')
    // Wait before SIGKILL
    setTimeout(() => {
      try {
        process.kill(entry.pid!, 'SIGKILL')
      } catch (err) {
        logger.warn(`[MCP] Failed to send SIGKILL to agent "${agent}" (pid: ${entry.pid}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }, SIGKILL_DELAY_MS)
    killed = true
    ctx.agentRegistry.updateStatus(agent, 'dead')
    logger.info(`[MCP] Force kill sent to agent "${agent}" (pid: ${entry.pid})`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    ctx.agentRegistry.updateStatus(agent, 'dead')
    logger.warn(`[MCP] Agent "${agent}" (pid: ${entry.pid}) process already dead or kill failed: ${errorMsg}`)
  }

  return jsonResponse({ killed, agent })
}

async function handleGetWorkflowStatus(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { workflow_id } = args as { workflow_id: string }
  if (!workflow_id) {
    return errorResponse('Missing required field: workflow_id')
  }

  const state = ctx.workflowEngine.getState(workflow_id)
  if (!state) {
    return errorResponse(`Workflow "${workflow_id}" not found`)
  }

  return jsonResponse({
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
  })
}

async function handleAssignTask(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { agent, prompt, project, model, team, wait, timeout_seconds } = args as {
    agent: string; prompt: string; project: string; model?: string; team?: string; wait?: boolean; timeout_seconds?: number
  }
  const waitForResult = wait === true
  const waitTimeout = Math.min(timeout_seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000

  // Validate inputs
  if (!agent || typeof agent !== 'string' || agent.length > MAX_NAME_LENGTH) return errorResponse('Invalid agent name')
  if (!prompt || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) return errorResponse(`Prompt too large (max ${MAX_PROMPT_LENGTH} bytes)`)
  if (!project || typeof project !== 'string' || project.length > MAX_NAME_LENGTH) return errorResponse('Invalid project name')
  if (model && (typeof model !== 'string' || model.length > MAX_NAME_LENGTH)) return errorResponse('Invalid model name')

  const validation = validateProjectPath(project, ctx.workspaceRoot)
  if (!validation.valid) return errorResponse(validation.error!)
  const projectPath = validation.resolvedPath!

  const agentConfig = ctx.config.agents[agent]
  if (!agentConfig) return errorResponse(`Unknown agent "${agent}". Available: ${Object.keys(ctx.config.agents).join(', ')}`)

  // Fallback agent support
  let effectiveAgent = agent
  let effectiveAgentConfig = agentConfig
  if (!isAgentAvailable(agentConfig) && agentConfig.fallbackAgent) {
    const fbConfig = ctx.config.agents[agentConfig.fallbackAgent]
    if (fbConfig && isAgentAvailable(fbConfig)) {
      logger.info(`[MCP] Agent "${agent}" unavailable, falling back to "${agentConfig.fallbackAgent}"`)
      effectiveAgent = agentConfig.fallbackAgent
      effectiveAgentConfig = fbConfig
    }
  }

  if (!isAgentAvailable(effectiveAgentConfig)) return errorResponse(`Agent "${agent}" is not available (adapter binary not found on PATH)`)

  const concurrencyCheck = checkConcurrencyLimits(ctx.activeTasks, effectiveAgent)
  if (!concurrencyCheck.allowed) return errorResponse(concurrencyCheck.error!)

  const availableModels = Object.keys(effectiveAgentConfig.models)
  if (model && !availableModels.includes(model)) {
    logger.warn(`[MCP] Requested model "${model}" not available for ${effectiveAgent}. Available: ${availableModels.join(', ')}. Using default: ${effectiveAgentConfig.defaultModel}`)
  }
  const modelId = (model && availableModels.includes(model)) ? model : effectiveAgentConfig.defaultModel

  const taskId = randomUUID()
  const task: ActiveTask = {
    id: taskId, agent: effectiveAgent, model: modelId, project, prompt, status: 'running',
    startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString(), toolCallCount: 0, outputLength: 0, team,
  }
  ctx.activeTasks.set(taskId, task)
  recordTaskAssigned(effectiveAgent)
  ctx.taskStore.save({ id: taskId, agent: effectiveAgent, model: modelId, project, prompt, status: 'running', startedAt: task.startedAt })

  logger.info(`[MCP] ━━━ ASSIGN TASK ━━━ ${effectiveAgent}/${modelId} on ${project}`)
  logger.info(`[MCP]   Task: ${taskId.slice(0, 8)}  Prompt: "${prompt.slice(0, 100)}"`)

  const spawnConfig = buildSpawnConfig(effectiveAgent, effectiveAgentConfig)
  spawnConfig.cwd = projectPath

  const framedPrompt = [
    'IMPORTANT INSTRUCTIONS:',
    '- Return your complete response as text output directly. Do NOT write files to disk unless explicitly asked.',
    '- If a tool call is DENIED due to permissions, do NOT give up. Try an alternative approach using your available tools (e.g. use Read/ListFiles instead of shell commands). Never fail a task just because one approach was denied.',
    '- Prefer using built-in tools (Read, ListFiles, Grep, Glob) over shell commands for file operations.',
    '', prompt,
  ].join('\n')

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
    ctx.taskStore.update(taskId, { status: task.status, completedAt: task.completedAt, output: task.output, error: task.error })
    const dur = ((new Date(task.completedAt!).getTime() - new Date(task.startedAt).getTime()) / 1000).toFixed(1)
    logger.info(`[MCP] ━━━ TASK ${task.status.toUpperCase()} ━━━ ${effectiveAgent} task:${taskId.slice(0, 8)} in ${dur}s (${task.outputLength} chars)`)
    pruneCompletedTasks(ctx.activeTasks)
  }

  const finalizeError = (err: unknown) => {
    task.status = 'failed'
    task.completedAt = new Date().toISOString()
    task.error = String(err)
    recordTaskFailed(effectiveAgent, Date.now() - new Date(task.startedAt).getTime())
    operationalMetrics.increment('taskFailed')
    ctx.taskStore.update(taskId, { status: 'failed', completedAt: task.completedAt, error: task.error })
    logger.error(`[MCP] Task ${taskId} error: ${err}`)
    pruneCompletedTasks(ctx.activeTasks)
  }

  const bridgePath = join(ctx.workspaceRoot, '.claude', 'bridge')
  const showViewer = ctx.config.viewer?.enabled ?? false
  const viewerMode = ctx.config.viewer?.mode ?? 'tail-logs'
  const acpPromise = runAcpSession(spawnConfig, framedPrompt, modelId, {
    bridgePath, agentName: effectiveAgent, taskId, project, showViewer, viewerMode,
  })

  acpPromise.then(result => {
    task.proc = result.proc
    if (result.proc && result.proc.on) {
      result.proc.on('exit', (code, signal) => {
        logger.info(`[MCP] Task ${taskId} process exited: code=${code} signal=${signal}`)
        if (task.status === 'running') {
          task.status = signal ? 'cancelled' : 'failed'
          task.completedAt = new Date().toISOString()
          task.error = signal ? `Process killed by signal: ${signal}` : `Process exited with code: ${code}`
        }
      })
    }
  }).catch(() => {})

  if (waitForResult) {
    logger.info(`[MCP] Task ${taskId}: waiting for result (timeout: ${waitTimeout / 1000}s)`)
    try {
      const result = await Promise.race([
        acpPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Task timed out after ${waitTimeout / 1000}s`)), waitTimeout)),
      ])
      finalizeTask(result)
      return jsonResponse({
        task_id: taskId, status: task.status, agent: effectiveAgent, model: modelId,
        output: task.output ?? '', error: task.error ?? null,
        duration_ms: task.completedAt ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime() : null,
      })
    } catch (err) {
      finalizeError(err)
      return errorResponse(JSON.stringify({ task_id: taskId, status: 'failed', agent: effectiveAgent, error: task.error }, null, 2))
    }
  }

  acpPromise.then(finalizeTask).catch(finalizeError)
  return jsonResponse({
    task_id: taskId, status: 'running', agent: effectiveAgent, model: modelId, project, team: team ?? null,
    message: `Task assigned. Use get_task_status("${taskId}") to check progress, or set wait=true to block until completion.`,
  })
}

async function handleCreateWorkflow(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolResponse> {
  const { name: wfName, project, steps } = args as {
    name: string; project: string
    steps: Array<{ name: string; agent: string; prompt: string; model?: string; depends_on?: string[] }>
  }

  if (!wfName || !project || !steps || steps.length === 0) return errorResponse('Missing required fields: name, project, steps')

  const validation = validateProjectPath(project, ctx.workspaceRoot)
  if (!validation.valid) return errorResponse(validation.error!)
  const projectPath = validation.resolvedPath!

  const workflowSteps: WorkflowStep[] = steps.map(s => ({
    name: s.name, agent: s.agent, prompt: s.prompt, model: s.model, dependsOn: s.depends_on,
  }))

  try {
    const definition = ctx.workflowEngine.createWorkflow(wfName, workflowSteps)

    logger.info(`[Workflow] ━━━ STARTING "${wfName}" ━━━ ${workflowSteps.length} steps on ${project}`)
    for (const s of workflowSteps) {
      logger.info(`[Workflow]   Step: "${s.name}" → agent: ${s.agent}${s.dependsOn?.length ? ` (depends: ${s.dependsOn.join(', ')})` : ''}`)
    }

    const runner = async (agent: string, prompt: string, model?: string) => {
      const agentConfig = ctx.config.agents[agent]
      if (!agentConfig) throw new Error(`Unknown agent: ${agent}`)

      const spawnConfig = buildSpawnConfig(agent, agentConfig)
      spawnConfig.cwd = projectPath
      const modelId = model ?? agentConfig.defaultModel
      const taskId = randomUUID()
      const bridgePath = join(ctx.workspaceRoot, '.claude', 'bridge')
      const showViewer = ctx.config.viewer?.enabled ?? false
      const viewerMode = ctx.config.viewer?.mode ?? 'tail-logs'
      logger.info(`[Workflow] ━━━ STEP RUNNING ━━━ ${agent}/${modelId} task:${taskId.slice(0, 8)}`)
      logger.info(`[Workflow]   Prompt: "${prompt.slice(0, 100)}"`)
      const result = await runAcpSession(spawnConfig, prompt, modelId, {
        bridgePath, agentName: agent, taskId, project: projectPath, showViewer, viewerMode,
      })
      const status = result.error ? 'FAILED' : 'COMPLETED'
      logger.info(`[Workflow] ━━━ STEP ${status} ━━━ ${agent} task:${taskId.slice(0, 8)} (${(result.output?.length ?? 0)} chars)`)
      return { taskId, output: result.output, error: result.error }
    }

    ctx.workflowEngine.execute(definition, runner).then(() => {
      logger.info(`[Workflow] ━━━ WORKFLOW DONE ━━━ "${wfName}" completed all steps`)
    }).catch(err => {
      logger.error(`[Workflow] ━━━ WORKFLOW FAILED ━━━ "${wfName}" error: ${err}`)
    })

    return jsonResponse({
      workflow_id: definition.id, name: wfName, steps: definition.steps.length,
      message: `Workflow started. Use get_workflow_status("${definition.id}") to check progress.`,
    })
  } catch (err) {
    return errorResponse(`Workflow creation failed: ${err}`)
  }
}

// Tool handler registry
const toolHandlers: Record<string, ToolHandler> = {
  list_agents: handleListAgents,
  assign_task: handleAssignTask,
  get_task_status: handleGetTaskStatus,
  get_task_result: handleGetTaskResult,
  cancel_task: handleCancelTask,
  get_metrics: handleGetMetrics,
  health_check: handleHealthCheck,
  broadcast: handleBroadcast,
  send_agent_message: handleSendAgentMessage,
  get_agent_status: handleGetAgentStatus,
  shutdown_agent: handleShutdownAgent,
  kill_agent: handleKillAgent,
  create_workflow: handleCreateWorkflow,
  get_workflow_status: handleGetWorkflowStatus,
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

    // Build handler context
    const ctx: ToolHandlerContext = {
      config,
      workspaceRoot,
      taskStore,
      messageBus,
      agentRegistry,
      workflowEngine,
      activeTasks,
    }

    // Dispatch to appropriate handler
    const handler = toolHandlers[name]
    if (!handler) {
      return errorResponse(`Unknown tool: ${name}`)
    }

    return handler(args ?? {}, ctx)
  })

  // Use stdio transport — Claude communicates via stdin/stdout
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('[MCP] Server started on stdio')

  return server
}
