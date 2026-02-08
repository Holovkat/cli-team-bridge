# Sprint 5: Code Compliance — Error Handling & Async

**Goal**: Fix swallowed errors, lock manager error masking, async EventEmitter issues, stream cleanup
**Severity**: Medium-High
**Estimated Effort**: Medium (3-4 hours)

## Bugfix Tasks

### 5.1 Fix Lock Manager Error Masking

- [ ] Distinguish EEXIST from other errors in `src/lock-manager.ts` at lines 22-27
  - **Current**:
    ```typescript
    } catch {
      // Lock held by another process, wait with exponential backoff
      await Bun.sleep(delay)
    }
    ```
  - **Fixed**:
    ```typescript
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        // Lock held — retry with backoff
        await Bun.sleep(delay)
        delay = Math.min(delay * 2, 500)
      } else {
        // Permission error, IO error, etc. — fail immediately
        logger.error(`Lock acquire failed: ${err?.code ?? err}`)
        return false
      }
    }
    ```
  - **Why**: Catches ALL errors including permission/IO errors, masking real failures as "lock held".
  - **Test**: "should fail immediately on EACCES error, not loop until timeout"

- [ ] Fix `release()` state tracking in `src/lock-manager.ts` at lines 34-43
  - **Current**: `held = false` set even if unlink fails
  - **Fixed**:
    ```typescript
    release() {
      if (!this.held) return
      try {
        if (existsSync(this.lockPath)) {
          unlinkSync(this.lockPath)
        }
        this.held = false
      } catch (err) {
        logger.error(`Failed to release lock: ${err}`)
        // Keep held = true so caller knows lock may still exist
      }
    }
    ```

### 5.2 Log Errors in Task Watcher Instead of Swallowing

- [ ] Add debug logging to `src/task-watcher.ts` at lines 83-85
  - **Current**:
    ```typescript
    } catch {
      // Skip unparseable files
    }
    ```
  - **Fixed**:
    ```typescript
    } catch (err) {
      logger.debug(`Skipping unparseable task file ${file}: ${err}`)
    }
    ```
  - **Why**: Silent error swallowing makes debugging broken task files impossible.
  - **Test**: "should log debug message for malformed task JSON"

### 5.3 Propagate Errors from Result Writer

- [ ] Return success/failure from `src/result-writer.ts` at lines 18-57 and 59-80
  - **Current**: `writeTaskResult()` catches and logs but doesn't propagate
  - **Fixed**: Change return type to `Promise<boolean>`:
    ```typescript
    export async function writeTaskResult(
      filePath: string,
      result: TaskResult,
      taskDir: string,
    ): Promise<boolean> {
      const lock = new LockManager(taskDir)
      try {
        // ... existing logic ...
        return true
      } catch (err) {
        logger.error(`Failed to write result for ${filePath}: ${err}`)
        return false
      } finally {
        lock.release()
      }
    }
    ```
  - Update caller in `src/index.ts` to check return value and handle failure.
  - **Why**: Callers currently assume writes succeeded. Failures should be observable.

### 5.4 Fix Async EventEmitter Handler

- [ ] Wrap async handler in `src/index.ts` at lines 70-118
  - **Current**: `watcher.on('task-assigned', async (assignment) => { ... })`
  - **Fixed**:
    ```typescript
    watcher.on('task-assigned', (assignment: TaskAssignment) => {
      handleTaskAssignment(assignment).catch((err) => {
        logger.error(`Unhandled error in task handler: ${err}`)
      })
    })

    async function handleTaskAssignment(assignment: TaskAssignment): Promise<void> {
      // ... existing async logic moved here ...
    }
    ```
  - **Why**: `EventEmitter` doesn't await async handlers. Unhandled rejections can crash the process.
  - **Test**: "should catch and log errors from async task handler"

### 5.5 Fix Stream Listener Cleanup

- [ ] Add `cancel()` handler to `nodeToWebReadable()` in `src/acp-client.ts` at lines 73-83
  - **Current**: No cleanup on cancel
  - **Fixed**:
    ```typescript
    function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
      let onData: ((chunk: Buffer) => void) | null = null
      let onEnd: (() => void) | null = null
      let onError: ((err: Error) => void) | null = null

      return new ReadableStream<Uint8Array>({
        start(controller) {
          onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk))
          onEnd = () => controller.close()
          onError = (err) => controller.error(err)
          nodeStream.on('data', onData)
          nodeStream.on('end', onEnd)
          nodeStream.on('error', onError)
        },
        cancel() {
          if (onData) nodeStream.off('data', onData)
          if (onEnd) nodeStream.off('end', onEnd)
          if (onError) nodeStream.off('error', onError)
          nodeStream.destroy()
        },
      })
    }
    ```
  - **Why**: Listeners never removed = memory leak on early stream cancellation.

### 5.6 Cap Agent Output in Memory

- [ ] Add output cap in `src/acp-client.ts` at line 175
  - **Current**: `output += update.content.text` — unbounded
  - **Fixed**:
    ```typescript
    const MAX_OUTPUT_BYTES = 1024 * 1024 // 1MB
    // ...
    case 'agent_message_chunk':
      if (update.content?.type === 'text') {
        if (output.length < MAX_OUTPUT_BYTES) {
          output += update.content.text.slice(0, MAX_OUTPUT_BYTES - output.length)
        }
      }
      break
    ```
  - **Why**: Long agent sessions can accumulate unlimited output in memory, causing OOM.
  - **Test**: "should truncate agent output at 1MB"
