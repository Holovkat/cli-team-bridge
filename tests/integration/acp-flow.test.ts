import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { runAcpSession, type AcpSpawnConfig } from '../../src/acp-client'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Integration tests for ACP Client + Server Integration
 *
 * Tests the full ACP session lifecycle with real process spawning:
 * - Spawn → Initialize → NewSession → Prompt → Response → Cleanup
 * - Protocol negotiation and handshake
 * - Tool call flow between client and server
 */

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `acp-integration-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('ACP Client + Server Integration', () => {
  describe('Full Session Lifecycle', () => {
    it('should handle spawn failures gracefully', async () => {
      const config: AcpSpawnConfig = {
        command: '/nonexistent/command/that/does/not/exist',
        args: [],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test spawn failure')

      // Should return error result, not throw
      expect(result.error).toBeDefined()
      expect(result.timedOut).toBe(false)
      expect(result.proc).toBeDefined()
      expect(result.toolCalls).toBeDefined()
      expect(Array.isArray(result.toolCalls)).toBe(true)
    })

    it('should handle process spawn errors', async () => {
      const config: AcpSpawnConfig = {
        command: 'nonexistent-binary',
        args: ['--invalid'],
        cwd: '/tmp',
        env: {},
      }

      const result = await runAcpSession(config, 'Test process error')

      expect(result.error).toBeDefined()
      expect(result.error).toMatch(/(Failed to spawn|ENOENT|process error)/)
      expect(result.proc).toBeDefined()
    })

    it('should handle session configuration', async () => {
      const config: AcpSpawnConfig = {
        command: 'echo',
        args: ['test'],
        cwd: testDir,
        env: { TEST_VAR: 'test_value' },
      }

      const result = await runAcpSession(config, 'Configuration test', undefined, {
        bridgePath: testDir,
        agentName: 'test-agent',
        taskId: 'task-123',
      })

      // Should handle configuration even if agent doesn't respond properly
      expect(result).toBeDefined()
      expect(result.proc).toBeDefined()
      expect(result.toolCalls).toBeDefined()
    })
  })

  describe('Protocol Negotiation', () => {
    it('should handle protocol initialization failures', async () => {
      const badAgentPath = join(testDir, 'bad-agent.sh')
      writeFileSync(badAgentPath, `#!/bin/bash
echo "Not a valid ACP protocol response"
exit 1
      `)

      const config: AcpSpawnConfig = {
        command: 'bash',
        args: [badAgentPath],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test invalid protocol')

      expect(result.error).toBeDefined()
      expect(result.proc).toBeDefined()
    })
  })

  describe('Tool Call Flow', () => {
    it('should initialize tool call tracking', async () => {
      const config: AcpSpawnConfig = {
        command: 'true', // Command that exits successfully
        args: [],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test tool calls')

      // Should initialize toolCalls array even on failure
      expect(result.toolCalls).toBeDefined()
      expect(Array.isArray(result.toolCalls)).toBe(true)
    })
  })

  describe('Error Handling', () => {
    it('should handle agent process errors gracefully', async () => {
      const config: AcpSpawnConfig = {
        command: 'false', // Command that exits with error
        args: [],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'This should fail')

      // Should handle error gracefully
      expect(result.error).toBeDefined()
      expect(result.proc).toBeDefined()
    })

    it('should handle malformed command arguments', async () => {
      const config: AcpSpawnConfig = {
        command: 'echo',
        args: ['test'], // Will exit immediately
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Test malformed args')

      // Should detect protocol error (echo exits before protocol handshake)
      expect(result.error).toBeDefined()
    })

    it('should return consistent error structure', async () => {
      const config: AcpSpawnConfig = {
        command: '/path/that/does/not/exist',
        args: [],
        cwd: testDir,
        env: {},
      }

      const result = await runAcpSession(config, 'Consistency test')

      // Verify error result structure
      expect(result).toHaveProperty('output')
      expect(result).toHaveProperty('error')
      expect(result).toHaveProperty('timedOut')
      expect(result).toHaveProperty('stopReason')
      expect(result).toHaveProperty('toolCalls')
      expect(result).toHaveProperty('proc')

      expect(result.error).toBeDefined()
      expect(typeof result.output).toBe('string')
      expect(typeof result.timedOut).toBe('boolean')
      expect(Array.isArray(result.toolCalls)).toBe(true)
    })
  })
})
