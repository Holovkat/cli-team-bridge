# Sprint 1: Security Critical Fixes

**Goal**: Close the two CRITICAL vulnerabilities that together form a full RCE chain
**Severity**: Critical
**Estimated Effort**: Small (2-3 hours)

## Bugfix Tasks

### 1.1 Fix Path Traversal in MCP `assign_task`

- [ ] Fix path traversal in `src/mcp-server.ts` at lines 155-162
  - **Current**:
    ```typescript
    const projectPath = join(workspaceRoot, project)
    if (!existsSync(projectPath)) {
      return { content: [{ type: 'text', text: `Project path does not exist: ${projectPath}` }], isError: true }
    }
    ```
  - **Fixed**:
    ```typescript
    import { resolve, sep } from 'path'
    // ...
    const projectPath = resolve(workspaceRoot, project)
    const resolvedRoot = resolve(workspaceRoot)
    if (!projectPath.startsWith(resolvedRoot + sep) && projectPath !== resolvedRoot) {
      return {
        content: [{ type: 'text', text: `Project path escapes workspace root: ${project}` }],
        isError: true,
      }
    }
    if (!existsSync(projectPath)) {
      return { content: [{ type: 'text', text: `Project path does not exist: ${projectPath}` }], isError: true }
    }
    ```
  - **Why**: `join()` does not prevent `../..` from escaping the workspace root. `resolve()` + prefix check ensures containment.
  - **Test**: "should reject project paths containing `..` that escape workspace root"
  - **Verify**: Call `assign_task` with `project: "../../etc"` — must return error, not spawn agent

### 1.2 Replace Blanket Auto-Approve with Permission Controls

- [ ] Replace auto-approve in `src/acp-client.ts` at lines 155-167
  - **Current**:
    ```typescript
    requestPermission: async (params) => {
      const allowOption = params.options?.find(
        (o: any) => o.kind === 'allow_always' || o.kind === 'allow_once',
      )
      return {
        outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? 'allow' },
      } as any
    },
    ```
  - **Fixed**:
    ```typescript
    requestPermission: async (params) => {
      const toolTitle = params.toolCall?.title ?? 'unknown'

      // Deny destructive operations
      const DENIED_PATTERNS = [
        /rm\s+-rf/i, /git\s+push\s+--force/i, /git\s+reset\s+--hard/i,
        /DROP\s+TABLE/i, /DELETE\s+FROM/i, /shutdown/i,
      ]
      const description = JSON.stringify(params)
      if (DENIED_PATTERNS.some(p => p.test(description))) {
        logger.warn(`Permission DENIED (destructive): ${toolTitle}`)
        const denyOption = params.options?.find((o: any) => o.kind === 'deny')
        return {
          outcome: { outcome: 'selected', optionId: denyOption?.optionId ?? 'deny' },
        } as any
      }

      // Prefer allow_once over allow_always
      const allowOnce = params.options?.find((o: any) => o.kind === 'allow_once')
      const allowAlways = params.options?.find((o: any) => o.kind === 'allow_always')
      const selected = allowOnce ?? allowAlways

      logger.info(`Permission GRANTED (${selected?.kind ?? 'fallback'}): ${toolTitle}`)
      return {
        outcome: { outcome: 'selected', optionId: selected?.optionId ?? 'allow' },
      } as any
    },
    ```
  - **Why**: Blanket `allow_always` gives spawned agents permanent unrestricted access. Deny-list + `allow_once` limits blast radius.
  - **Test**: "should deny permission for destructive operations (rm -rf, force push)"
  - **Test**: "should prefer allow_once over allow_always"
  - **Verify**: Spawn agent, trigger destructive command — must be denied

### 1.3 Stop Leaking Full `process.env` to Child Processes

- [ ] Fix env passthrough in `src/acp-client.ts` at line 111
  - **Current**:
    ```typescript
    env: { ...process.env, ...config.env },
    ```
  - **Fixed**:
    ```typescript
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      SHELL: process.env['SHELL'] ?? '',
      TERM: process.env['TERM'] ?? '',
      LANG: process.env['LANG'] ?? '',
      NODE_ENV: process.env['NODE_ENV'] ?? '',
      ...config.env,
    },
    ```
  - **Why**: Full `process.env` exposes all API keys, secrets, SSH credentials to every child process. Allowlist approach passes only necessary vars.
  - **Test**: "should only pass allowlisted env vars to child process"
  - **Verify**: Inspect spawned process env — must not contain `ANTHROPIC_API_KEY` unless explicitly in agent config
