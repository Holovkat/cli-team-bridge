# Feature: Cross-Agent Communication via MCP Messaging

**Created**: 2026-02-08
**Sprint**: 10
**Priority**: P1
**Status**: Planned

---

## Problem

Agents currently run in complete isolation — each gets a prompt, executes, and returns a result. There is no way for agents to:
- Share findings mid-task with other active agents
- Request help or verification from another agent
- Chain work (output of A feeds into B)
- Coordinate reviews or challenge each other's findings
- Build on each other's context

## Solution

Add a file-based messaging system managed entirely by the MCP server. Agents interact only through MCP tools — the underlying file system is an implementation detail they never see. Two MCP modes:

- **Orchestrator mode**: full control — assign tasks, manage agents, route messages, shutdown/kill agents
- **Agent mode**: communication tools only — check messages, send messages, request/claim tasks from peers

## Architecture

```
Claude Code (MCP client)
    │
    │ MCP (orchestrator mode)
    v
cli-team-bridge
    │
    ├── spawn ──> codex   [MCP: agentmode] ──> messaging tools
    ├── spawn ──> gemini  [MCP: agentmode] ──> messaging tools
    ├── spawn ──> droid   [MCP: agentmode] ──> messaging tools
    └── spawn ──> qwen    [MCP: agentmode] ──> messaging tools
                     │
                     v
              File-based message bus (internal)
              {project}/.claude/bridge/
                  agents.json        # active agent registry
                  messages/          # message queue (per agent)
                  requests/          # open task requests
                  tasks/             # shared task list
```

Agents don't know about the file system. They only see MCP tools.

## Message Types

| Type | Description | Visibility |
|------|-------------|------------|
| `message` | Direct message to a specific agent | Sender + recipient only |
| `request` | Open task request any agent can claim | All agents |
| `response` | Reply to a message or request | Sender + original requester |
| `nudge` | Follow-up on unclaimed request | All agents |
| `broadcast` | Message to all active agents (orchestrator only) | All agents |
| `shutdown` | Graceful shutdown request (orchestrator only) | Target agent |

## MCP Tools

### Agent Mode Tools

Agents get these tools via `mcpServers` in the ACP `newSession` call.

#### `check_messages`
Poll inbox for new messages. Returns all unread messages.
```typescript
// Input
{ agent_id?: string }  // filter by sender (optional)

// Output
{
  messages: [{
    id: string
    type: "message" | "request" | "response" | "nudge"
    from: string           // sender agent name
    to: string | "all"     // recipient
    content: string        // message body
    timestamp: string      // ISO 8601
    request_id?: string    // links responses to requests
    claimed_by?: string    // who claimed a request
  }]
}
```

#### `send_message`
Send a direct message to a specific agent.
```typescript
// Input
{
  to: string        // target agent name
  content: string   // message body
  reply_to?: string // message ID being replied to
}

// Output
{ message_id: string, delivered: boolean }
```

#### `request_task`
Post an open request any agent can claim.
```typescript
// Input
{
  description: string    // what needs doing
  context?: string       // supporting info / findings so far
  timeout_seconds?: number  // how long to wait (default: 30)
}

// Output
{ request_id: string, status: "open" }
```

#### `claim_request`
Claim an open request posted by another agent.
```typescript
// Input
{ request_id: string }

// Output
{ claimed: boolean, request: { ... } }
```

#### `list_agents`
See all active agents and their current status.
```typescript
// Input (none)

// Output
{
  agents: [{
    name: string
    status: "running" | "idle" | "waiting"
    model: string
    current_task?: string
    uptime_seconds: number
  }]
}
```

#### `wait_for_message`
Block until a message arrives or timeout. Used when an agent has posted a request and is waiting for a response.
```typescript
// Input
{
  from?: string            // wait for message from specific agent
  request_id?: string      // wait for response to specific request
  timeout_seconds?: number // max wait (default: 30, max: 120)
}

// Output
{ message: { ... } | null, timed_out: boolean }
```

### Orchestrator Mode Tools (in addition to all agent tools)

#### `broadcast`
Send a message to all active agents.
```typescript
// Input
{ content: string }

// Output
{ delivered_to: string[], failed: string[] }
```

#### `shutdown_agent`
Graceful shutdown — agent finishes current work then exits.
```typescript
// Input
{ agent: string, reason?: string }

// Output
{ acknowledged: boolean }
```

#### `kill_agent`
Force kill — SIGTERM then SIGKILL after 5s.
```typescript
// Input
{ agent: string }

// Output
{ killed: boolean }
```

#### `create_workflow`
Define a task chain where output flows between agents.
```typescript
// Input
{
  name: string
  steps: [{
    agent: string
    prompt: string
    model?: string
    depends_on?: string[]  // step names that must complete first
  }]
}

// Output
{ workflow_id: string, steps: number }
```

#### `get_agent_status`
Health and progress of all active agents.
```typescript
// Input (none)

// Output
{
  agents: [{
    name: string
    status: "running" | "idle" | "waiting" | "dead"
    task_id?: string
    messages_pending: number
    requests_pending: number
    uptime_seconds: number
    last_activity: string
  }]
}
```

## Request/Claim Flow

```
1. Codex:  request_task("Verify this SQL injection fix in config.ts:42")
           → request_id: "req-001", status: "open"

2. All agents see request via check_messages:
   { type: "request", from: "codex", content: "Verify this SQL injection..." }

3. Gemini: claim_request("req-001")
           → claimed: true

4. Codex sees claim notification via check_messages:
   { type: "response", content: "claimed by gemini", request_id: "req-001" }

5. Codex:  wait_for_message(request_id: "req-001", timeout_seconds: 60)
           → blocks until gemini responds

6. Gemini: send_message(to: "codex", content: "Verified. Fix is correct...",
                         reply_to: "req-001")

7. Codex receives response, incorporates into its work
```

## Context Injection

When an agent starts a new task (via `assign_task`), the bridge automatically prepends unread messages into the agent's prompt:

```
--- Messages from other agents ---
[codex → you] Found path traversal in mcp-server.ts:45. Can you verify?
[gemini → all] Security review complete. 3 critical findings attached.
--- End messages ---

Your task: Review the error handling patterns in cli-team-bridge...
```

This ensures agents have context even if they don't explicitly call `check_messages` at the start.

## Implementation Tasks

### Phase 1: Message Bus Core
- [ ] 1.1 Create `src/message-bus.ts` — file-based message store
  - Pattern: Follow `src/persistence.ts` for file I/O with locking
  - Methods: `writeMessage()`, `readInbox()`, `markRead()`, `createRequest()`, `claimRequest()`
  - Storage: JSON files in `{project}/.claude/bridge/messages/`
  - Test: Write message, read from inbox, mark as read
  - Verify: Unit tests pass, no race conditions with lock manager

- [ ] 1.2 Create `src/agent-registry.ts` — active agent tracking
  - Pattern: Follow `src/manifest.ts` for JSON file management
  - Methods: `register()`, `deregister()`, `getActive()`, `updateStatus()`, `heartbeat()`
  - Storage: `{project}/.claude/bridge/agents.json`
  - Test: Register agent, update status, deregister on exit
  - Verify: Registry reflects actual running processes

- [ ] 1.3 Add message types to `src/acp-types.ts`
  - Types: `BridgeMessage`, `TaskRequest`, `MessageType`, `AgentStatus`
  - Pattern: Follow existing ACP type definitions
  - Test: Type compilation, no `any` casts needed
  - Verify: `bun run typecheck` passes

### Phase 2: Agent Mode MCP Tools
- [ ] 2.1 Create `src/mcp-agentmode.ts` — MCP server for agent sessions
  - Pattern: Follow `src/mcp-server.ts` for tool registration
  - Tools: `check_messages`, `send_message`, `request_task`, `claim_request`, `list_agents`, `wait_for_message`
  - Test: Each tool callable via JSON-RPC, returns correct schema
  - Verify: Agent can send/receive messages in integration test

- [ ] 2.2 Wire agentmode MCP into ACP session spawn
  - File: `src/acp-client.ts` — pass MCP server config in `newSession({ mcpServers: [...] })`
  - Each spawned agent gets agentmode tools automatically
  - Test: Spawned agent can call `list_agents` during its session
  - Verify: ACP session starts with MCP tools available

- [ ] 2.3 Implement `wait_for_message` with timeout and cancellation
  - File: `src/mcp-agentmode.ts`
  - Poll interval: 1s, max timeout: 120s, cancellable on agent shutdown
  - Test: Wait resolves on message arrival; wait times out correctly
  - Verify: No hanging processes on timeout

### Phase 3: Orchestrator Enhancements
- [ ] 3.1 Add messaging tools to orchestrator MCP
  - File: `src/mcp-server.ts`
  - New tools: `broadcast`, `shutdown_agent`, `kill_agent`, `get_agent_status`
  - Pattern: Follow existing `assign_task` / `get_task_result` patterns
  - Test: Broadcast reaches all agents, shutdown sends graceful signal
  - Verify: Integration test with 2+ agents

- [ ] 3.2 Implement `create_workflow` for task chaining
  - File: `src/workflow.ts` (new)
  - Workflow engine: sequential/parallel steps with dependency resolution
  - Auto-injects previous step output into next step's prompt
  - Test: 3-step workflow executes in order, output chains correctly
  - Verify: Workflow completes end-to-end

- [ ] 3.3 Add context injection to `assign_task`
  - File: `src/mcp-server.ts`, `src/acp-client.ts`
  - Prepend unread messages to agent prompt on task start
  - Test: Agent receives messages from other agents in its prompt context
  - Verify: Messages appear in agent output/behaviour

### Phase 4: Lifecycle Management
- [ ] 4.1 Agent heartbeat and dead agent detection
  - File: `src/agent-registry.ts`
  - Heartbeat interval: 10s, dead threshold: 30s
  - Auto-deregister dead agents, notify orchestrator
  - Test: Agent stops heartbeat → detected as dead within 30s
  - Verify: Dead agents removed from registry and `list_agents`

- [ ] 4.2 Graceful shutdown flow
  - File: `src/acp-client.ts`, `src/mcp-server.ts`
  - `shutdown_agent`: write shutdown message → agent checks on next `check_messages` → agent exits cleanly
  - `kill_agent`: SIGTERM → 5s → SIGKILL
  - Test: Shutdown completes within 30s, kill completes within 10s
  - Verify: No orphaned processes

- [ ] 4.3 Cleanup on bridge shutdown
  - File: `src/index.ts`
  - On SIGTERM: broadcast shutdown to all agents, wait 30s, kill remaining, clean up message bus files
  - Test: Bridge shutdown kills all child processes
  - Verify: No orphaned processes or stale files

### Phase 5: Testing
- [ ] 5.1 Unit tests for message bus (`tests/message-bus.test.ts`)
- [ ] 5.2 Unit tests for agent registry (`tests/agent-registry.test.ts`)
- [ ] 5.3 Integration test: two agents exchange messages (`tests/agent-messaging.test.ts`)
- [ ] 5.4 Integration test: request/claim/respond flow (`tests/request-claim.test.ts`)
- [ ] 5.5 Integration test: workflow execution (`tests/workflow.test.ts`)
- [ ] 5.6 End-to-end test: orchestrator + 3 agents with full messaging (`tests/e2e-messaging.test.ts`)

## Acceptance Criteria

1. Agents can send/receive messages to/from other agents via MCP tools only
2. Agents can post open requests that any other agent can claim
3. Orchestrator can broadcast, shutdown, and kill agents
4. Workflow chains execute with output flowing between steps
5. Dead agents are detected and cleaned up automatically
6. No agent has direct knowledge of the file system — all via MCP tools
7. All message operations have timeouts to prevent deadlocks
8. Works with all 5 agent backends (codex, claude-code, gemini, qwen, droid)
