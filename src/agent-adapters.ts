import { type AgentConfig, type ModelConfig } from './config'
import { type SpawnConfig } from './acp-client'

/**
 * Build a SpawnConfig for a given agent, optionally overriding the model.
 *
 * NOTE: The exact CLI flags and ACP invocation patterns will be updated
 * after Phase 2 verification. Current flags are based on plan assumptions.
 */
export function buildSpawnConfig(
  agentName: string,
  agent: AgentConfig,
  modelOverride?: string,
): SpawnConfig {
  const modelName = modelOverride ?? agent.defaultModel
  const model: ModelConfig | undefined = agent.models[modelName]

  if (!model) {
    throw new Error(`Agent "${agentName}" has no model "${modelName}"`)
  }

  // Check API key availability
  if (!process.env[model.keyEnv]) {
    throw new Error(`Agent "${agentName}" model "${modelName}" requires env var ${model.keyEnv}`)
  }

  // Build args: base args + model flag
  const args = [...agent.args, model.flag, model.value]

  // Build env: only pass what's needed
  const env: Record<string, string> = {}
  if (process.env[model.keyEnv]) {
    env[model.keyEnv] = process.env[model.keyEnv]!
  }

  // Pass through agent-specific env
  if (agent.env) {
    for (const [key, val] of Object.entries(agent.env)) {
      env[key] = val
    }
  }

  // Ollama needs OLLAMA_HOST
  if (model.provider === 'ollama' && process.env['OLLAMA_HOST']) {
    env['OLLAMA_HOST'] = process.env['OLLAMA_HOST']!
  }

  return {
    command: agent.command,
    args,
    cwd: agent.cwd,
    env,
  }
}
