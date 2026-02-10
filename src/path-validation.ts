import { resolve, sep } from 'path'

/**
 * Validates that a team name is safe for use in file paths.
 *
 * Security rules:
 * - Only allows alphanumeric characters, hyphens, and underscores
 * - Rejects path traversal attempts (.., ., /)
 * - Rejects absolute paths
 * - Maximum length of 64 characters
 *
 * @param teamName - The team name to validate
 * @returns true if the team name is safe, false otherwise
 */
export function isValidTeamName(teamName: string): boolean {
  if (!teamName || typeof teamName !== 'string') {
    return false
  }

  // Length check (prevent excessively long paths)
  if (teamName.length === 0 || teamName.length > 64) {
    return false
  }

  // Only allow alphanumeric, hyphens, and underscores
  const safePattern = /^[a-zA-Z0-9_-]+$/
  if (!safePattern.test(teamName)) {
    return false
  }

  // Explicitly reject common path traversal patterns
  // (redundant with pattern check but defense in depth)
  const dangerousPatterns = [
    '..',  // parent directory
    '.',   // current directory
    '/',   // path separator
    '\\',  // windows path separator
  ]

  for (const pattern of dangerousPatterns) {
    if (teamName.includes(pattern)) {
      return false
    }
  }

  return true
}

/**
 * Validates that a resolved path is contained within a workspace root.
 *
 * This prevents path traversal attacks by ensuring the resolved absolute path
 * is a child of (or equal to) the workspace root.
 *
 * @param workspaceRoot - The absolute path to the workspace root
 * @param relativePath - The relative path to validate
 * @returns true if the path is safe (within workspace), false otherwise
 */
export function isPathSafe(workspaceRoot: string, relativePath: string): boolean {
  try {
    const resolvedPath = resolve(workspaceRoot, relativePath)
    const resolvedRoot = resolve(workspaceRoot)

    // Path must either be a child of workspace or the workspace itself
    return resolvedPath.startsWith(resolvedRoot + sep) || resolvedPath === resolvedRoot
  } catch {
    // If path resolution fails, reject it
    return false
  }
}

/**
 * Validates a team name and throws an error if invalid.
 *
 * @param teamName - The team name to validate
 * @throws Error if the team name is invalid
 */
export function validateTeamName(teamName: string): void {
  if (!isValidTeamName(teamName)) {
    const reasons: string[] = []

    if (!teamName || typeof teamName !== 'string') {
      reasons.push('team name is required')
    } else {
      if (teamName.length > 64) {
        reasons.push('team name exceeds 64 characters')
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(teamName)) {
        reasons.push('team name can only contain letters, numbers, hyphens, and underscores')
      }
      if (teamName.includes('..') || teamName.includes('/') || teamName.includes('\\')) {
        reasons.push('team name contains path traversal characters')
      }
    }

    throw new Error(
      `Invalid team name "${teamName}": ${reasons.join(', ')}\n` +
      'Team names must:\n' +
      '  - Contain only letters, numbers, hyphens, and underscores\n' +
      '  - Be 1-64 characters long\n' +
      '  - Not contain path separators or traversal sequences'
    )
  }
}
