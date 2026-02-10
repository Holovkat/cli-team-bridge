import { execFileSync } from 'child_process'
import { z } from 'zod'
import { logger } from './logger'

const ModelConfigSchema = z.object({
  flag: z.string(),
  value: z.string(),
  keyEnv: z.string().optional(),
  provider: z.string().optional(),
})

const AgentConfigSchema = z.object({
  type: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  defaultModel: z.string(),
  models: z.record(z.string(), ModelConfigSchema),
  strengths: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  fallbackAgent: z.string().optional(),
})

const BridgeConfigSchema = z.object({
  workspaceRoot: z.string(),
  agents: z.record(z.string(), AgentConfigSchema),
  /** Currently unused — reserved for future manual-approval workflow */
  permissions: z.object({ autoApprove: z.boolean() }),
  polling: z.object({ intervalMs: z.number().min(500).max(60000) }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    file: z.string().optional(),
  }),
  messaging: z.object({
    enabled: z.boolean().default(true),
    failSilently: z.boolean().default(true),
  }).default({ enabled: true, failSilently: true }),
  viewer: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['tail-logs', 'mirror-stream']).default('tail-logs'),
    interactive: z.boolean().default(false), // Reserved for future use
  }).default({ enabled: false, mode: 'tail-logs', interactive: false }),
})

/**
 * Model configuration for an agent.
 * `keyEnv` is used at runtime to pass API keys.
 * `flag`, `value`, `provider` are metadata used by config tooling and reserved for non-ACP agent types.
 */
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
  fallbackAgent?: string
}

export interface BridgeConfig {
  workspaceRoot: string
  agents: Record<string, AgentConfig>
  /** Currently unused — reserved for future manual-approval workflow */
  permissions: { autoApprove: boolean }
  polling: { intervalMs: number }
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; file?: string }
  messaging: { enabled: boolean; failSilently: boolean }
  viewer: { enabled: boolean; mode: 'tail-logs' | 'mirror-stream'; interactive: boolean }
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`)
  }

  const raw = await file.json()
  const config = BridgeConfigSchema.parse(raw) as BridgeConfig

  if (!config.agents || Object.keys(config.agents).length === 0) {
    throw new Error('Config must define at least one agent')
  }

  const ALLOWED_COMMANDS = new Set([
    'codex-acp', 'claude-code-acp', 'droid-acp',
    'gemini', 'qwen',
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
    .filter(([, m]) => m.keyEnv && !!process.env[m.keyEnv])
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
