# Sprint 6: Code Compliance — Dead Code & Cleanup

**Goal**: Remove dead code, centralize version, fix unused params/imports
**Severity**: Low
**Estimated Effort**: Small (1-2 hours)

## Bugfix Tasks

### 6.1 Remove Unused Imports

- [ ] Remove unused imports in `src/result-writer.ts` at line 2
  - **Current**: `import { join, dirname } from 'path'`
  - **Fixed**: Remove line (neither `join` nor `dirname` is used)
  - **Why**: Dead imports clutter code and confuse readers.

### 6.2 Remove or Use Unused Parameter

- [ ] Fix `agentName` in `src/agent-adapters.ts` at line 12
  - **Current**: `export function buildSpawnConfig(agentName: string, agent: AgentConfig)`
  - **Fixed** (option A — remove): `export function buildSpawnConfig(agent: AgentConfig)`
    - Update call sites in `index.ts` and `mcp-server.ts`
  - **Fixed** (option B — use for logging):
    ```typescript
    export function buildSpawnConfig(agentName: string, agent: AgentConfig): AcpSpawnConfig {
      logger.debug(`Building spawn config for agent: ${agentName}`)
      // ...
    ```
  - **Why**: Unused params add confusion and trigger linter warnings.

### 6.3 Remove or Implement `permissions.autoApprove`

- [ ] Address unused config field in `src/config.ts` at line 25
  - **Current**: `permissions: { autoApprove: boolean }` — defined but never read
  - **Fixed** (option A): Remove from `BridgeConfig` and config files
  - **Fixed** (option B): Wire it into `acp-client.ts` permission handler:
    ```typescript
    // In acp-client.ts, pass config.permissions.autoApprove
    // If false, deny all permissions (require manual approval workflow)
    ```
  - **Why**: Misleading config field — users think setting `autoApprove: false` has an effect.

### 6.4 Remove Unused `ModelConfig` Fields

- [ ] Address unused fields in `src/config.ts` at lines 4-9
  - `ModelConfig.flag`, `ModelConfig.value`, `ModelConfig.provider` are defined but unused at runtime
  - **Fixed** (option A): Remove until needed
  - **Fixed** (option B): Add comment explaining they're reserved for non-ACP agent types
  - **Why**: Dead schema fields confuse maintainers about what's actually used.

### 6.5 Centralize Version String

- [ ] Replace hardcoded `0.1.0` across 4 files
  - Files: `src/index.ts:37`, `src/mcp-server.ts:48`, `src/manifest.ts:43`, `src/acp-client.ts:210`
  - **Fixed**: Create `src/version.ts`:
    ```typescript
    import pkg from '../package.json'
    export const VERSION = pkg.version
    ```
    Replace all `'0.1.0'` with `VERSION` import.
  - **Why**: Version drift when updating `package.json` but forgetting source files.

### 6.6 Add MCP Tool Name Convention Comment

- [ ] Add comment to `src/mcp-server.ts` at line 52
  - **Fixed**: Add above tool definitions:
    ```typescript
    // MCP tool names use snake_case per protocol convention
    // Internal TypeScript code uses camelCase
    ```
  - **Why**: Naming inconsistency (snake_case tools vs camelCase code) is intentional but undocumented.

### 6.7 Remove Absolute Path from PROTOCOL-NOTES.md

- [ ] Fix `src/PROTOCOL-NOTES.md` if it exists
  - Remove any absolute paths like `/Users/tonyholovka/workspace/...`
  - Replace with repo-relative references
  - **Why**: Leaks host filesystem structure, reduces portability.

### 6.8 Enable `noUnusedLocals` in TypeScript Config

- [ ] Update `tsconfig.json`
  - **Fixed**: Add to `compilerOptions`:
    ```json
    "noUnusedLocals": true,
    "noUnusedParameters": true
    ```
  - **Why**: Catches dead code at compile time. Run `bun run typecheck` to find all violations.
