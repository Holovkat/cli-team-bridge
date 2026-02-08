import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { parseArgs } from 'util'
import { loadConfig } from './config'
import { configureLogger, logger } from './logger'
import { generateManifest } from './manifest'
import { TaskWatcher, type TaskAssignment } from './task-watcher'
import { writeTaskResult, markTaskInProgress, type TaskResult } from './result-writer'
import { runAcpSession } from './acp-client'
import { buildSpawnConfig } from './agent-adapters'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    team: { type: 'string' },
    config: { type: 'string', default: './bridge.config.json' },
  },
  strict: true,
})

if (!values.team) {
  console.error('Usage: bun run src/index.ts --team <team-id> [--config <path>]')
  process.exit(1)
}

const CLAUDE_DIR = process.env['HOME']
  ? join(process.env['HOME'], '.claude')
  : '/root/.claude'
const taskDir = join(CLAUDE_DIR, 'tasks', values.team)

// Ensure task directory exists
if (!existsSync(taskDir)) {
  mkdirSync(taskDir, { recursive: true })
}

const config = await loadConfig(values.config!)
configureLogger(config.logging.level as any, config.logging.file)

// Startup banner
console.log(`
╔══════════════════════════════════════════╗
║       CLI Team Bridge v0.1.0             ║
║       ACP Multi-Agent Coordinator        ║
╚══════════════════════════════════════════╝
`)
logger.info(`Team: ${values.team}`)
logger.info(`Task dir: ${taskDir}`)
logger.info(`Config: ${values.config}`)

// Generate manifest
await generateManifest(config, taskDir)

// Start watcher
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
    // Mark in progress
    await markTaskInProgress(filePath, taskDir)

    // Build spawn config
    const spawnConfig = buildSpawnConfig(task.owner, agentConfig, modelOverride)
    const model = modelOverride ?? agentConfig.defaultModel

    logger.info(`Starting ACP session for task ${task.id} with ${task.owner} (model: ${model})`)
    const startedAt = new Date().toISOString()

    // Run ACP session
    const acpResult = await runAcpSession(spawnConfig, task.description)
    const completedAt = new Date().toISOString()

    // Write result
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

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down...')
  watcher.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// SIGHUP = reload config + regenerate manifest
process.on('SIGHUP', async () => {
  logger.info('SIGHUP received — reloading config and manifest')
  try {
    const newConfig = await loadConfig(values.config!)
    Object.assign(config, newConfig)
    await generateManifest(config, taskDir)
  } catch (err) {
    logger.error(`Reload failed: ${err}`)
  }
})

logger.info('Bridge started — watching for tasks...')
