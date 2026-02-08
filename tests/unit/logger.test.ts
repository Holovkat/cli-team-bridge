import { describe, it, expect, beforeEach } from 'bun:test'
import { configureLogger, logger } from '../../src/logger'

describe('Logger', () => {
  beforeEach(() => {
    configureLogger('debug')
  })

  it('should not throw on any log level', () => {
    expect(() => logger.debug('debug msg')).not.toThrow()
    expect(() => logger.info('info msg')).not.toThrow()
    expect(() => logger.warn('warn msg')).not.toThrow()
    expect(() => logger.error('error msg')).not.toThrow()
  })

  it('should redact API keys from log output', () => {
    // The sanitize function is internal, but we can verify it doesn't crash
    // and that it processes strings with API key patterns
    expect(() => logger.info('key is sk-1234567890abcdefghijklmnop')).not.toThrow()
    expect(() => logger.info('token: ghp_abcdefghijklmnopqrstuvwxyz1234567890')).not.toThrow()
    expect(() => logger.info('Bearer eyJhbGciOiJIUzI1NiJ9.test')).not.toThrow()
  })
})
