import { logger } from './logger'

export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

const DEFAULT_RETRY: RetryConfig = { maxRetries: 3, baseDelayMs: 5000, maxDelayMs: 60000 }

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY,
  label: string = 'operation',
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < config.maxRetries) {
        const delay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs)
        logger.warn(`${label} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`)
        await Bun.sleep(delay)
      }
    }
  }
  throw lastError!
}
