import { appendFileSync, appendFile } from 'fs'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let currentLevel: LogLevel = 'info'
let logFile: string | undefined

export function configureLogger(level: LogLevel, file?: string) {
  currentLevel = level
  logFile = file
}

function formatMessage(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`
}

function writeToFileSync(formatted: string) {
  if (!logFile) return
  try {
    appendFileSync(logFile, formatted + '\n')
  } catch {
    // Cannot write to log file — nowhere safe to report this
  }
}

function writeToFileAsync(formatted: string) {
  if (!logFile) return
  appendFile(logFile, formatted + '\n', () => {
    // Fire and forget — errors silently ignored for non-critical log levels
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
