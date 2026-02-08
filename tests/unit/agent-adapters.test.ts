import { describe, it, expect } from 'bun:test'
import { buildSpawnConfig } from '../../src/agent-adapters'
import type { AgentConfig } from '../../src/config'

const testAgent: AgentConfig = {
  type: 'acp',
  command: 'codex-acp',
  args: ['--acp'],
  cwd: '/tmp/test',
  defaultModel: 'test-model',
  models: {
    'test-model': { flag: '--model', value: 'test', keyEnv: 'TEST_API_KEY' },
  },
  strengths: ['testing'],
  env: { CUSTOM_VAR: 'custom-value' },
}

describe('buildSpawnConfig', () => {
  it('should build spawn config with correct command and args', () => {
    const config = buildSpawnConfig('test-agent', testAgent)
    expect(config.command).toBe('codex-acp')
    expect(config.args).toEqual(['--acp'])
    expect(config.cwd).toBe('/tmp/test')
  })

  it('should pass through agent-specific env vars', () => {
    const config = buildSpawnConfig('test-agent', testAgent)
    expect(config.env['CUSTOM_VAR']).toBe('custom-value')
  })

  it('should pass model-specific keyEnv when set', () => {
    process.env['TEST_API_KEY'] = 'test-key-value'
    const config = buildSpawnConfig('test-agent', testAgent)
    expect(config.env['TEST_API_KEY']).toBe('test-key-value')
    delete process.env['TEST_API_KEY']
  })

  it('should not include unset env vars', () => {
    delete process.env['TEST_API_KEY']
    const config = buildSpawnConfig('test-agent', testAgent)
    expect(config.env['TEST_API_KEY']).toBeUndefined()
  })
})
