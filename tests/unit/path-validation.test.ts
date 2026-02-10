import { describe, it, expect } from 'bun:test'
import { isValidTeamName, isPathSafe, validateTeamName } from '../../src/path-validation'

describe('Team Name Validation', () => {
  describe('isValidTeamName', () => {
    it('should allow valid team names with alphanumeric characters', () => {
      expect(isValidTeamName('team-1')).toBe(true)
      expect(isValidTeamName('my_team')).toBe(true)
      expect(isValidTeamName('TeamAlpha')).toBe(true)
      expect(isValidTeamName('team123')).toBe(true)
    })

    it('should allow hyphens and underscores', () => {
      expect(isValidTeamName('my-team-name')).toBe(true)
      expect(isValidTeamName('my_team_name')).toBe(true)
      expect(isValidTeamName('team-name_123')).toBe(true)
    })

    it('should reject path traversal attempts', () => {
      expect(isValidTeamName('../etc')).toBe(false)
      expect(isValidTeamName('../../passwd')).toBe(false)
      expect(isValidTeamName('team/../etc')).toBe(false)
      expect(isValidTeamName('..')).toBe(false)
      expect(isValidTeamName('.')).toBe(false)
    })

    it('should reject absolute paths', () => {
      expect(isValidTeamName('/etc/passwd')).toBe(false)
      expect(isValidTeamName('/tmp/team')).toBe(false)
      expect(isValidTeamName('C:\\Windows\\System32')).toBe(false)
    })

    it('should reject special characters', () => {
      expect(isValidTeamName('team@name')).toBe(false)
      expect(isValidTeamName('team$name')).toBe(false)
      expect(isValidTeamName('team name')).toBe(false) // space
      expect(isValidTeamName('team;name')).toBe(false)
      expect(isValidTeamName('team&name')).toBe(false)
    })

    it('should reject empty or null values', () => {
      expect(isValidTeamName('')).toBe(false)
      expect(isValidTeamName(null as any)).toBe(false)
      expect(isValidTeamName(undefined as any)).toBe(false)
    })

    it('should reject excessively long names', () => {
      const longName = 'a'.repeat(65)
      expect(isValidTeamName(longName)).toBe(false)
      expect(isValidTeamName('a'.repeat(64))).toBe(true)
    })

    it('should reject path separators', () => {
      expect(isValidTeamName('team/name')).toBe(false)
      expect(isValidTeamName('team\\name')).toBe(false)
    })
  })

  describe('validateTeamName', () => {
    it('should not throw for valid team names', () => {
      expect(() => validateTeamName('valid-team')).not.toThrow()
      expect(() => validateTeamName('team_123')).not.toThrow()
    })

    it('should throw descriptive error for path traversal', () => {
      expect(() => validateTeamName('../etc')).toThrow(/path traversal/)
      expect(() => validateTeamName('../../passwd')).toThrow(/Invalid team name/)
    })

    it('should throw descriptive error for special characters', () => {
      expect(() => validateTeamName('team@name')).toThrow(/letters, numbers, hyphens, and underscores/)
    })

    it('should throw descriptive error for empty name', () => {
      expect(() => validateTeamName('')).toThrow(/team name is required/)
    })

    it('should throw descriptive error for long names', () => {
      const longName = 'a'.repeat(65)
      expect(() => validateTeamName(longName)).toThrow(/exceeds 64 characters/)
    })

    it('should include helpful usage message in error', () => {
      try {
        validateTeamName('../etc')
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toContain('Team names must:')
        expect(message).toContain('Contain only letters')
        expect(message).toContain('1-64 characters')
      }
    })
  })
})

describe('Path Safety Validation', () => {
  const workspace = '/tmp/test-workspace'

  describe('isPathSafe', () => {
    it('should allow valid paths within workspace', () => {
      expect(isPathSafe(workspace, 'my-project')).toBe(true)
      expect(isPathSafe(workspace, 'sub/nested/project')).toBe(true)
      expect(isPathSafe(workspace, 'team-1')).toBe(true)
    })

    it('should reject path traversal attempts', () => {
      expect(isPathSafe(workspace, '../../../etc/passwd')).toBe(false)
      expect(isPathSafe(workspace, 'project/../../..')).toBe(false)
      expect(isPathSafe(workspace, '../../etc')).toBe(false)
    })

    it('should reject absolute paths outside workspace', () => {
      expect(isPathSafe(workspace, '/etc/passwd')).toBe(false)
      expect(isPathSafe(workspace, '/tmp/other-workspace/project')).toBe(false)
    })

    it('should allow workspace root itself', () => {
      expect(isPathSafe(workspace, '.')).toBe(true)
    })

    it('should handle edge cases safely', () => {
      // Symlink-like attempts (path traversal through subdirectory)
      expect(isPathSafe(workspace, 'project/../../../etc')).toBe(false)
    })
  })
})
