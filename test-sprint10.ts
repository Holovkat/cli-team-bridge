#!/usr/bin/env bun
/**
 * Sprint 10 test — send a simple task to codex, droid, gemini, qwen via the MCP bridge
 */
import { spawn } from 'child_process'

const MCP_CMD = 'bun'
const MCP_ARGS = ['run', 'src/index.ts', '--mode', 'mcp', '--config', 'bridge.config.local.json']

let requestId = 0
const pendingResolvers = new Map<number, (value: any) => void>()
let buffer = ''

const proc = spawn(MCP_CMD, MCP_ARGS, {
  cwd: '/Users/tonyholovka/workspace/cli-team-bridge',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
})

proc.stderr?.on('data', (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    if (!line.includes('[DEBUG]')) {
      console.error(`  [bridge] ${line}`)
    }
  }
})

proc.stdout?.on('data', (chunk: Buffer) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      const resolver = pendingResolvers.get(msg.id)
      if (resolver) {
        pendingResolvers.delete(msg.id)
        resolver(msg)
      }
    } catch { /* skip non-JSON */ }
  }
})

function sendRpc(method: string, params: any): Promise<any> {
  const id = ++requestId
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  proc.stdin?.write(msg)
  return new Promise(resolve => pendingResolvers.set(id, resolve))
}

async function initialize() {
  await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-sprint10', version: '1.0.0' },
  })
  await sendRpc('notifications/initialized', {})
}

async function callTool(name: string, args: any): Promise<any> {
  const resp = await sendRpc('tools/call', { name, arguments: args })
  return resp.result
}

// --- Main test ---
await initialize()
console.log('\n=== Sprint 10 Multi-Agent Test ===\n')

// List agents first
const listResult = await callTool('list_agents', {})
console.log('Available agents:')
const agents = JSON.parse(listResult.content[0].text)
for (const [name, info] of Object.entries(agents) as any) {
  console.log(`  ${info.available ? '✓' : '✗'} ${name} (${info.defaultModel})`)
}

// Assign tasks to all 4 agents
const testAgents = ['codex', 'droid', 'gemini', 'qwen']
const taskIds: Record<string, string> = {}

console.log('\n--- Assigning tasks ---')
for (const agent of testAgents) {
  const result = await callTool('assign_task', {
    agent,
    prompt: `List the files in the current directory and tell me how many there are. Be brief.`,
    project: 'cli-team-bridge',
  })
  const parsed = JSON.parse(result.content[0].text)
  if (parsed.task_id) {
    taskIds[agent] = parsed.task_id
    console.log(`  ${agent}: task ${parsed.task_id.slice(0, 8)}... assigned`)
  } else {
    console.log(`  ${agent}: FAILED — ${result.content[0].text}`)
  }
}

// Poll for results
console.log('\n--- Waiting for results (max 120s) ---')
const startTime = Date.now()
const completed = new Set<string>()

while (completed.size < Object.keys(taskIds).length && Date.now() - startTime < 120_000) {
  for (const [agent, taskId] of Object.entries(taskIds)) {
    if (completed.has(agent)) continue

    const status = await callTool('get_task_status', { task_id: taskId })
    const parsed = JSON.parse(status.content[0].text)

    if (parsed.status !== 'running') {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      completed.add(agent)

      if (parsed.status === 'completed') {
        const result = await callTool('get_task_result', { task_id: taskId })
        const resultData = JSON.parse(result.content[0].text)
        const outputPreview = (resultData.output || '').slice(0, 200)
        console.log(`  ✓ ${agent} (${elapsed}s): ${outputPreview || '(empty output)'}`)
      } else {
        const result = await callTool('get_task_result', { task_id: taskId })
        const resultData = JSON.parse(result.content[0].text)
        console.log(`  ✗ ${agent} (${elapsed}s): ${parsed.status} — ${resultData.error?.slice(0, 200) || 'unknown error'}`)
      }
    }
  }

  if (completed.size < Object.keys(taskIds).length) {
    await new Promise(r => setTimeout(r, 5000))
  }
}

// Report any still running
for (const [agent] of Object.entries(taskIds)) {
  if (!completed.has(agent)) {
    console.log(`  ⏳ ${agent}: still running after 120s`)
  }
}

// Also test get_agent_status (new Sprint 10 tool)
console.log('\n--- Agent Status (Sprint 10) ---')
const agentStatus = await callTool('get_agent_status', {})
console.log(agentStatus.content[0].text)

console.log('\n=== Test Complete ===')
proc.kill('SIGTERM')
process.exit(0)
