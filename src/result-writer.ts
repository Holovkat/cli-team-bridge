import { readFileSync, renameSync } from 'fs'
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
): Promise<boolean> {
  const lock = new LockManager(taskDir)

  try {
    const acquired = await lock.acquire()
    if (!acquired) {
      throw new Error(`Could not acquire lock to write result for ${filePath}`)
    }

    const raw = readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('status' in parsed)) {
      throw new Error(`Invalid task file format: ${filePath}`)
    }
    const task = parsed as { id: string; status: string; result?: unknown; [key: string]: unknown }

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
    return true
  } catch (err) {
    logger.error(`Failed to write result for ${filePath}: ${err}`)
    return false
  } finally {
    lock.release()
  }
}

export async function markTaskInProgress(filePath: string, taskDir: string): Promise<boolean> {
  const lock = new LockManager(taskDir)

  try {
    const acquired = await lock.acquire()
    if (!acquired) {
      throw new Error(`Could not acquire lock to mark in_progress for ${filePath}`)
    }

    const raw = readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('status' in parsed)) {
      throw new Error(`Invalid task file format: ${filePath}`)
    }
    const task = parsed as { id: string; status: string; [key: string]: unknown }
    task.status = 'in_progress'

    const tmpPath = filePath + '.tmp'
    await Bun.write(tmpPath, JSON.stringify(task, null, 2))
    renameSync(tmpPath, filePath)
    return true
  } catch (err) {
    logger.error(`Failed to mark in_progress: ${err}`)
    return false
  } finally {
    lock.release()
  }
}
