import { logger } from './logger'
import { join } from 'path'
import { unlinkSync, writeFileSync, existsSync } from 'fs'

export class LockManager {
  private lockPath: string
  private held = false

  constructor(taskDir: string) {
    this.lockPath = join(taskDir, '.bridge-lock')
  }

  async acquire(timeoutMs = 5000): Promise<boolean> {
    const start = Date.now()
    let delay = 50

    while (Date.now() - start < timeoutMs) {
      try {
        // Exclusive create — fails if file exists
        writeFileSync(this.lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' })
        this.held = true
        return true
      } catch {
        // Lock held by another process, wait with exponential backoff
        await Bun.sleep(delay)
        delay = Math.min(delay * 2, 500)
      }
    }

    logger.warn(`Failed to acquire lock after ${timeoutMs}ms`)
    return false
  }

  release() {
    if (!this.held) return
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath)
      }
    } catch (err) {
      logger.error(`Failed to release lock: ${err}`)
    }
    this.held = false
  }
}
