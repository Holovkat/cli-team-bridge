import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, fsyncSync, openSync, closeSync } from 'fs'
import { logger } from './logger'
import { operationalMetrics } from './metrics'
import type { AgentRegistryEntry, AgentStatus } from './acp-types'

const HEARTBEAT_INTERVAL_MS = 10_000 // 10s
const DEAD_THRESHOLD_MS = 30_000 // 30s without heartbeat = dead

export class AgentRegistry {
  private registryPath: string
  private bridgePath: string

  constructor(bridgePath: string) {
    this.bridgePath = bridgePath
    this.registryPath = join(bridgePath, 'agents.json')
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.bridgePath)) {
      mkdirSync(this.bridgePath, { recursive: true })
    }
  }

  private load(): AgentRegistryEntry[] {
    if (!existsSync(this.registryPath)) return []
    try {
      const raw = readFileSync(this.registryPath, 'utf-8')
      return JSON.parse(raw) as AgentRegistryEntry[]
    } catch (err) {
      logger.warn(`[AgentRegistry] Failed to load registry: ${err}`)
      return []
    }
  }

  private save(entries: AgentRegistryEntry[]): void {
    try {
      // Atomic write: write to temp file, fsync, then rename
      const tempPath = `${this.registryPath}.tmp`
      const data = JSON.stringify(entries, null, 2)
      
      writeFileSync(tempPath, data)
      
      // Ensure data is flushed to disk before renaming
      const fd = openSync(tempPath, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      
      // Atomic rename
      renameSync(tempPath, this.registryPath)
    } catch (err) {
      logger.error(`[AgentRegistry] Failed to save registry: ${err}`)
      operationalMetrics.increment('registrySaveFailures')
      // Don't throw - registry corruption is worse than stale data
      // The next operation will retry with the in-memory state
    }
  }

  register(name: string, model: string, pid?: number): AgentRegistryEntry {
    const entries = this.load()

    // Remove existing entry with same name (re-registration)
    const filtered = entries.filter(e => e.name !== name)

    const now = new Date().toISOString()
    const entry: AgentRegistryEntry = {
      name,
      status: 'running',
      model,
      registeredAt: now,
      lastHeartbeat: now,
      lastActivity: now,
      pid,
      messagesPending: 0,
      requestsPending: 0,
    }

    filtered.push(entry)
    this.save(filtered)
    logger.info(`[AgentRegistry] Registered agent: ${name} (model: ${model}, pid: ${pid ?? 'N/A'})`)
    return entry
  }

  deregister(name: string): boolean {
    const entries = this.load()
    const before = entries.length
    const filtered = entries.filter(e => e.name !== name)
    if (filtered.length === before) return false

    this.save(filtered)
    logger.info(`[AgentRegistry] Deregistered agent: ${name}`)
    return true
  }

  getActive(): AgentRegistryEntry[] {
    const entries = this.load()
    return entries.filter(e => e.status !== 'dead')
  }

  getAll(): AgentRegistryEntry[] {
    return this.load()
  }

  get(name: string): AgentRegistryEntry | null {
    const entries = this.load()
    return entries.find(e => e.name === name) ?? null
  }

  updateStatus(name: string, status: AgentStatus, currentTask?: string): boolean {
    const entries = this.load()
    const entry = entries.find(e => e.name === name)
    if (!entry) return false

    entry.status = status
    entry.lastActivity = new Date().toISOString()
    if (currentTask !== undefined) {
      entry.currentTask = currentTask
    }
    this.save(entries)
    return true
  }

  heartbeat(name: string): boolean {
    const entries = this.load()
    const entry = entries.find(e => e.name === name)
    if (!entry) return false

    entry.lastHeartbeat = new Date().toISOString()
    this.save(entries)
    return true
  }

  updateMessageCounts(name: string, messagesPending: number, requestsPending: number): void {
    const entries = this.load()
    const entry = entries.find(e => e.name === name)
    if (!entry) return

    entry.messagesPending = messagesPending
    entry.requestsPending = requestsPending
    this.save(entries)
  }

  detectDead(): AgentRegistryEntry[] {
    const entries = this.load()
    const now = Date.now()
    const deadAgents: AgentRegistryEntry[] = []

    for (const entry of entries) {
      if (entry.status === 'dead') continue

      const lastHeartbeat = new Date(entry.lastHeartbeat).getTime()
      const elapsed = now - lastHeartbeat

      if (elapsed > DEAD_THRESHOLD_MS) {
        // Also check if process is actually running
        let processAlive = false
        if (entry.pid) {
          try {
            process.kill(entry.pid, 0)
            processAlive = true
          } catch {
            processAlive = false
          }
        }

        if (!processAlive) {
          entry.status = 'dead'
          entry.lastActivity = new Date().toISOString()
          deadAgents.push(entry)
          logger.warn(`[AgentRegistry] Agent "${entry.name}" detected as dead (no heartbeat for ${Math.round(elapsed / 1000)}s)`)
        }
      }
    }

    if (deadAgents.length > 0) {
      this.save(entries)
    }
    return deadAgents
  }

  pruneDeadAgents(): number {
    const entries = this.load()
    const alive = entries.filter(e => e.status !== 'dead')
    const pruned = entries.length - alive.length
    if (pruned > 0) {
      this.save(alive)
      logger.info(`[AgentRegistry] Pruned ${pruned} dead agents`)
    }
    return pruned
  }

  clear(): void {
    this.save([])
    logger.info('[AgentRegistry] Registry cleared')
  }

  getHeartbeatInterval(): number {
    return HEARTBEAT_INTERVAL_MS
  }

  getDeadThreshold(): number {
    return DEAD_THRESHOLD_MS
  }

  getUptimeSeconds(name: string): number {
    const entry = this.get(name)
    if (!entry) return 0
    return Math.round((Date.now() - new Date(entry.registeredAt).getTime()) / 1000)
  }
}
