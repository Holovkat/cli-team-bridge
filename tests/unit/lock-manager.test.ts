import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { LockManager } from '../../src/lock-manager'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `lock-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('LockManager', () => {
  it('should acquire lock on first attempt', async () => {
    const lock = new LockManager(testDir)
    const acquired = await lock.acquire()
    expect(acquired).toBe(true)
    expect(existsSync(join(testDir, '.bridge-lock'))).toBe(true)
    lock.release()
  })

  it('should release lock successfully', async () => {
    const lock = new LockManager(testDir)
    await lock.acquire()
    lock.release()
    expect(existsSync(join(testDir, '.bridge-lock'))).toBe(false)
  })

  it('should timeout after specified duration', async () => {
    const lock1 = new LockManager(testDir)
    const lock2 = new LockManager(testDir)
    await lock1.acquire()
    const acquired = await lock2.acquire(500) // 500ms timeout
    expect(acquired).toBe(false)
    lock1.release()
  })

  it('should fail to acquire when lock held by another', async () => {
    const lock1 = new LockManager(testDir)
    const lock2 = new LockManager(testDir)
    await lock1.acquire()
    const result = await lock2.acquire(200)
    expect(result).toBe(false)
    lock1.release()
  })
})
