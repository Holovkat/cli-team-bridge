# Sprint 4: Code Compliance — Typing & Validation

**Goal**: Eliminate `as any` casts, add runtime config validation, fix type safety
**Severity**: High
**Estimated Effort**: Medium (4-6 hours)

## Bugfix Tasks

### 4.1 Add Runtime Config Validation with Zod

- [ ] Install zod and add schema validation to `src/config.ts`
  - **Current**: `const config: BridgeConfig = await file.json()` — trusts unvalidated JSON
  - **Fixed**:
    ```bash
    bun add zod
    ```
    ```typescript
    import { z } from 'zod'

    const ModelConfigSchema = z.object({
      flag: z.string(),
      value: z.string(),
      keyEnv: z.string().optional(),
      provider: z.string().optional(),
    })

    const AgentConfigSchema = z.object({
      type: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      defaultModel: z.string(),
      models: z.record(ModelConfigSchema),
      strengths: z.array(z.string()),
      env: z.record(z.string()).optional(),
    })

    const BridgeConfigSchema = z.object({
      workspaceRoot: z.string(),
      agents: z.record(AgentConfigSchema),
      permissions: z.object({ autoApprove: z.boolean() }),
      polling: z.object({ intervalMs: z.number().min(500).max(60000) }),
      logging: z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
        file: z.string().optional(),
      }),
    })

    export async function loadConfig(path: string): Promise<BridgeConfig> {
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`Config file not found: ${path}`)
      }
      const raw = await file.json()
      const config = BridgeConfigSchema.parse(raw) // Throws ZodError with details
      // ... existing agent validation ...
      return config
    }
    ```
  - **Why**: Unvalidated JSON can have wrong types, missing fields, or extra fields causing runtime crashes.
  - **Test**: "should reject config with missing agents"
  - **Test**: "should reject config with invalid polling interval"

### 4.2 Type `logging.level` Properly

- [ ] Fix type in `src/config.ts` at `BridgeConfig` interface
  - **Current**: `logging: { level: string; file?: string }`
  - **Fixed**: `logging: { level: 'debug' | 'info' | 'warn' | 'error'; file?: string }`
  - Remove `as any` cast in `src/index.ts:32`:
    - **Current**: `configureLogger(config.logging.level as any, config.logging.file)`
    - **Fixed**: `configureLogger(config.logging.level, config.logging.file)`
  - **Why**: Eliminates 1 of 14 `as any` casts.

### 4.3 Add ACP SDK Type Definitions

- [ ] Create `src/acp-types.ts` with local type definitions for ACP SDK shapes
  - **Fixed**: Create new file:
    ```typescript
    // Local type definitions for ACP SDK interactions
    // These provide type safety without relying on SDK exporting all types

    export interface AcpInitializeParams {
      protocolVersion: number
      clientCapabilities: Record<string, unknown>
      clientInfo: { name: string; version: string }
    }

    export interface AcpInitializeResult {
      agentInfo?: { name?: string; version?: string }
    }

    export interface AcpNewSessionParams {
      cwd: string
      mcpServers: unknown[]
    }

    export interface AcpNewSessionResult {
      sessionId: string
      models?: { availableModels?: Array<{ modelId: string; name?: string }> }
    }

    export interface AcpPromptParams {
      sessionId: string
      prompt: Array<{ type: 'text'; text: string }>
    }

    export interface AcpPromptResult {
      stopReason?: string | null
    }

    export interface AcpPermissionRequest {
      toolCall?: { title?: string }
      options?: Array<{ kind: string; optionId: string }>
    }

    export interface AcpSessionUpdate {
      sessionUpdate: string
      content?: { type?: string; text?: string }
      toolCallId?: string
      title?: string
      status?: string
      entries?: unknown[]
    }
    ```
  - Then update `src/acp-client.ts` to use these types instead of `as any`.
  - **Why**: Eliminates ~10 of 13 `as any` casts in `acp-client.ts` while maintaining SDK compatibility.
  - **Test**: `bun run typecheck` passes with no errors

### 4.4 Fix Untyped JSON Parsing

- [ ] Add type guards to `src/result-writer.ts` at lines 31-32
  - **Current**: `const task = JSON.parse(raw)` — implicitly `any`
  - **Fixed**:
    ```typescript
    const task: unknown = JSON.parse(raw)
    if (!task || typeof task !== 'object' || !('id' in task) || !('status' in task)) {
      throw new Error(`Invalid task file format: ${filePath}`)
    }
    const typedTask = task as { id: string; status: string; result?: unknown; [key: string]: unknown }
    ```
  - **Why**: `JSON.parse` returns `any`. Parsing into `unknown` + validating prevents accessing undefined fields.

- [ ] Same fix in `src/task-watcher.ts` at line 64
  - **Current**: `const task: TaskData = JSON.parse(raw)`
  - **Fixed**: Parse as `unknown`, validate required fields, then narrow to `TaskData`
