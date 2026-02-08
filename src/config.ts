import { logger } from './logger'

export interface ModelConfig {
  flag: string
  value: string
  keyEnv: string
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

  // Validate each agent and check env vars
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.command) throw new Error(`Agent "${name}" missing command`)
    if (!agent.defaultModel) throw new Error(`Agent "${name}" missing defaultModel`)

    if (!agent.models[agent.defaultModel]) {
      throw new Error(`Agent "${name}" defaultModel "${agent.defaultModel}" not in models`)
    }

    for (const [modelName, model] of Object.entries(agent.models)) {
      if (!process.env[model.keyEnv]) {
        logger.warn(`Agent "${name}" model "${modelName}" — env var ${model.keyEnv} not set`)
      }
    }
  }

  return config
}

export function getAvailableModels(agent: AgentConfig): string[] {
  return Object.entries(agent.models)
    .filter(([_, m]) => !!process.env[m.keyEnv])
    .map(([name]) => name)
}

export function isAgentAvailable(agent: AgentConfig): boolean {
  return getAvailableModels(agent).length > 0
}
