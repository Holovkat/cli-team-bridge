import { logger } from './logger'
import type { MessageBus } from './message-bus'
import type { AgentRegistry } from './agent-registry'
import type { BridgeMessage, TaskRequest, MessageType } from './acp-types'

export interface MessagingConfig {
  enabled: boolean
  failSilently: boolean
}

/**
 * Wrapper class that provides safe access to messaging functionality.
 * When messaging is disabled, all methods return safe defaults.
 * When failSilently is true, errors are logged as warnings instead of thrown.
 */
export class MessagingWrapper {
  private messageBus: MessageBus | null
  private agentRegistry: AgentRegistry | null
  private config: MessagingConfig

  constructor(
    messageBus: MessageBus | null,
    agentRegistry: AgentRegistry | null,
    config?: MessagingConfig
  ) {
    this.messageBus = messageBus
    this.agentRegistry = agentRegistry
    this.config = config ?? { enabled: true, failSilently: true }
  }

  private handleError(operation: string, err: unknown): void {
    if (this.config.failSilently) {
      logger.warn(`[MessagingWrapper] ${operation} failed: ${err}`)
    } else {
      throw err
    }
  }

  private isEnabled(): boolean {
    return this.config.enabled && this.messageBus !== null && this.agentRegistry !== null
  }

  // --- MessageBus wrapper methods ---

  writeMessage(
    from: string,
    to: string,
    content: string,
    opts?: { type?: MessageType; requestId?: string; replyTo?: string }
  ): BridgeMessage | null {
    if (!this.isEnabled()) {
      logger.debug(`[MessagingWrapper] writeMessage skipped (disabled): ${from} → ${to}`)
      return null
    }
    try {
      return this.messageBus!.writeMessage(from, to, content, opts)
    } catch (err) {
      this.handleError('writeMessage', err)
      return null
    }
  }

  readInbox(
    agentName: string,
    opts?: { fromAgent?: string; unreadOnly?: boolean }
  ): BridgeMessage[] {
    if (!this.isEnabled()) return []
    try {
      return this.messageBus!.readInbox(agentName, opts)
    } catch (err) {
      this.handleError('readInbox', err)
      return []
    }
  }

  markRead(agentName: string, messageIds: string[]): number {
    if (!this.isEnabled()) return 0
    try {
      return this.messageBus!.markRead(agentName, messageIds)
    } catch (err) {
      this.handleError('markRead', err)
      return 0
    }
  }

  markAllRead(agentName: string): number {
    if (!this.isEnabled()) return 0
    try {
      return this.messageBus!.markAllRead(agentName)
    } catch (err) {
      this.handleError('markAllRead', err)
      return 0
    }
  }

  createRequest(
    from: string,
    description: string,
    opts?: { context?: string; timeoutSeconds?: number }
  ): TaskRequest | null {
    if (!this.isEnabled()) return null
    try {
      return this.messageBus!.createRequest(from, description, opts)
    } catch (err) {
      this.handleError('createRequest', err)
      return null
    }
  }

  claimRequest(
    requestId: string,
    claimedBy: string
  ): { claimed: boolean; request: TaskRequest | null } {
    if (!this.isEnabled()) return { claimed: false, request: null }
    try {
      return this.messageBus!.claimRequest(requestId, claimedBy)
    } catch (err) {
      this.handleError('claimRequest', err)
      return { claimed: false, request: null }
    }
  }

  getRequest(requestId: string): TaskRequest | null {
    if (!this.isEnabled()) return null
    try {
      return this.messageBus!.getRequest(requestId)
    } catch (err) {
      this.handleError('getRequest', err)
      return null
    }
  }

  listOpenRequests(): TaskRequest[] {
    if (!this.isEnabled()) return []
    try {
      return this.messageBus!.listOpenRequests()
    } catch (err) {
      this.handleError('listOpenRequests', err)
      return []
    }
  }

  getUnreadCount(agentName: string): number {
    if (!this.isEnabled()) return 0
    try {
      return this.messageBus!.getUnreadCount(agentName)
    } catch (err) {
      this.handleError('getUnreadCount', err)
      return 0
    }
  }

  getUnreadMessages(agentName: string): BridgeMessage[] {
    if (!this.isEnabled()) return []
    try {
      return this.messageBus!.getUnreadMessages(agentName)
    } catch (err) {
      this.handleError('getUnreadMessages', err)
      return []
    }
  }

  cleanup(agentName: string): void {
    if (!this.isEnabled()) return
    try {
      this.messageBus!.cleanup(agentName)
    } catch (err) {
      this.handleError('cleanup', err)
    }
  }

  cleanupAll(): void {
    if (!this.isEnabled()) return
    try {
      this.messageBus!.cleanupAll()
    } catch (err) {
      this.handleError('cleanupAll', err)
    }
  }

  // --- AgentRegistry wrapper methods ---

  register(name: string, model: string, pid?: number): ReturnType<AgentRegistry['register']> | null {
    if (!this.isEnabled()) return null
    try {
      return this.agentRegistry!.register(name, model, pid)
    } catch (err) {
      this.handleError('register', err)
      return null
    }
  }

  deregister(name: string): boolean {
    if (!this.isEnabled()) return false
    try {
      return this.agentRegistry!.deregister(name)
    } catch (err) {
      this.handleError('deregister', err)
      return false
    }
  }

  getActive(): ReturnType<AgentRegistry['getActive']> {
    if (!this.isEnabled()) return []
    try {
      return this.agentRegistry!.getActive()
    } catch (err) {
      this.handleError('getActive', err)
      return []
    }
  }

  getAll(): ReturnType<AgentRegistry['getAll']> {
    if (!this.isEnabled()) return []
    try {
      return this.agentRegistry!.getAll()
    } catch (err) {
      this.handleError('getAll', err)
      return []
    }
  }

  get(name: string): ReturnType<AgentRegistry['get']> {
    if (!this.isEnabled()) return null
    try {
      return this.agentRegistry!.get(name)
    } catch (err) {
      this.handleError('get', err)
      return null
    }
  }

  updateStatus(name: string, status: Parameters<AgentRegistry['updateStatus']>[1], currentTask?: string): boolean {
    if (!this.isEnabled()) return false
    try {
      return this.agentRegistry!.updateStatus(name, status, currentTask)
    } catch (err) {
      this.handleError('updateStatus', err)
      return false
    }
  }

  heartbeat(name: string): boolean {
    if (!this.isEnabled()) return false
    try {
      return this.agentRegistry!.heartbeat(name)
    } catch (err) {
      this.handleError('heartbeat', err)
      return false
    }
  }

  updateMessageCounts(name: string, messagesPending: number, requestsPending: number): void {
    if (!this.isEnabled()) return
    try {
      this.agentRegistry!.updateMessageCounts(name, messagesPending, requestsPending)
    } catch (err) {
      this.handleError('updateMessageCounts', err)
    }
  }

  detectDead(): ReturnType<AgentRegistry['detectDead']> {
    if (!this.isEnabled()) return []
    try {
      return this.agentRegistry!.detectDead()
    } catch (err) {
      this.handleError('detectDead', err)
      return []
    }
  }

  pruneDeadAgents(): number {
    if (!this.isEnabled()) return 0
    try {
      return this.agentRegistry!.pruneDeadAgents()
    } catch (err) {
      this.handleError('pruneDeadAgents', err)
      return 0
    }
  }

  clear(): void {
    if (!this.isEnabled()) return
    try {
      this.agentRegistry!.clear()
    } catch (err) {
      this.handleError('clear', err)
    }
  }

  getHeartbeatInterval(): number {
    if (!this.isEnabled()) return 10000 // Default 10s
    try {
      return this.agentRegistry!.getHeartbeatInterval()
    } catch (err) {
      this.handleError('getHeartbeatInterval', err)
      return 10000
    }
  }

  getDeadThreshold(): number {
    if (!this.isEnabled()) return 30000 // Default 30s
    try {
      return this.agentRegistry!.getDeadThreshold()
    } catch (err) {
      this.handleError('getDeadThreshold', err)
      return 30000
    }
  }

  getUptimeSeconds(name: string): number {
    if (!this.isEnabled()) return 0
    try {
      return this.agentRegistry!.getUptimeSeconds(name)
    } catch (err) {
      this.handleError('getUptimeSeconds', err)
      return 0
    }
  }
}
