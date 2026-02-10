/**
 * Permission Policy Engine for ACP Agent Tool Call Authorization
 *
 * Replaces regex-based destructive command blocking with a declarative
 * allowlist policy that supports path-based scoping and explicit actions.
 */

import { logger } from './logger'

/** Action to take when a rule matches */
export type PermissionAction = 'allow' | 'deny' | 'ask'

/** Tool name pattern (exact match or wildcard with *) */
export type ToolPattern = string

/** Path scope restriction for file operations */
export interface PathScope {
  /** Allow access to paths under these directories */
  allowedDirs?: string[]
  /** Block access to paths matching these patterns */
  blockedPatterns?: RegExp[]
}

/** A single permission rule */
export interface PermissionRule {
  /** Human-readable description of this rule */
  name: string
  /** Tool name pattern to match (e.g., "Read", "Bash", "git_*") */
  toolPattern: ToolPattern
  /** Action to take when this rule matches */
  action: PermissionAction
  /** Optional path-based restrictions for file operations */
  pathScope?: PathScope
  /** Optional additional condition based on tool arguments */
  condition?: (args: Record<string, unknown>) => boolean
  /** Optional log message when this rule triggers */
  logMessage?: string
}

/** Context for permission evaluation */
export interface PermissionContext {
  toolName: string
  toolTitle?: string
  args: Record<string, unknown>
  projectRoot: string
}

/** Result of permission evaluation */
export interface PermissionResult {
  action: PermissionAction
  matchedRule: string
  reason: string
}

/**
 * Check if a path is within allowed directories
 */
function isPathAllowed(
  filePath: string,
  pathScope: PathScope | undefined,
  projectRoot: string,
): boolean {
  if (!pathScope) return true

  const normalizedPath = filePath.startsWith('/') ? filePath : `${projectRoot}/${filePath}`

  // Check blocked patterns first
  if (pathScope.blockedPatterns) {
    for (const pattern of pathScope.blockedPatterns) {
      if (pattern.test(normalizedPath)) {
        return false
      }
    }
  }

  // If no allowedDirs specified, allow all (except blocked)
  if (!pathScope.allowedDirs || pathScope.allowedDirs.length === 0) {
    return true
  }

  // Check if path is within allowed directories
  for (const allowedDir of pathScope.allowedDirs) {
    const fullAllowedDir = allowedDir.startsWith('/') ? allowedDir : `${projectRoot}/${allowedDir}`
    if (normalizedPath.startsWith(fullAllowedDir)) {
      return true
    }
  }

  return false
}

/**
 * Match a tool name against a pattern (supports wildcards)
 */
function matchToolPattern(toolName: string, pattern: ToolPattern): boolean {
  // Exact match
  if (pattern === toolName) return true

  // Wildcard match (e.g., "git_*" matches "git_status", "git_add")
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return regex.test(toolName)
  }

  return false
}

/**
 * Get default permission rules for safe agent operation.
 * Call this function with workspaceRoot to get rules with proper path scoping.
 *
 * Rules are evaluated in order - first match wins.
 * Default-deny: if no rule matches, the action is 'deny'.
 *
 * @param workspaceRoot - The workspace root directory for path scoping
 * @param additionalAllowedDirs - Additional directories to allow for file reads (default: [])
 * @returns Array of permission rules with proper path scoping
 */
export function getDefaultPermissionRules(
  workspaceRoot: string,
  additionalAllowedDirs: string[] = [],
): PermissionRule[] {
  return [
  // === DENY: Destructive git operations ===
  {
    name: 'deny-git-force-push',
    toolPattern: 'Bash',
    action: 'deny',
    condition: (args) => {
      const cmd = String(args.command || '')
      return /git\s+push\s+.*--force/.test(cmd) || /git\s+push\s+-f\b/.test(cmd)
    },
    logMessage: 'Blocked dangerous git push --force',
  },
  {
    name: 'deny-git-reset-hard',
    toolPattern: 'Bash',
    action: 'deny',
    condition: (args) => /git\s+reset\s+.*--hard/.test(String(args.command || '')),
    logMessage: 'Blocked dangerous git reset --hard',
  },
  {
    name: 'deny-rm-rf',
    toolPattern: 'Bash',
    action: 'deny',
    condition: (args) => {
      const cmd = String(args.command || '')

      // Check if command contains rm
      if (!/\brm\b/.test(cmd)) return false

      // Parse the command to detect both recursive and force flags
      // Split by pipes, semicolons, and logical operators to check only the rm command
      const commandSegment = cmd.split(/[|;&]/).find(seg => /\brm\b/.test(seg))
      if (!commandSegment) return false

      // Split into tokens
      const tokens = commandSegment.trim().split(/\s+/)

      // Track presence of recursive and force flags
      let hasRecursive = false
      let hasForce = false

      for (const token of tokens) {
        // Long form flags
        if (token === '--recursive') hasRecursive = true
        if (token === '--force') hasForce = true

        // Short form flags (can be combined like -rf or separate like -r -f)
        if (token.startsWith('-') && !token.startsWith('--')) {
          // Check if this is a combined short flag (like -rf, -fr, -rRf, etc.)
          const flags = token.slice(1) // Remove leading dash
          if (/[rR]/.test(flags)) hasRecursive = true
          if (/[fF]/.test(flags)) hasForce = true
        }
      }

      // Block if BOTH recursive and force flags are present
      return hasRecursive && hasForce
    },
    logMessage: 'Blocked recursive delete',
  },
  {
    name: 'deny-dd-disk-write',
    toolPattern: 'Bash',
    action: 'deny',
    condition: (args) => /dd\s+.*of=\/(dev|disk)/.test(String(args.command || '')),
    logMessage: 'Blocked raw disk write',
  },

  // === DENY: Database destructive operations ===
  {
    name: 'deny-drop-table',
    toolPattern: '*',
    action: 'deny',
    condition: (args) => /DROP\s+TABLE/i.test(JSON.stringify(args)),
    logMessage: 'Blocked DROP TABLE',
  },
  {
    name: 'deny-delete-without-where',
    toolPattern: '*',
    action: 'deny',
    condition: (args) => /DELETE\s+FROM\s+\w+\s*;?$/i.test(String(args.command || '')) &&
                         !/WHERE/i.test(String(args.command || '')),
    logMessage: 'Blocked DELETE without WHERE clause',
  },

  // === DENY: System shutdown/reboot ===
  {
    name: 'deny-shutdown',
    toolPattern: 'Bash',
    action: 'deny',
    condition: (args) => /\b(shutdown|reboot|halt|poweroff)\b/.test(String(args.command || '')),
    logMessage: 'Blocked system shutdown',
  },

  // === ALLOW: Safe git read operations ===
  {
    name: 'allow-git-status',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+status\b/.test(String(args.command || '')),
  },
  {
    name: 'allow-git-diff',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+diff\b/.test(String(args.command || '')),
  },
  {
    name: 'allow-git-log',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+log\b/.test(String(args.command || '')),
  },
  {
    name: 'allow-git-show',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+show\b/.test(String(args.command || '')),
  },

  // === ALLOW: Safe git write operations ===
  {
    name: 'allow-git-add',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+add\b/.test(String(args.command || '')),
  },
  {
    name: 'allow-git-commit',
    toolPattern: 'Bash',
    action: 'allow',
    condition: (args) => /^git\s+commit\b/.test(String(args.command || '')),
  },

  // === ALLOW: File read operations (scoped to project) ===
  {
    name: 'allow-read',
    toolPattern: 'Read',
    action: 'allow',
    pathScope: {
      allowedDirs: [workspaceRoot, '/tmp', ...additionalAllowedDirs],
      blockedPatterns: [
        /\.env$/,
        /\.ssh\//,
        /\.aws\//,
        /\.docker\//,
        /id_rsa/,
        /id_ed25519/,
        /\.pem$/,
        /\.key$/,
        /secrets?\./i,
        /password/i,
        /token/i,
      ],
    },
  },

  // === ALLOW: File write operations (scoped to project) ===
  {
    name: 'allow-write',
    toolPattern: 'Write',
    action: 'allow',
    pathScope: {
      blockedPatterns: [
        /\.env$/,
        /\.ssh\//,
        /\.aws\//,
        /\/etc\//,
        /\/usr\/bin\//,
        /\/bin\//,
        /\.pem$/,
        /\.key$/,
      ],
    },
  },

  // === ALLOW: File edit operations (scoped to project) ===
  {
    name: 'allow-edit',
    toolPattern: 'Edit',
    action: 'allow',
    pathScope: {
      blockedPatterns: [
        /\.env$/,
        /\.ssh\//,
        /\.aws\//,
        /\/etc\//,
        /\.pem$/,
        /\.key$/,
      ],
    },
  },

  // === ASK: Bash commands (log for audit) ===
  {
    name: 'ask-bash',
    toolPattern: 'Bash',
    action: 'ask',
    logMessage: 'Bash command requires approval',
  },

  // === ASK: Network operations ===
  {
    name: 'ask-fetch',
    toolPattern: 'FetchURL',
    action: 'ask',
    logMessage: 'External network request requires approval',
  },
  {
    name: 'ask-web-search',
    toolPattern: 'WebSearch',
    action: 'ask',
    logMessage: 'Web search requires approval',
  },
  ]
}

/**
 * Default permission rules for backwards compatibility.
 * Uses empty workspace root - prefer using getDefaultPermissionRules() with actual workspace root.
 * @deprecated Use getDefaultPermissionRules(workspaceRoot) instead
 */
export const DEFAULT_PERMISSION_RULES: PermissionRule[] = getDefaultPermissionRules('', [])

/**
 * Evaluate a tool call against permission rules
 *
 * @param context - The permission context (tool name, args, project root)
 * @param rules - Array of permission rules to evaluate (defaults to rules for context.projectRoot)
 * @returns PermissionResult with action, matched rule name, and reason
 */
export function evaluatePermission(
  context: PermissionContext,
  rules?: PermissionRule[],
): PermissionResult {
  // If no rules provided, generate them with the actual workspace root
  const effectiveRules = rules ?? getDefaultPermissionRules(context.projectRoot)
  const { toolName, args, projectRoot } = context

  for (const rule of effectiveRules) {
    // Check tool pattern match
    if (!matchToolPattern(toolName, rule.toolPattern)) {
      continue
    }

    // Check additional condition if present
    if (rule.condition && !rule.condition(args)) {
      continue
    }

    // Check path scope for file operations
    if (rule.pathScope) {
      const filePath = String(args.file_path || args.path || args.filePath || '')
      if (filePath && !isPathAllowed(filePath, rule.pathScope, projectRoot)) {
        logger.warn(`Permission DENIED by path scope: ${filePath} not allowed by rule "${rule.name}"`)
        return {
          action: 'deny',
          matchedRule: rule.name,
          reason: `Path "${filePath}" is outside allowed scope`,
        }
      }
    }

    // Rule matched - log if specified
    if (rule.logMessage) {
      if (rule.action === 'deny') {
        logger.warn(`${rule.logMessage}: ${toolName}`)
      } else {
        logger.info(`${rule.logMessage}: ${toolName}`)
      }
    }

    return {
      action: rule.action,
      matchedRule: rule.name,
      reason: `Matched rule: ${rule.name}`,
    }
  }

  // Default deny - no rule matched
  logger.warn(`Permission DENIED (default): ${toolName} - no matching rule`)
  return {
    action: 'deny',
    matchedRule: 'default-deny',
    reason: 'No permission rule matched - default deny',
  }
}

/**
 * Create a custom permission rule set by extending defaults
 */
export function createRuleSet(
  customRules: PermissionRule[],
  baseRules: PermissionRule[] = DEFAULT_PERMISSION_RULES,
): PermissionRule[] {
  // Custom rules are prepended so they take precedence
  return [...customRules, ...baseRules]
}
