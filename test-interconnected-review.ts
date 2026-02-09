#!/usr/bin/env bun
/**
 * Interconnected multi-agent review test
 *
 * Flow:
 * 1. Spawn 3 expert agents with their specialty tasks
 * 2. Collect their initial findings
 * 3. Feed findings to writer agent to draft review + follow-up questions
 * 4. Route follow-up questions back to relevant experts
 * 5. Writer compiles final review.md
 */
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'

const PROJECT = 'cli-team-bridge'
const WORKSPACE = '/Users/tonyholovka/workspace/cli-team-bridge'

// --- MCP Bridge Connection ---
let requestId = 0
const pendingResolvers = new Map<number, (value: any) => void>()
let buffer = ''

const proc = spawn('bun', [
  'run', 'src/index.ts', '--mode', 'mcp',
  '--config', 'bridge.config.local.json',
], {
  cwd: WORKSPACE,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
})

proc.stderr?.on('data', (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    if (line.includes('[INFO]') && !line.includes('parse JSON')) {
      console.error(`  [bridge] ${line.replace(/.*\[INFO\]\s*/, '')}`)
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
    } catch { /* skip */ }
  }
})

function sendRpc(method: string, params: any): Promise<any> {
  const id = ++requestId
  proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise(resolve => pendingResolvers.set(id, resolve))
}

async function callTool(name: string, args: any): Promise<any> {
  const resp = await sendRpc('tools/call', { name, arguments: args })
  return resp.result
}

async function assignAndWait(agent: string, prompt: string, label: string, maxWait = 180_000): Promise<string> {
  console.log(`\n  >> Assigning to ${agent}: ${label}`)
  const assignResult = await callTool('assign_task', { agent, prompt, project: PROJECT })
  const parsed = JSON.parse(assignResult.content[0].text)

  if (!parsed.task_id) {
    console.log(`  !! ${agent} assignment failed: ${assignResult.content[0].text}`)
    return `ERROR: ${assignResult.content[0].text}`
  }

  const taskId = parsed.task_id
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    const status = await callTool('get_task_status', { task_id: taskId })
    const s = JSON.parse(status.content[0].text)

    if (s.status !== 'running') {
      const result = await callTool('get_task_result', { task_id: taskId })
      const r = JSON.parse(result.content[0].text)
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)

      if (s.status === 'completed') {
        console.log(`  << ${agent} completed (${elapsed}s) — ${(r.output || '').length} chars`)
        return r.output || ''
      } else {
        console.log(`  !! ${agent} ${s.status} (${elapsed}s): ${(r.error || '').slice(0, 200)}`)
        return `ERROR: ${r.error || 'unknown'}`
      }
    }
    await new Promise(r => setTimeout(r, 5000))
  }

  console.log(`  !! ${agent} timed out after ${maxWait/1000}s`)
  return 'ERROR: timed out'
}

// --- Initialize MCP ---
await sendRpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'review-orchestrator', version: '1.0.0' },
})
await sendRpc('notifications/initialized', {})

console.log(`
╔══════════════════════════════════════════════════╗
║  Interconnected Multi-Agent Review               ║
║  Project: cli-team-bridge                        ║
╚══════════════════════════════════════════════════╝
`)

// ============================================================
// ROUND 1: Expert agents do their initial analysis
// ============================================================
console.log('━━━ ROUND 1: Expert Analysis ━━━')

const expertTasks = [
  {
    agent: 'gemini',
    label: 'Security Expert',
    prompt: `You are a security expert reviewing cli-team-bridge. Analyze the codebase for:
1. Authentication and authorization patterns
2. Input validation and sanitization
3. Process isolation and environment handling
4. Path traversal protections
5. Any remaining vulnerabilities

Focus on src/acp-client.ts, src/mcp-server.ts, src/config.ts, and src/agent-adapters.ts.
Be thorough but concise. Format findings as bullet points with severity ratings.
This is for a comprehensive project review document.`,
  },
  {
    agent: 'qwen',
    label: 'Architecture Expert',
    prompt: `You are an architecture expert reviewing cli-team-bridge. Analyze:
1. Overall architecture (MCP-to-ACP bridge pattern)
2. Module separation and responsibilities
3. Error handling patterns across the codebase
4. Async flow management
5. Configuration management approach
6. The new cross-agent messaging system (src/message-bus.ts, src/agent-registry.ts, src/workflow.ts)

Focus on design quality, extensibility, and maintainability.
Be thorough but concise. Format as bullet points.
This is for a comprehensive project review document.`,
  },
  {
    agent: 'droid',
    label: 'Code Quality Expert',
    prompt: `You are a code quality expert reviewing cli-team-bridge. Analyze:
1. TypeScript best practices and type safety
2. Error handling completeness
3. Test coverage and test quality (check tests/ directory)
4. Logging and observability
5. Resource management (process lifecycle, cleanup, memory)
6. Code duplication or unnecessary complexity

Review all files in src/ and tests/.
Be thorough but concise. Format as bullet points with specific file references.
This is for a comprehensive project review document.`,
  },
]

// Run all 3 expert tasks concurrently
console.log('\nStarting 3 expert agents concurrently...')
const expertResults = await Promise.all(
  expertTasks.map(task => assignAndWait(task.agent, task.prompt, task.label))
)

const expertFindings: Record<string, string> = {}
for (let i = 0; i < expertTasks.length; i++) {
  expertFindings[expertTasks[i].label] = expertResults[i]
}

console.log(`\n━━━ Expert results collected ━━━`)
for (const [label, result] of Object.entries(expertFindings)) {
  console.log(`  ${label}: ${result.startsWith('ERROR') ? '✗ FAILED' : `✓ ${result.length} chars`}`)
}

// ============================================================
// ROUND 2: Writer drafts review + generates follow-up questions
// ============================================================
console.log('\n━━━ ROUND 2: Writer Draft + Follow-up Questions ━━━')

const writerDraftPrompt = `You are a technical writer compiling a comprehensive project review document for cli-team-bridge.

Three expert agents have provided their analysis. Here are their findings:

=== SECURITY EXPERT (gemini) ===
${expertFindings['Security Expert'].slice(0, 5000)}

=== ARCHITECTURE EXPERT (qwen) ===
${expertFindings['Architecture Expert'].slice(0, 5000)}

=== CODE QUALITY EXPERT (droid) ===
${expertFindings['Code Quality Expert'].slice(0, 5000)}

Your task:
1. Review all expert findings
2. Identify any gaps or areas that need deeper analysis
3. Generate 1-2 specific follow-up questions for EACH expert to fill those gaps
4. Draft the outline of review.md

Format your response as:

## FOLLOW-UP QUESTIONS

### For Security Expert:
1. [question]
2. [question]

### For Architecture Expert:
1. [question]
2. [question]

### For Code Quality Expert:
1. [question]
2. [question]

## DRAFT OUTLINE
[your outline for review.md with sections and key points to cover]
`

const writerDraft = await assignAndWait('codex', writerDraftPrompt, 'Writer — Draft + Questions')

// ============================================================
// ROUND 3: Route follow-up questions to experts
// ============================================================
console.log('\n━━━ ROUND 3: Follow-up Questions to Experts ━━━')

// Parse follow-up questions and send to relevant experts
const followUpTasks = [
  {
    agent: 'gemini',
    label: 'Security Follow-up',
    prompt: `You are the security expert for cli-team-bridge. You previously provided a security analysis.
The technical writer has follow-up questions based on your analysis and the other experts' findings.

Your previous findings:
${expertFindings['Security Expert'].slice(0, 2000)}

The writer's draft and questions:
${writerDraft.slice(0, 3000)}

Please answer any security-related follow-up questions thoroughly. If the writer asked about areas you didn't cover, analyze those now.
Focus especially on the new cross-agent messaging files (src/message-bus.ts, src/mcp-agentmode.ts).
Be concise and specific with file:line references where applicable.`,
  },
  {
    agent: 'qwen',
    label: 'Architecture Follow-up',
    prompt: `You are the architecture expert for cli-team-bridge. You previously provided an architecture analysis.
The technical writer has follow-up questions.

Your previous findings:
${expertFindings['Architecture Expert'].slice(0, 2000)}

The writer's draft and questions:
${writerDraft.slice(0, 3000)}

Please answer any architecture-related follow-up questions thoroughly. If the writer identified gaps, analyze those areas now.
Be concise and specific.`,
  },
  {
    agent: 'droid',
    label: 'Code Quality Follow-up',
    prompt: `You are the code quality expert for cli-team-bridge. You previously provided a code quality analysis.
The technical writer has follow-up questions.

Your previous findings:
${expertFindings['Code Quality Expert'].slice(0, 2000)}

The writer's draft and questions:
${writerDraft.slice(0, 3000)}

Please answer any code quality follow-up questions thoroughly. If the writer identified gaps, analyze those areas now.
Be concise and specific with file references.`,
  },
]

// Run follow-ups concurrently
const followUpResults = await Promise.all(
  followUpTasks.map(task => assignAndWait(task.agent, task.prompt, task.label))
)

const followUpFindings: Record<string, string> = {}
for (let i = 0; i < followUpTasks.length; i++) {
  followUpFindings[followUpTasks[i].label] = followUpResults[i]
}

console.log(`\n━━━ Follow-up results collected ━━━`)
for (const [label, result] of Object.entries(followUpFindings)) {
  console.log(`  ${label}: ${result.startsWith('ERROR') ? '✗ FAILED' : `✓ ${result.length} chars`}`)
}

// ============================================================
// ROUND 4: Writer compiles final review.md
// ============================================================
console.log('\n━━━ ROUND 4: Final Review Compilation ━━━')

const finalWriterPrompt = `You are a technical writer compiling the FINAL comprehensive review document for cli-team-bridge.

You now have all expert findings (initial + follow-up). Compile everything into a well-structured review.md document.

=== INITIAL FINDINGS ===

SECURITY EXPERT (gemini):
${expertFindings['Security Expert'].slice(0, 3000)}

ARCHITECTURE EXPERT (qwen):
${expertFindings['Architecture Expert'].slice(0, 3000)}

CODE QUALITY EXPERT (droid):
${expertFindings['Code Quality Expert'].slice(0, 3000)}

=== FOLLOW-UP RESPONSES ===

SECURITY FOLLOW-UP (gemini):
${followUpFindings['Security Follow-up'].slice(0, 2000)}

ARCHITECTURE FOLLOW-UP (qwen):
${followUpFindings['Architecture Follow-up'].slice(0, 2000)}

CODE QUALITY FOLLOW-UP (droid):
${followUpFindings['Code Quality Follow-up'].slice(0, 2000)}

=== YOUR EARLIER DRAFT ===
${writerDraft.slice(0, 2000)}

Now write the complete review.md. Include:

# cli-team-bridge — Multi-Agent Code Review

**Date**: 2026-02-08
**Reviewers**: gemini (security), qwen (architecture), droid (code quality), codex (writer/coordinator)
**Method**: Automated multi-agent review via cli-team-bridge cross-agent messaging

## Executive Summary
[2-3 paragraph overview]

## Security Analysis
[Synthesize gemini's findings]

## Architecture Review
[Synthesize qwen's findings]

## Code Quality Assessment
[Synthesize droid's findings]

## Cross-Agent Messaging System (Sprint 10)
[Dedicated section on the new messaging feature]

## Recommendations
[Prioritized list of improvements]

## Scores
- Security: X/100
- Architecture: X/100
- Code Quality: X/100
- Overall: X/100

Write the COMPLETE document. This will be saved directly as review.md.
`

const finalReview = await assignAndWait('codex', finalWriterPrompt, 'Writer — Final Compilation', 300_000)

// ============================================================
// Save review.md
// ============================================================
if (finalReview && !finalReview.startsWith('ERROR')) {
  const reviewPath = `${WORKSPACE}/review.md`
  writeFileSync(reviewPath, finalReview)
  console.log(`\n✓ review.md written (${finalReview.length} chars) → ${reviewPath}`)
} else {
  console.log('\n✗ Failed to generate final review')
  // Save what we have
  const fallback = `# cli-team-bridge — Multi-Agent Code Review

**Date**: 2026-02-08
**Status**: Partial — writer agent failed to compile final review

## Expert Findings

### Security (gemini)
${expertFindings['Security Expert'].slice(0, 5000)}

### Architecture (qwen)
${expertFindings['Architecture Expert'].slice(0, 5000)}

### Code Quality (droid)
${expertFindings['Code Quality Expert'].slice(0, 5000)}

## Writer Draft (codex)
${writerDraft.slice(0, 5000)}

## Follow-up Responses
${Object.entries(followUpFindings).map(([k, v]) => `### ${k}\n${v.slice(0, 3000)}`).join('\n\n')}
`
  writeFileSync(`${WORKSPACE}/review.md`, fallback)
  console.log(`  Fallback review.md written with raw findings`)
}

// Summary
console.log(`
╔══════════════════════════════════════════════════╗
║  Review Complete                                  ║
╠══════════════════════════════════════════════════╣
║  Round 1: 3 expert agents (concurrent)           ║
║  Round 2: Writer draft + follow-up questions     ║
║  Round 3: 3 expert follow-ups (concurrent)       ║
║  Round 4: Writer final compilation               ║
║  Total agent invocations: 8                      ║
╚══════════════════════════════════════════════════╝
`)

proc.kill('SIGTERM')
process.exit(0)
