# cli-team-bridge — Multi-Agent Code Review

**Date**: 2026-02-08  
**Reviewers**: gemini (security), qwen (architecture), droid (code quality), codex (writer/coordinator)  
**Method**: Automated multi-agent review via cli-team-bridge cross-agent messaging

---

## Executive Summary

`cli-team-bridge` implements a pragmatic “bridge” between MCP (Model Context Protocol) tool invocations and ACP (Agent Client Protocol) agent sessions. The core design—MCP server mode (JSON-RPC over stdio) plus a watcher mode (file/task polling)—is modular and generally defensive: it validates inputs, constrains which agent executables may be launched, and includes multiple guardrails for process lifetime and output size.

The most important security posture observation is that the bridge is *not a sandbox*: agents run as normal local child processes with the user’s privileges. While there are meaningful mitigations (notably a strict environment-variable allowlist and strong project path traversal protections), any compromised or malicious agent binary can still cause damage within the user’s permission boundary. The current “destructive command filtering” is regex-based and can be bypassed trivially; treating it as a safety rail rather than a security boundary is essential.

Sprint 10’s cross-agent messaging (file-based message bus + agent registry) adds useful coordination primitives, but it introduces new integrity and reliability concerns (disk full, partial writes, corrupted JSON, silent drops) and appears insufficiently isolated from production-critical bridge paths. Tightening the boundary (feature flag / optional plugin), improving persistence discipline (atomic writes, error propagation), and hardening local-state assumptions would materially improve robustness.

---

## Security Analysis

### What’s Strong

- **Environment variable allowlist (High impact)**  
  `src/acp-client.ts` spawns agents with a strict allowlist of environment variables rather than inheriting `process.env`. This materially reduces the chance of accidental secret leakage (tokens, cloud creds, CI secrets) into agent processes.

- **Path traversal protection for project roots (High impact)**  
  `src/mcp-server.ts` resolves requested project paths against a configured `workspaceRoot` and verifies containment (e.g., `startsWith(resolvedRoot + sep)`), effectively mitigating `../../..` traversal attempts. It also checks that the target project directory exists before use.

- **Input validation and bounds checking (Low–Medium impact)**  
  `src/mcp-server.ts` enforces size limits (e.g., prompt max ~100KB) and validates identifiers (UUID formatting) and project names (no control characters).

- **Executable command allowlist (Low impact, but correct control)**  
  `src/config.ts` restricts configurable agent commands to a known allowlist (e.g., `codex-acp`, `claude-code-acp`, etc.), reducing configuration-based RCE risk.

- **Output buffer caps (Medium impact)**  
  `src/acp-client.ts` caps captured stdout (~128KB) and stderr (~64KB), reducing DoS risk from runaway verbose agent output.

- **Safer default permission mode (“allow once”) (Low impact)**  
  Defaulting to `allow_once` instead of `allow_always` reduces the blast radius when tool permission prompts are involved.

### Key Risks / Gaps

- **No real sandboxing for agents (Medium→High)**  
  Agents execute directly on the host with the user’s privileges. If an agent executable is compromised, or if the agent follows malicious instructions, the bridge cannot prevent filesystem/network actions beyond best-effort policy.

- **Transport-layer trust assumption (Low, but notable)**  
  `src/mcp-server.ts` implicitly trusts the stdio transport (“trust parent process”). This is typical for local MCP, but if the transport evolves (HTTP/WebSocket), the current model does not authenticate/authorize clients.

- **Regex-based “destructive command” blocking is bypassable (Medium)**  
  The current approach in `src/acp-client.ts` denies a small set of destructive patterns using regex (e.g., `/rm\s+-rf/i`). This is brittle and should not be treated as a security control.

  **Concrete bypass list (examples):**
  - Alternative flags: `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`
  - Shell expansion/IFS tricks: `rm -r${IFS}-f /`
  - Different utilities: `find . -delete`, `rsync -r --delete empty/ target/`, `mv directory /dev/null`
  - Via interpreters: `python -c "import shutil; shutil.rmtree('/')"`
  - Obfuscation: `echo cm0gLXJmIC8K | base64 -d | sh`
  - DoS: fork bomb `:(){ :|:& };:`

### Recommendations (Security Controls, ranked by robustness)

1. **Containerization / sandboxing (gold standard)**  
   Run agent binaries inside ephemeral containers (Docker/Podman) or OS sandboxes (e.g., `bubblewrap` on Linux, `sandbox-exec`/Seatbelt on macOS where feasible). Mount the workspace as a controlled volume; restrict network and filesystem by default.

2. **Shell avoidance + structured exec (robust and feasible)**  
   Ensure `spawn` is never run with `shell: true`. Prefer structured execution of tools where the binary and args are separated (no shell parsing).

3. **Replace deny-list with allow-list for tool execution**  
   Enforce a strict allowlist of permitted tool binaries (and possibly subcommands). Block everything else by default. This is far safer than trying to enumerate “bad” commands.

---

## Architecture Review

### Core Bridge Pattern (Validated)

- **Bridge design is conceptually sound**: MCP requests are translated into ACP sessions, isolating protocol concerns from agent execution.
- **Two operational modes**:
  - **MCP server mode**: JSON-RPC over stdio handled by `src/mcp-server.ts`.
  - **Watcher mode**: file/task polling handled by `src/task-watcher.ts` and `src/index.ts` orchestration.
- **Separation of responsibilities (mostly good)**:
  - `mcp-server.ts`: MCP protocol handling and tool surfaces
  - `acp-client.ts`: agent process/session management
  - `config.ts`: centralized configuration and validation
  - `persistence.ts`: recovery of task state across restarts

### Corrections to Earlier Architecture Claims (Follow-up)

The follow-up review explicitly notes several *non-existent* features that were previously implied:

- **Workflow DAG engine**: ❌ Not implemented  
  No dependency graph / DAG orchestration found; tasks are not scheduled via a workflow engine.

- **Health checks**: ❌ Not implemented  
  No endpoints/probes/heartbeats exposed as a health-check system.

- **Metrics**: ❌ Not implemented  
  No Prometheus/OTel metrics; only logging.

- **SIGHUP reload**: ❌ Not implemented  
  No SIGHUP signal reload handlers; config changes require restart.

- **Per-agent concurrency limits**: ❌ Not implemented  
  No explicit per-agent concurrency throttling; multiple agents can run simultaneously.

### Bridge Core vs Messaging Boundary

- **Production-critical “bridge core”**:
  - `mcp-server.ts`, `acp-client.ts`, `task-watcher.ts`, `persistence.ts`

- **Experimental cross-agent messaging (Sprint 10)**:
  - `message-bus.ts`, `agent-registry.ts`

**Boundary concern**: The experimental messaging components appear too tightly coupled into core processing paths rather than being a clearly optional module. This increases the blast radius of messaging-layer failures (e.g., disk full, corrupted JSON) impacting core bridging.

### Failure Modes & Recovery (Key Scenarios)

- **Disk full / write failures**:
  - Messaging/registry writes can fail; some paths may fail silently or without user-visible surfacing.
- **Corrupted JSON / partial writes**:
  - File-based state can corrupt; recovery behavior varies (some modules warn and skip, others may throw).
- **Operational resilience**:
  - Process lifecycle management (timeouts, safe kill) is a strong point, but persistence/messaging write discipline needs hardening (atomic writes, stronger error propagation).

---

## Code Quality Assessment

### Strengths

- **Runtime schema validation with Zod** (`config.ts`)  
  The `BridgeConfigSchema` pattern is a strong foundation for safe configuration handling.

- **Good use of TypeScript modeling**  
  Discriminated unions for statuses and separated ACP types (`acp-types.ts`) improve clarity.

- **Broad unit test presence**  
  Many modules have targeted tests (config, watcher, persistence, messaging), which is above-average for a CLI orchestration tool.

### Must-Fix Issues (Top 5, prioritized by impact/risk)

| Priority | Issue | Location | Why it matters |
|---|---|---|---|
| **P1** | `processing` set leak on unhandled error | `src/index.ts` around task assignment handling | Tasks can get stuck “in processing” forever, blocking retries |
| **P2** | Registry `save()` can throw unhandled | `src/agent-registry.ts` | Risks registry corruption and agent state loss |
| **P3** | Message bus can drop/lose messages silently | `src/message-bus.ts` | Reliability issue; operators won’t know messages were lost |
| **P4** | `as any` casts around ACP SDK calls | `src/acp-client.ts` | Type safety bypass; future SDK changes can break at runtime |
| **P5** | Readability: IIFE for task retrieval | `src/mcp-server.ts` | Harder to maintain and test; simple helper would clarify flow |

Additional notable issues:
- `src/mcp-server.ts`: workflow execution errors are logged but not clearly propagated to the user (reduces debuggability and correctness guarantees).
- Missing/limited runtime validation for some MCP handler `args` shapes beyond basic presence checks (risk of unexpected runtime errors).

### Test Coverage Snapshot (from findings)

- **Good**: `message-bus.test.ts`, `agent-registry.test.ts`, `config.test.ts`, `task-watcher.test.ts`, `persistence.test.ts`
- **Basic/minimal**: `lock-manager.test.ts` (missing stale-lock scenario), `agent-adapters.test.ts` (env passing only), `result-writer.test.ts` (basic paths), `logger.test.ts` (smoke-level)

---

## Cross-Agent Messaging System (Sprint 10)

### What it is

- **MessageBus (`message-bus.ts`)**: file-based message passing (direct, broadcast, request/response patterns in tests)
- **AgentRegistry (`agent-registry.ts`)**: discovery/coordination state (CRUD, heartbeat/dead detection, pruning)

State is stored under a local directory (noted in the review prompts as `.claude/bridge`), making it easy to inspect and debug, but inherently subject to filesystem semantics and local-process threats.

### Strengths

- **Conceptual separation exists at module level**: messaging/registry are distinct from MCP/ACP bridging modules.
- **Graceful degradation in places**: corrupted message files may be skipped with warnings rather than crashing (good operational behavior).

### Reliability & Operational Risks

- **Silent failures**:
  - `message-bus.ts` can return early when message directories don’t exist (should warn/propagate).
- **Persistence robustness**:
  - `agent-registry.ts` `save()` may throw without containment; corruption/partial write risks exist.
- **Disk-full and partial-write behavior**:
  - File-based IPC requires explicit atomic write patterns and clear failure surfacing; otherwise, message loss and inconsistent registry state are likely under stress.

### Security / Threat Model Considerations (local filesystem IPC)

- **Same-user process threat** (most relevant): Any process running as the same OS user can typically read/modify `.claude/bridge` unless permissions are tightened. This enables message injection, replay, deletion, and registry spoofing by a malicious local process.
- **Different-user threat**: Mitigated primarily by standard directory permissions, assuming no overly-permissive modes and no shared group/world writable directories.

**Hardening options (practical):**
- Enforce restrictive directory permissions (e.g., `0700`) on `.claude/bridge` and subdirectories.
- Use **atomic writes** (write temp file + fsync + rename) for registry and message enqueues.
- Add **lock discipline** around registry/message operations (avoid concurrent writers clobbering state).
- Add **replay protection** (monotonic sequence numbers, timestamps with acceptance windows).
- Consider **message authentication** (HMAC/signatures) if the threat model includes same-user untrusted processes; note that protecting the signing key is non-trivial without OS keychain support or sandboxing.

### Boundary Recommendation

Treat Sprint 10 messaging as **optional/experimental** until:
- write-path failures are surfaced reliably,
- persistence is made atomic,
- and the bridge core can operate safely even if messaging fails.

---

## Recommendations

### P0 (Security posture / blast-radius)
- **Run agents in a sandbox/container** by default (or provide a “secure mode” profile).
- **Remove reliance on regex-based destructive command blocking** as a security measure; replace with allowlisted, structured tool execution and “no shell” enforcement.

### P1 (Reliability correctness)
- Fix the **stuck processing-set** issue in `src/index.ts` so failures always clean up and tasks can retry.
- Make `agent-registry` persistence **atomic and exception-safe** (catch, write temp, rename).
- Ensure `message-bus` **never fails silently** (warn and/or propagate error; add observable counters).

### P2 (Maintainability / future-proofing)
- Replace `as any` ACP SDK calls with proper interfaces/types and (where feasible) runtime validation.
- Refactor `mcp-server.ts` IIFE task retrieval into a helper for readability and testability.
- Improve user-facing error propagation for workflow/tool failures (avoid “log-only” failure modes).

### P3 (Observability & operations)
- Add minimal metrics (even just counters) for:
  - message write failures / dropped messages
  - registry save failures
  - agent spawn failures / timeouts
- Document the threat model and operational assumptions for `.claude/bridge`.

---

## Scores

- **Security: 68/100**  
  Strong env/path controls and bounds checking, but unsandboxed execution plus bypassable command filtering meaningfully elevate risk.

- **Architecture: 70/100**  
  Solid bridge core and modularity, but earlier “feature claims” were incorrect, and experimental messaging appears insufficiently isolated from core reliability.

- **Code Quality: 74/100**  
  Good TS/Zod patterns and decent tests, but several must-fix correctness/reliability issues (processing leak, atomic persistence, silent failures) should be addressed promptly.

- **Overall: 70/100**  
  A solid foundation with clear next steps: sandboxing/allowlists for security, and a handful of targeted reliability fixes to make the bridge and Sprint 10 messaging production-ready.# cli-team-bridge — Multi-Agent Code Review

**Date**: 2026-02-08  
**Reviewers**: gemini (security), qwen (architecture), droid (code quality), codex (writer/coordinator)  
**Method**: Automated multi-agent review via cli-team-bridge cross-agent messaging

---

## Executive Summary

`cli-team-bridge` implements a pragmatic “bridge” between MCP (Model Context Protocol) tool invocations and ACP (Agent Client Protocol) agent sessions. The core design—MCP server mode (JSON-RPC over stdio) plus a watcher mode (file/task polling)—is modular and generally defensive: it validates inputs, constrains which agent executables may be launched, and includes multiple guardrails for process lifetime and output size.

The most important security posture observation is that the bridge is *not a sandbox*: agents run as normal local child processes with the user’s privileges. While there are meaningful mitigations (notably a strict environment-variable allowlist and strong project path traversal protections), any compromised or malicious agent binary can still cause damage within the user’s permission boundary. The current “destructive command filtering” is regex-based and can be bypassed trivially; treating it as a safety rail rather than a security boundary is essential.

Sprint 10’s cross-agent messaging (file-based message bus + agent registry) adds useful coordination primitives, but it introduces new integrity and reliability concerns (disk full, partial writes, corrupted JSON, silent drops) and appears insufficiently isolated from production-critical bridge paths. Tightening the boundary (feature flag / optional plugin), improving persistence discipline (atomic writes, error propagation), and hardening local-state assumptions would materially improve robustness.

---

## Security Analysis

### What’s Strong

- **Environment variable allowlist (High impact)**  
  `src/acp-client.ts` spawns agents with a strict allowlist of environment variables rather than inheriting `process.env`. This materially reduces the chance of accidental secret leakage (tokens, cloud creds, CI secrets) into agent processes.

- **Path traversal protection for project roots (High impact)**  
  `src/mcp-server.ts` resolves requested project paths against a configured `workspaceRoot` and verifies containment (e.g., `startsWith(resolvedRoot + sep)`), effectively mitigating `../../..` traversal attempts. It also checks that the target project directory exists before use.

- **Input validation and bounds checking (Low–Medium impact)**  
  `src/mcp-server.ts` enforces size limits (e.g., prompt max ~100KB) and validates identifiers (UUID formatting) and project names (no control characters).

- **Executable command allowlist (Low impact, but correct control)**  
  `src/config.ts` restricts configurable agent commands to a known allowlist (e.g., `codex-acp`, `claude-code-acp`, etc.), reducing configuration-based RCE risk.

- **Output buffer caps (Medium impact)**  
  `src/acp-client.ts` caps captured stdout (~128KB) and stderr (~64KB), reducing DoS risk from runaway verbose agent output.

- **Safer default permission mode (“allow once”) (Low impact)**  
  Defaulting to `allow_once` instead of `allow_always` reduces the blast radius when tool permission prompts are involved.

### Key Risks / Gaps

- **No real sandboxing for agents (Medium→High)**  
  Agents execute directly on the host with the user’s privileges. If an agent executable is compromised, or if the agent follows malicious instructions, the bridge cannot prevent filesystem/network actions beyond best-effort policy.

- **Transport-layer trust assumption (Low, but notable)**  
  `src/mcp-server.ts` implicitly trusts the stdio transport (“trust parent process”). This is typical for local MCP, but if the transport evolves (HTTP/WebSocket), the current model does not authenticate/authorize clients.

- **Regex-based “destructive command” blocking is bypassable (Medium)**  
  The current approach in `src/acp-client.ts` denies a small set of destructive patterns using regex (e.g., `/rm\s+-rf/i`). This is brittle and should not be treated as a security control.

  **Concrete bypass list (examples):**
  - Alternative flags: `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`
  - Shell expansion/IFS tricks: `rm -r${IFS}-f /`
  - Different utilities: `find . -delete`, `rsync -r --delete empty/ target/`, `mv directory /dev/null`
  - Via interpreters: `python -c "import shutil; shutil.rmtree('/')"`
  - Obfuscation: `echo cm0gLXJmIC8K | base64 -d | sh`
  - DoS: fork bomb `:(){ :|:& };:`

### Recommendations (Security Controls, ranked by robustness)

1. **Containerization / sandboxing (gold standard)**  
   Run agent binaries inside ephemeral containers (Docker/Podman) or OS sandboxes (e.g., `bubblewrap` on Linux, `sandbox-exec`/Seatbelt on macOS where feasible). Mount the workspace as a controlled volume; restrict network and filesystem by default.

2. **Shell avoidance + structured exec (robust and feasible)**  
   Ensure `spawn` is never run with `shell: true`. Prefer structured execution of tools where the binary and args are separated (no shell parsing).

3. **Replace deny-list with allow-list for tool execution**  
   Enforce a strict allowlist of permitted tool binaries (and possibly subcommands). Block everything else by default. This is far safer than trying to enumerate “bad” commands.

---

## Architecture Review

### Core Bridge Pattern (Validated)

- **Bridge design is conceptually sound**: MCP requests are translated into ACP sessions, isolating protocol concerns from agent execution.
- **Two operational modes**:
  - **MCP server mode**: JSON-RPC over stdio handled by `src/mcp-server.ts`.
  - **Watcher mode**: file/task polling handled by `src/task-watcher.ts` and `src/index.ts` orchestration.
- **Separation of responsibilities (mostly good)**:
  - `mcp-server.ts`: MCP protocol handling and tool surfaces
  - `acp-client.ts`: agent process/session management
  - `config.ts`: centralized configuration and validation
  - `persistence.ts`: recovery of task state across restarts

### Corrections to Earlier Architecture Claims (Follow-up)

The follow-up review explicitly notes several *non-existent* features that were previously implied:

- **Workflow DAG engine**: ❌ Not implemented  
  No dependency graph / DAG orchestration found; tasks are not scheduled via a workflow engine.

- **Health checks**: ❌ Not implemented  
  No endpoints/probes/heartbeats exposed as a health-check system.

- **Metrics**: ❌ Not implemented  
  No Prometheus/OTel metrics; only logging.

- **SIGHUP reload**: ❌ Not implemented  
  No SIGHUP signal reload handlers; config changes require restart.

- **Per-agent concurrency limits**: ❌ Not implemented  
  No explicit per-agent concurrency throttling; multiple agents can run simultaneously.

### Bridge Core vs Messaging Boundary

- **Production-critical “bridge core”**:
  - `mcp-server.ts`, `acp-client.ts`, `task-watcher.ts`, `persistence.ts`

- **Experimental cross-agent messaging (Sprint 10)**:
  - `message-bus.ts`, `agent-registry.ts`

**Boundary concern**: The experimental messaging components appear too tightly coupled into core processing paths rather than being a clearly optional module. This increases the blast radius of messaging-layer failures (e.g., disk full, corrupted JSON) impacting core bridging.

### Failure Modes & Recovery (Key Scenarios)

- **Disk full / write failures**:
  - Messaging/registry writes can fail; some paths may fail silently or without user-visible surfacing.
- **Corrupted JSON / partial writes**:
  - File-based state can corrupt; recovery behavior varies (some modules warn and skip, others may throw).
- **Operational resilience**:
  - Process lifecycle management (timeouts, safe kill) is a strong point, but persistence/messaging write discipline needs hardening (atomic writes, stronger error propagation).

---

## Code Quality Assessment

### Strengths

- **Runtime schema validation with Zod** (`config.ts`)  
  The `BridgeConfigSchema` pattern is a strong foundation for safe configuration handling.

- **Good use of TypeScript modeling**  
  Discriminated unions for statuses and separated ACP types (`acp-types.ts`) improve clarity.

- **Broad unit test presence**  
  Many modules have targeted tests (config, watcher, persistence, messaging), which is above-average for a CLI orchestration tool.

### Must-Fix Issues (Top 5, prioritized by impact/risk)

| Priority | Issue | Location | Why it matters |
|---|---|---|---|
| **P1** | `processing` set leak on unhandled error | `src/index.ts` around task assignment handling | Tasks can get stuck “in processing” forever, blocking retries |
| **P2** | Registry `save()` can throw unhandled | `src/agent-registry.ts` | Risks registry corruption and agent state loss |
| **P3** | Message bus can drop/lose messages silently | `src/message-bus.ts` | Reliability issue; operators won’t know messages were lost |
| **P4** | `as any` casts around ACP SDK calls | `src/acp-client.ts` | Type safety bypass; future SDK changes can break at runtime |
| **P5** | Readability: IIFE for task retrieval | `src/mcp-server.ts` | Harder to maintain and test; simple helper would clarify flow |

Additional notable issues:
- `src/mcp-server.ts`: workflow execution errors are logged but not clearly propagated to the user (reduces debuggability and correctness guarantees).
- Missing/limited runtime validation for some MCP handler `args` shapes beyond basic presence checks (risk of unexpected runtime errors).

### Test Coverage Snapshot (from findings)

- **Good**: `message-bus.test.ts`, `agent-registry.test.ts`, `config.test.ts`, `task-watcher.test.ts`, `persistence.test.ts`
- **Basic/minimal**: `lock-manager.test.ts` (missing stale-lock scenario), `agent-adapters.test.ts` (env passing only), `result-writer.test.ts` (basic paths), `logger.test.ts` (smoke-level)

---

## Cross-Agent Messaging System (Sprint 10)

### What it is

- **MessageBus (`message-bus.ts`)**: file-based message passing (direct, broadcast, request/response patterns in tests)
- **AgentRegistry (`agent-registry.ts`)**: discovery/coordination state (CRUD, heartbeat/dead detection, pruning)

State is stored under a local directory (noted in the review prompts as `.claude/bridge`), making it easy to inspect and debug, but inherently subject to filesystem semantics and local-process threats.

### Strengths

- **Conceptual separation exists at module level**: messaging/registry are distinct from MCP/ACP bridging modules.
- **Graceful degradation in places**: corrupted message files may be skipped with warnings rather than crashing (good operational behavior).

### Reliability & Operational Risks

- **Silent failures**:
  - `message-bus.ts` can return early when message directories don’t exist (should warn/propagate).
- **Persistence robustness**:
  - `agent-registry.ts` `save()` may throw without containment; corruption/partial write risks exist.
- **Disk-full and partial-write behavior**:
  - File-based IPC requires explicit atomic write patterns and clear failure surfacing; otherwise, message loss and inconsistent registry state are likely under stress.

### Security / Threat Model Considerations (local filesystem IPC)

- **Same-user process threat** (most relevant): Any process running as the same OS user can typically read/modify `.claude/bridge` unless permissions are tightened. This enables message injection, replay, deletion, and registry spoofing by a malicious local process.
- **Different-user threat**: Mitigated primarily by standard directory permissions, assuming no overly-permissive modes and no shared group/world writable directories.

**Hardening options (practical):**
- Enforce restrictive directory permissions (e.g., `0700`) on `.claude/bridge` and subdirectories.
- Use **atomic writes** (write temp file + fsync + rename) for registry and message enqueues.
- Add **lock discipline** around registry/message operations (avoid concurrent writers clobbering state).
- Add **replay protection** (monotonic sequence numbers, timestamps with acceptance windows).
- Consider **message authentication** (HMAC/signatures) if the threat model includes same-user untrusted processes; note that protecting the signing key is non-trivial without OS keychain support or sandboxing.

### Boundary Recommendation

Treat Sprint 10 messaging as **optional/experimental** until:
- write-path failures are surfaced reliably,
- persistence is made atomic,
- and the bridge core can operate safely even if messaging fails.

---

## Recommendations

### P0 (Security posture / blast-radius)
- **Run agents in a sandbox/container** by default (or provide a “secure mode” profile).
- **Remove reliance on regex-based destructive command blocking** as a security measure; replace with allowlisted, structured tool execution and “no shell” enforcement.

### P1 (Reliability correctness)
- Fix the **stuck processing-set** issue in `src/index.ts` so failures always clean up and tasks can retry.
- Make `agent-registry` persistence **atomic and exception-safe** (catch, write temp, rename).
- Ensure `message-bus` **never fails silently** (warn and/or propagate error; add observable counters).

### P2 (Maintainability / future-proofing)
- Replace `as any` ACP SDK calls with proper interfaces/types and (where feasible) runtime validation.
- Refactor `mcp-server.ts` IIFE task retrieval into a helper for readability and testability.
- Improve user-facing error propagation for workflow/tool failures (avoid “log-only” failure modes).

### P3 (Observability & operations)
- Add minimal metrics (even just counters) for:
  - message write failures / dropped messages
  - registry save failures
  - agent spawn failures / timeouts
- Document the threat model and operational assumptions for `.claude/bridge`.

---

## Scores

- **Security: 68/100**  
  Strong env/path controls and bounds checking, but unsandboxed execution plus bypassable command filtering meaningfully elevate risk.

- **Architecture: 70/100**  
  Solid bridge core and modularity, but earlier “feature claims” were incorrect, and experimental messaging appears insufficiently isolated from core reliability.

- **Code Quality: 74/100**  
  Good TS/Zod patterns and decent tests, but several must-fix correctness/reliability issues (processing leak, atomic persistence, silent failures) should be addressed promptly.

- **Overall: 70/100**  
  A solid foundation with clear next steps: sandboxing/allowlists for security, and a handful of targeted reliability fixes to make the bridge and Sprint 10 messaging production-ready.