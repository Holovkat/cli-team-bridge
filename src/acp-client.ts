import { spawn, type ChildProcess } from 'child_process'
import { Readable, Writable } from 'node:stream'
import { WritableStream, ReadableStream } from 'node:stream/web'
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
} from '@agentclientprotocol/sdk'
import { logger } from './logger'
import { VERSION } from './version'
import { AgentRegistry } from './agent-registry'
import { MessageBus } from './message-bus'
import { operationalMetrics } from './metrics'
import { evaluatePermission } from './permission-policy'
import { SessionViewer } from './session-viewer'
import type {
  AcpInitializeParams,
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPromptParams,
  AcpPromptResult,
  AcpPermissionRequest,
  AcpPermissionOption,
  AcpPermissionResponse,
  AcpSetSessionModelParams,
} from './acp-types'

export interface AcpSpawnConfig {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface AcpResult {
  output: string
  error: string | null
  timedOut: boolean
  stopReason: string | null
  toolCalls: ToolCallInfo[]
}

export interface ToolCallInfo {
  toolCallId: string
  title?: string
  status?: string
}

const TASK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const INIT_TIMEOUT_MS = 30 * 1000 // 30 seconds for initialize/newSession
const MAX_STDERR_BYTES = 64 * 1024 // 64KB cap on stderr buffer
const MAX_OUTPUT_BYTES = 128 * 1024 // 128KB cap on agent output buffer
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 // 64KB cap on tool output (diffs, terminal, etc.)

/** Safely kill a process — no-op if already dead */
function safeKill(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill(signal)
    }
  } catch {
    // Process already dead — ignore
  }
}

/**
 * Merge agent message output with tool output.
 * When agents write files via tool calls instead of returning text,
 * the tool output contains the real content.
 */
function mergeOutput(agentOutput: string, toolOutput: string): string {
  const agentTrimmed = agentOutput.trim()
  const toolTrimmed = toolOutput.trim()

  // If agent output is substantial, prefer it
  if (agentTrimmed.length > 500) {
    // Still append tool output if it has unique content
    if (toolTrimmed.length > 100 && !agentTrimmed.includes(toolTrimmed.slice(0, 200))) {
      return `${agentTrimmed}\n\n--- Tool Output ---\n${toolTrimmed}`
    }
    return agentTrimmed
  }

  // Agent output is thin — tool output is the real content
  if (toolTrimmed.length > 0) {
    if (agentTrimmed.length > 0) {
      return `${agentTrimmed}\n\n--- Tool Output ---\n${toolTrimmed}`
    }
    return toolTrimmed
  }

  return agentTrimmed
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

// Convert Node.js streams to Web Streams (same pattern as claude-code-acp)
function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  })
}

function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  let onData: ((chunk: Buffer) => void) | null = null
  let onEnd: (() => void) | null = null
  let onError: ((err: Error) => void) | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk))
      onEnd = () => controller.close()
      onError = (err) => controller.error(err)
      nodeStream.on('data', onData)
      nodeStream.on('end', onEnd)
      nodeStream.on('error', onError)
    },
    cancel() {
      if (onData) nodeStream.off('data', onData)
      if (onEnd) nodeStream.off('end', onEnd)
      if (onError) nodeStream.off('error', onError)
      nodeStream.destroy()
    },
  })
}

/**
 * Run an ACP session against an agent adapter (claude-code-acp, codex-acp, droid-acp).
 *
 * Follows the same pattern as Zed IDE's client-side ACP implementation:
 * 1. Spawn adapter process
 * 2. Create NDJSON stream from stdin/stdout
 * 3. Create ClientSideConnection with Client callbacks
 * 4. initialize → newSession → prompt → collect output
 */
export interface AcpSessionOptions {
  bridgePath?: string
  agentName?: string
  taskId?: string
  project?: string
  showViewer?: boolean
}

export async function runAcpSession(
  config: AcpSpawnConfig,
  prompt: string,
  modelId?: string,
  options?: AcpSessionOptions,
): Promise<AcpResult> {
  let output = ''
  let toolOutput = '' // Captured from tool calls (file writes, diffs, terminal)
  let stderr = ''
  let timedOut = false
  const toolCalls: ToolCallInfo[] = []

  function appendOutput(text: string) {
    if (output.length < MAX_OUTPUT_BYTES) {
      output += text.slice(0, MAX_OUTPUT_BYTES - output.length)
    }
  }

  function appendToolOutput(text: string) {
    if (toolOutput.length < MAX_TOOL_OUTPUT_BYTES) {
      toolOutput += text.slice(0, MAX_TOOL_OUTPUT_BYTES - toolOutput.length)
    }
  }

  /** Tool titles that indicate file-read operations (output is not useful to return) */
  const READ_TOOL_PATTERNS = /\b(read|cat|view|open|load)\b.*\b(file|content|source)\b/i

  interface ToolContentItem {
    type: string
    content?: Array<{ type: string; text?: string }> | string
    uri?: string
    diff?: string
    output?: string
  }

  interface ToolCallUpdate {
    title?: string
    content?: ToolContentItem[]
    rawOutput?: string | unknown
  }

  /** Extract text content from tool_call and tool_call_update events */
  function extractToolContent(update: ToolCallUpdate) {
    // Skip raw file-read tool output — it's not useful for orchestrator
    const title = update.title ?? ''
    if (READ_TOOL_PATTERNS.test(title)) {
      return
    }

    // Content array — text blocks, diffs, terminal output
    if (Array.isArray(update.content)) {
      for (const item of update.content) {
        if (item.type === 'content' && item.content) {
          if (Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === 'text' && c.text) {
                appendToolOutput(c.text)
              }
            }
          }
        } else if (item.type === 'diff' && item.diff) {
          appendToolOutput(`\n[diff: ${item.uri ?? 'unknown'}]\n${item.diff}\n`)
        } else if (item.type === 'terminal' && item.output) {
          appendToolOutput(item.output)
        }
      }
    }
    // rawOutput — only capture if reasonably sized (skip large file dumps)
    if (update.rawOutput != null) {
      const raw = typeof update.rawOutput === 'string'
        ? update.rawOutput
        : JSON.stringify(update.rawOutput)
      if (raw.length > 0 && raw.length < 10_000) {
        appendToolOutput(raw)
      }
    }
  }

  // Session viewer — opens a Ghostty terminal showing live progress
  let viewer: SessionViewer | null = null
  if (options?.showViewer && options?.taskId && options?.agentName) {
    viewer = new SessionViewer({
      taskId: options.taskId,
      agentName: options.agentName,
      model: modelId ?? 'unknown',
      project: options.project ?? config.cwd,
      prompt,
    })
    await viewer.open()
  }

  logger.info(`[ACP] ▶ Spawning ${options?.agentName ?? config.command} (${modelId ?? 'default'})  cmd: ${config.command} ${config.args.join(' ')}`)

  // 1. Spawn the ACP adapter process
  let proc: ChildProcess
  try {
    proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: {
        // Allowlist — only pass essential system vars, not all secrets
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        SHELL: process.env['SHELL'] ?? '',
        TERM: process.env['TERM'] ?? '',
        LANG: process.env['LANG'] ?? '',
        NODE_ENV: process.env['NODE_ENV'] ?? '',
        // Agent-specific env vars (API keys only for this agent)
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    operationalMetrics.increment('agentSpawnFailures')
    return { output: '', error: `Failed to spawn: ${err}`, timedOut: false, stopReason: null, toolCalls: [] }
  }

  // 2. Process lifecycle promise — rejects on spawn error or unexpected exit
  const processExited = new Promise<never>((_resolve, reject) => {
    proc.on('error', (err) => {
      reject(new Error(`ACP adapter process error (${config.command}): ${err.message}`))
    })
    proc.on('close', (code, signal) => {
      reject(new Error(`ACP adapter exited unexpectedly: code=${code} signal=${signal}`))
    })
  })

  // Capture stderr for diagnostics, capped at MAX_STDERR_BYTES
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length)
    }
  })

  // Timeout handler
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    operationalMetrics.increment('agentTimeouts')
    logger.warn(`ACP session timed out after ${TASK_TIMEOUT_MS}ms, killing process`)
    safeKill(proc, 'SIGTERM')
    sigkillTimer = setTimeout(() => safeKill(proc, 'SIGKILL'), 5000)
  }, TASK_TIMEOUT_MS)

  try {
    // 3. Create NDJSON stream from child process stdin/stdout
    // Bridge Node.js/Web stream type differences (same as Zed adapters)
    const stream = ndJsonStream(
      nodeToWebWritable(proc.stdin as Writable) as any,
      nodeToWebReadable(proc.stdout as Readable) as any,
    )

    // 4. Create ClientSideConnection with our Client implementation
    const connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        // Permission controls: policy-based allowlist engine
        requestPermission: (async (params: AcpPermissionRequest): Promise<AcpPermissionResponse> => {
          const toolTitle = params.toolCall?.title ?? 'unknown'
          const toolName = params.toolCall?.toolName ?? toolTitle

          // Extract arguments from the tool call
          const args: Record<string, unknown> = {}
          if (params.toolCall?.arguments) {
            for (const [key, value] of Object.entries(params.toolCall.arguments)) {
              args[key] = value
            }
          }

          // Evaluate against permission policy
          const result = evaluatePermission({
            toolName,
            toolTitle,
            args,
            projectRoot: config.cwd,
          })

          // Handle the permission result
          viewer?.logPermission(result.action, toolTitle)

          switch (result.action) {
            case 'deny':
              logger.warn(`Permission DENIED (${result.matchedRule}): ${toolTitle} - ${result.reason}`)
              const denyOption = params.options?.find((o: AcpPermissionOption) => o.kind === 'deny')
              return {
                outcome: { outcome: 'selected', optionId: denyOption?.optionId ?? 'deny' },
              }

            case 'ask':
              logger.info(`Permission ASK (${result.matchedRule}): ${toolTitle} - requires user approval`)
              // Prefer allow_once over allow_always to limit blast radius
              const allowOnce = params.options?.find((o: AcpPermissionOption) => o.kind === 'allow_once')
              const allowAlways = params.options?.find((o: AcpPermissionOption) => o.kind === 'allow_always')
              const askSelected = allowOnce ?? allowAlways
              return {
                outcome: { outcome: 'selected', optionId: askSelected?.optionId ?? 'allow_once' },
              }

            case 'allow':
            default:
              logger.info(`Permission ALLOWED (${result.matchedRule}): ${toolTitle}`)
              // Prefer allow_once over allow_always to limit blast radius
              const grantOnce = params.options?.find((o: AcpPermissionOption) => o.kind === 'allow_once')
              const grantAlways = params.options?.find((o: AcpPermissionOption) => o.kind === 'allow_always')
              const grantSelected = grantOnce ?? grantAlways
              return {
                outcome: { outcome: 'selected', optionId: grantSelected?.optionId ?? 'allow' },
              }
          }
        }) as any,

        // Collect streamed output from the agent
        sessionUpdate: (async (notification: any) => {
          const update = notification.update as any
          switch (update.sessionUpdate) {
            case 'agent_message_chunk':
              if (update.content?.type === 'text') {
                appendOutput(update.content.text)
                viewer?.logOutput(update.content.text)
              }
              break
            case 'agent_thought_chunk':
              logger.debug(`[thought] ${update.content?.text?.slice(0, 100)}...`)
              viewer?.log('\x1b[90m💭 Thinking\x1b[0m', update.content?.text?.slice(0, 120))
              break
            case 'tool_call': {
              toolCalls.push({
                toolCallId: update.toolCallId,
                title: update.title,
                status: update.status,
              })
              logger.debug(`Tool call: ${update.title ?? update.toolCallId}`)
              viewer?.logToolCall(update.title ?? update.toolCallId, update.status)
              extractToolContent(update)
              break
            }
            case 'tool_call_update': {
              logger.debug(`Tool update: ${update.toolCallId} → ${update.status}`)
              viewer?.logToolCall(update.title ?? update.toolCallId, update.status)
              extractToolContent(update)
              break
            }
            case 'plan':
              logger.debug(`Plan update: ${JSON.stringify(update.entries?.length ?? 0)} entries`)
              viewer?.log('\x1b[34m📋 Plan\x1b[0m', `${update.entries?.length ?? 0} entries`)
              break
          }
        }) as any,
      }),
      stream,
    )

    // 5. Initialize — negotiate protocol version and capabilities
    //    Race against process lifecycle + 30s timeout
    logger.info('Sending ACP initialize...')
    const initParams: AcpInitializeParams = {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'cli-team-bridge', version: VERSION },
    }
    const initResult = await Promise.race([
      withTimeout(
        connection.initialize(initParams as unknown as Parameters<typeof connection.initialize>[0]),
        INIT_TIMEOUT_MS,
        'ACP initialize',
      ),
      processExited,
    ]) as AcpInitializeResult

    logger.info(`ACP initialized: ${initResult.agentInfo?.name ?? 'unknown'} v${initResult.agentInfo?.version ?? '?'}`)

    // 6. Create new session — race against process lifecycle + 30s timeout
    logger.info('Creating ACP session...')
    const newSessionParams: AcpNewSessionParams = {
      cwd: config.cwd,
      mcpServers: [],
    }
    const session = await Promise.race([
      withTimeout(
        connection.newSession(newSessionParams as unknown as Parameters<typeof connection.newSession>[0]),
        INIT_TIMEOUT_MS,
        'ACP newSession',
      ),
      processExited,
    ]) as AcpNewSessionResult

    const sessionId = session.sessionId
    logger.info(`ACP session created: ${sessionId}`)

    // 7. Set model if requested and available
    if (modelId && session.models?.availableModels) {
      const available = session.models.availableModels
      const match = available.find((m) => m.modelId === modelId || m.name === modelId)
      if (match) {
        try {
          const setModelParams: AcpSetSessionModelParams = {
            sessionId,
            modelId: match.modelId,
          }
          await connection.unstable_setSessionModel?.(setModelParams as unknown as Parameters<typeof connection.unstable_setSessionModel>[0])
          logger.info(`Model set to: ${match.modelId}`)
        } catch (err) {
          logger.warn(`Failed to set model ${modelId}: ${err}`)
        }
      } else {
        logger.warn(`Model "${modelId}" not available. Available: ${available.map((m) => m.modelId).join(', ')}`)
      }
    }

    // 8. Register agent and inject context from pending messages
    let finalPrompt = prompt
    if (options?.bridgePath && options?.agentName) {
      const reg = new AgentRegistry(options.bridgePath)
      const bus = new MessageBus(options.bridgePath)
      reg.register(options.agentName, modelId ?? 'unknown', proc.pid ?? undefined)

      // Context injection: prepend unread messages to prompt
      const unread = bus.getUnreadMessages(options.agentName)
      if (unread.length > 0) {
        const msgLines = unread.map(m =>
          `[${m.from} → ${m.to === 'all' ? 'all' : 'you'}] ${m.content}`
        ).join('\n')
        finalPrompt = `--- Messages from other agents ---\n${msgLines}\n--- End messages ---\n\n${prompt}`
        bus.markAllRead(options.agentName)
        logger.info(`[ACP] Injected ${unread.length} messages into prompt for ${options.agentName}`)
      }
    }

    // 9. Send prompt and wait for completion — race against process lifecycle
    logger.info('Sending ACP prompt...')
    const promptParams: AcpPromptParams = {
      sessionId,
      prompt: [{ type: 'text', text: finalPrompt }],
    }
    const result = await Promise.race([
      connection.prompt(promptParams as unknown as Parameters<typeof connection.prompt>[0]),
      processExited,
    ]) as AcpPromptResult

    const stopReason = result.stopReason ?? null
    logger.info(`[ACP] ✓ ${options?.agentName ?? 'agent'} completed (stopReason=${stopReason})`)

    clearTimeout(timeoutHandle)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    // Deregister agent on completion
    if (options?.bridgePath && options?.agentName) {
      new AgentRegistry(options.bridgePath).deregister(options.agentName)
    }

    // Kill the process gracefully
    safeKill(proc)

    // If agent message output is thin but tool output has substance, merge them
    // This handles agents that write files via tools instead of returning text
    const finalOutput = mergeOutput(output, toolOutput)

    viewer?.complete('completed', finalOutput.length)
    return { output: finalOutput, error: null, timedOut: false, stopReason, toolCalls }
  } catch (err) {
    clearTimeout(timeoutHandle)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    // Deregister agent on error
    if (options?.bridgePath && options?.agentName) {
      new AgentRegistry(options.bridgePath).deregister(options.agentName)
    }

    safeKill(proc)

    const errStr = err instanceof Error ? err.message : JSON.stringify(err, null, 2)
    const errorMsg = `ACP session error: ${errStr}${stderr ? `\nstderr: ${stderr.slice(0, 2000)}` : ''}`
    logger.error(errorMsg)
    viewer?.complete(timedOut ? 'timed_out' : 'failed')
    return { output, error: errorMsg, timedOut, stopReason: null, toolCalls }
  }
}
