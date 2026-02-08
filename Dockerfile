FROM oven/bun:latest

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install agent CLIs — verified package names go here after Phase 2
# RUN bun install -g @openai/codex
# RUN bun install -g @anthropic-ai/claude-code
# RUN bun install -g factory-cli

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .

CMD ["bun", "run", "src/index.ts"]
