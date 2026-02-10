# Viewer Mode Implementation

**Date:** 2026-02-10
**Status:** ✅ Complete

## Overview

This document describes the implementation of interactive tmux mirror mode and the task cleanup race condition fix for the CLI Team Bridge.

---

## Part 1: Interactive Tmux Mirror Mode

### Problem Statement

Agents ran completely headless with piped stdio, making it impossible to debug failures in real-time. Session viewer only showed delayed logs via `tail -f`, providing no visibility into live agent decision-making or permission denials.

### Solution: Mirror-Stream Mode

Added a new viewer mode that streams agent output in real-time to tmux panes while preserving the existing ACP protocol.

**Architecture:**
```
Old: Agent stdout → ACP parser → Log file → tail -f → tmux pane (delayed)
New: Agent stdout → ACP parser → Log file + Stream pipe → tmux pane (real-time)
```

### Implementation Details

#### 1. Configuration Schema (`src/config.ts`)

Added viewer configuration with mode selection:

```typescript
viewer: z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['tail-logs', 'mirror-stream']).default('tail-logs'),
  interactive: z.boolean().default(false), // Reserved for future use
}).default({ enabled: false, mode: 'tail-logs', interactive: false })
```

#### 2. SessionViewer Enhancement (`src/session-viewer.ts`)

**New Properties:**
- `viewerMode: 'tail-logs' | 'mirror-stream'` - Tracks current mode
- `paneId: string | null` - Stores tmux pane ID for streaming

**Key Methods:**

- `streamToTmux(text: string)` - Streams text to tmux pane using `send-keys -l`
  ```typescript
  private streamToTmux(text: string): void {
    if (this.viewerMode === 'mirror-stream' && this.paneId) {
      try {
        const escaped = text.replace(/'/g, "'\\''")
        execFileSync('tmux', ['send-keys', '-t', `${TMUX_SESSION}:${this.agentName}`, '-l', escaped],
          { stdio: 'ignore' })
      } catch (error) {
        logger.debug(`[SessionViewer] Failed to stream to tmux: ${error}`)
      }
    }
  }
  ```

- `addTmuxPane()` - Updated to create different pane types:
  - **tail-logs**: Runs `tail -f logfile` (existing behavior)
  - **mirror-stream**: Shows placeholder "Waiting for agent output..."
  - Returns pane ID for tracking

**Integration Points:**
- `log()` - Writes to file + streams to tmux
- `logOutput()` - Writes to file + streams to tmux
- `complete()` - Writes footer + streams to tmux

#### 3. Wiring Through Components

**ACP Client (`src/acp-client.ts`):**
```typescript
export interface AcpSessionOptions {
  bridgePath?: string
  agentName?: string
  taskId?: string
  project?: string
  showViewer?: boolean
  viewerMode?: 'tail-logs' | 'mirror-stream'  // NEW
}
```

**Task Watcher (`src/index.ts`):**
```typescript
runAcpSession(spawnConfig, task.description, model, {
  taskId: task.id,
  agentName: task.owner,
  project: config.workspaceRoot,
  showViewer: config.viewer?.enabled ?? false,
  viewerMode: config.viewer?.mode ?? 'tail-logs',  // NEW
})
```

**MCP Server (`src/mcp-server.ts`):**
- Updated `assign_task` handler to pass `viewerMode`
- Updated workflow engine to pass `viewerMode`

#### 4. Configuration Example

`bridge.config.local.json`:
```json
{
  "viewer": {
    "enabled": true,
    "mode": "mirror-stream",
    "interactive": false
  }
}
```

### Usage

**Enable mirror-stream mode:**
1. Set `viewer.enabled: true` in config
2. Set `viewer.mode: "mirror-stream"`
3. Restart bridge
4. Assign tasks - tmux panes will show real-time output

**Modes:**
- `tail-logs` - Default, existing behavior (delayed file tail)
- `mirror-stream` - Real-time streaming via tmux send-keys
- `interactive: false` - Reserved for future stdin mirroring

### Benefits

✅ Real-time visibility into agent decision-making
✅ See permission denials as they happen
✅ Debug failures without parsing logs after the fact
✅ No changes to ACP protocol (stdio still piped)
✅ Graceful degradation if tmux fails
✅ Log files still written for persistence

---

## Part 2: Task Cleanup Race Condition Fix

### Problem Statement

Orchestrator received "Task not found" errors when polling completed tasks, even though they just finished successfully.

**Root Cause:**
1. Task completes → `finalizeTask()` called
2. `finalizeTask()` calls `pruneCompletedTasks()` immediately
3. If `activeTasks.size > 100`, pruning removes completed tasks
4. Orchestrator polls within milliseconds
5. Task already gone from memory
6. Error: "Task not found"

### Solution: Grace Period

Added minimum retention time for just-completed tasks to ensure orchestrator has time to poll.

### Implementation (`src/mcp-server.ts`)

**New Constant:**
```typescript
const TASK_GRACE_PERIOD_MS = 5 * 60 * 1000 // 5 minutes - minimum retention
```

**Updated Pruning Logic:**
```typescript
function pruneCompletedTasks() {
  if (activeTasks.size <= MAX_ACTIVE_TASKS) return
  const now = Date.now()
  for (const [id, task] of activeTasks) {
    if (task.status !== 'running' && task.completedAt) {
      const age = now - new Date(task.completedAt).getTime()
      // Only prune if older than grace period AND retention period
      if (age > TASK_GRACE_PERIOD_MS && age > TASK_RETENTION_MS) {
        activeTasks.delete(id)
      }
    }
  }
}
```

**Improved Error Messages:**
- `get_task_status`: "Task not found. It may have been pruned or never existed."
- `get_task_result`: "Task not found. It may have been pruned. Check get_task_status first."

### Benefits

✅ Prevents premature task pruning
✅ Orchestrator has 5-minute window to poll results
✅ Eliminates "Task not found" race condition
✅ Still allows cleanup of old tasks (after 5 min + 1 hour)

---

## Files Modified

```
bridge.config.local.json |   6 ++-
src/acp-client.ts        |   2 +
src/config.ts            |   6 ++-
src/index.ts             |   1 +
src/mcp-server.ts        |  33 ++++++---
src/session-viewer.ts    |  48 +++++++++---
```

**Total:** 8 files changed, 181 insertions(+), 21 deletions(-)

---

## Testing Plan

### Test 1: Mirror Mode Basic Functionality
1. Set `viewer: { enabled: true, mode: 'mirror-stream' }` in config
2. Restart bridge, assign task to agent
3. **Verify:** Ghostty window opens with tmux pane
4. **Verify:** Agent output appears immediately (not delayed)
5. **Verify:** Task completes successfully (ACP protocol intact)
6. **Verify:** Log file still written to `~/.bridge-sessions/`

### Test 2: Concurrent Agents
1. Start 3 tasks simultaneously with mirror-stream mode
2. **Verify:** 3 tmux panes appear, each with independent output
3. **Verify:** No cross-contamination between panes
4. **Verify:** All tasks complete successfully

### Test 3: Tail Mode Unchanged
1. Set `viewer: { enabled: true, mode: 'tail-logs' }`
2. Assign task
3. **Verify:** Existing tail -f behavior works as before

### Test 4: Task Grace Period
1. Assign task via MCP
2. Poll `get_task_status` every 100ms
3. As soon as status is 'completed', call `get_task_result`
4. **Verify:** Result returned successfully (not "Task not found")

### Test 5: Concurrent Task Pruning
1. Assign 150 tasks concurrently (exceeds MAX_ACTIVE_TASKS=100)
2. Poll all task results as they complete
3. **Verify:** All tasks return results, no "Task not found" errors

---

## Future Enhancements

- [ ] Interactive mode: Mirror stdin to allow user input during agent execution
- [ ] Configurable grace period per task or globally
- [ ] Stream filtering: Show only errors/warnings in mirror mode
- [ ] Record sessions for playback
- [ ] Multi-window support for large teams

---

## References

- Plan document: `/Users/tonyholovka/.claude/projects/-Users-tonyholovka-workspace-cli-team-bridge/285c0df1-7931-45ff-8c61-2bc0e0d27bde.jsonl`
- Implementation date: 2026-02-10
- Team: tmux-mirror-and-task-fix
