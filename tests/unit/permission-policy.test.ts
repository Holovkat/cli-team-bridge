import { describe, it, expect } from 'bun:test'
import {
  evaluatePermission,
  createRuleSet,
  type PermissionContext,
  type PermissionRule,
} from '../../src/permission-policy'

describe('Permission Policy Engine', () => {
  const projectRoot = '/workspace/project'

  describe('evaluatePermission', () => {
    it('should deny git push --force', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git push origin main --force' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-git-force-push')
    })

    it('should deny git push -f', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git push -f origin main' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-git-force-push')
    })

    it('should deny git reset --hard', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git reset --hard HEAD~1' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-git-reset-hard')
    })

    it('should deny rm -rf', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'rm -rf /some/path' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-rm-rf')
    })

    it('should deny dd to disk', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'dd if=/dev/zero of=/dev/sda' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-dd-disk-write')
    })

    it('should deny DROP TABLE in SQL', () => {
      const context: PermissionContext = {
        toolName: 'SQL',
        args: { command: 'DROP TABLE users;' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-drop-table')
    })

    it('should deny DELETE without WHERE', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'DELETE FROM users;' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-delete-without-where')
    })

    it('should allow DELETE with WHERE clause', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'DELETE FROM users WHERE id = 1;' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      // This won't match the delete rule, so it will fall through to ask-bash
      expect(result.action).toBe('ask')
    })

    it('should deny shutdown commands', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'shutdown -h now' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('deny-shutdown')
    })

    it('should allow git status', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git status' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-git-status')
    })

    it('should allow git diff', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git diff HEAD~1' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-git-diff')
    })

    it('should allow git log', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git log --oneline -10' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-git-log')
    })

    it('should allow git add', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git add src/file.ts' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-git-add')
    })

    it('should allow git commit', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git commit -m "message"' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-git-commit')
    })

    it('should ask for unknown bash commands', () => {
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'some-unknown-command' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('ask')
      expect(result.matchedRule).toBe('ask-bash')
    })

    it('should allow Read operations', () => {
      const context: PermissionContext = {
        toolName: 'Read',
        args: { file_path: 'src/index.ts' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-read')
    })

    it('should deny Read of .env files', () => {
      const context: PermissionContext = {
        toolName: 'Read',
        args: { file_path: '.env' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.reason).toContain('outside allowed scope')
    })

    it('should deny Read of SSH keys', () => {
      const context: PermissionContext = {
        toolName: 'Read',
        args: { file_path: '/home/user/.ssh/id_rsa' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
    })

    it('should allow Write operations', () => {
      const context: PermissionContext = {
        toolName: 'Write',
        args: { file_path: 'src/new-file.ts', content: 'hello' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-write')
    })

    it('should deny Write to system paths', () => {
      const context: PermissionContext = {
        toolName: 'Write',
        args: { file_path: '/etc/passwd', content: 'evil' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
    })

    it('should allow Edit operations', () => {
      const context: PermissionContext = {
        toolName: 'Edit',
        args: { file_path: 'src/index.ts', old_str: 'foo', new_str: 'bar' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('allow')
      expect(result.matchedRule).toBe('allow-edit')
    })

    it('should ask for FetchURL', () => {
      const context: PermissionContext = {
        toolName: 'FetchURL',
        args: { url: 'https://example.com' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('ask')
      expect(result.matchedRule).toBe('ask-fetch')
    })

    it('should ask for WebSearch', () => {
      const context: PermissionContext = {
        toolName: 'WebSearch',
        args: { query: 'test' },
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('ask')
      expect(result.matchedRule).toBe('ask-web-search')
    })

    it('should default deny for unknown tools', () => {
      const context: PermissionContext = {
        toolName: 'UnknownTool',
        args: {},
        projectRoot,
      }
      const result = evaluatePermission(context)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('default-deny')
    })
  })

  describe('createRuleSet', () => {
    it('should prepend custom rules to base rules', () => {
      const customRule: PermissionRule = {
        name: 'custom-allow',
        toolPattern: 'CustomTool',
        action: 'allow',
      }
      const rules = createRuleSet([customRule])
      expect(rules[0]).toBe(customRule)
      expect(rules.length).toBeGreaterThan(1)
    })

    it('should allow custom rules to take precedence', () => {
      const customRule: PermissionRule = {
        name: 'custom-deny-bash',
        toolPattern: 'Bash',
        action: 'deny',
        condition: () => true,
      }
      const rules = createRuleSet([customRule])
      const context: PermissionContext = {
        toolName: 'Bash',
        args: { command: 'git status' },
        projectRoot,
      }
      // Even though git status is normally allowed, custom rule should match first
      const result = evaluatePermission(context, rules)
      expect(result.action).toBe('deny')
      expect(result.matchedRule).toBe('custom-deny-bash')
    })
  })

  describe('wildcard patterns', () => {
    it('should match git_* wildcard', () => {
      const rule: PermissionRule = {
        name: 'test-git-wildcard',
        toolPattern: 'git_*',
        action: 'allow',
      }
      const gitStatusContext: PermissionContext = {
        toolName: 'git_status',
        args: {},
        projectRoot,
      }
      const gitAddContext: PermissionContext = {
        toolName: 'git_add',
        args: {},
        projectRoot,
      }
      const otherContext: PermissionContext = {
        toolName: 'Bash',
        args: {},
        projectRoot,
      }

      expect(evaluatePermission(gitStatusContext, [rule]).action).toBe('allow')
      expect(evaluatePermission(gitAddContext, [rule]).action).toBe('allow')
      expect(evaluatePermission(otherContext, [rule]).action).toBe('deny')
    })

    it('should match * wildcard for all tools', () => {
      const rule: PermissionRule = {
        name: 'catch-all-deny',
        toolPattern: '*',
        action: 'deny',
        condition: (args) => JSON.stringify(args).includes('dangerous'),
      }

      const dangerousContext: PermissionContext = {
        toolName: 'AnyTool',
        args: { data: 'dangerous payload' },
        projectRoot,
      }
      const safeContext: PermissionContext = {
        toolName: 'AnyTool',
        args: { data: 'safe' },
        projectRoot,
      }

      expect(evaluatePermission(dangerousContext, [rule]).action).toBe('deny')
      expect(evaluatePermission(safeContext, [rule]).action).toBe('deny') // No match, falls to default
    })
  })
})
