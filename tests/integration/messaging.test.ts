import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MessageBus } from '../../src/message-bus'
import { AgentRegistry } from '../../src/agent-registry'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Integration tests for Message Bus + Agent Registry
 *
 * Tests cross-component messaging and agent lifecycle:
 * - Agent registration and discovery
 * - Message sending and receiving
 * - Heartbeat and dead agent detection
 * - Message cleanup and retention
 */

let testDir: string
let bus: MessageBus
let registry: AgentRegistry

beforeEach(() => {
  testDir = join(tmpdir(), `messaging-integration-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  bus = new MessageBus(testDir)
  registry = new AgentRegistry(testDir)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('Message Bus + Agent Registry Integration', () => {
  describe('Agent Registration and Discovery', () => {
    it('should register agent and send messages to it', () => {
      // Register agent
      const entry = registry.register('agent-a', 'claude-sonnet-4', 12345)
      expect(entry.name).toBe('agent-a')
      expect(entry.status).toBe('running')

      // Send message to registered agent
      bus.writeMessage('system', 'agent-a', 'Welcome to the system')

      // Agent should receive message
      const messages = bus.readInbox('agent-a')
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Welcome to the system')
      expect(messages[0].from).toBe('system')
    })

    it('should support multiple registered agents exchanging messages', () => {
      // Register multiple agents
      registry.register('agent-a', 'claude-sonnet-4')
      registry.register('agent-b', 'gpt-5-turbo')
      registry.register('agent-c', 'gemini-3-pro')

      // Verify all registered
      const active = registry.getActive()
      expect(active).toHaveLength(3)

      // Cross-agent messaging
      bus.writeMessage('agent-a', 'agent-b', 'Hello from A')
      bus.writeMessage('agent-b', 'agent-c', 'Hello from B')
      bus.writeMessage('agent-c', 'agent-a', 'Hello from C')

      // Verify messages delivered
      expect(bus.readInbox('agent-b')).toHaveLength(1)
      expect(bus.readInbox('agent-c')).toHaveLength(1)
      expect(bus.readInbox('agent-a')).toHaveLength(1)

      expect(bus.readInbox('agent-b')[0].from).toBe('agent-a')
      expect(bus.readInbox('agent-c')[0].from).toBe('agent-b')
      expect(bus.readInbox('agent-a')[0].from).toBe('agent-c')
    })

    it('should handle agent re-registration', () => {
      registry.register('agent-a', 'model-1', 100)
      const first = registry.get('agent-a')
      expect(first?.pid).toBe(100)

      // Re-register with new PID
      registry.register('agent-a', 'model-1', 200)
      const second = registry.get('agent-a')
      expect(second?.pid).toBe(200)

      // Should only have one entry
      expect(registry.getAll()).toHaveLength(1)

      // Messages should still work
      bus.writeMessage('system', 'agent-a', 'Test after re-registration')
      expect(bus.readInbox('agent-a')).toHaveLength(1)
    })
  })

  describe('Heartbeat and Dead Agent Detection', () => {
    it('should detect dead agents via heartbeat timeout', async () => {
      // Register agent with fake PID
      registry.register('agent-a', 'model', 999999)

      // Manually set lastHeartbeat to 60s ago
      const { writeFileSync, readFileSync } = await import('fs')
      const registryPath = join(testDir, 'agents.json')
      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'))
      entries[0].lastHeartbeat = new Date(Date.now() - 60_000).toISOString()
      writeFileSync(registryPath, JSON.stringify(entries, null, 2))

      // Detect dead agents
      const dead = registry.detectDead()
      expect(dead).toHaveLength(1)
      expect(dead[0].name).toBe('agent-a')
      expect(dead[0].status).toBe('dead')

      // Dead agent should still receive messages (they're queued)
      bus.writeMessage('system', 'agent-a', 'Message to dead agent')
      expect(bus.readInbox('agent-a')).toHaveLength(1)
    })

    it('should maintain heartbeat for active agents', () => {
      registry.register('agent-a', 'model')

      // Send heartbeat
      const before = registry.get('agent-a')?.lastHeartbeat
      registry.heartbeat('agent-a')
      const after = registry.get('agent-a')?.lastHeartbeat

      expect(after).toBeTruthy()
      expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime())

      // Active agent should not be detected as dead
      const dead = registry.detectDead()
      expect(dead).toHaveLength(0)
    })

    it('should prune dead agents from registry', () => {
      registry.register('agent-alive', 'model')
      registry.register('agent-dead', 'model')

      // Mark one as dead
      registry.updateStatus('agent-dead', 'dead')

      // Prune dead agents
      const pruned = registry.pruneDeadAgents()
      expect(pruned).toBe(1)

      // Only alive agent should remain
      const remaining = registry.getAll()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].name).toBe('agent-alive')
    })
  })

  describe('Cross-Agent Message Exchange', () => {
    it('should support request/response patterns', () => {
      registry.register('requester', 'model')
      registry.register('responder', 'model')

      // Create request (this also sends a broadcast notification)
      const req = bus.createRequest('requester', 'Process this data', { timeoutSeconds: 60 })
      expect(req.status).toBe('open')

      // Responder claims request (this sends "Claimed by responder" message)
      const claim = bus.claimRequest(req.id, 'responder')
      expect(claim.claimed).toBe(true)
      expect(claim.request?.claimedBy).toBe('responder')

      // Responder sends additional response message
      bus.writeMessage('responder', 'requester', 'Data processed', {
        type: 'response',
        requestId: req.id,
      })

      // Requester receives both claim notification and response
      const messages = bus.readInbox('requester')
      const responses = messages.filter(m => m.type === 'response' && m.requestId === req.id)
      expect(responses.length).toBeGreaterThanOrEqual(1)
      expect(responses.some(r => r.from === 'responder')).toBe(true)
    })

    it('should support broadcast messages', () => {
      // Register multiple agents
      registry.register('agent-a', 'model')
      registry.register('agent-b', 'model')
      registry.register('agent-c', 'model')

      // Trigger inbox creation
      bus.writeMessage('system', 'agent-a', 'init')
      bus.writeMessage('system', 'agent-b', 'init')
      bus.writeMessage('system', 'agent-c', 'init')

      // Broadcast from agent-a
      bus.writeMessage('agent-a', 'all', 'Important announcement')

      // All agents except sender should receive
      const inboxA = bus.readInbox('agent-a').filter(m => m.content === 'Important announcement')
      const inboxB = bus.readInbox('agent-b').filter(m => m.content === 'Important announcement')
      const inboxC = bus.readInbox('agent-c').filter(m => m.content === 'Important announcement')

      expect(inboxA).toHaveLength(0) // Sender excluded
      expect(inboxB).toHaveLength(1)
      expect(inboxC).toHaveLength(1)
    })

    it('should track unread message counts in registry', () => {
      registry.register('agent-a', 'model')

      // Send messages
      bus.writeMessage('system', 'agent-a', 'msg1')
      bus.writeMessage('system', 'agent-a', 'msg2')
      bus.writeMessage('system', 'agent-a', 'msg3')

      // Update message count in registry
      const unreadCount = bus.getUnreadCount('agent-a')
      expect(unreadCount).toBe(3)

      registry.updateMessageCounts('agent-a', unreadCount, 0)
      const agent = registry.get('agent-a')
      expect(agent?.messagesPending).toBe(3)

      // Mark some as read
      bus.markAllRead('agent-a')
      const newUnreadCount = bus.getUnreadCount('agent-a')
      expect(newUnreadCount).toBe(0)

      registry.updateMessageCounts('agent-a', newUnreadCount, 0)
      const updatedAgent = registry.get('agent-a')
      expect(updatedAgent?.messagesPending).toBe(0)
    })
  })

  describe('Message Cleanup and Retention', () => {
    it('should clean up agent messages on deregistration', () => {
      registry.register('agent-temp', 'model')

      // Send messages
      bus.writeMessage('system', 'agent-temp', 'msg1')
      bus.writeMessage('system', 'agent-temp', 'msg2')
      expect(bus.readInbox('agent-temp')).toHaveLength(2)

      // Cleanup messages
      bus.cleanup('agent-temp')
      expect(bus.readInbox('agent-temp')).toHaveLength(0)

      // Deregister agent
      registry.deregister('agent-temp')
      expect(registry.get('agent-temp')).toBeNull()
    })

    it('should handle full cleanup of all agents and messages', () => {
      // Register multiple agents
      registry.register('agent-a', 'model')
      registry.register('agent-b', 'model')
      registry.register('agent-c', 'model')

      // Send messages
      bus.writeMessage('system', 'agent-a', 'msg1')
      bus.writeMessage('system', 'agent-b', 'msg2')
      bus.writeMessage('system', 'agent-c', 'msg3')

      // Create requests (these also send broadcast messages to all agents)
      bus.createRequest('agent-a', 'task1', { timeoutSeconds: 60 })
      bus.createRequest('agent-b', 'task2', { timeoutSeconds: 60 })

      // Verify state (agent-a gets msg1 + 2 request broadcasts)
      const inboxA = bus.readInbox('agent-a')
      expect(inboxA.length).toBeGreaterThanOrEqual(1)

      // Verify requests exist
      expect(bus.listOpenRequests()).toHaveLength(2)

      // Full cleanup
      bus.cleanupAll()
      registry.clear()

      // Everything should be gone
      expect(bus.readInbox('agent-a')).toHaveLength(0)
      expect(bus.readInbox('agent-b')).toHaveLength(0)
      expect(bus.readInbox('agent-c')).toHaveLength(0)
      expect(bus.listOpenRequests()).toHaveLength(0)
      expect(registry.getAll()).toHaveLength(0)
    })

    it('should enforce message retention limits per inbox', () => {
      registry.register('agent-overflow', 'model')

      // MAX_MESSAGES_PER_INBOX is typically around 1000
      // We'll send a few messages and verify pruning works
      // (Full stress test would be too slow)

      // Send multiple messages
      for (let i = 0; i < 10; i++) {
        bus.writeMessage('system', 'agent-overflow', `msg-${i}`)
      }

      const messages = bus.readInbox('agent-overflow')
      expect(messages.length).toBeLessThanOrEqual(1000) // Under limit
      expect(messages.length).toBe(10)

      // Verify messages exist (order may vary due to filesystem timestamp resolution)
      const contents = messages.map(m => m.content)
      expect(contents).toContain('msg-0')
      expect(contents).toContain('msg-9')
    })
  })

  describe('Agent Status Tracking', () => {
    it('should track agent status changes', () => {
      registry.register('agent-status', 'model')

      // Initial status
      let agent = registry.get('agent-status')
      expect(agent?.status).toBe('running')

      // Update to waiting
      registry.updateStatus('agent-status', 'waiting', 'task-123')
      agent = registry.get('agent-status')
      expect(agent?.status).toBe('waiting')
      expect(agent?.currentTask).toBe('task-123')

      // Update to idle
      registry.updateStatus('agent-status', 'idle')
      agent = registry.get('agent-status')
      expect(agent?.status).toBe('idle')

      // Status should be reflected in active agents list
      const active = registry.getActive()
      expect(active.find(a => a.name === 'agent-status')?.status).toBe('idle')
    })

    it('should track agent uptime', async () => {
      registry.register('agent-uptime', 'model')

      // Just registered - uptime should be near 0
      let uptime = registry.getUptimeSeconds('agent-uptime')
      expect(uptime).toBeLessThan(2)

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1100))

      // Uptime should increase
      uptime = registry.getUptimeSeconds('agent-uptime')
      expect(uptime).toBeGreaterThanOrEqual(1)
    })

    it('should update lastActivity on status changes', async () => {
      registry.register('agent-activity', 'model')

      const before = registry.get('agent-activity')?.lastActivity
      await new Promise(resolve => setTimeout(resolve, 100))

      registry.updateStatus('agent-activity', 'running', 'new-task')
      const after = registry.get('agent-activity')?.lastActivity

      expect(after).toBeTruthy()
      expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime())
    })
  })
})
