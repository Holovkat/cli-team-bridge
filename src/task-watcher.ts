import { EventEmitter } from 'events'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { type BridgeConfig } from './config'
import { logger } from './logger'

export interface TaskData {
  id: string
  subject: string
  description: string
  owner: string
  status: string
  metadata?: { model?: string; [key: string]: unknown }
  blocks?: string[]
  blockedBy?: string[]
  [key: string]: unknown
}

export interface TaskAssignment {
  task: TaskData
  filePath: string
  modelOverride?: string
}

export class TaskWatcher extends EventEmitter {
  private taskDir: string
  private agentNames: Set<string>
  private processing = new Set<string>()
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(config: BridgeConfig, taskDir: string) {
    super()
    this.taskDir = taskDir
    this.agentNames = new Set(Object.keys(config.agents))
    this.intervalMs = config.polling.intervalMs
  }

  start() {
    logger.info(`Watching ${this.taskDir} every ${this.intervalMs}ms for agents: ${[...this.agentNames].join(', ')}`)
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    this.poll() // Initial check
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  markComplete(taskId: string) {
    this.processing.delete(taskId)
  }

  private poll() {
    try {
      const files = readdirSync(this.taskDir).filter(f => f.endsWith('.json') && f !== 'bridge-manifest.json')

      for (const file of files) {
        const filePath = join(this.taskDir, file)
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const parsed: unknown = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object') continue
          const task = parsed as TaskData

          if (!task.id || !task.owner || !task.status) continue
          if (task.status !== 'pending') continue
          if (!this.agentNames.has(task.owner)) continue
          if (this.processing.has(task.id)) continue

          // Check blockedBy
          if (task.blockedBy && task.blockedBy.length > 0) continue

          this.processing.add(task.id)
          const assignment: TaskAssignment = {
            task,
            filePath,
            modelOverride: task.metadata?.model,
          }

          logger.info(`Task ${task.id} assigned to ${task.owner}: "${task.subject}"`)
          this.emit('task-assigned', assignment)
        } catch {
          // Skip unparseable files
        }
      }
    } catch (err) {
      logger.error(`Poll error: ${err}`)
    }
  }
}
