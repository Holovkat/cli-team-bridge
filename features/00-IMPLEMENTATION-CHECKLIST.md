# CLI Team Bridge — Implementation Checklist

**Generated**: 2026-02-08
**Source**: Multi-agent code review (claude-code, codex, droid)
**Baseline Scores**: Security 32/100 | Compliance 60/100 | Feature Completeness 52/100

---

## Sprint 1: Security Critical Fixes
**Goal**: Close 2 CRITICAL + 1 HIGH vulnerability forming RCE chain
**Shard**: [`01-bugfix-security-critical.md`](./01-bugfix-security-critical.md)
**Severity**: Critical
**Priority**: P0 — Must fix before any deployment

### Tasks
- [x] 1.1 Fix path traversal in MCP `assign_task` (`mcp-server.ts`)
- [x] 1.2 Replace blanket auto-approve with permission controls (`acp-client.ts`)
- [x] 1.3 Stop leaking full `process.env` to child processes (`acp-client.ts`)

---

## Sprint 2: Security High-Priority Fixes
**Goal**: Close HIGH severity security gaps
**Shard**: [`02-bugfix-security-high.md`](./02-bugfix-security-high.md)
**Severity**: High
**Priority**: P0

### Tasks
- [x] 2.1 Add command allowlist validation (`config.ts`)
- [x] 2.2 Sanitize sensitive data from logs (`logger.ts`)
- [x] 2.3 Harden Dockerfile — non-root user, pin versions (`Dockerfile`)
- [x] 2.4 Restrict Docker volume mounts (`docker-compose.yml`)

---

## Sprint 3: Security Medium & Low Fixes
**Goal**: Close remaining security findings
**Shard**: [`03-bugfix-security-medium-low.md`](./03-bugfix-security-medium-low.md)
**Severity**: Medium / Low
**Priority**: P1

### Tasks
- [x] 3.1 Fix stale lock detection in lock manager (`lock-manager.ts`)
- [x] 3.2 Add input validation to MCP tool handlers (`mcp-server.ts`)
- [x] 3.3 Add concurrent task limit (`mcp-server.ts`)
- [x] 3.4 Use full UUID for task IDs (`mcp-server.ts`)
- [x] 3.5 Add `.gitignore` for local config and logs
- [x] 3.6 Validate config on SIGHUP reload (`index.ts`)

---

## Sprint 4: Code Compliance — Typing & Validation
**Goal**: Eliminate `as any` casts, add runtime validation
**Shard**: [`04-bugfix-compliance-typing.md`](./04-bugfix-compliance-typing.md)
**Severity**: High
**Priority**: P1

### Tasks
- [x] 4.1 Add runtime config validation with Zod (`config.ts`)
- [x] 4.2 Type `logging.level` properly (`config.ts`, `index.ts`)
- [x] 4.3 Add ACP SDK type definitions (new `acp-types.ts`)
- [x] 4.4 Fix untyped JSON parsing (`result-writer.ts`, `task-watcher.ts`)

---

## Sprint 5: Code Compliance — Error Handling & Async
**Goal**: Fix swallowed errors, async issues, stream cleanup
**Shard**: [`05-bugfix-compliance-error-handling.md`](./05-bugfix-compliance-error-handling.md)
**Severity**: Medium-High
**Priority**: P1

### Tasks
- [x] 5.1 Fix lock manager error masking (`lock-manager.ts`)
- [x] 5.2 Log errors in task watcher instead of swallowing (`task-watcher.ts`)
- [x] 5.3 Propagate errors from result writer (`result-writer.ts`)
- [x] 5.4 Fix async EventEmitter handler (`index.ts`)
- [x] 5.5 Fix stream listener cleanup (`acp-client.ts`)
- [x] 5.6 Cap agent output in memory (`acp-client.ts`)

---

## Sprint 6: Code Compliance — Dead Code & Cleanup
**Goal**: Remove dead code, centralize version, housekeeping
**Shard**: [`06-bugfix-compliance-cleanup.md`](./06-bugfix-compliance-cleanup.md)
**Severity**: Low
**Priority**: P2

### Tasks
- [x] 6.1 Remove unused imports (`result-writer.ts`)
- [x] 6.2 Remove or use unused `agentName` parameter (`agent-adapters.ts`)
- [x] 6.3 Remove or implement `permissions.autoApprove` (`config.ts`)
- [x] 6.4 Remove unused `ModelConfig` fields (`config.ts`)
- [x] 6.5 Centralize version string (new `version.ts`)
- [x] 6.6 Add MCP tool name convention comment (`mcp-server.ts`)
- [x] 6.7 Remove absolute paths from docs
- [x] 6.8 Enable `noUnusedLocals` in tsconfig

---

## Sprint 7: Production Resilience Features
**Goal**: Add retry, auth, persistence, cancellation, stuck task detection
**Shard**: [`07-feature-production-resilience.md`](./07-feature-production-resilience.md)
**Severity**: P0-P1 feature gaps
**Priority**: P0-P1

### Tasks
- [x] 7.1 Add retry logic with exponential backoff (new `retry.ts`)
- [x] 7.2 Add MCP authentication (`mcp-server.ts`)
- [x] 7.3 Add task persistence with SQLite (new `persistence.ts`)
- [x] 7.4 Add task cancellation MCP tool (`mcp-server.ts`, `acp-client.ts`)
- [x] 7.5 Add stuck task detection (`task-watcher.ts`)

---

## Sprint 8: Test Coverage
**Goal**: Add unit and integration tests for critical paths
**Shard**: [`08-feature-testing.md`](./08-feature-testing.md)
**Severity**: High
**Priority**: P1

### Tasks
- [x] 8.1 Set up test infrastructure (Bun test runner)
- [x] 8.2 Config validation tests
- [x] 8.3 Lock manager tests
- [x] 8.4 Path traversal tests
- [x] 8.5 Agent adapters tests
- [x] 8.6 Logger tests
- [x] 8.7 Result writer tests
- [x] 8.8 Task watcher tests
- [x] 8.9 MCP server integration tests

---

## Sprint 9: Production Features (P2)
**Goal**: Health checks, metrics, concurrency, degradation, streaming
**Shard**: [`09-feature-production-p2.md`](./09-feature-production-p2.md)
**Severity**: P2 feature gaps
**Priority**: P2

### Tasks
- [x] 9.1 Per-agent concurrency limits
- [x] 9.2 Agent health checks with circuit breaker
- [x] 9.3 Graceful degradation / fallback agent
- [x] 9.4 Metrics & observability (new `metrics.ts`)
- [x] 9.5 Streaming progress for long-running tasks
- [x] 9.6 Multi-team isolation
- [x] 9.7 Complete config hot-reload

---

## Sprint 10: Cross-Agent Communication
**Goal**: File-based messaging system enabling inter-agent communication, task requests, and workflow orchestration — all via MCP tools
**Shard**: [`10-feature-cross-agent-messaging.md`](./10-feature-cross-agent-messaging.md)
**Priority**: P1

### Phase 1: Message Bus Core
- [x] 10.1 Create message bus with file-based store (`src/message-bus.ts`)
- [x] 10.2 Create agent registry for active agent tracking (`src/agent-registry.ts`)
- [x] 10.3 Add message types to ACP types (`src/acp-types.ts`)

### Phase 2: Agent Mode MCP Tools
- [x] 10.4 Create agentmode MCP server (`src/mcp-agentmode.ts`)
- [x] 10.5 Wire agentmode MCP into ACP session spawn (`src/acp-client.ts`)
- [x] 10.6 Implement `wait_for_message` with timeout and cancellation

### Phase 3: Orchestrator Enhancements
- [x] 10.7 Add messaging tools to orchestrator MCP (`src/mcp-server.ts`)
- [x] 10.8 Implement workflow engine for task chaining (`src/workflow.ts`)
- [x] 10.9 Add context injection — prepend unread messages to agent prompts

### Phase 4: Lifecycle Management
- [x] 10.10 Agent heartbeat and dead agent detection
- [x] 10.11 Graceful shutdown and force kill flows
- [x] 10.12 Cleanup on bridge shutdown — kill all agents, clean up files

### Phase 5: Testing
- [x] 10.13 Unit tests for message bus and agent registry
- [ ] 10.14 Integration test: two agents exchange messages
- [ ] 10.15 Integration test: request/claim/respond flow
- [ ] 10.16 Integration test: workflow execution
- [ ] 10.17 End-to-end test: orchestrator + 3 agents with full messaging

---

## Progress Tracker

| Sprint | Shard | Tasks | Done | Status |
|--------|-------|-------|------|--------|
| 1 | Security Critical | 3 | 3 | **Complete** |
| 2 | Security High | 4 | 4 | **Complete** |
| 3 | Security Med/Low | 6 | 6 | **Complete** |
| 4 | Typing & Validation | 4 | 4 | **Complete** |
| 5 | Error Handling | 6 | 6 | **Complete** |
| 6 | Cleanup | 8 | 8 | **Complete** |
| 7 | Production Resilience | 5 | 5 | **Complete** |
| 8 | Testing | 9 | 9 | **Complete** |
| 9 | Production P2 | 7 | 7 | **Complete** |
| 10 | Cross-Agent Messaging | 17 | 13 | **In Progress** |
| **Total** | | **69** | **65** | **Sprint 10 Testing** |

### Target Scores After All Sprints
- Security: 32 → **85+**
- Code Compliance: 60 → **90+**
- Feature Completeness: 52 → **85+**
