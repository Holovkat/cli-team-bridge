/**
 * Session Viewer — shows live agent session progress in a tiled Ghostty window.
 *
 * Uses a single Ghostty window running a tmux session ("bridge-viewer").
 * Each agent task gets its own tmux pane tailing a per-task log file.
 * Panes tile automatically as agents are added.
 */
import { execFileSync, spawn } from 'child_process'
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'

const LOG_DIR = join(process.env['HOME'] ?? '/tmp', '.bridge-sessions')
const TMUX_SESSION = 'bridge-viewer'

/** Check if the tmux session exists */
function tmuxSessionExists(): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Count panes in the tmux session */
function tmuxPaneCount(): number {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', TMUX_SESSION], { encoding: 'utf8' })
    return out.trim().split('\n').length
  } catch {
    return 0
  }
}

/** Open the Ghostty window with the tmux session */
function openGhosttyWithTmux(): void {
  if (process.platform !== 'darwin' || !existsSync('/Applications/Ghostty.app')) {
    logger.warn('[SessionViewer] Ghostty not found, session logs only')
    return
  }

  // Create tmux session (detached) if it doesn't exist
  if (!tmuxSessionExists()) {
    try {
      execFileSync('tmux', [
        'new-session', '-d', '-s', TMUX_SESSION, '-x', '220', '-y', '60',
        'echo "  Bridge Session Viewer — waiting for agents..."; sleep 86400',
      ], { stdio: 'ignore' })
    } catch (err) {
      logger.warn(`[SessionViewer] Failed to create tmux session: ${err}`)
      return
    }

    // Configure tmux session appearance
    const tmuxOpts: [string, string][] = [
      ['pane-border-status', 'top'],
      ['pane-border-format', ' #{pane_title} '],
      ['pane-border-style', 'fg=colour240'],
      ['pane-active-border-style', 'fg=colour45'],
      ['status-style', 'bg=colour235,fg=colour45'],
      ['status-left', ' Bridge Viewer '],
      ['status-right', ' %H:%M '],
    ]
    for (const [key, value] of tmuxOpts) {
      try {
        execFileSync('tmux', ['set-option', '-t', TMUX_SESSION, key, value], { stdio: 'ignore' })
      } catch { /* ignore styling errors */ }
    }
  }

  // Check if Ghostty is already showing the session
  try {
    const clients = execFileSync('tmux', ['list-clients', '-t', TMUX_SESSION], { encoding: 'utf8' }).trim()
    if (clients.length > 0) {
      logger.info('[SessionViewer] Ghostty viewer already open')
      return
    }
  } catch {
    // No clients — need to open Ghostty
  }

  try {
    const ghosttyProc = spawn('open', [
      '-na', 'Ghostty.app',
      '--args',
      '--title=Bridge Session Viewer',
      '--window-width=220',
      '--window-height=60',
      '-e', `tmux attach -t ${TMUX_SESSION}`,
    ], {
      detached: true,
      stdio: 'ignore',
    })
    ghosttyProc.unref()
    logger.info('[SessionViewer] Opened Ghostty with tmux session')
  } catch (err) {
    logger.warn(`[SessionViewer] Failed to open Ghostty: ${err}`)
  }
}

/** Add a new tmux pane tailing a log file */
function addTmuxPane(logPath: string, agentName: string): void {
  try {
    const panes = tmuxPaneCount()

    if (panes <= 1) {
      // First real pane — kill the placeholder and use the existing pane
      execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'C-c'], { stdio: 'ignore' })
      execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, `tail -f "${logPath}"`, 'Enter'], { stdio: 'ignore' })
      execFileSync('tmux', ['select-pane', '-t', TMUX_SESSION, '-T', agentName], { stdio: 'ignore' })
    } else {
      // Split and add new pane
      execFileSync('tmux', ['split-window', '-t', TMUX_SESSION, `tail -f "${logPath}"`], { stdio: 'ignore' })
      execFileSync('tmux', ['select-pane', '-t', TMUX_SESSION, '-T', agentName], { stdio: 'ignore' })
      // Re-tile all panes evenly
      execFileSync('tmux', ['select-layout', '-t', TMUX_SESSION, 'tiled'], { stdio: 'ignore' })
    }
  } catch (err) {
    logger.warn(`[SessionViewer] Failed to add tmux pane for ${agentName}: ${err}`)
  }
}

export interface SessionViewerOptions {
  taskId: string
  agentName: string
  model: string
  project: string
  prompt: string
}

export class SessionViewer {
  private logPath: string
  private taskId: string
  private agentName: string
  private startTime: number

  constructor(opts: SessionViewerOptions) {
    this.taskId = opts.taskId
    this.agentName = opts.agentName
    this.startTime = Date.now()

    // Ensure log directory exists
    mkdirSync(LOG_DIR, { recursive: true })

    this.logPath = join(LOG_DIR, `${opts.taskId}.log`)

    // Write session header
    const header = [
      `\x1b[1;36m╔══════════════════════════════════════════════════════╗\x1b[0m`,
      `\x1b[1;36m║\x1b[0m  \x1b[1mAgent\x1b[0m: \x1b[33m${opts.agentName}\x1b[0m / \x1b[35m${opts.model}\x1b[0m`,
      `\x1b[1;36m║\x1b[0m  \x1b[1mTask\x1b[0m: ${opts.taskId.slice(0, 8)}...  \x1b[90m${new Date().toLocaleTimeString()}\x1b[0m`,
      `\x1b[1;36m║\x1b[0m  \x1b[1mPrompt\x1b[0m: ${opts.prompt.slice(0, 60)}${opts.prompt.length > 60 ? '...' : ''}`,
      `\x1b[1;36m╚══════════════════════════════════════════════════════╝\x1b[0m`,
      '',
    ].join('\n')

    writeFileSync(this.logPath, header)
  }

  /** Open/reuse the Ghostty+tmux viewer and add a pane for this session */
  open(): void {
    try {
      openGhosttyWithTmux()
      // Small delay to let Ghostty attach before splitting
      const delay = tmuxSessionExists() && tmuxPaneCount() > 0 ? 200 : 1500
      setTimeout(() => {
        addTmuxPane(this.logPath, this.agentName)
      }, delay)
      logger.info(`[SessionViewer] Added pane for ${this.agentName} (${this.taskId.slice(0, 8)})`)
    } catch (err) {
      logger.warn(`[SessionViewer] Failed to open viewer: ${err}`)
    }
  }

  /** Log a session event */
  log(event: string, detail?: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
    const timestamp = `\x1b[90m[${elapsed}s]\x1b[0m`
    const line = detail
      ? `${timestamp} ${event}: ${detail}\n`
      : `${timestamp} ${event}\n`
    try {
      appendFileSync(this.logPath, line)
    } catch { /* Don't crash */ }
  }

  /** Log agent text output */
  logOutput(text: string): void {
    try {
      appendFileSync(this.logPath, text)
    } catch { /* Don't crash */ }
  }

  /** Log a tool call event */
  logToolCall(title: string, status?: string): void {
    const icon = status === 'completed' ? '\x1b[32m✓\x1b[0m'
      : status === 'failed' ? '\x1b[31m✗\x1b[0m'
      : '\x1b[33m⚙\x1b[0m'
    this.log(`${icon} \x1b[1mTool\x1b[0m`, title)
  }

  /** Log permission decision */
  logPermission(action: string, toolTitle: string): void {
    const icon = action === 'allow' ? '\x1b[32m✓\x1b[0m'
      : action === 'deny' ? '\x1b[31m✗\x1b[0m'
      : '\x1b[33m?\x1b[0m'
    this.log(`${icon} \x1b[1mPermission ${action}\x1b[0m`, toolTitle)
  }

  /** Log session completion */
  complete(status: 'completed' | 'failed' | 'timed_out', outputLength?: number): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
    const icon = status === 'completed' ? '\x1b[32m✓\x1b[0m'
      : status === 'timed_out' ? '\x1b[33m⏳\x1b[0m'
      : '\x1b[31m✗\x1b[0m'

    const footer = [
      '',
      `\x1b[1;36m╔══════════════════════════════════════════════════════╗\x1b[0m`,
      `\x1b[1;36m║\x1b[0m  ${icon} \x1b[1m${status.toUpperCase()}\x1b[0m in ${elapsed}s${outputLength != null ? `  (${outputLength} chars)` : ''}`,
      `\x1b[1;36m╚══════════════════════════════════════════════════════╝\x1b[0m`,
      '',
    ].join('\n')

    try {
      appendFileSync(this.logPath, footer)
    } catch { /* Don't crash */ }
  }

  /** Get the log file path */
  getLogPath(): string {
    return this.logPath
  }

  /** Close the viewer (no-op — tmux panes stay until session is killed) */
  close(): void {
    // Panes stay open for review; user can kill tmux session manually
  }
}

/** Kill the tmux viewer session (cleanup) */
export function killViewerSession(): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
    logger.info('[SessionViewer] Killed tmux viewer session')
  } catch {
    // Session doesn't exist — fine
  }
}
