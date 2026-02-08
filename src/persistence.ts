import { Database } from 'bun:sqlite'
import { logger } from './logger'

export interface PersistedTask {
  id: string
  agent: string
  model: string
  project: string
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  output?: string
  error?: string | null
}

export class TaskStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      output TEXT,
      error TEXT
    )`)
  }

  save(task: PersistedTask): void {
    this.db.run(
      `INSERT OR REPLACE INTO tasks (id, agent, model, project, prompt, status, started_at, completed_at, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.agent, task.model, task.project, task.prompt, task.status, task.startedAt, task.completedAt ?? null, task.output ?? null, task.error ?? null],
    )
  }

  get(id: string): PersistedTask | null {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, string> | null
    if (!row) return null
    return {
      id: row['id'],
      agent: row['agent'],
      model: row['model'],
      project: row['project'],
      prompt: row['prompt'],
      status: row['status'] as PersistedTask['status'],
      startedAt: row['started_at'],
      completedAt: row['completed_at'] ?? undefined,
      output: row['output'] ?? undefined,
      error: row['error'],
    }
  }

  update(id: string, updates: Partial<Pick<PersistedTask, 'status' | 'completedAt' | 'output' | 'error'>>): void {
    const sets: string[] = []
    const values: (string | null)[] = []
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status) }
    if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(updates.completedAt) }
    if (updates.output !== undefined) { sets.push('output = ?'); values.push(updates.output) }
    if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error ?? null) }
    if (sets.length === 0) return
    values.push(id)
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  listRunning(): PersistedTask[] {
    const rows = this.db.query('SELECT * FROM tasks WHERE status = ?').all('running') as Record<string, string>[]
    return rows.map(row => ({
      id: row['id'],
      agent: row['agent'],
      model: row['model'],
      project: row['project'],
      prompt: row['prompt'],
      status: 'running' as const,
      startedAt: row['started_at'],
    }))
  }

  prune(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    const result = this.db.run(
      `DELETE FROM tasks WHERE status != 'running' AND completed_at < ?`,
      [cutoff],
    )
    return result.changes
  }

  recoverOrphaned(): number {
    const result = this.db.run(
      `UPDATE tasks SET status = 'failed', error = 'Bridge restarted — task orphaned', completed_at = ? WHERE status = 'running'`,
      [new Date().toISOString()],
    )
    if (result.changes > 0) {
      logger.warn(`Recovered ${result.changes} orphaned tasks on startup`)
    }
    return result.changes
  }

  close(): void {
    this.db.close()
  }
}
