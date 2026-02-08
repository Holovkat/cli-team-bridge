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
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
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
export async function runAcpSession(
  config: AcpSpawnConfig,
  prompt: string,
  modelId?: string,
): Promise<AcpResult> {
  let output = ''
  let stderr = ''
  let timedOut = false
  const toolCalls: ToolCallInfo[] = []

  logger.info(`Spawning ACP adapter: ${config.command} ${config.args.join(' ')}`)

  // 1. Spawn the ACP adapter process
  let proc: ChildProcess
  try {
    proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
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
    logger.warn(`ACP session timed out after ${TASK_TIMEOUT_MS}ms, killing process`)
    safeKill(proc, 'SIGTERM')
    sigkillTimer = setTimeout(() => safeKill(proc, 'SIGKILL'), 5000)
  }, TASK_TIMEOUT_MS)

  try {
    // 3. Create NDJSON stream from child process stdin/stdout
    // Cast to any to bridge Node.js/Web stream type differences (same as Zed adapters)
    const stream = ndJsonStream(
      nodeToWebWritable(proc.stdin as Writable) as any,
      nodeToWebReadable(proc.stdout as Readable) as any,
    )

    // 4. Create ClientSideConnection with our Client implementation
    const connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        // Auto-approve all permission requests (bridge runs in trusted mode)
        requestPermission: async (params) => {
          const allowOption = params.options?.find(
            (o: any) => o.kind === 'allow_always' || o.kind === 'allow_once',
          )
          logger.debug(`Permission requested: ${params.toolCall?.title ?? 'unknown'} → auto-approving`)
          return {
            outcome: {
              outcome: 'selected',
              optionId: allowOption?.optionId ?? 'allow',
            },
          } as any
        },

        // Collect streamed output from the agent
        sessionUpdate: async (notification) => {
          const update = notification.update as any
          switch (update.sessionUpdate) {
            case 'agent_message_chunk':
              if (update.content?.type === 'text') {
                output += update.content.text
              }
              break
            case 'agent_thought_chunk':
              // Log thinking but don't include in output
              logger.debug(`[thought] ${update.content?.text?.slice(0, 100)}...`)
              break
            case 'tool_call':
              toolCalls.push({
                toolCallId: update.toolCallId,
                title: update.title,
                status: update.status,
              })
              logger.debug(`Tool call: ${update.title ?? update.toolCallId}`)
              break
            case 'tool_call_update':
              logger.debug(`Tool update: ${update.toolCallId} → ${update.status}`)
              break
            case 'plan':
              logger.debug(`Plan update: ${JSON.stringify(update.entries?.length ?? 0)} entries`)
              break
          }
        },
      }),
      stream,
    )

    // 5. Initialize — negotiate protocol version and capabilities
    //    Race against process lifecycle + 30s timeout
    logger.info('Sending ACP initialize...')
    const initResult = await Promise.race([
      withTimeout(
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'cli-team-bridge', version: '0.1.0' },
        } as any),
        INIT_TIMEOUT_MS,
        'ACP initialize',
      ),
      processExited,
    ])

    logger.info(`ACP initialized: ${(initResult as any).agentInfo?.name ?? 'unknown'} v${(initResult as any).agentInfo?.version ?? '?'}`)

    // 6. Create new session — race against process lifecycle + 30s timeout
    logger.info('Creating ACP session...')
    const session = await Promise.race([
      withTimeout(
        connection.newSession({
          cwd: config.cwd,
          mcpServers: [],
        } as any),
        INIT_TIMEOUT_MS,
        'ACP newSession',
      ),
      processExited,
    ])

    const sessionId = (session as any).sessionId
    logger.info(`ACP session created: ${sessionId}`)

    // 7. Set model if requested and available
    if (modelId && (session as any).models?.availableModels) {
      const available = (session as any).models.availableModels as any[]
      const match = available.find((m: any) => m.modelId === modelId || m.name === modelId)
      if (match) {
        try {
          await (connection as any).unstable_setSessionModel?.({
            sessionId,
            modelId: match.modelId,
          })
          logger.info(`Model set to: ${match.modelId}`)
        } catch (err) {
          logger.warn(`Failed to set model ${modelId}: ${err}`)
        }
      } else {
        logger.warn(`Model "${modelId}" not available. Available: ${available.map((m: any) => m.modelId).join(', ')}`)
      }
    }

    // 8. Send prompt and wait for completion — race against process lifecycle
    logger.info('Sending ACP prompt...')
    const result = await Promise.race([
      connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      } as any),
      processExited,
    ])

    const stopReason = (result as any).stopReason ?? null
    logger.info(`ACP prompt completed: stopReason=${stopReason}`)

    clearTimeout(timeoutHandle)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    // Kill the process gracefully
    safeKill(proc)

    return { output, error: null, timedOut: false, stopReason, toolCalls }
  } catch (err) {
    clearTimeout(timeoutHandle)
    if (sigkillTimer) clearTimeout(sigkillTimer)
    safeKill(proc)

    const errorMsg = `ACP session error: ${err}${stderr ? `\nstderr: ${stderr.slice(0, 2000)}` : ''}`
    logger.error(errorMsg)
    return { output, error: errorMsg, timedOut, stopReason: null, toolCalls }
  }
}
