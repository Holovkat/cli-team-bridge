import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AgentRegistry } from '../../src/agent-registry'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDir: string
let registry: AgentRegistry

beforeEach(() => {
  testDir = join(tmpdir(), `registry-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  registry = new AgentRegistry(testDir)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('AgentRegistry', () => {
  describe('register / deregister', () => {
    it('should register an agent', () => {
      const entry = registry.register('codex', 'gpt-5.3-codex', 12345)
      expect(entry.name).toBe('codex')
      expect(entry.status).toBe('running')
      expect(entry.model).toBe('gpt-5.3-codex')
      expect(entry.pid).toBe(12345)
    })

    it('should re-register replaces existing entry', () => {
      registry.register('codex', 'gpt-5.3-codex', 100)
      registry.register('codex', 'gpt-5.3-codex', 200)
      const all = registry.getAll()
      expect(all).toHaveLength(1)
      expect(all[0].pid).toBe(200)
    })

    it('should deregister an agent', () => {
      registry.register('codex', 'gpt-5.3-codex')
      const removed = registry.deregister('codex')
      expect(removed).toBe(true)
      expect(registry.getAll()).toHaveLength(0)
    })

    it('should return false when deregistering non-existent agent', () => {
      expect(registry.deregister('nonexistent')).toBe(false)
    })
  })

  describe('getActive / getAll / get', () => {
    it('should return only active agents', () => {
      registry.register('codex', 'gpt-5.3-codex')
      registry.register('gemini', 'gemini-3-pro')
      registry.register('dead-agent', 'model')
      registry.updateStatus('dead-agent', 'dead')

      const active = registry.getActive()
      expect(active).toHaveLength(2)
      expect(active.map(a => a.name).sort()).toEqual(['codex', 'gemini'])
    })

    it('should get a specific agent', () => {
      registry.register('codex', 'gpt-5.3-codex')
      const agent = registry.get('codex')
      expect(agent).not.toBeNull()
      expect(agent?.name).toBe('codex')
    })

    it('should return null for non-existent agent', () => {
      expect(registry.get('nonexistent')).toBeNull()
    })
  })

  describe('updateStatus', () => {
    it('should update agent status', () => {
      registry.register('codex', 'gpt-5.3-codex')
      registry.updateStatus('codex', 'waiting', 'task-123')
      const agent = registry.get('codex')
      expect(agent?.status).toBe('waiting')
      expect(agent?.currentTask).toBe('task-123')
    })

    it('should return false for non-existent agent', () => {
      expect(registry.updateStatus('nonexistent', 'idle')).toBe(false)
    })
  })

  describe('heartbeat', () => {
    it('should update lastHeartbeat', () => {
      registry.register('codex', 'gpt-5.3-codex')
      const before = registry.get('codex')?.lastHeartbeat

      // Small delay to ensure timestamp changes
      const result = registry.heartbeat('codex')
      expect(result).toBe(true)

      const after = registry.get('codex')?.lastHeartbeat
      expect(after).toBeTruthy()
      expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime())
    })
  })

  describe('detectDead', () => {
    it('should detect agents with no recent heartbeat and dead process', () => {
      // Register with a fake PID that doesn't exist
      registry.register('dead-agent', 'model', 999999)

      // Manually set lastHeartbeat to 60s ago
      const entries = registry.getAll()
      entries[0].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      // Write back
      const { writeFileSync } = require('fs')
      writeFileSync(join(testDir, 'agents.json'), JSON.stringify(entries, null, 2))

      const dead = registry.detectDead()
      expect(dead).toHaveLength(1)
      expect(dead[0].name).toBe('dead-agent')
      expect(dead[0].status).toBe('dead')
    })
  })

  describe('pruneDeadAgents', () => {
    it('should remove dead agents from registry', () => {
      registry.register('alive', 'model')
      registry.register('dead', 'model')
      registry.updateStatus('dead', 'dead')

      const pruned = registry.pruneDeadAgents()
      expect(pruned).toBe(1)
      expect(registry.getAll()).toHaveLength(1)
      expect(registry.getAll()[0].name).toBe('alive')
    })
  })

  describe('clear', () => {
    it('should clear all agents', () => {
      registry.register('a', 'model')
      registry.register('b', 'model')
      registry.clear()
      expect(registry.getAll()).toHaveLength(0)
    })
  })

  describe('getUptimeSeconds', () => {
    it('should return uptime for registered agent', () => {
      registry.register('codex', 'model')
      const uptime = registry.getUptimeSeconds('codex')
      expect(uptime).toBeGreaterThanOrEqual(0)
      expect(uptime).toBeLessThan(5) // Just registered
    })

    it('should return 0 for non-existent agent', () => {
      expect(registry.getUptimeSeconds('nonexistent')).toBe(0)
    })
  })
})
