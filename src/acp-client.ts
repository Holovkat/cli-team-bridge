import { spawn, type ChildProcess } from 'child_process'
import { logger } from './logger'

export interface SpawnConfig {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface AcpResult {
  output: string
  error: string | null
  timedOut: boolean
}

const TASK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Spawn an agent CLI in ACP mode, send a prompt, and collect the result.
 *
 * NOTE: This is a placeholder implementation. Phase 2 will verify the exact
 * ACP protocol (initialize/newSession/prompt lifecycle) and the correct SDK
 * import paths. This will be updated with real ACP SDK usage after verification.
 */
export async function runAcpSession(
  config: SpawnConfig,
  prompt: string,
): Promise<AcpResult> {
  return new Promise((resolve) => {
    let output = ''
    let stderr = ''
    let timedOut = false
    let proc: ChildProcess

    logger.info(`Spawning: ${config.command} ${config.args.join(' ')}`)

    try {
      proc = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ output: '', error: `Failed to spawn: ${err}`, timedOut: false })
      return
    }

    const timeout = setTimeout(() => {
      timedOut = true
      logger.warn(`Task timed out after ${TASK_TIMEOUT_MS}ms, killing process`)
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, TASK_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      const error = code !== 0 ? `Process exited with code ${code}. stderr: ${stderr}` : null
      resolve({ output, error, timedOut })
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ output, error: `Process error: ${err.message}`, timedOut })
    })

    // TODO: Replace with proper ACP protocol handshake after Phase 2 verification
    // For now, write the prompt to stdin as a simple message
    if (proc.stdin) {
      proc.stdin.write(prompt + '\n')
      proc.stdin.end()
    }
  })
}
