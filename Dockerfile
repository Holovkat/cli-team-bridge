FROM oven/bun:latest

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install ACP adapter packages (the bridge spawns these as child processes)
RUN bun install -g @zed-industries/codex-acp@latest
RUN bun install -g @zed-industries/claude-code-acp@latest
RUN bun install -g droid-acp@latest

# Install the actual CLI tools that ACP adapters spawn
RUN bun install -g @anthropic-ai/claude-code@latest
RUN bun install -g @openai/codex@latest
RUN bun install -g @factory/cli@latest

# Create writable dirs for adapter state
RUN mkdir -p /root/.codex /root/.factory /root/.claude

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .

CMD ["bun", "run", "src/index.ts"]
