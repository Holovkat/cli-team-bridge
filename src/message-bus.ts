import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { logger } from './logger'
import type { BridgeMessage, TaskRequest, MessageType } from './acp-types'

const MAX_MESSAGES_PER_INBOX = 500
const MAX_MESSAGE_SIZE = 64 * 1024 // 64KB per message content

export class MessageBus {
  private basePath: string
  private messagesDir: string
  private requestsDir: string

  constructor(bridgePath: string) {
    this.basePath = bridgePath
    this.messagesDir = join(bridgePath, 'messages')
    this.requestsDir = join(bridgePath, 'requests')
    this.ensureDirs()
  }

  private ensureDirs(): void {
    for (const dir of [this.basePath, this.messagesDir, this.requestsDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
  }

  private agentInboxDir(agentName: string): string {
    const dir = join(this.messagesDir, agentName)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  writeMessage(from: string, to: string, content: string, opts?: {
    type?: MessageType
    requestId?: string
    replyTo?: string
  }): BridgeMessage {
    if (content.length > MAX_MESSAGE_SIZE) {
      content = content.slice(0, MAX_MESSAGE_SIZE)
      logger.warn(`Message from ${from} to ${to} truncated to ${MAX_MESSAGE_SIZE} bytes`)
    }

    const msg: BridgeMessage = {
      id: randomUUID(),
      type: opts?.type ?? 'message',
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      requestId: opts?.requestId,
      replyTo: opts?.replyTo,
      read: false,
    }

    try {
      if (to === 'all') {
        // Broadcast: write to every agent's inbox
        this.writeToAllInboxes(msg, from)
      } else {
        this.writeToInbox(to, msg)
      }
      logger.debug(`[MessageBus] ${from} → ${to}: ${msg.type} (${msg.id})`)
    } catch (err) {
      logger.error(`[MessageBus] Failed to write message from ${from} to ${to}: ${err}`)
      // Re-throw to ensure callers know the message was not delivered
      throw new Error(`Message delivery failed: ${err}`)
    }

    return msg
  }

  private writeToInbox(agentName: string, msg: BridgeMessage): void {
    const inboxDir = this.agentInboxDir(agentName)
    
    try {
      const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'))

      // Prune oldest if inbox is full
      if (files.length >= MAX_MESSAGES_PER_INBOX) {
        const sorted = files.sort()
        const toRemove = sorted.slice(0, files.length - MAX_MESSAGES_PER_INBOX + 1)
        for (const f of toRemove) {
          try { 
            unlinkSync(join(inboxDir, f)) 
          } catch (err) {
            logger.warn(`[MessageBus] Failed to prune message ${f}: ${err}`)
          }
        }
        logger.warn(`[MessageBus] Pruned ${toRemove.length} messages from ${agentName} inbox`)
      }

      // Filename: timestamp-uuid.json for natural ordering
      const filename = `${msg.timestamp.replace(/[:.]/g, '-')}-${msg.id.slice(0, 8)}.json`
      const filePath = join(inboxDir, filename)
      writeFileSync(filePath, JSON.stringify(msg, null, 2))
    } catch (err) {
      logger.error(`[MessageBus] Failed to write to inbox for ${agentName}: ${err}`)
      throw err
    }
  }

  private writeToAllInboxes(msg: BridgeMessage, excludeSender: string): void {
    if (!existsSync(this.messagesDir)) {
      throw new Error(`Messages directory does not exist: ${this.messagesDir}`)
    }
    
    let agents: string[]
    try {
      agents = readdirSync(this.messagesDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== excludeSender)
        .map(d => d.name)
    } catch (err) {
      logger.error(`[MessageBus] Failed to list agent inboxes: ${err}`)
      throw err
    }

    const errors: Error[] = []
    for (const agent of agents) {
      try {
        this.writeToInbox(agent, { ...msg, to: agent })
      } catch (err) {
        logger.error(`[MessageBus] Failed to write to inbox for ${agent}: ${err}`)
        errors.push(err as Error)
      }
    }
    
    // If any writes failed, report the failure
    if (errors.length > 0) {
      throw new Error(`Broadcast failed for ${errors.length} of ${agents.length} agents`)
    }
  }

  readInbox(agentName: string, opts?: { fromAgent?: string; unreadOnly?: boolean }): BridgeMessage[] {
    const inboxDir = this.agentInboxDir(agentName)
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json')).sort()

    const messages: BridgeMessage[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(inboxDir, file), 'utf-8')
        const msg: BridgeMessage = JSON.parse(raw)

        if (opts?.unreadOnly && msg.read) continue
        if (opts?.fromAgent && msg.from !== opts.fromAgent) continue

        messages.push(msg)
      } catch (err) {
        logger.warn(`[MessageBus] Failed to read message file ${file}: ${err}`)
        // Continue processing other messages - don't let one corrupt file break the entire inbox
      }
    }
    return messages
  }

  markRead(agentName: string, messageIds: string[]): number {
    const inboxDir = this.agentInboxDir(agentName)
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'))
    const idSet = new Set(messageIds)
    let count = 0

    for (const file of files) {
      const filePath = join(inboxDir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const msg: BridgeMessage = JSON.parse(raw)
        if (idSet.has(msg.id) && !msg.read) {
          msg.read = true
          writeFileSync(filePath, JSON.stringify(msg, null, 2))
          count++
        }
      } catch (err) {
        logger.warn(`[MessageBus] Failed to mark message ${file} as read: ${err}`)
        // Continue processing other messages
      }
    }
    return count
  }

  markAllRead(agentName: string): number {
    const unread = this.readInbox(agentName, { unreadOnly: true })
    if (unread.length === 0) return 0
    return this.markRead(agentName, unread.map(m => m.id))
  }

  createRequest(from: string, description: string, opts?: {
    context?: string
    timeoutSeconds?: number
  }): TaskRequest {
    const req: TaskRequest = {
      id: randomUUID(),
      from,
      description,
      context: opts?.context,
      status: 'open',
      createdAt: new Date().toISOString(),
      timeoutSeconds: opts?.timeoutSeconds ?? 30,
    }

    const filename = `${req.createdAt.replace(/[:.]/g, '-')}-${req.id.slice(0, 8)}.json`
    writeFileSync(join(this.requestsDir, filename), JSON.stringify(req, null, 2))

    // Notify all agents about the new request
    this.writeMessage(from, 'all', description, {
      type: 'request',
      requestId: req.id,
    })

    logger.info(`[MessageBus] Request created: ${req.id} from ${from}`)
    return req
  }

  claimRequest(requestId: string, claimedBy: string): { claimed: boolean; request: TaskRequest | null } {
    const files = readdirSync(this.requestsDir).filter(f => f.endsWith('.json'))

    for (const file of files) {
      const filePath = join(this.requestsDir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const req: TaskRequest = JSON.parse(raw)

        if (req.id !== requestId) continue

        if (req.status !== 'open') {
          return { claimed: false, request: req }
        }

        // Check timeout
        const elapsed = (Date.now() - new Date(req.createdAt).getTime()) / 1000
        if (elapsed > req.timeoutSeconds) {
          req.status = 'expired'
          writeFileSync(filePath, JSON.stringify(req, null, 2))
          return { claimed: false, request: req }
        }

        // Claim it
        req.status = 'claimed'
        req.claimedBy = claimedBy
        req.claimedAt = new Date().toISOString()
        writeFileSync(filePath, JSON.stringify(req, null, 2))

        // Notify the requester
        this.writeMessage(claimedBy, req.from, `Claimed by ${claimedBy}`, {
          type: 'response',
          requestId: req.id,
        })

        logger.info(`[MessageBus] Request ${requestId} claimed by ${claimedBy}`)
        return { claimed: true, request: req }
      } catch (err) {
        logger.warn(`[MessageBus] Failed to read request file ${file}: ${err}`)
        // Continue processing other requests
      }
    }

    return { claimed: false, request: null }
  }

  getRequest(requestId: string): TaskRequest | null {
    const files = readdirSync(this.requestsDir).filter(f => f.endsWith('.json'))

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.requestsDir, file), 'utf-8')
        const req: TaskRequest = JSON.parse(raw)
        if (req.id === requestId) return req
      } catch (err) {
        logger.warn(`[MessageBus] Failed to read request file ${file}: ${err}`)
        // Continue processing other requests
      }
    }
    return null
  }

  listOpenRequests(): TaskRequest[] {
    const files = readdirSync(this.requestsDir).filter(f => f.endsWith('.json')).sort()
    const requests: TaskRequest[] = []

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.requestsDir, file), 'utf-8')
        const req: TaskRequest = JSON.parse(raw)

        // Expire stale requests
        if (req.status === 'open') {
          const elapsed = (Date.now() - new Date(req.createdAt).getTime()) / 1000
          if (elapsed > req.timeoutSeconds) {
            req.status = 'expired'
            writeFileSync(join(this.requestsDir, file), JSON.stringify(req, null, 2))
            continue
          }
          requests.push(req)
        }
      } catch (err) {
        logger.warn(`[MessageBus] Failed to list open request from ${file}: ${err}`)
        // Continue processing other requests
      }
    }
    return requests
  }

  getUnreadCount(agentName: string): number {
    return this.readInbox(agentName, { unreadOnly: true }).length
  }

  getUnreadMessages(agentName: string): BridgeMessage[] {
    return this.readInbox(agentName, { unreadOnly: true })
  }

  cleanup(agentName: string): void {
    const inboxDir = join(this.messagesDir, agentName)
    if (!existsSync(inboxDir)) return
    try {
      const files = readdirSync(inboxDir)
      for (const f of files) {
        try { 
          unlinkSync(join(inboxDir, f)) 
        } catch (err) {
          logger.warn(`[MessageBus] Failed to delete message ${f} during cleanup: ${err}`)
        }
      }
      logger.info(`[MessageBus] Cleaned up inbox for ${agentName}`)
    } catch (err) {
      logger.warn(`[MessageBus] Failed to clean inbox for ${agentName}: ${err}`)
    }
  }

  cleanupAll(): void {
    // Clean messages
    if (existsSync(this.messagesDir)) {
      const agents = readdirSync(this.messagesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
      for (const agent of agents) {
        this.cleanup(agent)
      }
    }

    // Clean requests
    if (existsSync(this.requestsDir)) {
      const files = readdirSync(this.requestsDir)
      for (const f of files) {
        try { 
          unlinkSync(join(this.requestsDir, f)) 
        } catch (err) {
          logger.warn(`[MessageBus] Failed to delete request ${f} during cleanup: ${err}`)
        }
      }
    }
    logger.info('[MessageBus] Full cleanup complete')
  }
}
