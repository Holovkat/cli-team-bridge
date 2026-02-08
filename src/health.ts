import { logger } from './logger'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

interface AgentHealth {
  lastChecked: string
  lastHealthy: string | null
  consecutiveFailures: number
  status: HealthStatus
}

const agentHealthMap = new Map<string, AgentHealth>()

const DEGRADED_THRESHOLD = 2
const UNHEALTHY_THRESHOLD = 5

export function getAgentHealth(agentName: string): AgentHealth {
  return agentHealthMap.get(agentName) ?? {
    lastChecked: new Date().toISOString(),
    lastHealthy: null,
    consecutiveFailures: 0,
    status: 'healthy',
  }
}

export function recordAgentSuccess(agentName: string): void {
  const now = new Date().toISOString()
  agentHealthMap.set(agentName, {
    lastChecked: now,
    lastHealthy: now,
    consecutiveFailures: 0,
    status: 'healthy',
  })
}

export function recordAgentFailure(agentName: string): void {
  const existing = getAgentHealth(agentName)
  const failures = existing.consecutiveFailures + 1
  let status: HealthStatus = 'healthy'
  if (failures >= UNHEALTHY_THRESHOLD) status = 'unhealthy'
  else if (failures >= DEGRADED_THRESHOLD) status = 'degraded'

  agentHealthMap.set(agentName, {
    lastChecked: new Date().toISOString(),
    lastHealthy: existing.lastHealthy,
    consecutiveFailures: failures,
    status,
  })

  if (status === 'unhealthy') {
    logger.warn(`Agent "${agentName}" marked unhealthy after ${failures} consecutive failures`)
  }
}

export function isAgentHealthy(agentName: string): boolean {
  const health = getAgentHealth(agentName)
  return health.status !== 'unhealthy'
}

export function getAllAgentHealth(): Record<string, AgentHealth> {
  const result: Record<string, AgentHealth> = {}
  for (const [name, health] of agentHealthMap) {
    result[name] = health
  }
  return result
}
