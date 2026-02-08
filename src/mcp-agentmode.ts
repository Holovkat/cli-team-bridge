import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { logger } from './logger'
import { VERSION } from './version'
import { MessageBus } from './message-bus'
import { AgentRegistry } from './agent-registry'

const MAX_WAIT_TIMEOUT = 120 // seconds
const DEFAULT_WAIT_TIMEOUT = 30 // seconds
const POLL_INTERVAL_MS = 1000 // 1 second

export interface AgentModeConfig {
  agentName: string
  bridgePath: string
}

export function createAgentModeServer(config: AgentModeConfig): Server {
  const { agentName, bridgePath } = config
  const messageBus = new MessageBus(bridgePath)
  const registry = new AgentRegistry(bridgePath)

  const server = new Server(
    { name: `cli-team-bridge-agentmode`, version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'check_messages',
        description: 'Check your inbox for new messages from other agents. Returns all unread messages.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent_id: {
              type: 'string',
              description: 'Optional: filter by sender agent name',
            },
          },
        },
      },
      {
        name: 'send_message',
        description: 'Send a direct message to a specific agent.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            to: { type: 'string', description: 'Target agent name' },
            content: { type: 'string', description: 'Message body' },
            reply_to: { type: 'string', description: 'Optional: message ID being replied to' },
          },
          required: ['to', 'content'],
        },
      },
      {
        name: 'request_task',
        description: 'Post an open request that any agent can claim. Other agents will see it and can claim it.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            description: { type: 'string', description: 'What needs doing' },
            context: { type: 'string', description: 'Supporting info / findings so far' },
            timeout_seconds: { type: 'number', description: 'How long to wait for a claim (default: 30)' },
          },
          required: ['description'],
        },
      },
      {
        name: 'claim_request',
        description: 'Claim an open request posted by another agent.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            request_id: { type: 'string', description: 'The request ID to claim' },
          },
          required: ['request_id'],
        },
      },
      {
        name: 'list_agents',
        description: 'See all active agents and their current status.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'wait_for_message',
        description: 'Block until a message arrives or timeout. Use when waiting for a response to a request.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            from: { type: 'string', description: 'Wait for message from specific agent' },
            request_id: { type: 'string', description: 'Wait for response to specific request' },
            timeout_seconds: { type: 'number', description: 'Max wait in seconds (default: 30, max: 120)' },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // Update heartbeat on every tool call
    registry.heartbeat(agentName)

    switch (name) {
      case 'check_messages': {
        const { agent_id } = (args ?? {}) as { agent_id?: string }
        const messages = messageBus.readInbox(agentName, {
          unreadOnly: true,
          fromAgent: agent_id,
        })

        // Mark as read
        if (messages.length > 0) {
          messageBus.markRead(agentName, messages.map(m => m.id))
        }

        // Also include open requests
        const openRequests = messageBus.listOpenRequests()
          .filter(r => r.from !== agentName) // Don't show own requests

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              messages: messages.map(m => ({
                id: m.id,
                type: m.type,
                from: m.from,
                to: m.to,
                content: m.content,
                timestamp: m.timestamp,
                request_id: m.requestId ?? null,
                claimed_by: m.claimedBy ?? null,
              })),
              open_requests: openRequests.map(r => ({
                id: r.id,
                from: r.from,
                description: r.description,
                context: r.context ?? null,
                created_at: r.createdAt,
              })),
            }, null, 2),
          }],
        }
      }

      case 'send_message': {
        const { to, content, reply_to } = args as { to: string; content: string; reply_to?: string }

        if (!to || !content) {
          return { content: [{ type: 'text', text: 'Missing required fields: to, content' }], isError: true }
        }

        // Check target agent exists
        const targetAgent = registry.get(to)
        if (!targetAgent) {
          return { content: [{ type: 'text', text: `Agent "${to}" not found in registry` }], isError: true }
        }

        const msg = messageBus.writeMessage(agentName, to, content, {
          type: 'message',
          replyTo: reply_to,
        })

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              message_id: msg.id,
              delivered: true,
            }, null, 2),
          }],
        }
      }

      case 'request_task': {
        const { description, context, timeout_seconds } = args as {
          description: string
          context?: string
          timeout_seconds?: number
        }

        if (!description) {
          return { content: [{ type: 'text', text: 'Missing required field: description' }], isError: true }
        }

        const timeout = Math.min(timeout_seconds ?? DEFAULT_WAIT_TIMEOUT, MAX_WAIT_TIMEOUT)
        const req = messageBus.createRequest(agentName, description, { context, timeoutSeconds: timeout })

        registry.updateStatus(agentName, 'waiting')

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              request_id: req.id,
              status: 'open',
            }, null, 2),
          }],
        }
      }

      case 'claim_request': {
        const { request_id } = args as { request_id: string }

        if (!request_id) {
          return { content: [{ type: 'text', text: 'Missing required field: request_id' }], isError: true }
        }

        const result = messageBus.claimRequest(request_id, agentName)

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              claimed: result.claimed,
              request: result.request ? {
                id: result.request.id,
                from: result.request.from,
                description: result.request.description,
                context: result.request.context ?? null,
                status: result.request.status,
              } : null,
            }, null, 2),
          }],
        }
      }

      case 'list_agents': {
        const agents = registry.getActive()

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agents: agents.map(a => ({
                name: a.name,
                status: a.status,
                model: a.model,
                current_task: a.currentTask ?? null,
                uptime_seconds: registry.getUptimeSeconds(a.name),
              })),
            }, null, 2),
          }],
        }
      }

      case 'wait_for_message': {
        const { from, request_id, timeout_seconds } = (args ?? {}) as {
          from?: string
          request_id?: string
          timeout_seconds?: number
        }

        const timeout = Math.min(timeout_seconds ?? DEFAULT_WAIT_TIMEOUT, MAX_WAIT_TIMEOUT) * 1000
        const startTime = Date.now()

        registry.updateStatus(agentName, 'waiting')

        while (Date.now() - startTime < timeout) {
          const messages = messageBus.readInbox(agentName, { unreadOnly: true })

          for (const msg of messages) {
            const matchesSender = !from || msg.from === from
            const matchesRequest = !request_id || msg.requestId === request_id

            if (matchesSender && matchesRequest) {
              messageBus.markRead(agentName, [msg.id])
              registry.updateStatus(agentName, 'running')

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    message: {
                      id: msg.id,
                      type: msg.type,
                      from: msg.from,
                      content: msg.content,
                      timestamp: msg.timestamp,
                      request_id: msg.requestId ?? null,
                    },
                    timed_out: false,
                  }, null, 2),
                }],
              }
            }
          }

          // Poll interval
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        }

        registry.updateStatus(agentName, 'running')
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ message: null, timed_out: true }, null, 2),
          }],
        }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  })

  logger.info(`[AgentMode] MCP server created for agent "${agentName}"`)
  return server
}
