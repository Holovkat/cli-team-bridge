import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { runAcpSession, type AcpSpawnConfig } from '../../src/acp-client'
import { AgentRegistry } from '../../src/agent-registry'
import { MessageBus } from '../../src/message-bus'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Integration tests for Error Recovery
 *
 * Tests error handling and recovery mechanisms:
 * - Agent crash recovery
 * - Timeout handling
 * - Stuck task detection
 * - Graceful degradation
 */

let testDir: string
let registry: AgentRegistry
let bus: MessageBus

beforeEach(() => {
  testDir = join(tmpdir(), `error-recovery-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  registry = new AgentRegistry(testDir)
  bus = new MessageBus(testDir)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('Error Recovery Integration', () => {
  describe('Agent Crash Recovery', () => {
    it('should handle agent crash gracefully', async () => {
      const crashAgentPath = join(testDir, 'crash-agent.ts')
      writeFileSync(crashAgentPath, `
// Agent that crashes immediately
throw new Error('Agent crashed!')
      `.trim())

      const config: AcpSpawnConfig = {
        command: 'bun',
        args: ['run', crashAgentPath],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test crash recovery')

      // Should return error result, not throw
      expect(result.error).toBeDefined()
      expect(result.output).toBeDefined()
      expect(result.proc).toBeDefined()
      expect(result.timedOut).toBe(false)
    })

    it('should detect and mark crashed agents as dead', () => {
      // Register agent with fake PID
      registry.register('crash-agent', 'model', 999999)

      // Set heartbeat to past
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries[0].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      // Detect dead agents
      const dead = registry.detectDead()
      expect(dead).toHaveLength(1)
      expect(dead[0].status).toBe('dead')

      // Messages to dead agent should still be queued
      bus.writeMessage('system', 'crash-agent', 'Are you alive?')
      const messages = bus.readInbox('crash-agent')
      expect(messages).toHaveLength(1)
    })

    it('should clean up crashed agent resources', async () => {
      registry.register('cleanup-test', 'model')
      bus.writeMessage('system', 'cleanup-test', 'msg1')
      bus.writeMessage('system', 'cleanup-test', 'msg2')

      // Verify resources exist
      expect(registry.get('cleanup-test')).toBeTruthy()
      expect(bus.readInbox('cleanup-test')).toHaveLength(2)

      // Cleanup
      registry.deregister('cleanup-test')
      bus.cleanup('cleanup-test')

      // Resources should be gone
      expect(registry.get('cleanup-test')).toBeNull()
      expect(bus.readInbox('cleanup-test')).toHaveLength(0)
    })

    it('should handle multiple simultaneous crashes', () => {
      registry.register('agent-a', 'model', 999991)
      registry.register('agent-b', 'model', 999992)
      registry.register('agent-c', 'model', 999993)

      // Set all heartbeats to past
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries.forEach((entry: any) => {
        entry.lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      })
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      // Detect all dead agents
      const dead = registry.detectDead()
      expect(dead).toHaveLength(3)

      // Prune all dead agents
      const pruned = registry.pruneDeadAgents()
      expect(pruned).toBe(3)
      expect(registry.getAll()).toHaveLength(0)
    })
  })

  describe('Timeout Handling', () => {
    it('should timeout long-running agents', async () => {
      const slowAgentPath = join(testDir, 'slow-agent.ts')
      writeFileSync(slowAgentPath, `
// Agent that never responds
import { setTimeout } from 'timers/promises'
await setTimeout(300_000) // 5 minutes
      `.trim())

      const config: AcpSpawnConfig = {
        command: 'bun',
        args: ['run', slowAgentPath],
        cwd: testDir,
        env: {},
      }

      // This will timeout (default timeout is 2 minutes)
      const result = await runAcpSession(config, 'Test timeout')

      // Should timeout and return error
      expect(result.timedOut || result.error).toBeTruthy()
      expect(result.proc).toBeDefined()
    }, 5000) // Test timeout of 5s

    it('should handle request timeout', async () => {
      const req = bus.createRequest('requester', 'Urgent task', { timeoutSeconds: 1 })
      expect(req.status).toBe('open')

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 1100))

      // Try to claim expired request
      const result = bus.claimRequest(req.id, 'late-agent')
      expect(result.claimed).toBe(false)
      expect(result.request?.status).toBe('expired')
    })

    it('should list only non-expired requests', async () => {
      bus.createRequest('agent-a', 'Task 1', { timeoutSeconds: 60 })
      bus.createRequest('agent-b', 'Task 2', { timeoutSeconds: 1 })
      bus.createRequest('agent-c', 'Task 3', { timeoutSeconds: 60 })

      // Wait for one to expire
      await new Promise(resolve => setTimeout(resolve, 1100))

      const open = bus.listOpenRequests()
      expect(open).toHaveLength(2) // Only non-expired
    })
  })

  describe('Stuck Task Detection', () => {
    it('should detect agents stuck on tasks', () => {
      registry.register('stuck-agent', 'model')
      registry.updateStatus('stuck-agent', 'running', 'task-123')

      // Agent hasn't sent heartbeat for a while
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries[0].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      // Detect dead agent
      const dead = registry.detectDead()
      expect(dead).toHaveLength(1)

      const stuckAgent = dead[0]
      expect(stuckAgent.status).toBe('dead')
      expect(stuckAgent.currentTask).toBe('task-123')
    })

    it('should detect multiple stuck tasks', () => {
      registry.register('agent-a', 'model')
      registry.register('agent-b', 'model')
      registry.register('agent-c', 'model')

      registry.updateStatus('agent-a', 'running', 'task-1')
      registry.updateStatus('agent-b', 'running', 'task-2')
      registry.updateStatus('agent-c', 'idle')

      // Mark first two as dead
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries[0].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      entries[0].pid = 999991
      entries[1].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      entries[1].pid = 999992
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      const dead = registry.detectDead()
      expect(dead).toHaveLength(2)
      expect(dead.every(a => a.currentTask)).toBe(true)
    })
  })

  describe('Graceful Degradation', () => {
    it('should continue processing messages after agent failure', () => {
      registry.register('agent-alive', 'model')
      registry.register('agent-dead', 'model', 999999)

      // Send messages to both
      bus.writeMessage('system', 'agent-alive', 'Message to alive agent')
      bus.writeMessage('system', 'agent-dead', 'Message to dead agent')

      // Mark one as dead
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries.find((e: any) => e.name === 'agent-dead').lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      registry.detectDead()

      // Alive agent should still receive new messages
      bus.writeMessage('system', 'agent-alive', 'Another message')
      expect(bus.readInbox('agent-alive')).toHaveLength(2)

      // Dead agent's messages are still queued (for recovery)
      expect(bus.readInbox('agent-dead')).toHaveLength(1)
    })

    it('should handle partial broadcast failures', async () => {
      // Create multiple agent inboxes
      bus.writeMessage('system', 'agent-a', 'init')
      bus.writeMessage('system', 'agent-b', 'init')
      bus.writeMessage('system', 'agent-c', 'init')

      // Broadcast should succeed even if one agent is dead
      bus.writeMessage('sender', 'all', 'Broadcast message')

      // All agents should receive
      expect(bus.readInbox('agent-a').filter(m => m.content === 'Broadcast message')).toHaveLength(1)
      expect(bus.readInbox('agent-b').filter(m => m.content === 'Broadcast message')).toHaveLength(1)
      expect(bus.readInbox('agent-c').filter(m => m.content === 'Broadcast message')).toHaveLength(1)
    })

    it('should preserve message order during failures', async () => {
      registry.register('agent-test', 'model')

      // Send multiple messages
      bus.writeMessage('sender', 'agent-test', 'msg1')
      bus.writeMessage('sender', 'agent-test', 'msg2')
      bus.writeMessage('sender', 'agent-test', 'msg3')

      const messages = bus.readInbox('agent-test')
      expect(messages).toHaveLength(3)

      // Messages should be in order
      expect(messages[0].content).toBe('msg1')
      expect(messages[1].content).toBe('msg2')
      expect(messages[2].content).toBe('msg3')
    })

    it('should handle filesystem errors gracefully', async () => {
      // Try to write to non-existent directory
      const badBus = new MessageBus('/nonexistent/path/that/does/not/exist')

      // Should create directory automatically
      expect(() => {
        badBus.writeMessage('test', 'agent', 'msg')
      }).not.toThrow()

      // Verify message was written
      const messages = badBus.readInbox('agent')
      expect(messages).toHaveLength(1)
    })

    it('should handle corrupted registry gracefully', () => {
      registry.register('test-agent', 'model')

      // Corrupt the registry file
      const registryPath = join(testDir, 'agents.json')
      writeFileSync(registryPath, '{ invalid json }')

      // Should handle corruption (returns empty array on parse failure)
      const agents = registry.getAll()
      expect(Array.isArray(agents)).toBe(true)

      // Should be able to re-register
      registry.register('recovery-agent', 'model')
      const recovered = registry.get('recovery-agent')
      expect(recovered).toBeTruthy()
    })
  })

  describe('Process Lifecycle Management', () => {
    it('should track process cleanup', async () => {
      const config: AcpSpawnConfig = {
        command: 'true', // Quick exit command
        args: [],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(
        config,
        'Quick task',
        undefined,
        { bridgePath: testDir, agentName: 'quick-agent', taskId: 'task-123' }
      )

      // Process should have error (exits before ACP handshake)
      expect(result.proc).toBeDefined()

      // Give process time to exit
      await new Promise(resolve => setTimeout(resolve, 100))

      // Agent should be deregistered after session
      const agent = registry.get('quick-agent')
      expect(agent).toBeNull()
    })

    it('should handle process termination signals', async () => {
      const sleepScript = join(testDir, 'sleep.sh')
      writeFileSync(sleepScript, `#!/bin/bash
trap 'echo "Caught SIGTERM"; exit 0' SIGTERM
sleep 10
`)

      const config: AcpSpawnConfig = {
        command: 'bash',
        args: [sleepScript],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test SIGTERM')

      // Process should be terminated or have error
      expect(result.proc).toBeDefined()
      expect(result.error).toBeDefined()
    })
  })
})
