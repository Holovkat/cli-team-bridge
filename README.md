# cli-team-bridge

An MCP-to-ACP bridge that lets Claude Code (or any MCP client) delegate tasks to external coding agents — Codex, Claude Code, Gemini, Qwen, Droid (Factory), and Ollama — over the [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol).

Inspired by [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — the built-in experimental feature for coordinating multiple Claude Code sessions. This project extends that concept across vendor boundaries, letting you orchestrate agents from OpenAI, Anthropic, Google, Alibaba, and local models (Ollama) through a single MCP-to-ACP bridge.

The bridge translates [MCP](https://modelcontextprotocol.io/) tool calls (JSON-RPC over stdio) into [ACP](https://github.com/zed-industries/agent-client-protocol) sessions (NDJSON over stdio), so your MCP client doesn't need to know anything about ACP — it just calls `assign_task` and gets results back.

## What it does

The bridge sits between your AI coding assistant and multiple external agents. You ask Claude Code to "have codex review this project" and the bridge:

1. Spawns the ACP adapter process (e.g. `codex-acp`, `gemini --experimental-acp`)
2. Initializes an ACP session pointed at your project directory
3. Sends your prompt to the agent
4. Streams back the result

All agents can run concurrently — each gets its own isolated child process.

## Supported agents

| Agent | Command | Default Model | Auth |
|-------|---------|---------------|------|
| **codex** | `codex-acp` | `gpt-5.3-codex` | OAuth (`codex login`) |
| **claude-code** | `claude-code-acp` | `opus` | OAuth (`claude login`) |
| **gemini** | `gemini --experimental-acp` | `gemini-3-pro` | OAuth (`gemini login`) |
| **qwen** | `qwen --acp` | `coder-model` | OAuth (`qwen login`) |
| **droid** | `droid-acp` | `custom:kimi-for-coding-[Kimi]-7` | OAuth (`droid login`) |

Each agent supports multiple models — see [Configuration](#configuration) for the full list. Gemini and Qwen have built-in ACP support (no separate adapter binary needed).

### Authentication

Each agent CLI uses its own OAuth flow. You authenticate once per agent on your machine, and the bridge uses those stored credentials — no API keys are passed through the bridge itself.

```bash
codex login          # Authenticates with OpenAI — uses your OpenAI subscription
claude login         # Authenticates with Anthropic — uses your Anthropic subscription
gemini login         # Authenticates with Google — uses your Google AI subscription
qwen login           # Authenticates with Alibaba Cloud — uses your Qwen subscription
droid login          # Authenticates with Factory — uses your Factory subscription
```

Each login stores OAuth tokens locally (e.g. `~/.codex/`, `~/.claude/`, `~/.factory/`). The bridge spawns agent processes that read these tokens directly — it never handles credentials itself. You use your own subscriptions and quotas for each provider.

Droid/Factory also supports custom model routing through API keys configured in `~/.factory/settings.json` (e.g. Kimi, Ollama, LM Studio). These are managed by Factory, not the bridge.

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- ACP adapter binaries installed globally:
  ```bash
  bun install -g @zed-industries/codex-acp@latest
  bun install -g @zed-industries/claude-code-acp@latest
  bun install -g droid-acp@latest
  ```
- The underlying CLI tools:
  ```bash
  bun install -g @openai/codex@latest
  bun install -g @anthropic-ai/claude-code@latest
  bun install -g @factory/cli@latest
  ```
- CLIs with built-in ACP (no adapter needed):
  ```bash
  npm install -g @google/gemini-cli@latest
  npm install -g qwen-code@latest
  ```
- Each agent authenticated via their respective flow (`codex login`, `claude login`, `gemini login`, `qwen login`, `droid login`)

## Installation

```bash
git clone https://github.com/Holovkat/cli-team-bridge.git
cd cli-team-bridge
bun install
```

## Setting up Claude Code

### Step 1: Enable Agent Teams (optional but recommended)

[Agent Teams](https://code.claude.com/docs/en/agent-teams) is an experimental Claude Code feature that lets you coordinate multiple Claude Code sessions. While the bridge works without it, enabling it lets you combine Claude-to-Claude coordination with cross-vendor delegation.

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Or set it in your shell before launching Claude Code:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### Step 2: Register the bridge as an MCP server

```bash
claude mcp add cli-team-bridge -- bun run /path/to/cli-team-bridge/src/index.ts --mode mcp --config /path/to/cli-team-bridge/bridge.config.local.json
```

This registers the bridge so Claude Code can call its tools. The MCP server loads at session startup, so you need to start a **new Claude Code session** after adding it.

### Step 3: Verify it works

Start a new Claude Code session and try:

```
> List available agents from the bridge
```

You should see all configured agents with their models and strengths.

### Using Agent Teams with the bridge

With Agent Teams enabled, you can have Claude Code spawn teammates that each use the bridge to delegate to different external agents:

```
Create an agent team to review cli-team-bridge from different angles.
Have one teammate ask codex to do a code quality review,
another teammate ask gemini for a security audit,
and a third teammate ask droid for an error handling review.
Synthesize all findings when they're done.
```

The team lead coordinates the Claude teammates, each teammate calls the bridge's MCP tools to dispatch work to external agents, and results flow back through the team.

**Key Agent Teams controls:**
- `Shift+Up/Down` — select and message teammates directly
- `Shift+Tab` — toggle delegate mode (lead coordinates only, no code edits)
- `Ctrl+T` — view shared task list
- Split pane mode requires `tmux` or iTerm2

See the [Agent Teams docs](https://code.claude.com/docs/en/agent-teams) for full details.

## Usage

The bridge runs in two modes: **MCP** (for Claude Code integration) and **Watcher** (file-based task polling).

### MCP mode (recommended)

Start a **new Claude Code session** (after registering the bridge above), then use natural language:

```
> List available agents from the bridge
> Ask codex to review the code quality of cli-team-bridge
> Have droid do a security analysis of my-project
> Send all 5 agents to review cli-team-bridge concurrently
```

Claude Code gets 4 MCP tools:

| Tool | Description |
|------|-------------|
| `list_agents` | List available agents, their models, and strengths |
| `assign_task` | Send a task to an agent (returns task ID immediately) |
| `get_task_status` | Poll whether a task is still running |
| `get_task_result` | Get the full output once a task completes |

### Watcher mode

Runs as a daemon that polls a task directory for JSON task files. Useful for Docker deployments or multi-process setups.

```bash
bun run src/index.ts --team my-team --config bridge.config.local.json --mode watcher
```

### Both modes

```bash
bun run src/index.ts --team my-team --config bridge.config.local.json --mode both
```

### CLI flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--team` | watcher/both | — | Team ID (creates task dir at `~/.claude/tasks/<team>/`) |
| `--config` | no | `./bridge.config.json` | Path to config file |
| `--mode` | no | `both` | `mcp`, `watcher`, or `both` |

## Configuration

Two config files are provided:

- `bridge.config.json` — Docker/production config (paths relative to container)
- `bridge.config.local.json` — Local dev config (absolute paths to your machine)

### Config structure

```jsonc
{
  "workspaceRoot": "/Users/you/workspace",  // Root dir containing your projects
  "agents": {
    "codex": {
      "type": "acp",
      "command": "codex-acp",           // ACP adapter binary
      "args": [],
      "cwd": "/path/to/bridge",         // Working directory for the adapter
      "defaultModel": "gpt-5.3-codex",
      "models": {
        "gpt-5.3-codex": { "flag": "--model", "value": "gpt-5.3-codex" }
      },
      "strengths": ["code generation", "refactoring", "debugging"]
    },
    "claude-code": {
      "type": "acp",
      "command": "claude-code-acp",
      "defaultModel": "opus",
      "models": {
        "opus":   { "flag": "--model", "value": "opus" },
        "sonnet": { "flag": "--model", "value": "sonnet" },
        "haiku":  { "flag": "--model", "value": "haiku" }
      },
      "strengths": ["architecture", "complex reasoning", "code review"]
    },
    "droid": {
      "type": "acp",
      "command": "droid-acp",
      "defaultModel": "custom:kimi-for-coding-[Kimi]-7",
      "models": {
        "custom:kimi-for-coding-[Kimi]-7": {
          "flag": "--model",
          "value": "custom:kimi-for-coding-[Kimi]-7",
          "provider": "factory"
        }
        // Add more Factory models as needed
      },
      "strengths": ["multi-model flexibility", "cost optimization", "custom model support"]
    }
  },
  "permissions": { "autoApprove": true },
  "polling": { "intervalMs": 2000 },       // Watcher polling interval
  "logging": { "level": "info", "file": "./bridge.log" }
}
```

### Adding a new agent

1. Add an entry to the `agents` object in your config file
2. Set `command` to the ACP adapter binary name
3. Define available models with their CLI flags
4. Install the adapter binary globally (`bun install -g <package>`)

### Example: Ollama (local models via Droid/Factory)

Ollama models can be used through the Droid/Factory adapter. First, configure your Ollama models as custom models in Factory (`~/.factory/settings.json`), then reference them in your bridge config using the `custom:` prefix and `"provider": "factory"`.

**Step 1**: Ensure Ollama is running with your models pulled:

```bash
ollama serve                    # start the server
ollama pull nemotron-3-nano     # pull a model
```

**Step 2**: Configure the model in Factory (via `droid` CLI or `~/.factory/settings.json`). The model appears with an ID like `custom:nemotron-3-nano-[Ollama]-37`.

**Step 3**: Add it to your bridge config under the `droid` agent's models:

```jsonc
"droid": {
  "type": "acp",
  "command": "droid-acp",
  "args": [],
  "cwd": "/path/to/bridge",
  "defaultModel": "custom:kimi-for-coding-[Kimi]-7",
  "models": {
    "custom:kimi-for-coding-[Kimi]-7": { "flag": "--model", "value": "custom:kimi-for-coding-[Kimi]-7", "provider": "factory" },
    "custom:nemotron-3-nano-[Ollama]-37": { "flag": "--model", "value": "custom:nemotron-3-nano-[Ollama]-37", "provider": "factory" }
  }
}
```

**Step 4**: Assign a task specifying the Ollama model:

```
> Ask droid to review cli-team-bridge using the nemotron-3-nano model
```

**Tested**: nemotron-3-nano (24GB, Q4_K_M) completed a file listing task in ~10 seconds via `droid-acp` on macOS with Ollama running locally at `localhost:11434`.

### Custom models (Droid/Factory)

Droid supports custom models configured in Factory. Use the `custom:` prefix:

```json
"custom:kimi-for-coding-[Kimi]-7": {
  "flag": "--model",
  "value": "custom:kimi-for-coding-[Kimi]-7",
  "provider": "factory"
}
```

## Docker

Build and run with Docker Compose:

```bash
docker compose up -d
```

The container runs in watcher mode by default. Volume mounts:

| Host | Container | Mode | Purpose |
|------|-----------|------|---------|
| `.` | `/app` | rw | Bridge source (live reload) |
| `~/.claude` | `/root/.claude` | rw | Task files shared with Claude Code |
| `~/workspace` | `/workspace` | ro | Project workspaces for agents to analyze |

To use agents that require OAuth inside Docker, mount their credential directories:

```yaml
volumes:
  - ~/.codex:/root/.codex       # Codex OAuth tokens
  - ~/.factory:/root/.factory   # Droid/Factory OAuth tokens
  - ~/.claude:/root/.claude     # Claude Code OAuth tokens
```

### Environment variables

All agents use OAuth by default (see [Authentication](#authentication)). API keys are only needed if you prefer key-based auth over OAuth:

```
OPENAI_API_KEY=...      # Optional: alternative to `codex login`
ANTHROPIC_API_KEY=...   # Optional: alternative to `claude login`
GOOGLE_API_KEY=...      # Optional: alternative to `gemini login`
OLLAMA_HOST=...         # Optional: Ollama server URL (default: http://localhost:11434)
```

## Security

The bridge includes several security measures:

- **Env allowlist**: Only essential system vars (PATH, HOME, SHELL, TERM, LANG, NODE_ENV) plus agent-specific keys are passed to child processes — secrets are not leaked
- **Permission controls**: Destructive operations (rm -rf, force push, DROP TABLE, etc.) are automatically denied; non-destructive operations use `allow_once` instead of `allow_always`
- **Path traversal protection**: Project paths are validated to stay within the workspace root
- **Stderr isolation**: All logging goes to stderr to protect the MCP JSON-RPC transport on stdout
- **Process lifecycle monitoring**: Spawn failures and unexpected exits propagate immediately instead of hanging for 30 minutes
- **Operation timeouts**: `initialize` and `newSession` have 30s timeouts; `prompt` has a 30-minute timeout
- **Memory management**: Completed tasks are pruned after 1 hour when the task map exceeds 100 entries

## Architecture

```
Claude Code (MCP client)
    |
    | MCP (JSON-RPC over stdio)
    v
cli-team-bridge (MCP-to-ACP bridge)
    |
    | ACP (NDJSON over stdio)
    |
    |--- spawn ---> codex-acp ---------> codex CLI ----> OpenAI     (OAuth)
    |--- spawn ---> claude-code-acp --> claude CLI ----> Anthropic   (OAuth)
    |--- spawn ---> gemini --experimental-acp ---------> Google AI   (OAuth)
    |--- spawn ---> qwen --acp -----------------------> Alibaba     (OAuth)
    |--- spawn ---> droid-acp ---------> droid CLI ----> Factory.ai  (OAuth)
    |--- spawn ---> droid-acp ---------> droid CLI ----> Ollama      (local)
```

Each `assign_task` call spawns a separate ACP adapter process. Multiple tasks run concurrently in isolated child processes.

### Source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, CLI arg parsing, mode selection |
| `src/mcp-server.ts` | MCP server — exposes tools to Claude Code |
| `src/acp-client.ts` | ACP session lifecycle — spawn, initialize, prompt, cleanup |
| `src/agent-adapters.ts` | Builds spawn configs from agent definitions |
| `src/config.ts` | Config loader and validation |
| `src/task-watcher.ts` | File-based task polling (watcher mode) |
| `src/result-writer.ts` | Writes task results back to JSON files |
| `src/manifest.ts` | Generates bridge manifest for team discovery |
| `src/logger.ts` | Crash-safe structured logger (stderr + file) |

## Test results

All 5 agent configurations tested concurrently on macOS (2026-02-08):

| Agent | Model | Time | Task |
|-------|-------|------|------|
| **qwen** | coder-model | 10s | Source file listing |
| **droid** | kimi-for-coding (Kimi) | 20s | Error handling review |
| **claude-code** | opus | 30s | Architecture analysis |
| **gemini** | gemini-3-pro | 35s | Security review (3 findings) |
| **droid** | nemotron-3-nano (Ollama) | 70s | File listing (local inference) |

## Acknowledgments

- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — the inspiration for cross-vendor agent coordination
- [Agent Client Protocol (ACP)](https://github.com/zed-industries/agent-client-protocol) — the open standard for agent-editor communication
- [Zed IDE](https://zed.dev) — ACP adapter patterns (`codex-acp`, `claude-code-acp`)
- [Factory/Droid](https://factory.ai) — multi-model custom routing and Ollama integration

## License

MIT
