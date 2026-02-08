import { describe, it, expect, beforeAll } from 'bun:test'
import { loadConfig, isAgentAvailable, getAvailableModels } from '../../src/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `config-test-${Date.now()}`)

const validConfig = {
  workspaceRoot: '/tmp/test-workspace',
  agents: {
    'test-agent': {
      type: 'acp',
      command: 'codex-acp',
      args: ['--acp'],
      cwd: '/tmp',
      defaultModel: 'test-model',
      models: { 'test-model': { flag: '--model', value: 'test' } },
      strengths: ['testing'],
    },
  },
  permissions: { autoApprove: false },
  polling: { intervalMs: 1000 },
  logging: { level: 'info' },
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true })
})

describe('loadConfig', () => {
  it('should load valid config file', async () => {
    const configPath = join(testDir, 'valid.json')
    writeFileSync(configPath, JSON.stringify(validConfig))
    const config = await loadConfig(configPath)
    expect(config.workspaceRoot).toBe('/tmp/test-workspace')
    expect(Object.keys(config.agents)).toContain('test-agent')
  })

  it('should throw on missing config file', async () => {
    await expect(loadConfig(join(testDir, 'missing.json'))).rejects.toThrow('Config file not found')
  })

  it('should throw when no agents defined', async () => {
    const configPath = join(testDir, 'no-agents.json')
    writeFileSync(configPath, JSON.stringify({ ...validConfig, agents: {} }))
    await expect(loadConfig(configPath)).rejects.toThrow()
  })

  it('should throw when defaultModel not in models', async () => {
    const configPath = join(testDir, 'bad-model.json')
    const badConfig = JSON.parse(JSON.stringify(validConfig))
    badConfig.agents['test-agent'].defaultModel = 'nonexistent'
    writeFileSync(configPath, JSON.stringify(badConfig))
    await expect(loadConfig(configPath)).rejects.toThrow('not in models')
  })

  it('should reject config with unknown command', async () => {
    const configPath = join(testDir, 'bad-cmd.json')
    const badConfig = JSON.parse(JSON.stringify(validConfig))
    badConfig.agents['test-agent'].command = 'evil-binary'
    writeFileSync(configPath, JSON.stringify(badConfig))
    await expect(loadConfig(configPath)).rejects.toThrow('not in allowlist')
  })
})

describe('getAvailableModels', () => {
  it('should return all models for ACP agents', () => {
    const agent = validConfig.agents['test-agent'] as any
    const models = getAvailableModels(agent)
    expect(models).toContain('test-model')
  })
})

describe('isAgentAvailable', () => {
  it('should return false for unavailable binary', () => {
    const agent = { ...validConfig.agents['test-agent'], command: 'nonexistent-binary-xyz' } as any
    expect(isAgentAvailable(agent)).toBe(false)
  })
})
