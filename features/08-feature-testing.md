# Sprint 8: Test Coverage

**Goal**: Add unit and integration tests for critical paths
**Severity**: High (code compliance requirement)
**Estimated Effort**: Medium (4-6 hours)

## Setup Tasks

### 8.1 Set Up Test Infrastructure

- [ ] Configure Bun test runner
  - Bun has built-in test runner — no extra dependencies needed
  - Create test directory structure:
    ```
    tests/
      unit/
        config.test.ts
        lock-manager.test.ts
        logger.test.ts
        agent-adapters.test.ts
        result-writer.test.ts
        task-watcher.test.ts
      integration/
        mcp-server.test.ts
        acp-client.test.ts
    ```
  - Add test script to `package.json`:
    ```json
    "test": "bun test",
    "test:watch": "bun test --watch"
    ```

## Unit Test Tasks

### 8.2 Config Validation Tests

- [ ] Create `tests/unit/config.test.ts`
  - "should load valid config file"
  - "should throw on missing config file"
  - "should throw when no agents defined"
  - "should throw when agent missing command"
  - "should throw when defaultModel not in models"
  - "should reject config with unknown command" (after allowlist added)
  - "should detect agent availability via which command"
  - "should return available models for ACP agents"

### 8.3 Lock Manager Tests

- [ ] Create `tests/unit/lock-manager.test.ts`
  - "should acquire lock on first attempt"
  - "should fail to acquire when lock held by another"
  - "should release lock successfully"
  - "should timeout after specified duration"
  - "should recover from stale lock (dead PID)"
  - "should fail immediately on EACCES (not loop)"
  - "should handle concurrent acquire attempts"

### 8.4 Path Traversal Tests

- [ ] Create `tests/unit/path-validation.test.ts`
  - "should allow valid project paths within workspace"
  - "should reject ../.. path traversal"
  - "should reject absolute paths"
  - "should reject paths with null bytes"
  - "should reject symlinks escaping workspace" (if applicable)

### 8.5 Agent Adapters Tests

- [ ] Create `tests/unit/agent-adapters.test.ts`
  - "should build spawn config with correct command and args"
  - "should pass through agent-specific env vars"
  - "should pass model-specific keyEnv when set"
  - "should not include unset env vars"

### 8.6 Logger Tests

- [ ] Create `tests/unit/logger.test.ts`
  - "should respect log level filtering"
  - "should format messages with ISO timestamp"
  - "should write to file when configured"
  - "should redact API keys from log output" (after sanitizer added)

### 8.7 Result Writer Tests

- [ ] Create `tests/unit/result-writer.test.ts`
  - "should write task result with atomic rename"
  - "should truncate output exceeding MAX_OUTPUT_LENGTH"
  - "should return false on write failure"
  - "should mark task as in_progress"

### 8.8 Task Watcher Tests

- [ ] Create `tests/unit/task-watcher.test.ts`
  - "should emit task-assigned for pending tasks owned by known agents"
  - "should skip tasks not in pending status"
  - "should skip tasks owned by unknown agents"
  - "should skip blocked tasks"
  - "should not re-emit tasks already processing"
  - "should log debug for malformed task files"

## Integration Test Tasks

### 8.9 MCP Server Integration Tests

- [ ] Create `tests/integration/mcp-server.test.ts`
  - "list_agents should return configured agents"
  - "assign_task should reject unknown agent"
  - "assign_task should reject unavailable agent"
  - "assign_task should reject path traversal"
  - "assign_task should reject oversized prompt"
  - "assign_task should enforce concurrency limit"
  - "get_task_status should return running task"
  - "get_task_result should return completed task output"
  - "get_task_result should indicate still running"
