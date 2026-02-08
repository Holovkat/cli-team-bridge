import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { writeTaskResult, markTaskInProgress, type TaskResult } from '../../src/result-writer'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `result-writer-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('writeTaskResult', () => {
  it('should write task result successfully', async () => {
    const taskFile = join(testDir, 'task-1.json')
    writeFileSync(taskFile, JSON.stringify({ id: 'task-1', status: 'in_progress', subject: 'Test task' }))

    const result: TaskResult = {
      agentName: 'test-agent',
      model: 'test-model',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      status: 'completed',
      output: 'Task output here',
      error: null,
    }

    const success = await writeTaskResult(taskFile, result, testDir)
    expect(success).toBe(true)

    const written = JSON.parse(readFileSync(taskFile, 'utf-8'))
    expect(written.status).toBe('completed')
    expect(written.result.output).toBe('Task output here')
  })

  it('should return false on write failure', async () => {
    const success = await writeTaskResult('/nonexistent/path/task.json', {
      agentName: 'a', model: 'm', startedAt: '', completedAt: '', status: 'completed', output: '', error: null,
    }, testDir)
    expect(success).toBe(false)
  })
})

describe('markTaskInProgress', () => {
  it('should mark task as in_progress', async () => {
    const taskFile = join(testDir, 'task-2.json')
    writeFileSync(taskFile, JSON.stringify({ id: 'task-2', status: 'pending', subject: 'Test' }))

    const success = await markTaskInProgress(taskFile, testDir)
    expect(success).toBe(true)

    const task = JSON.parse(readFileSync(taskFile, 'utf-8'))
    expect(task.status).toBe('in_progress')
  })
})
