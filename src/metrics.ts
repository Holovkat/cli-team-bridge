import { logger } from './logger'

interface AgentMetrics {
  assigned: number
  completed: number
  failed: number
  cancelled: number
  totalDurationMs: number
}

/**
 * MetricsCollector - Thread-safe metrics collection for operational observability
 * 
 * Counters:
 * - messageWriteFailures: Failed message writes to agent inboxes
 * - messageDropped: Messages dropped due to full inboxes
 * - registrySaveFailures: Failed agent registry persistence operations
 * - agentSpawnFailures: Failed ACP agent process spawns
 * - agentTimeouts: Agent tasks that timed out
 * - taskCompleted: Successfully completed tasks
 * - taskFailed: Failed tasks
 */
export class MetricsCollector {
  private counters: Map<string, number> = new Map()
  private readonly lock = new Map<string, boolean>()

  constructor() {
    // Initialize all operational counters to 0
    this.counters.set('messageWriteFailures', 0)
    this.counters.set('messageDropped', 0)
    this.counters.set('registrySaveFailures', 0)
    this.counters.set('agentSpawnFailures', 0)
    this.counters.set('agentTimeouts', 0)
    this.counters.set('taskCompleted', 0)
    this.counters.set('taskFailed', 0)
  }

  /**
   * Increment a counter by 1 (or specified amount)
   * Thread-safe using simple locking mechanism
   */
  increment(counter: string, amount: number = 1): void {
    // Simple spin-lock for thread safety (defensive for single-threaded but safe)
    while (this.lock.get(counter)) {
      // Spin wait - in single-threaded Node.js this resolves immediately
    }
    
    this.lock.set(counter, true)
    try {
      const current = this.counters.get(counter) ?? 0
      this.counters.set(counter, current + amount)
    } finally {
      this.lock.set(counter, false)
    }
  }

  /**
   * Get the current value of a counter
   */
  get(counter: string): number {
    return this.counters.get(counter) ?? 0
  }

  /**
   * Get a snapshot of all metrics
   */
  getSnapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {}
    for (const [key, value] of this.counters) {
      snapshot[key] = value
    }
    return snapshot
  }

  /**
   * Reset all counters to 0
   */
  reset(): void {
    for (const key of this.counters.keys()) {
      this.counters.set(key, 0)
    }
  }

  /**
   * Reset a specific counter to 0
   */
  resetCounter(counter: string): void {
    this.counters.set(counter, 0)
  }
}

// Global metrics collector instance
export const operationalMetrics = new MetricsCollector()

interface AgentMetrics {
  assigned: number
  completed: number
  failed: number
  cancelled: number
  totalDurationMs: number
}

export const metrics = {
  startedAt: new Date().toISOString(),
  tasksAssigned: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  tasksCancelled: 0,
  totalDurationMs: 0,
  byAgent: new Map<string, AgentMetrics>(),
}

function getOrCreateAgentMetrics(agent: string): AgentMetrics {
  let m = metrics.byAgent.get(agent)
  if (!m) {
    m = { assigned: 0, completed: 0, failed: 0, cancelled: 0, totalDurationMs: 0 }
    metrics.byAgent.set(agent, m)
  }
  return m
}

export function recordTaskAssigned(agent: string): void {
  metrics.tasksAssigned++
  getOrCreateAgentMetrics(agent).assigned++
}

export function recordTaskCompleted(agent: string, durationMs: number): void {
  metrics.tasksCompleted++
  metrics.totalDurationMs += durationMs
  operationalMetrics.increment('taskCompleted')
  const m = getOrCreateAgentMetrics(agent)
  m.completed++
  m.totalDurationMs += durationMs
}

export function recordTaskFailed(agent: string, durationMs: number): void {
  metrics.tasksFailed++
  metrics.totalDurationMs += durationMs
  operationalMetrics.increment('taskFailed')
  const m = getOrCreateAgentMetrics(agent)
  m.failed++
  m.totalDurationMs += durationMs
}

export function recordTaskCancelled(agent: string): void {
  metrics.tasksCancelled++
  getOrCreateAgentMetrics(agent).cancelled++
}

export function getMetricsSummary(): Record<string, unknown> {
  const uptimeMs = Date.now() - new Date(metrics.startedAt).getTime()
  const avgDurationMs = metrics.tasksCompleted > 0
    ? Math.round(metrics.totalDurationMs / metrics.tasksCompleted)
    : 0

  const byAgent: Record<string, unknown> = {}
  for (const [name, m] of metrics.byAgent) {
    const total = m.completed + m.failed
    byAgent[name] = {
      assigned: m.assigned,
      completed: m.completed,
      failed: m.failed,
      cancelled: m.cancelled,
      successRate: total > 0 ? `${Math.round((m.completed / total) * 100)}%` : 'N/A',
      avgDurationMs: m.completed > 0 ? Math.round(m.totalDurationMs / m.completed) : 0,
    }
  }

  return {
    uptime: `${Math.round(uptimeMs / 1000)}s`,
    startedAt: metrics.startedAt,
    totals: {
      assigned: metrics.tasksAssigned,
      completed: metrics.tasksCompleted,
      failed: metrics.tasksFailed,
      cancelled: metrics.tasksCancelled,
    },
    avgDurationMs,
    byAgent,
    operational: operationalMetrics.getSnapshot(),
  }
}

export function startMetricsLogger(intervalMs: number = 5 * 60 * 1000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const summary = getMetricsSummary()
    logger.info(`[Metrics] ${JSON.stringify(summary)}`)
  }, intervalMs)
}
