import { execFileSync } from 'child_process'
import { logger } from './logger'

export interface ModelConfig {
  flag: string
  value: string
  keyEnv?: string
  provider?: string
}

export interface AgentConfig {
  type: string
  command: string
  args: string[]
  cwd: string
  defaultModel: string
  models: Record<string, ModelConfig>
  strengths: string[]
  env?: Record<string, string>
}

export interface BridgeConfig {
  workspaceRoot: string
  agents: Record<string, AgentConfig>
  permissions: { autoApprove: boolean }
  polling: { intervalMs: number }
  logging: { level: string; file?: string }
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`)
  }

  const config: BridgeConfig = await file.json()

  if (!config.agents || Object.keys(config.agents).length === 0) {
    throw new Error('Config must define at least one agent')
  }

  const ALLOWED_COMMANDS = new Set([
    'codex-acp', 'claude-code-acp', 'droid-acp',
  ])

  // Validate each agent and check env vars
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.command) throw new Error(`Agent "${name}" missing command`)
    if (!ALLOWED_COMMANDS.has(agent.command)) {
      throw new Error(`Agent "${name}" command "${agent.command}" not in allowlist: ${[...ALLOWED_COMMANDS].join(', ')}`)
    }
    if (!agent.defaultModel) throw new Error(`Agent "${name}" missing defaultModel`)

    if (!agent.models[agent.defaultModel]) {
      throw new Error(`Agent "${name}" defaultModel "${agent.defaultModel}" not in models`)
    }

    // Only warn about missing env vars for non-ACP agents (ACP adapters use their own OAuth)
    if (agent.type !== 'acp') {
      for (const [modelName, model] of Object.entries(agent.models)) {
        if (model.keyEnv && !process.env[model.keyEnv]) {
          logger.warn(`Agent "${name}" model "${modelName}" — env var ${model.keyEnv} not set`)
        }
      }
    }
  }

  return config
}

export function getAvailableModels(agent: AgentConfig): string[] {
  // For ACP adapters, models are available if the adapter binary exists
  // (adapters use stored auth, not necessarily env vars)
  if (agent.type === 'acp') {
    return Object.keys(agent.models)
  }
  return Object.entries(agent.models)
    .filter(([_, m]) => m.keyEnv && !!process.env[m.keyEnv])
    .map(([name]) => name)
}

export function isAgentAvailable(agent: AgentConfig): boolean {
  if (agent.type === 'acp') {
    try {
      execFileSync('which', [agent.command], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  return getAvailableModels(agent).length > 0
}
