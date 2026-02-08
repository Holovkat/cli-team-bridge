# Sprint 7: Production Resilience Features

**Goal**: Add retry logic, MCP authentication, task persistence, task cancellation
**Severity**: P0-P1 feature gaps
**Estimated Effort**: Large (8-12 hours)

## Feature Tasks

### 7.1 Add Retry Logic with Exponential Backoff (P0)

- [ ] Create `src/retry.ts` with retry utility
  - **Implementation**:
    ```typescript
    export interface RetryConfig {
      maxRetries: number
      baseDelayMs: number
      maxDelayMs: number
    }

    const DEFAULT_RETRY: RetryConfig = { maxRetries: 3, baseDelayMs: 5000, maxDelayMs: 60000 }

    export async function withRetry<T>(
      fn: () => Promise<T>,
      config: RetryConfig = DEFAULT_RETRY,
      label: string = 'operation',
    ): Promise<T> {
      let lastError: Error | undefined
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
          return await fn()
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < config.maxRetries) {
            const delay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs)
            logger.warn(`${label} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`)
            await Bun.sleep(delay)
          }
        }
      }
      throw lastError
    }
    ```
  - [ ] Wrap `runAcpSession()` calls in `src/index.ts` and `src/mcp-server.ts` with `withRetry()`
  - [ ] Add `retry` config section to `BridgeConfig`:
    ```typescript
    retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number }
    ```
  - **Why**: Failed tasks (network, adapter crash) are currently marked failed immediately with no recovery.
  - **Test**: "should retry failed ACP session up to maxRetries times"
  - **Test**: "should use exponential backoff between retries"

### 7.2 Add MCP Authentication (P0)

- [ ] Add bearer token validation to `src/mcp-server.ts`
  - **Implementation**: Add auth config to `BridgeConfig`:
    ```typescript
    auth?: { tokens: string[] }  // List of valid bearer tokens
    ```
  - Add validation at the start of `CallToolRequestSchema` handler:
    ```typescript
    // For network transports — validate auth header/token
    // For stdio transport — trust parent process (current behavior)
    // This prepares for future HTTP/WS transport
    ```
  - [ ] Add `cancel_task` MCP tool for authorized users
  - **Why**: Any process that can write to stdin can invoke tools. Needed for network transport.

### 7.3 Add Task Persistence (P1)

- [ ] Create `src/persistence.ts` with SQLite-backed task store
  - **Implementation**:
    ```typescript
    import { Database } from 'bun:sqlite'

    export class TaskStore {
      private db: Database

      constructor(dbPath: string) {
        this.db = new Database(dbPath)
        this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          model TEXT NOT NULL,
          project TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          started_at TEXT NOT NULL,
          completed_at TEXT,
          output TEXT,
          error TEXT
        )`)
      }

      save(task: ActiveTask): void { /* INSERT OR REPLACE */ }
      get(id: string): ActiveTask | null { /* SELECT */ }
      update(id: string, updates: Partial<ActiveTask>): void { /* UPDATE */ }
      listRunning(): ActiveTask[] { /* SELECT WHERE status = 'running' */ }
      prune(olderThanMs: number): number { /* DELETE completed older than */ }
    }
    ```
  - [ ] Replace `activeTasks` Map in `src/mcp-server.ts` with `TaskStore`
  - [ ] On startup, recover orphaned `in_progress` tasks (mark as `failed` with "bridge restarted")
  - **Why**: In-memory Map loses all task state on restart. Orphaned tasks stay `in_progress` forever.
  - **Test**: "should persist tasks across bridge restart"
  - **Test**: "should mark orphaned in_progress tasks as failed on startup"

### 7.4 Add Task Cancellation (P1)

- [ ] Add `cancel_task` MCP tool to `src/mcp-server.ts`
  - **Implementation**:
    ```typescript
    {
      name: 'cancel_task',
      description: 'Cancel a running task by its ID. Sends SIGTERM to the agent process.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID to cancel' },
        },
        required: ['task_id'],
      },
    }
    ```
  - [ ] Track child process references in `activeTasks` (add `proc: ChildProcess` to `ActiveTask`)
  - [ ] On cancel: `safeKill(proc)`, update status to `cancelled`
  - [ ] Add `cancelled` status to task lifecycle
  - **Why**: No way to stop a misbehaving or stuck agent. Only option is killing entire bridge.
  - **Test**: "should cancel running task and update status to cancelled"

### 7.5 Add Stuck Task Detection (P1)

- [ ] Add heartbeat/lease mechanism to `src/task-watcher.ts`
  - **Implementation**: Tasks get a `leaseExpiresAt` field. Watcher checks for expired leases:
    ```typescript
    const LEASE_DURATION_MS = 35 * 60 * 1000 // 35 min (> 30 min task timeout)

    // In poll():
    if (task.status === 'in_progress') {
      const leaseExpired = task.metadata?.leaseExpiresAt &&
        Date.now() > new Date(task.metadata.leaseExpiresAt).getTime()
      if (leaseExpired) {
        logger.warn(`Task ${task.id} lease expired — marking failed`)
        // Write failed result
      }
    }
    ```
  - **Why**: If bridge crashes mid-task, tasks stay `in_progress` forever with no recovery.
  - **Test**: "should mark tasks as failed when lease expires"
