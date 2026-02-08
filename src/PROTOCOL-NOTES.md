# Protocol Verification Notes

**Date**: 2026-02-08
**Verified on**: macOS Darwin 25.2.0

## Summary

ACP (Agent Client Protocol) is an **open standard** (JSON-RPC 2.0 over NDJSON/stdio)
co-developed by Zed Industries and JetBrains. All three target agents have ACP adapter
packages maintained by Zed Industries or the community.

The bridge acts as an **ACP client** using `ClientSideConnection` from
`@agentclientprotocol/sdk`, spawning each agent's ACP adapter as a child process.

```
Bridge (ClientSideConnection) <--NDJSON/stdio--> claude-code-acp | codex-acp | droid-acp
```

---

## ACP Protocol Overview

- **Transport**: NDJSON over stdin/stdout (stderr reserved for logging)
- **Protocol version**: 1
- **Lifecycle**:
  1. `initialize` — negotiate version + capabilities
  2. `session/new` — create session, get sessionId, available models/modes
  3. `session/prompt` — send prompt, receive streamed `session/update` notifications
  4. `session/cancel` — cancel in-progress prompt
- **Client callbacks**: `requestPermission`, `sessionUpdate`, `readTextFile`,
  `writeTextFile`, `createTerminal`, etc.

---

## ACP Adapter Packages

| Agent | Adapter Package | Version | Binary | Key Dependency |
|-------|----------------|---------|--------|---------------|
| Claude Code | `@zed-industries/claude-code-acp` | 0.13.1 | `claude-code-acp` | `@anthropic-ai/claude-agent-sdk` |
| Codex | `@zed-industries/codex-acp` | 0.9.2 | `codex-acp` | self-contained |
| Droid | `droid-acp` | 0.6.1 | `droid-acp` | `@agentclientprotocol/sdk` |

### Claude Code ACP Adapter
- Wraps `@anthropic-ai/claude-agent-sdk` (the SDK, not the CLI)
- Redirects all console output to stderr
- Implements `Agent` interface: `initialize`, `newSession`, `prompt`, `cancel`
- Supports modes: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`
- Auth via `ANTHROPIC_API_KEY` env var or `claude /login`
- Model selection via `session/new` response → `setSessionModel()`
- Source: `/Users/tonyholovka/workspace/zed/claude-code-acp/src/acp-agent.ts`

### Codex ACP Adapter
- Published by Zed Industries
- Self-contained (no external deps listed)
- Binary: `codex-acp`
- Auth via `OPENAI_API_KEY` env var

### Droid ACP Adapter
- Community-maintained (kingsword09)
- Bridges ACP to Droid's `--stream-jsonrpc` mode
- Auth via `FACTORY_API_KEY` env var
- Writes MCP server configs to `.factory/mcp.json`

---

## SDK Usage Pattern (Client Side)

```typescript
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

// Spawn adapter process
const proc = spawn("claude-code-acp", [], { stdio: ["pipe", "pipe", "pipe"] });

// Create NDJSON stream from child's stdin/stdout
const stream = ndJsonStream(
  nodeToWebWritable(proc.stdin),
  nodeToWebReadable(proc.stdout)
);

// Create client-side connection
const connection = new ClientSideConnection(
  (agent) => ({
    // Client implementation — handle agent callbacks
    requestPermission: async (params) => ({
      outcome: { outcome: "selected", optionId: "allow" }
    }),
    sessionUpdate: async (notification) => {
      // Collect streamed output
      if (notification.update.sessionUpdate === "agent_message_chunk") {
        output += notification.update.content.text;
      }
    },
  }),
  stream
);

// Protocol lifecycle
const initResult = await connection.initialize({
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "cli-team-bridge", version: "0.1.0" }
});

const session = await connection.newSession({ cwd: "/workspace" });

const result = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Do the thing" }]
});
// result.stopReason: "end_turn" | "cancelled" | "max_turn_requests"
```

---

## Bridge Config — Verified

| Agent | Command | Env Vars Required |
|-------|---------|------------------|
| claude-code | `claude-code-acp` | `ANTHROPIC_API_KEY` |
| codex | `codex-acp` | `OPENAI_API_KEY` |
| droid | `droid-acp` | `FACTORY_API_KEY` |

Model selection happens via ACP's `setSessionModel()` after `newSession()`,
not via CLI flags. The adapters handle model routing internally.

---

## Native CLI Modes (Fallback Reference)

These are documented for reference but NOT used by the bridge:

| CLI | Non-interactive | Model Flag | Auto-approve |
|-----|----------------|------------|-------------|
| `codex exec` | `--json --full-auto` | `-m <model>` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude -p` | `--output-format json` | `--model <model>` | `--dangerously-skip-permissions` |
| `droid exec` | `-o json` | `-m <model>` | `--skip-permissions-unsafe` |
