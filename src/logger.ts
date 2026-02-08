import { appendFileSync, appendFile, chmodSync } from 'fs'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let currentLevel: LogLevel = 'info'
let logFile: string | undefined

export function configureLogger(level: LogLevel, file?: string) {
  currentLevel = level
  logFile = file
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,          // OpenAI keys
  /anthropic-[a-zA-Z0-9_-]{20,}/g,    // Anthropic keys
  /ghp_[a-zA-Z0-9]{36}/g,             // GitHub PATs
  /Bearer\s+[a-zA-Z0-9._-]+/gi,       // Bearer tokens
  /api[_-]?key[=:]\s*[^\s,}]+/gi,     // Generic API keys
]

let logFilePermissionsSet = false

function sanitize(message: string): string {
  let result = message
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

function formatMessage(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${sanitize(message)}`
}

function writeToFileSync(formatted: string) {
  if (!logFile) return
  try {
    appendFileSync(logFile, formatted + '\n')
    if (!logFilePermissionsSet) {
      chmodSync(logFile, 0o600)
      logFilePermissionsSet = true
    }
  } catch {
    // Cannot write to log file — nowhere safe to report this
  }
}

function writeToFileAsync(formatted: string) {
  if (!logFile) return
  appendFile(logFile, formatted + '\n', () => {
    if (!logFilePermissionsSet) {
      try {
        chmodSync(logFile!, 0o600)
        logFilePermissionsSet = true
      } catch {
        // Ignore — best effort
      }
    }
  })
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[currentLevel]) return
  const formatted = formatMessage(level, message)

  // Always use console.error to avoid corrupting MCP JSON-RPC on stdout
  console.error(formatted)

  // Use sync writes for error/warn (crash safety), async for info/debug
  if (level === 'error' || level === 'warn') {
    writeToFileSync(formatted)
  } else {
    writeToFileAsync(formatted)
  }
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
}
