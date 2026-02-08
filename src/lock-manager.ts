import { logger } from './logger'
import { join } from 'path'
import { readFileSync, unlinkSync, writeFileSync, existsSync } from 'fs'

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
        writeFileSync(this.lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' })
        this.held = true
        return true
      } catch (err: any) {
        if (err?.code !== 'EEXIST') {
          // Permission error, IO error, etc. — fail immediately
          logger.error(`Lock acquire failed (non-EEXIST): ${err}`)
          return false
        }
        // Check if lock is stale (dead process or expired)
        try {
          const content = readFileSync(this.lockPath, 'utf-8')
          const [pidStr, timestampStr] = content.split('\n')
          const pid = parseInt(pidStr, 10)
          const timestamp = parseInt(timestampStr, 10)
          const LOCK_EXPIRY_MS = 60_000 // 1 minute

          const isStale = Date.now() - timestamp > LOCK_EXPIRY_MS
          let isProcessDead = false
          try { process.kill(pid, 0) } catch { isProcessDead = true }

          if (isStale || isProcessDead) {
            logger.warn(`Removing stale lock (pid=${pid}, age=${Date.now() - timestamp}ms)`)
            unlinkSync(this.lockPath)
            continue
          }
        } catch {
          // Lock file disappeared between check and read — retry
        }
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
      this.held = false
    } catch (err) {
      logger.error(`Failed to release lock: ${err}`)
      // Keep held = true so caller knows lock may still exist
    }
  }
}
