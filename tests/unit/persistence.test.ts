import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { TaskStore } from '../../src/persistence'
import { rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dbPath: string
let store: TaskStore

beforeEach(() => {
  dbPath = join(tmpdir(), `test-tasks-${Date.now()}.db`)
  store = new TaskStore(dbPath)
})

afterEach(() => {
  store.close()
  try { rmSync(dbPath) } catch {}
})

describe('TaskStore', () => {
  it('should save and retrieve a task', () => {
    store.save({ id: 'task-1', agent: 'droid', model: 'kimi', project: 'test', prompt: 'do something', status: 'running', startedAt: '2026-01-01T00:00:00Z' })
    const task = store.get('task-1')
    expect(task).not.toBeNull()
    expect(task!.agent).toBe('droid')
    expect(task!.status).toBe('running')
  })

  it('should update task status', () => {
    store.save({ id: 'task-2', agent: 'droid', model: 'kimi', project: 'test', prompt: 'do something', status: 'running', startedAt: '2026-01-01T00:00:00Z' })
    store.update('task-2', { status: 'completed', completedAt: '2026-01-01T00:01:00Z', output: 'done' })
    const task = store.get('task-2')
    expect(task!.status).toBe('completed')
    expect(task!.output).toBe('done')
  })

  it('should return null for nonexistent task', () => {
    expect(store.get('nonexistent')).toBeNull()
  })

  it('should list running tasks', () => {
    store.save({ id: 't1', agent: 'a', model: 'm', project: 'p', prompt: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z' })
    store.save({ id: 't2', agent: 'a', model: 'm', project: 'p', prompt: 'x', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' })
    const running = store.listRunning()
    expect(running.length).toBe(1)
    expect(running[0].id).toBe('t1')
  })

  it('should recover orphaned tasks', () => {
    store.save({ id: 'orphan', agent: 'a', model: 'm', project: 'p', prompt: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z' })
    const count = store.recoverOrphaned()
    expect(count).toBe(1)
    const task = store.get('orphan')
    expect(task!.status).toBe('failed')
    expect(task!.error).toContain('orphaned')
  })
})
