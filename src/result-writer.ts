import { readFileSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { LockManager } from './lock-manager'
import { logger } from './logger'

const MAX_OUTPUT_LENGTH = 10 * 1024 // 10KB

export interface TaskResult {
  agentName: string
  model: string
  startedAt: string
  completedAt: string
  status: 'completed' | 'failed'
  output: string
  error: string | null
}

export async function writeTaskResult(
  filePath: string,
  result: TaskResult,
  taskDir: string,
): Promise<void> {
  const lock = new LockManager(taskDir)

  try {
    const acquired = await lock.acquire()
    if (!acquired) {
      throw new Error(`Could not acquire lock to write result for ${filePath}`)
    }

    const raw = readFileSync(filePath, 'utf-8')
    const task = JSON.parse(raw)

    // Truncate output
    const truncatedOutput = result.output.length > MAX_OUTPUT_LENGTH
      ? result.output.slice(0, MAX_OUTPUT_LENGTH) + '\n... [truncated, see bridge.log]'
      : result.output

    if (result.output.length > MAX_OUTPUT_LENGTH) {
      logger.info(`Full output for task ${task.id}:\n${result.output}`)
    }

    task.result = { ...result, output: truncatedOutput }
    task.status = result.status === 'completed' ? 'completed' : 'failed'

    // Atomic write: temp file + rename
    const tmpPath = filePath + '.tmp'
    await Bun.write(tmpPath, JSON.stringify(task, null, 2))
    renameSync(tmpPath, filePath)

    logger.info(`Result written for task ${task.id}: ${result.status}`)
  } catch (err) {
    logger.error(`Failed to write result for ${filePath}: ${err}`)
  } finally {
    lock.release()
  }
}

export async function markTaskInProgress(filePath: string, taskDir: string): Promise<void> {
  const lock = new LockManager(taskDir)

  try {
    const acquired = await lock.acquire()
    if (!acquired) {
      throw new Error(`Could not acquire lock to mark in_progress for ${filePath}`)
    }

    const raw = readFileSync(filePath, 'utf-8')
    const task = JSON.parse(raw)
    task.status = 'in_progress'

    const tmpPath = filePath + '.tmp'
    await Bun.write(tmpPath, JSON.stringify(task, null, 2))
    renameSync(tmpPath, filePath)
  } catch (err) {
    logger.error(`Failed to mark in_progress: ${err}`)
  } finally {
    lock.release()
  }
}
