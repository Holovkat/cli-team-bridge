import { type AgentConfig } from './config'
import { type AcpSpawnConfig } from './acp-client'
import { logger } from './logger'

/**
 * Build an AcpSpawnConfig for a given agent.
 *
 * Each agent uses its ACP adapter binary (claude-code-acp, codex-acp, droid-acp).
 * Model selection happens via ACP's setSessionModel() after session creation,
 * not via CLI flags.
 */
export function buildSpawnConfig(
  agentName: string,
  agent: AgentConfig,
): AcpSpawnConfig {
  logger.debug(`Building spawn config for agent: ${agentName}`)
  // Build env: pass through required API keys
  const env: Record<string, string> = {}

  // Pass model-related API keys (if configured — ACP/OAuth adapters typically don't need them)
  for (const [, model] of Object.entries(agent.models)) {
    if (model.keyEnv && process.env[model.keyEnv]) {
      env[model.keyEnv] = process.env[model.keyEnv]!
    }
  }

  // Pass through agent-specific env
  if (agent.env) {
    for (const [key, val] of Object.entries(agent.env)) {
      env[key] = val
    }
  }

  return {
    command: agent.command,
    args: [...agent.args],
    cwd: agent.cwd,
    env,
  }
}
