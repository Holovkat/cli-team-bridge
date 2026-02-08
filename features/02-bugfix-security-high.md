# Sprint 2: Security High-Priority Fixes

**Goal**: Close HIGH severity security gaps — command injection, secrets in logs, Docker hardening
**Severity**: High
**Estimated Effort**: Medium (4-6 hours)

## Bugfix Tasks

### 2.1 Add Command Allowlist Validation

- [ ] Validate agent `command` against allowlist in `src/config.ts` at lines 43-58
  - **Current**:
    ```typescript
    if (!agent.command) throw new Error(`Agent "${name}" missing command`)
    ```
  - **Fixed**:
    ```typescript
    const ALLOWED_COMMANDS = new Set([
      'codex-acp', 'claude-code-acp', 'droid-acp',
    ])
    if (!agent.command) throw new Error(`Agent "${name}" missing command`)
    if (!ALLOWED_COMMANDS.has(agent.command)) {
      throw new Error(`Agent "${name}" command "${agent.command}" not in allowlist: ${[...ALLOWED_COMMANDS].join(', ')}`)
    }
    ```
  - **Why**: Config file compromise allows arbitrary command execution via `spawn()`. Allowlist ensures only known ACP adapter binaries run.
  - **Test**: "should reject config with unknown command"
  - **Verify**: Set `command: "/bin/bash"` in config — must throw at load

### 2.2 Sanitize Sensitive Data from Logs

- [ ] Add log sanitizer in `src/logger.ts`
  - **Current**: No sanitization — raw strings logged
  - **Fixed**: Add before `formatMessage()`:
    ```typescript
    const SECRET_PATTERNS = [
      /sk-[a-zA-Z0-9_-]{20,}/g,          // OpenAI keys
      /anthropic-[a-zA-Z0-9_-]{20,}/g,    // Anthropic keys
      /ghp_[a-zA-Z0-9]{36}/g,             // GitHub PATs
      /Bearer\s+[a-zA-Z0-9._-]+/gi,       // Bearer tokens
      /api[_-]?key[=:]\s*[^\s,}]+/gi,     // Generic API keys
    ]

    function sanitize(message: string): string {
      let result = message
      for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]')
      }
      return result
    }
    ```
    Apply `sanitize()` in `formatMessage()`.
  - **Why**: stderr capture (`acp-client.ts:281`), full output logging (`result-writer.ts:40`), and spawn args (`acp-client.ts:104`) can all contain secrets.
  - **Test**: "should redact OpenAI API keys from log output"
  - **Verify**: Log a string containing `sk-proj-abc123...` — must show `[REDACTED]`

- [ ] Set restrictive permissions on log file in `src/logger.ts`
  - **Fixed**: After first write, `chmodSync(logFile, 0o600)`
  - **Why**: Log file in working directory readable by any user

### 2.3 Harden Dockerfile — Non-Root User

- [ ] Add non-root user to `Dockerfile`
  - **Current**: No `USER` directive, runs as root
  - **Fixed**: Add after `RUN mkdir -p`:
    ```dockerfile
    RUN groupadd -r bridge && useradd -r -g bridge -d /home/bridge -s /bin/bash bridge
    RUN mkdir -p /home/bridge/.codex /home/bridge/.factory /home/bridge/.claude
    RUN chown -R bridge:bridge /home/bridge /app

    USER bridge
    ```
  - **Why**: Root in container + RW volume mounts = host compromise path

- [ ] Pin Docker image versions in `Dockerfile`
  - **Current**: `FROM oven/bun:latest`, `@latest` for all global installs
  - **Fixed**: Pin to specific versions:
    ```dockerfile
    FROM oven/bun:1.2.0
    RUN bun install -g @zed-industries/codex-acp@0.14.1
    ```
  - **Why**: `latest` tags cause non-reproducible builds and supply chain risk

### 2.4 Restrict Docker Volume Mounts

- [ ] Tighten `docker-compose.yml` volume mounts at line 7-8
  - **Current**:
    ```yaml
    - /Users/tonyholovka/.claude:/root/.claude
    - /Users/tonyholovka/workspace:/workspace:ro
    ```
  - **Fixed**:
    ```yaml
    - /Users/tonyholovka/.claude/tasks:/home/bridge/.claude/tasks  # Only tasks subdir
    - /Users/tonyholovka/workspace:/workspace:ro
    ```
  - **Why**: Full `.claude` directory contains auth tokens, session data, settings. Only tasks subdir needed.

- [ ] Add security options to `docker-compose.yml`:
    ```yaml
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    ```
