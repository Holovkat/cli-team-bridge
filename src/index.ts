import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { parseArgs } from 'util'
import { loadConfig, type BridgeConfig } from './config'
import { configureLogger, logger } from './logger'
import { generateManifest } from './manifest'
import { TaskWatcher, type TaskAssignment } from './task-watcher'
import { writeTaskResult, markTaskInProgress, type TaskResult } from './result-writer'
import { runAcpSession } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'
import { startMcpServer } from './mcp-server'
import { VERSION } from './version'
import { withRetry } from './retry'
import { MessageBus } from './message-bus'
import { AgentRegistry } from './agent-registry'
import { MessagingWrapper } from './messaging-wrapper'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    team: { type: 'string' },
    config: { type: 'string', default: './bridge.config.json' },
    mode: { type: 'string', default: 'both' }, // watcher | mcp | both
  },
  strict: false,
})

const mode = values.mode as 'watcher' | 'mcp' | 'both'

if (mode !== 'mcp' && !values.team) {
  console.error('Usage: bun run src/index.ts --team <team-id> [--config <path>] [--mode watcher|mcp|both]')
  console.error('  --team is required for watcher and both modes')
  process.exit(1)
}

const config = await loadConfig(values.config as string)
configureLogger(config.logging.level, config.logging.file)

// Startup banner
console.error(`
╔══════════════════════════════════════════╗
║       CLI Team Bridge v${VERSION}             ║
║       ACP Multi-Agent Coordinator        ║
╚══════════════════════════════════════════╝
`)
console.error(`Mode: ${mode}`)
console.error(`Workspace: ${config.workspaceRoot}`)
console.error(`Config: ${values.config}`)

// Bridge-level messaging infrastructure for shutdown cleanup
const messagingConfig = config.messaging ?? { enabled: true, failSilently: true }
const bridgePath = join(config.workspaceRoot, '.claude', 'bridge')

// Create messaging components only if enabled
let bridgeRegistry: AgentRegistry | null = null
let bridgeMessageBus: MessageBus | null = null

if (messagingConfig.enabled) {
  try {
    bridgeRegistry = new AgentRegistry(bridgePath)
    bridgeMessageBus = new MessageBus(bridgePath)
    logger.info('[Messaging] Bridge messaging infrastructure initialized')
  } catch (err) {
    if (messagingConfig.failSilently) {
      logger.warn(`[Messaging] Failed to initialize messaging: ${err}`)
    } else {
      throw err
    }
  }
} else {
  logger.info('[Messaging] Bridge messaging is disabled')
}

// Wrap messaging components with safe wrapper
const messaging = new MessagingWrapper(bridgeMessageBus, bridgeRegistry, messagingConfig)

// --- MCP Server Mode ---
if (mode === 'mcp' || mode === 'both') {
  // MCP uses stdout for JSON-RPC, so all logging must go to stderr/file
  await startMcpServer(config, config.workspaceRoot)
  console.error('[MCP] Server ready on stdio')
}

// --- File Watcher Mode ---
if (mode === 'watcher' || mode === 'both') {
  const CLAUDE_DIR = process.env['HOME']
    ? join(process.env['HOME'], '.claude')
    : '/root/.claude'
  const taskDir = join(CLAUDE_DIR, 'tasks', values.team as string)

  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true })
  }

  console.error(`Team: ${values.team}`)
  console.error(`Task dir: ${taskDir}`)

  await generateManifest(config, taskDir)

  const watcher = new TaskWatcher(config, taskDir)

  async function handleTaskAssignment(assignment: TaskAssignment, config: BridgeConfig, watcher: TaskWatcher): Promise<void> {
    const { task, filePath, modelOverride } = assignment
    const agentConfig = config.agents[task.owner]

    if (!agentConfig) {
      logger.error(`No config for agent "${task.owner}"`)
      watcher.markComplete(task.id)
      return
    }

    try {
      const marked = await markTaskInProgress(filePath, taskDir)
      if (!marked) {
        logger.warn(`Failed to mark task ${task.id} as in_progress`)
      }

      const spawnConfig = buildSpawnConfig(task.owner, agentConfig)
      const model = modelOverride ?? agentConfig.defaultModel

      logger.info(`Starting ACP session for task ${task.id} with ${task.owner} (model: ${model})`)
      const startedAt = new Date().toISOString()

      const acpResult = await withRetry(
        () => runAcpSession(spawnConfig, task.description, model, {
          taskId: task.id,
          agentName: task.owner,
          project: config.workspaceRoot,
          showViewer: config.viewer?.enabled ?? false,
          viewerMode: config.viewer?.mode ?? 'tail-logs',
        }),
        { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 30000 },
        `task-${task.id}`,
      )
      const completedAt = new Date().toISOString()

      const result: TaskResult = {
        agentName: task.owner,
        model,
        startedAt,
        completedAt,
        status: acpResult.error ? 'failed' : 'completed',
        output: acpResult.output,
        error: acpResult.error,
      }

      const written = await writeTaskResult(filePath, result, taskDir)
      if (!written) {
        logger.warn(`Failed to write result for task ${task.id}`)
      }
    } catch (err) {
      logger.error(`Task ${task.id} failed: ${err}`)
      const result: TaskResult = {
        agentName: task.owner,
        model: modelOverride ?? agentConfig.defaultModel,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        output: '',
        error: String(err),
      }
      const written = await writeTaskResult(filePath, result, taskDir)
      if (!written) {
        logger.warn(`Failed to write result for task ${task.id}`)
      }
    } finally {
      watcher.markComplete(task.id)
    }
  }

  watcher.on('task-assigned', async (assignment: TaskAssignment) => {
    try {
      await handleTaskAssignment(assignment, config, watcher)
    } catch (err) {
      logger.error(`Unhandled error in task handler for ${assignment.task.id}: ${err}`)
    } finally {
      // Ensure processing set is always cleaned up, even on unexpected errors
      watcher.markComplete(assignment.task.id)
    }
  })

  watcher.start()

  const shutdown = () => {
    logger.info('Shutting down...')
    watcher.stop()

    // Graceful agent cleanup — broadcast shutdown, then kill remaining
    const activeAgents = messaging.getActive()
    if (activeAgents.length > 0) {
      logger.info(`Sending shutdown to ${activeAgents.length} active agents...`)
      for (const agent of activeAgents) {
        messaging.writeMessage('orchestrator', agent.name, 'Bridge shutting down', { type: 'shutdown' })
        if (agent.pid) {
          try { process.kill(agent.pid, 'SIGTERM') } catch { /* already dead */ }
        }
      }
      // Force kill after 5s
      setTimeout(() => {
        for (const agent of activeAgents) {
          if (agent.pid) {
            try { process.kill(agent.pid, 'SIGKILL') } catch { /* already dead */ }
          }
        }
        messaging.clear()
        messaging.cleanupAll()
        process.exit(0)
      }, 5000)
    } else {
      process.exit(0)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.on('SIGHUP', async () => {
    logger.info('SIGHUP received — reloading config and manifest')
    try {
      const newConfig = await loadConfig(values.config as string)
      // Log what changed
      const changedKeys: string[] = []
      for (const key of Object.keys(newConfig) as (keyof BridgeConfig)[]) {
        if (JSON.stringify(config[key]) !== JSON.stringify(newConfig[key])) {
          changedKeys.push(key)
        }
      }
      if (changedKeys.length > 0) {
        logger.info(`Config changes detected in: ${changedKeys.join(', ')}`)
      } else {
        logger.info('No config changes detected')
      }
      // Deep replace — Object.assign is shallow, leaves stale nested objects
      for (const key of Object.keys(config) as (keyof BridgeConfig)[]) {
        delete (config as any)[key]
      }
      Object.assign(config, newConfig)
      // Reinitialize watcher with new config
      watcher.updateAgents(config)
      await generateManifest(config, taskDir)
      logger.info('Config reloaded successfully')
    } catch (err) {
      logger.error(`Reload failed: ${err}`)
    }
  })

  logger.info('Watcher started — watching for tasks...')
}

// Keep process alive in MCP-only mode
if (mode === 'mcp') {
  console.error('[MCP] Waiting for requests on stdin...')

  const mcpShutdown = () => {
    logger.info('MCP shutting down...')
    const activeAgents = messaging.getActive()
    for (const agent of activeAgents) {
      if (agent.pid) {
        try { process.kill(agent.pid, 'SIGTERM') } catch { /* already dead */ }
      }
    }
    messaging.clear()
    messaging.cleanupAll()
    process.exit(0)
  }

  process.on('SIGINT', mcpShutdown)
  process.on('SIGTERM', mcpShutdown)
}
