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

async function writeToFile(formatted: string) {
  if (!logFile) return
  try {
    await Bun.write(Bun.file(logFile), formatted + '\n', { append: true } as any)
  } catch {
    // Fallback: append via file API
    const file = Bun.file(logFile)
    const existing = await file.exists() ? await file.text() : ''
    await Bun.write(logFile, existing + formatted + '\n')
  }
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[currentLevel]) return
  const formatted = formatMessage(level, message)
  console[level === 'debug' ? 'log' : level](formatted)
  writeToFile(formatted)
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
}
