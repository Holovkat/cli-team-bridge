/**
 * System-wide constants for the CLI Team Bridge.
 *
 * Centralizes magic numbers to improve maintainability and clarity.
 * Constants are grouped by functional area.
 */

// ============================================================================
// Task Management & Lifecycle
// ============================================================================

/**
 * Maximum number of tasks to keep in memory (active + completed).
 * Older completed tasks are pruned beyond this limit.
 */
export const MAX_ACTIVE_TASKS = 100

/**
 * Retention period for completed tasks in milliseconds (1 hour).
 * Tasks older than this may be pruned if MAX_ACTIVE_TASKS is exceeded.
 */
export const TASK_RETENTION_MS = 60 * 60 * 1000

/**
 * Minimum retention period for completed tasks in milliseconds (5 minutes).
 * Tasks are never pruned before this grace period, even if MAX_ACTIVE_TASKS is exceeded.
 */
export const TASK_GRACE_PERIOD_MS = 5 * 60 * 1000

/**
 * Maximum concurrent running tasks across all agents.
 */
export const MAX_CONCURRENT_RUNNING = 10

/**
 * Maximum concurrent tasks per individual agent.
 */
export const MAX_PER_AGENT = 3

// ============================================================================
// Timeouts & Delays
// ============================================================================

/**
 * Maximum task execution timeout in milliseconds (30 minutes).
 * Tasks exceeding this duration are terminated.
 */
export const TASK_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Timeout for ACP initialize and newSession operations in milliseconds (30 seconds).
 */
export const INIT_TIMEOUT_MS = 30 * 1000

/**
 * Maximum wait time for synchronous task operations in seconds (30 minutes).
 */
export const MAX_WAIT_SECONDS = 1800

/**
 * Default wait time for synchronous task operations in seconds (5 minutes).
 */
export const DEFAULT_WAIT_SECONDS = 300

/**
 * Delay before sending SIGKILL after SIGTERM in milliseconds (5 seconds).
 * Applies to both task cancellation and agent shutdown.
 */
export const SIGKILL_DELAY_MS = 5000

// ============================================================================
// Size Limits & Buffers
// ============================================================================

/**
 * Maximum prompt length in bytes (100KB).
 * Prompts exceeding this size are rejected.
 */
export const MAX_PROMPT_LENGTH = 100 * 1024

/**
 * Maximum length for agent/project/model names (256 characters).
 */
export const MAX_NAME_LENGTH = 256

/**
 * Maximum stderr buffer size in bytes (64KB).
 * Stderr output is truncated beyond this limit.
 */
export const MAX_STDERR_BYTES = 64 * 1024

/**
 * Maximum agent output buffer size in bytes (128KB).
 * Agent message output is truncated beyond this limit.
 */
export const MAX_OUTPUT_BYTES = 128 * 1024

/**
 * Maximum tool output buffer size in bytes (64KB).
 * Tool call output (diffs, terminal, etc.) is truncated beyond this limit.
 */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024

/**
 * Maximum raw tool output size for capturing in bytes (10KB).
 * Raw outputs larger than this are skipped to avoid large file dumps.
 */
export const MAX_RAW_TOOL_OUTPUT_BYTES = 10_000

/**
 * Maximum length for error message stderr excerpts in characters (2000).
 */
export const MAX_ERROR_STDERR_LENGTH = 2000

// ============================================================================
// Output Merging & Analysis Thresholds
// ============================================================================

/**
 * Minimum agent output length considered "substantial" in bytes (500).
 * Used when deciding whether to merge agent and tool outputs.
 */
export const SUBSTANTIAL_OUTPUT_THRESHOLD = 500

/**
 * Minimum tool output length to consider for merging in bytes (100).
 */
export const MIN_TOOL_OUTPUT_LENGTH = 100

/**
 * Length of tool output slice used for uniqueness comparison in bytes (200).
 * When checking if tool output differs from agent output.
 */
export const TOOL_OUTPUT_COMPARISON_LENGTH = 200

// ============================================================================
// Message Bus Configuration
// ============================================================================

/**
 * Maximum messages per agent inbox (500).
 * Older messages are pruned when this limit is exceeded.
 */
export const MAX_MESSAGES_PER_INBOX = 500

/**
 * Maximum message content size in bytes (64KB).
 * Messages exceeding this size are truncated.
 */
export const MAX_MESSAGE_SIZE = 64 * 1024
