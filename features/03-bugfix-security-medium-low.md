# Sprint 3: Security Medium & Low Fixes

**Goal**: Close remaining security findings — lock manager, input validation, task IDs, config hygiene
**Severity**: Medium / Low
**Estimated Effort**: Medium (3-5 hours)

## Bugfix Tasks

### 3.1 Fix Stale Lock Detection in Lock Manager

- [ ] Add PID liveness check and expiry to `src/lock-manager.ts` at lines 13-31
  - **Current**: No stale lock detection — crash leaves permanent lock
  - **Fixed**:
    ```typescript
    async acquire(timeoutMs = 5000): Promise<boolean> {
      const start = Date.now()
      let delay = 50

      while (Date.now() - start < timeoutMs) {
        try {
          writeFileSync(this.lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' })
          this.held = true
          return true
        } catch (err: any) {
          if (err?.code !== 'EEXIST') {
            logger.error(`Lock acquire failed (non-EEXIST): ${err}`)
            return false
          }
          // Check if lock is stale
          try {
            const content = readFileSync(this.lockPath, 'utf-8')
            const [pidStr, timestampStr] = content.split('\n')
            const pid = parseInt(pidStr, 10)
            const timestamp = parseInt(timestampStr, 10)
            const LOCK_EXPIRY_MS = 60_000 // 1 minute

            const isStale = Date.now() - timestamp > LOCK_EXPIRY_MS
            let isProcessDead = false
            try { process.kill(pid, 0) } catch { isProcessDead = true }

            if (isStale || isProcessDead) {
              logger.warn(`Removing stale lock (pid=${pid}, age=${Date.now() - timestamp}ms)`)
              unlinkSync(this.lockPath)
              continue
            }
          } catch {
            // Lock file disappeared between check and read — retry
          }
          await Bun.sleep(delay)
          delay = Math.min(delay * 2, 500)
        }
      }
      logger.warn(`Failed to acquire lock after ${timeoutMs}ms`)
      return false
    }
    ```
  - **Why**: Process crash leaves orphaned lock file. PID check + expiry allows recovery.
  - **Test**: "should recover from stale lock left by dead process"
  - **Verify**: Create lock file with fake PID, acquire should succeed

### 3.2 Add Input Validation to MCP Tool Handlers

- [ ] Add validation in `src/mcp-server.ts` at `assign_task` handler (line 132)
  - **Fixed**: Add after argument destructuring:
    ```typescript
    // Validate inputs
    const MAX_PROMPT_LENGTH = 100 * 1024 // 100KB
    const MAX_NAME_LENGTH = 256

    if (!agent || typeof agent !== 'string' || agent.length > MAX_NAME_LENGTH) {
      return { content: [{ type: 'text', text: 'Invalid agent name' }], isError: true }
    }
    if (!prompt || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
      return { content: [{ type: 'text', text: `Prompt too large (max ${MAX_PROMPT_LENGTH} bytes)` }], isError: true }
    }
    if (!project || typeof project !== 'string' || project.length > MAX_NAME_LENGTH) {
      return { content: [{ type: 'text', text: 'Invalid project name' }], isError: true }
    }
    if (/[\x00-\x1f]/.test(project)) {
      return { content: [{ type: 'text', text: 'Project name contains control characters' }], isError: true }
    }
    if (model && (typeof model !== 'string' || model.length > MAX_NAME_LENGTH)) {
      return { content: [{ type: 'text', text: 'Invalid model name' }], isError: true }
    }
    ```
  - **Why**: No length/format validation enables OOM via giant prompts, null byte injection in paths.
  - **Test**: "should reject prompts larger than 100KB"
  - **Test**: "should reject project names with null bytes"

- [ ] Add `task_id` format validation in `get_task_status` and `get_task_result`
  - **Fixed**:
    ```typescript
    if (!task_id || typeof task_id !== 'string' || !/^[a-f0-9]{8,36}$/.test(task_id)) {
      return { content: [{ type: 'text', text: 'Invalid task_id format' }], isError: true }
    }
    ```

### 3.3 Add Concurrent Task Limit

- [ ] Enforce max running tasks in `src/mcp-server.ts` before task creation (line ~167)
  - **Fixed**: Add before creating task:
    ```typescript
    const MAX_CONCURRENT_RUNNING = 10
    const runningCount = [...activeTasks.values()].filter(t => t.status === 'running').length
    if (runningCount >= MAX_CONCURRENT_RUNNING) {
      return {
        content: [{ type: 'text', text: `Too many concurrent tasks (${runningCount}/${MAX_CONCURRENT_RUNNING}). Try again later.` }],
        isError: true,
      }
    }
    ```
  - **Why**: Unbounded `runAcpSession` calls can exhaust processes/memory.
  - **Test**: "should reject assign_task when at concurrency limit"

### 3.4 Use Full UUID for Task IDs

- [ ] Fix task ID generation in `src/mcp-server.ts` at line 164
  - **Current**: `const taskId = randomUUID().slice(0, 8)`
  - **Fixed**: `const taskId = randomUUID()`
  - **Why**: 8 chars = 32 bits entropy. Birthday collision at ~65K tasks.
  - **Test**: "should generate full UUID task IDs"

### 3.5 Add `.gitignore` for Local Config

- [ ] Create/update `.gitignore` to exclude local config
  - **Fixed**: Add to `.gitignore`:
    ```
    bridge.config.local.json
    bridge.log
    mcp-test-stderr.log
    *.tmp
    ```
  - **Why**: `bridge.config.local.json` contains host filesystem paths. Log files may contain secrets.

### 3.6 Validate Config on SIGHUP Reload

- [ ] Harden SIGHUP handler in `src/index.ts` at lines 131-139
  - **Current**:
    ```typescript
    const newConfig = await loadConfig(values.config!)
    Object.assign(config, newConfig)
    ```
  - **Fixed**:
    ```typescript
    const newConfig = await loadConfig(values.config!)
    // Deep replace — Object.assign is shallow
    for (const key of Object.keys(config) as (keyof BridgeConfig)[]) {
      delete (config as any)[key]
    }
    Object.assign(config, newConfig)
    logger.info('Config reloaded successfully')
    ```
  - **Why**: Shallow `Object.assign` leaves stale nested objects from old config.
