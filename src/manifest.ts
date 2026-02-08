import { join } from 'path'
import { type BridgeConfig, getAvailableModels, isAgentAvailable } from './config'
import { logger } from './logger'

interface AgentManifest {
  status: 'available' | 'unavailable'
  reason?: string
  defaultModel: string
  availableModels: string[]
  strengths: string[]
}

interface BridgeManifest {
  bridge: string
  version: string
  generatedAt: string
  agents: Record<string, AgentManifest>
  taskFormat: {
    ownerField: string
    modelField: string
    example: Record<string, unknown>
  }
}

export async function generateManifest(config: BridgeConfig, taskDir: string): Promise<void> {
  const agents: Record<string, AgentManifest> = {}

  for (const [name, agent] of Object.entries(config.agents)) {
    const available = isAgentAvailable(agent)
    const availableModels = getAvailableModels(agent)

    agents[name] = {
      status: available ? 'available' : 'unavailable',
      ...(available ? {} : { reason: `No API keys set for any model` }),
      defaultModel: agent.defaultModel,
      availableModels,
      strengths: agent.strengths,
    }
  }

  const manifest: BridgeManifest = {
    bridge: 'cli-team-bridge',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    agents,
    taskFormat: {
      ownerField: "Use agent name as 'owner' value",
      modelField: "Optional 'model' in task metadata to override default",
      example: { owner: 'droid', metadata: { model: 'kimi-k2' } },
    },
  }

  const manifestPath = join(taskDir, 'bridge-manifest.json')
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
  logger.info(`Manifest written to ${manifestPath}`)
}
