import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { TaskWatcher } from '../../src/task-watcher'
import type { BridgeConfig } from '../../src/config'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDir: string

const mockConfig: BridgeConfig = {
  workspaceRoot: '/tmp',
  agents: {
    'test-agent': {
      type: 'acp', command: 'codex-acp', args: [], cwd: '/tmp',
      defaultModel: 'test', models: { test: { flag: '', value: '' } }, strengths: [],
    },
  },
  permissions: { autoApprove: false },
  polling: { intervalMs: 60000 },
  logging: { level: 'info' },
  messaging: { enabled: false, failSilently: true },
  viewer: { enabled: false },
}

beforeEach(() => {
  testDir = join(tmpdir(), `watcher-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('TaskWatcher', () => {
  it('should emit task-assigned for pending tasks owned by known agents', (done) => {
    const watcher = new TaskWatcher(mockConfig, testDir)

    writeFileSync(join(testDir, 'task-1.json'), JSON.stringify({
      id: 'task-1', subject: 'Test', description: 'Test task',
      owner: 'test-agent', status: 'pending',
    }))

    watcher.on('task-assigned', (assignment) => {
      expect(assignment.task.id).toBe('task-1')
      expect(assignment.task.owner).toBe('test-agent')
      watcher.stop()
      done()
    })

    watcher.start()
  })

  it('should skip tasks not in pending status', async () => {
    const watcher = new TaskWatcher(mockConfig, testDir)
    let emitted = false

    writeFileSync(join(testDir, 'task-2.json'), JSON.stringify({
      id: 'task-2', subject: 'Done', description: 'Already done',
      owner: 'test-agent', status: 'completed',
    }))

    watcher.on('task-assigned', () => { emitted = true })
    watcher.start()
    await Bun.sleep(200)
    watcher.stop()
    expect(emitted).toBe(false)
  })

  it('should skip tasks owned by unknown agents', async () => {
    const watcher = new TaskWatcher(mockConfig, testDir)
    let emitted = false

    writeFileSync(join(testDir, 'task-3.json'), JSON.stringify({
      id: 'task-3', subject: 'Unknown', description: 'Unknown agent',
      owner: 'unknown-agent', status: 'pending',
    }))

    watcher.on('task-assigned', () => { emitted = true })
    watcher.start()
    await Bun.sleep(200)
    watcher.stop()
    expect(emitted).toBe(false)
  })

  it('should skip blocked tasks', async () => {
    const watcher = new TaskWatcher(mockConfig, testDir)
    let emitted = false

    writeFileSync(join(testDir, 'task-4.json'), JSON.stringify({
      id: 'task-4', subject: 'Blocked', description: 'Blocked task',
      owner: 'test-agent', status: 'pending', blockedBy: ['other-task'],
    }))

    watcher.on('task-assigned', () => { emitted = true })
    watcher.start()
    await Bun.sleep(200)
    watcher.stop()
    expect(emitted).toBe(false)
  })
})
