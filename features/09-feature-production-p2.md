# Sprint 9: Production Features (P2)

**Goal**: Add health checks, metrics, per-agent concurrency, graceful degradation, streaming progress
**Severity**: P2 feature gaps
**Estimated Effort**: Large (10-14 hours)

## Feature Tasks

### 9.1 Per-Agent Concurrency Limits

- [ ] Add per-agent max concurrent config to `BridgeConfig`:
  ```typescript
  concurrency?: { maxPerAgent?: number; maxTotal?: number }
  ```
- [ ] Track running tasks per agent in `src/mcp-server.ts`
- [ ] Reject or queue tasks when agent at capacity
- [ ] Return queue position in `assign_task` response
- **Why**: One agent type shouldn't monopolize all resources.

### 9.2 Agent Health Checks

- [ ] Create `src/health.ts` with periodic health probing
  - Spawn adapter with a no-op/ping prompt periodically
  - Track last-healthy timestamp per agent
  - Expose health in `list_agents` response:
    ```json
    { "lastHealthy": "2026-02-08T11:00:00Z", "healthStatus": "healthy|degraded|unhealthy" }
    ```
- [ ] Add circuit breaker: after N consecutive failures, mark agent `unavailable` temporarily
- **Why**: `which` binary check only tells if binary exists, not if agent can actually process tasks.

### 9.3 Graceful Degradation / Fallback Agent

- [ ] Add `fallbackAgent` config option per agent
  ```typescript
  fallbackAgent?: string  // Agent to use when primary is unavailable
  ```
- [ ] In `assign_task`, if primary agent unavailable, try fallback
- [ ] Log fallback usage for visibility
- **Why**: Hard failure when agent unavailable. Fallback provides resilience.

### 9.4 Metrics & Observability

- [ ] Create `src/metrics.ts` with in-memory counters:
  ```typescript
  export const metrics = {
    tasksAssigned: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    totalDurationMs: 0,
    byAgent: new Map<string, { assigned: number; completed: number; failed: number; totalMs: number }>(),
  }
  ```
- [ ] Add `get_metrics` MCP tool returning:
  - Total tasks (assigned/completed/failed)
  - Average task duration
  - Per-agent success rates
  - Uptime
- [ ] Log metrics summary periodically (every 5 min)
- **Why**: No visibility into task performance, agent utilization, or system health.

### 9.5 Streaming Progress for Long-Running Tasks

- [ ] Add `lastUpdate` field to `ActiveTask`:
  ```typescript
  lastUpdate?: string  // Last agent_message_chunk or tool_call timestamp
  toolCallCount?: number
  outputLength?: number
  ```
- [ ] Update these fields in `sessionUpdate` callback
- [ ] Include progress info in `get_task_status` response:
  ```json
  { "toolCallCount": 5, "outputLength": 2048, "lastUpdate": "2026-02-08T11:42:00Z" }
  ```
- **Why**: Long tasks (up to 30 min) appear stuck with no feedback.

### 9.6 Multi-Team Isolation

- [ ] Support multiple teams in MCP mode
- [ ] Add optional `team` parameter to `assign_task`
- [ ] Isolate task maps per team
- [ ] Add `list_teams` MCP tool
- **Why**: Single shared task processing loop has no team isolation.

### 9.7 Complete Config Hot-Reload

- [ ] Fix SIGHUP race condition — snapshot config before use
- [ ] Reinitialize watcher with new config (new agent names, polling interval)
- [ ] Log config diff on reload (what changed)
- **Why**: Current SIGHUP reloads config object but doesn't reinitialize MCP server or watcher.
