FROM oven/bun:1.2.0

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install ACP adapter packages (the bridge spawns these as child processes)
RUN bun install -g @zed-industries/codex-acp@latest
RUN bun install -g @zed-industries/claude-code-acp@latest
RUN bun install -g droid-acp@latest

# Install the actual CLI tools that ACP adapters spawn
RUN bun install -g @anthropic-ai/claude-code@latest
RUN bun install -g @openai/codex@latest
RUN bun install -g @factory/cli@latest

# Create non-root user for security
RUN groupadd -r bridge && useradd -r -g bridge -d /home/bridge -s /bin/bash bridge
RUN mkdir -p /home/bridge/.codex /home/bridge/.factory /home/bridge/.claude

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .

# Set ownership and switch to non-root user
RUN chown -R bridge:bridge /home/bridge /app
USER bridge

CMD ["bun", "run", "src/index.ts"]
