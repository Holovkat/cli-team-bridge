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

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    team: { type: 'string' },
    config: { type: 'string', default: './bridge.config.json' },
    mode: { type: 'string', default: 'both' }, // watcher | mcp | both
  },
  strict: true,
})

const mode = values.mode as 'watcher' | 'mcp' | 'both'

if (mode !== 'mcp' && !values.team) {
  console.error('Usage: bun run src/index.ts --team <team-id> [--config <path>] [--mode watcher|mcp|both]')
  console.error('  --team is required for watcher and both modes')
  process.exit(1)
}

const config = await loadConfig(values.config!)
configureLogger(config.logging.level as any, config.logging.file)

// Startup banner
console.error(`
╔══════════════════════════════════════════╗
║       CLI Team Bridge v0.1.0             ║
║       ACP Multi-Agent Coordinator        ║
╚══════════════════════════════════════════╝
`)
console.error(`Mode: ${mode}`)
console.error(`Workspace: ${config.workspaceRoot}`)
console.error(`Config: ${values.config}`)

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
  const taskDir = join(CLAUDE_DIR, 'tasks', values.team!)

  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true })
  }

  console.error(`Team: ${values.team}`)
  console.error(`Task dir: ${taskDir}`)

  await generateManifest(config, taskDir)

  const watcher = new TaskWatcher(config, taskDir)

  watcher.on('task-assigned', async (assignment: TaskAssignment) => {
    const { task, filePath, modelOverride } = assignment
    const agentConfig = config.agents[task.owner]

    if (!agentConfig) {
      logger.error(`No config for agent "${task.owner}"`)
      watcher.markComplete(task.id)
      return
    }

    try {
      await markTaskInProgress(filePath, taskDir)

      const spawnConfig = buildSpawnConfig(task.owner, agentConfig)
      const model = modelOverride ?? agentConfig.defaultModel

      logger.info(`Starting ACP session for task ${task.id} with ${task.owner} (model: ${model})`)
      const startedAt = new Date().toISOString()

      const acpResult = await runAcpSession(spawnConfig, task.description, model)
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

      await writeTaskResult(filePath, result, taskDir)
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
      await writeTaskResult(filePath, result, taskDir)
    } finally {
      watcher.markComplete(task.id)
    }
  })

  watcher.start()

  const shutdown = () => {
    logger.info('Shutting down...')
    watcher.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.on('SIGHUP', async () => {
    logger.info('SIGHUP received — reloading config and manifest')
    try {
      const newConfig = await loadConfig(values.config!)
      // Deep replace — Object.assign is shallow, leaves stale nested objects
      for (const key of Object.keys(config) as (keyof BridgeConfig)[]) {
        delete (config as any)[key]
      }
      Object.assign(config, newConfig)
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
}
