import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MessageBus } from '../../src/message-bus'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDir: string
let bus: MessageBus

beforeEach(() => {
  testDir = join(tmpdir(), `msgbus-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  bus = new MessageBus(testDir)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('MessageBus', () => {
  describe('writeMessage / readInbox', () => {
    it('should write and read a direct message', () => {
      bus.writeMessage('agent-a', 'agent-b', 'Hello from A')
      const messages = bus.readInbox('agent-b')
      expect(messages).toHaveLength(1)
      expect(messages[0].from).toBe('agent-a')
      expect(messages[0].to).toBe('agent-b')
      expect(messages[0].content).toBe('Hello from A')
      expect(messages[0].type).toBe('message')
      expect(messages[0].read).toBe(false)
    })

    it('should support filtering by sender', () => {
      bus.writeMessage('agent-a', 'agent-c', 'From A')
      bus.writeMessage('agent-b', 'agent-c', 'From B')
      const fromA = bus.readInbox('agent-c', { fromAgent: 'agent-a' })
      expect(fromA).toHaveLength(1)
      expect(fromA[0].from).toBe('agent-a')
    })

    it('should support unreadOnly filter', () => {
      const msg = bus.writeMessage('agent-a', 'agent-b', 'Test')
      bus.markRead('agent-b', [msg.id])
      const unread = bus.readInbox('agent-b', { unreadOnly: true })
      expect(unread).toHaveLength(0)
      const all = bus.readInbox('agent-b')
      expect(all).toHaveLength(1)
    })

    it('should broadcast to all agents except sender', () => {
      // Create inboxes by writing a message to each
      bus.writeMessage('setup', 'agent-a', 'setup')
      bus.writeMessage('setup', 'agent-b', 'setup')
      bus.writeMessage('setup', 'agent-c', 'setup')

      // Broadcast from agent-a
      bus.writeMessage('agent-a', 'all', 'Broadcast message')

      const inboxA = bus.readInbox('agent-a').filter(m => m.type === 'broadcast' || m.content === 'Broadcast message')
      const inboxB = bus.readInbox('agent-b').filter(m => m.content === 'Broadcast message')
      const inboxC = bus.readInbox('agent-c').filter(m => m.content === 'Broadcast message')

      expect(inboxA).toHaveLength(0) // Sender excluded
      expect(inboxB).toHaveLength(1)
      expect(inboxC).toHaveLength(1)
    })
  })

  describe('markRead', () => {
    it('should mark messages as read', () => {
      const msg1 = bus.writeMessage('a', 'b', 'msg1')
      const msg2 = bus.writeMessage('a', 'b', 'msg2')
      bus.markRead('b', [msg1.id])

      const unread = bus.readInbox('b', { unreadOnly: true })
      expect(unread).toHaveLength(1)
      expect(unread[0].id).toBe(msg2.id)
    })

    it('should markAllRead', () => {
      bus.writeMessage('a', 'b', 'msg1')
      bus.writeMessage('a', 'b', 'msg2')
      bus.writeMessage('a', 'b', 'msg3')
      const count = bus.markAllRead('b')
      expect(count).toBe(3)
      expect(bus.getUnreadCount('b')).toBe(0)
    })
  })

  describe('createRequest / claimRequest', () => {
    it('should create an open request', () => {
      const req = bus.createRequest('agent-a', 'Verify SQL fix')
      expect(req.id).toBeTruthy()
      expect(req.status).toBe('open')
      expect(req.from).toBe('agent-a')
    })

    it('should list open requests', () => {
      bus.createRequest('agent-a', 'Task 1', { timeoutSeconds: 60 })
      bus.createRequest('agent-b', 'Task 2', { timeoutSeconds: 60 })
      const open = bus.listOpenRequests()
      expect(open).toHaveLength(2)
    })

    it('should claim an open request', () => {
      // Create inbox for agent-a so claim notification can be delivered
      bus.writeMessage('setup', 'agent-a', 'setup')

      const req = bus.createRequest('agent-a', 'Review config.ts', { timeoutSeconds: 60 })
      const result = bus.claimRequest(req.id, 'agent-b')
      expect(result.claimed).toBe(true)
      expect(result.request?.status).toBe('claimed')
      expect(result.request?.claimedBy).toBe('agent-b')
    })

    it('should not allow double claiming', () => {
      bus.writeMessage('setup', 'agent-a', 'setup')

      const req = bus.createRequest('agent-a', 'Review', { timeoutSeconds: 60 })
      bus.claimRequest(req.id, 'agent-b')
      const second = bus.claimRequest(req.id, 'agent-c')
      expect(second.claimed).toBe(false)
      expect(second.request?.claimedBy).toBe('agent-b')
    })

    it('should expire stale requests', async () => {
      const req = bus.createRequest('agent-a', 'Quick task', { timeoutSeconds: 1 })
      await new Promise(r => setTimeout(r, 1100))
      const result = bus.claimRequest(req.id, 'agent-b')
      expect(result.claimed).toBe(false)
      expect(result.request?.status).toBe('expired')
    })
  })

  describe('getUnreadCount', () => {
    it('should count unread messages', () => {
      bus.writeMessage('a', 'b', 'msg1')
      bus.writeMessage('a', 'b', 'msg2')
      expect(bus.getUnreadCount('b')).toBe(2)
    })
  })

  describe('cleanup', () => {
    it('should clean agent inbox', () => {
      bus.writeMessage('a', 'b', 'msg1')
      bus.writeMessage('a', 'b', 'msg2')
      bus.cleanup('b')
      expect(bus.readInbox('b')).toHaveLength(0)
    })

    it('should cleanupAll', () => {
      bus.writeMessage('a', 'b', 'msg1')
      bus.writeMessage('b', 'a', 'msg2')
      bus.createRequest('a', 'test', { timeoutSeconds: 60 })
      bus.cleanupAll()
      expect(bus.readInbox('a')).toHaveLength(0)
      expect(bus.readInbox('b')).toHaveLength(0)
      expect(bus.listOpenRequests()).toHaveLength(0)
    })
  })
})
