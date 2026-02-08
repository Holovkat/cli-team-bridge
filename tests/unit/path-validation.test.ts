import { describe, it, expect } from 'bun:test'
import { resolve, sep } from 'path'

// Test the path traversal logic used in mcp-server.ts
function isPathSafe(workspaceRoot: string, project: string): boolean {
  const projectPath = resolve(workspaceRoot, project)
  const resolvedRoot = resolve(workspaceRoot)
  return projectPath.startsWith(resolvedRoot + sep) || projectPath === resolvedRoot
}

describe('Path Traversal Validation', () => {
  const workspace = '/tmp/test-workspace'

  it('should allow valid project paths within workspace', () => {
    expect(isPathSafe(workspace, 'my-project')).toBe(true)
    expect(isPathSafe(workspace, 'sub/nested/project')).toBe(true)
  })

  it('should reject ../.. path traversal', () => {
    expect(isPathSafe(workspace, '../../../etc/passwd')).toBe(false)
    expect(isPathSafe(workspace, 'project/../../..')).toBe(false)
  })

  it('should reject absolute paths', () => {
    expect(isPathSafe(workspace, '/etc/passwd')).toBe(false)
    expect(isPathSafe(workspace, '/tmp/other-workspace/project')).toBe(false)
  })

  it('should allow workspace root itself', () => {
    expect(isPathSafe(workspace, '.')).toBe(true)
  })
})
