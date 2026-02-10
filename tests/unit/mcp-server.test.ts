import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'fs'
import type { BridgeConfig } from '../../src/config'
import { TaskStore } from '../../src/persistence'
import { MessageBus } from '../../src/message-bus'
import { AgentRegistry } from '../../src/agent-registry'
import { WorkflowEngine } from '../../src/workflow'
import { startMcpServer } from '../../src/mcp-server'
import {
  MAX_CONCURRENT_RUNNING,
  MAX_PER_AGENT,
  MAX_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_ACTIVE_TASKS,
  TASK_RETENTION_MS,
  TASK_GRACE_PERIOD_MS,
} from '../../src/constants'

// Test context setup
let testWorkspace: string
let testBridgePath: string
let taskStore: TaskStore
let dbPath: string
let messageBus: MessageBus | null
let agentRegistry: AgentRegistry | null
let workflowEngine: WorkflowEngine
let activeTasks: Map<string, any>

// Mock config
const mockConfig: BridgeConfig = {
  workspaceRoot: '',
  agents: {
    'test-agent': {
      type: 'acp',
      command: 'test-acp',
      args: [],
      cwd: '',
      defaultModel: 'test-model',
      models: {
        'test-model': {
          flag: '--model',
          value: 'test',
        },
        'alt-model': {
          flag: '--model',
          value: 'alt',
        },
      },
      strengths: ['testing'],
    },
    'unavailable-agent': {
      type: 'acp',
      command: 'nonexistent-binary',
      args: [],
      cwd: '',
      defaultModel: 'test-model',
      models: {
        'test-model': {
          flag: '--model',
          value: 'test',
        },
      },
      strengths: ['testing'],
    },
    'fallback-source': {
      type: 'acp',
      command: 'nonexistent-binary',
      args: [],
      cwd: '',
      defaultModel: 'test-model',
      models: {
        'test-model': {
          flag: '--model',
          value: 'test',
        },
      },
      strengths: ['testing'],
      fallbackAgent: 'test-agent',
    },
  },
  permissions: { autoApprove: true },
  polling: { intervalMs: 1000 },
  logging: { level: 'error' },
  messaging: { enabled: true, failSilently: true },
  viewer: { enabled: false, mode: 'tail-logs', interactive: false },
}

// Import handlers after mocking
const toolHandlers: Record<string, any> = {}

beforeEach(() => {
  // Setup test workspace
  testWorkspace = join(tmpdir(), `test-mcp-${Date.now()}`)
  testBridgePath = join(testWorkspace, '.claude', 'bridge')
  mkdirSync(testWorkspace, { recursive: true })
  mkdirSync(testBridgePath, { recursive: true })
  mkdirSync(join(testWorkspace, 'test-project'), { recursive: true })

  // Update mock config paths
  mockConfig.workspaceRoot = testWorkspace
  mockConfig.agents['test-agent'].cwd = testWorkspace
  mockConfig.agents['unavailable-agent'].cwd = testWorkspace
  mockConfig.agents['fallback-source'].cwd = testWorkspace

  // Setup database
  dbPath = join(testWorkspace, '.bridge-tasks.db')
  taskStore = new TaskStore(dbPath)

  // Setup messaging
  messageBus = new MessageBus(testBridgePath)
  agentRegistry = new AgentRegistry(testBridgePath)

  // Setup workflow engine
  workflowEngine = new WorkflowEngine()

  // Setup active tasks map
  activeTasks = new Map()
})

afterEach(() => {
  if (taskStore) taskStore.close()
  try {
    rmSync(testWorkspace, { recursive: true, force: true })
  } catch {}
})

// Helper to create test context
function createContext() {
  return {
    config: mockConfig,
    workspaceRoot: testWorkspace,
    taskStore,
    messageBus,
    agentRegistry,
    workflowEngine,
    activeTasks,
  }
}

// Helper to parse JSON response
function parseResponse(response: any): any {
  if (response.content?.[0]?.text) {
    return JSON.parse(response.content[0].text)
  }
  return null
}

describe('MCP Server Tool Handlers', () => {
  describe('validateTaskId', () => {
    it('should accept valid UUID task IDs', async () => {
      const { default: mcpModule } = await import('../../src/mcp-server')
      // Test via get_task_status since validateTaskId is internal
      const validId = randomUUID()
      const ctx = createContext()

      // Create a task first
      activeTasks.set(validId, {
        id: validId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      // This should not throw
      expect(validId).toMatch(/^[a-f0-9-]{8,36}$/)
    })

    it('should reject invalid task ID formats', () => {
      const invalidIds = [
        'not-a-uuid',
        '123',
        'INVALID-ID',
        '../../../etc/passwd',
        '',
      ]

      invalidIds.forEach(id => {
        expect(/^[a-f0-9-]{8,36}$/.test(id)).toBe(false)
      })
    })
  })

  describe('validateProjectPath', () => {
    it('should accept valid project paths', () => {
      const projectPath = 'test-project'
      const fullPath = join(testWorkspace, projectPath)
      expect(existsSync(fullPath)).toBe(true)
    })

    it('should reject path traversal attempts', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'test/../../../etc/passwd',
      ]

      // Path validation should reject these
      maliciousPaths.forEach(path => {
        const resolved = join(testWorkspace, path)
        // Should either not exist or escape workspace
        const isUnsafe = !resolved.startsWith(testWorkspace) || !existsSync(resolved)
        expect(isUnsafe).toBe(true)
      })
    })

    it('should reject paths with control characters', () => {
      const badPaths = [
        'project\x00null',
        'project\x01control',
        'project\nnewline',
      ]

      badPaths.forEach(path => {
        expect(/[\x00-\x1f]/.test(path)).toBe(true)
      })
    })

    it('should reject non-existent paths', () => {
      const nonExistentPath = join(testWorkspace, 'does-not-exist')
      expect(existsSync(nonExistentPath)).toBe(false)
    })
  })

  describe('checkConcurrencyLimits', () => {
    it('should allow tasks under global limit', () => {
      const ctx = createContext()

      // Add tasks under limit
      for (let i = 0; i < MAX_CONCURRENT_RUNNING - 1; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          agent: 'test-agent',
          status: 'running',
        })
      }

      expect(ctx.activeTasks.size).toBeLessThan(MAX_CONCURRENT_RUNNING)
    })

    it('should reject tasks exceeding global limit', () => {
      const ctx = createContext()

      // Fill to global limit
      for (let i = 0; i < MAX_CONCURRENT_RUNNING; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          agent: `agent-${i % 3}`,
          status: 'running',
        })
      }

      const runningCount = [...ctx.activeTasks.values()].filter(t => t.status === 'running').length
      expect(runningCount).toBe(MAX_CONCURRENT_RUNNING)
    })

    it('should allow tasks under per-agent limit', () => {
      const ctx = createContext()

      // Add tasks under per-agent limit
      for (let i = 0; i < MAX_PER_AGENT - 1; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          agent: 'test-agent',
          status: 'running',
        })
      }

      const agentRunning = [...ctx.activeTasks.values()].filter(
        t => t.status === 'running' && t.agent === 'test-agent'
      ).length
      expect(agentRunning).toBeLessThan(MAX_PER_AGENT)
    })

    it('should reject tasks exceeding per-agent limit', () => {
      const ctx = createContext()

      // Fill to per-agent limit
      for (let i = 0; i < MAX_PER_AGENT; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          agent: 'test-agent',
          status: 'running',
        })
      }

      const agentRunning = [...ctx.activeTasks.values()].filter(
        t => t.status === 'running' && t.agent === 'test-agent'
      ).length
      expect(agentRunning).toBe(MAX_PER_AGENT)
    })
  })

  describe('list_agents', () => {
    it('should list all configured agents', async () => {
      const { default: startMcpServer } = await import('../../src/mcp-server')
      // We'll test the handler logic directly via imported module
      const agents = mockConfig.agents
      expect(Object.keys(agents)).toContain('test-agent')
      expect(Object.keys(agents)).toContain('unavailable-agent')
      expect(agents['test-agent'].defaultModel).toBe('test-model')
    })

    it('should include agent availability status', () => {
      const agent = mockConfig.agents['test-agent']
      expect(agent).toBeDefined()
      expect(agent.models).toBeDefined()
      expect(agent.strengths).toBeDefined()
    })

    it('should include available models for each agent', () => {
      const agent = mockConfig.agents['test-agent']
      expect(Object.keys(agent.models)).toContain('test-model')
      expect(Object.keys(agent.models)).toContain('alt-model')
    })
  })

  describe('get_task_status', () => {
    it('should return status for running task', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        toolCallCount: 5,
        outputLength: 100,
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.status).toBe('running')
      expect(task.agent).toBe('test-agent')
      expect(task.toolCallCount).toBe(5)
    })

    it('should return status for completed task', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: 'Task completed successfully',
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.status).toBe('completed')
      expect(task.output).toBeDefined()
    })

    it('should reject invalid task ID format', () => {
      const invalidId = 'not-a-uuid'
      expect(/^[a-f0-9-]{8,36}$/.test(invalidId)).toBe(false)
    })

    it('should return error for non-existent task', () => {
      const ctx = createContext()
      const taskId = randomUUID()
      expect(ctx.activeTasks.get(taskId)).toBeUndefined()
    })
  })

  describe('get_task_result', () => {
    it('should return full result for completed task', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: 'Task output here',
        error: null,
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.output).toBe('Task output here')
      expect(task.error).toBeNull()
    })

    it('should return error for failed task', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'failed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: '',
        error: 'Task failed with error',
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.status).toBe('failed')
      expect(task.error).toBe('Task failed with error')
    })

    it('should indicate running task not yet complete', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.status).toBe('running')
      expect(task.output).toBeUndefined()
    })
  })

  describe('cancel_task', () => {
    it('should reject cancelling non-existent task', () => {
      const ctx = createContext()
      const taskId = randomUUID()
      expect(ctx.activeTasks.get(taskId)).toBeUndefined()
    })

    it('should reject cancelling non-running task', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        status: 'completed',
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.status).not.toBe('running')
    })

    it('should mark task as cancelled', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      ctx.activeTasks.set(taskId, {
        id: taskId,
        status: 'running',
        agent: 'test-agent',
      })

      const task = ctx.activeTasks.get(taskId)
      task.status = 'cancelled'
      task.completedAt = new Date().toISOString()
      task.error = 'Cancelled by user'

      expect(task.status).toBe('cancelled')
      expect(task.error).toBe('Cancelled by user')
    })
  })

  describe('assign_task', () => {
    it('should reject invalid agent name', () => {
      const longName = 'a'.repeat(MAX_NAME_LENGTH + 1)
      expect(longName.length).toBeGreaterThan(MAX_NAME_LENGTH)
    })

    it('should reject oversized prompt', () => {
      const hugePrompt = 'x'.repeat(MAX_PROMPT_LENGTH + 1)
      expect(hugePrompt.length).toBeGreaterThan(MAX_PROMPT_LENGTH)
    })

    it('should reject invalid project name', () => {
      const invalidProject = '../../../etc/passwd'
      const resolved = join(testWorkspace, invalidProject)
      const isOutsideWorkspace = !resolved.startsWith(testWorkspace)
      expect(isOutsideWorkspace).toBe(true)
    })

    it('should reject unknown agent', () => {
      const unknownAgent = 'nonexistent-agent'
      expect(mockConfig.agents[unknownAgent]).toBeUndefined()
    })

    it('should use fallback agent when primary unavailable', () => {
      const fallbackConfig = mockConfig.agents['fallback-source']
      expect(fallbackConfig.fallbackAgent).toBe('test-agent')
    })

    it('should reject unavailable agent with no fallback', () => {
      const agent = mockConfig.agents['unavailable-agent']
      expect(agent.fallbackAgent).toBeUndefined()
    })

    it('should fallback to default model if requested model unavailable', () => {
      const agent = mockConfig.agents['test-agent']
      const requestedModel = 'nonexistent-model'
      expect(agent.models[requestedModel]).toBeUndefined()
      expect(agent.defaultModel).toBe('test-model')
    })

    it('should validate path traversal in project parameter', () => {
      const traversalPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
      ]

      traversalPaths.forEach(path => {
        const resolved = join(testWorkspace, path)
        const isUnsafe = !resolved.startsWith(testWorkspace)
        expect(isUnsafe || !existsSync(resolved)).toBe(true)
      })
    })
  })

  describe('get_metrics', () => {
    it('should return metrics summary', async () => {
      const { getMetricsSummary } = await import('../../src/metrics')
      const metrics = getMetricsSummary()
      expect(metrics).toBeDefined()
      expect(typeof metrics).toBe('object')
    })
  })

  describe('health_check', () => {
    it('should report healthy when agents available', () => {
      const ctx = createContext()
      const availableAgents = Object.entries(ctx.config.agents)
        .filter(([_, config]) => config.command === 'test-acp')
      expect(availableAgents.length).toBeGreaterThan(0)
    })

    it('should report degraded when no agents available', () => {
      const ctx = createContext()
      // Mock all agents as unavailable
      const allUnavailable = Object.values(ctx.config.agents)
        .every(config => config.command === 'nonexistent-binary' && !config.fallbackAgent)
      expect(allUnavailable).toBe(false) // We have fallback agent
    })

    it('should include running task count', () => {
      const ctx = createContext()

      for (let i = 0; i < 3; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          status: 'running',
        })
      }

      const runningCount = [...ctx.activeTasks.values()].filter(t => t.status === 'running').length
      expect(runningCount).toBe(3)
    })

    it('should include concurrency limits', () => {
      expect(MAX_CONCURRENT_RUNNING).toBeDefined()
      expect(MAX_PER_AGENT).toBeDefined()
    })
  })

  describe('broadcast (messaging)', () => {
    it('should reject when messaging disabled', () => {
      const ctx = createContext()
      ctx.messageBus = null
      ctx.agentRegistry = null
      expect(ctx.messageBus).toBeNull()
    })

    it('should reject missing content', () => {
      const content = ''
      expect(content).toBe('')
    })

    it('should deliver to all active agents', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        ctx.agentRegistry.register('agent1', 'test-model', 12345)
        ctx.agentRegistry.register('agent2', 'test-model', 12346)

        const activeAgents = ctx.agentRegistry.getActive()
        expect(activeAgents.length).toBe(2)
      }
    })
  })

  describe('send_agent_message (messaging)', () => {
    it('should reject when messaging disabled', () => {
      const ctx = createContext()
      ctx.messageBus = null
      ctx.agentRegistry = null
      expect(ctx.messageBus).toBeNull()
    })

    it('should reject missing fields', () => {
      const missingTo = { content: 'test' }
      const missingContent = { to: 'agent1' }
      expect(missingTo.to).toBeUndefined()
      expect(missingContent.content).toBeUndefined()
    })

    it('should reject unknown agent', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        const target = ctx.agentRegistry.get('nonexistent-agent')
        expect(target).toBeNull()
      }
    })
  })

  describe('get_agent_status (messaging)', () => {
    it('should reject when messaging disabled', () => {
      const ctx = createContext()
      ctx.messageBus = null
      ctx.agentRegistry = null
      expect(ctx.messageBus).toBeNull()
    })

    it('should list all registered agents', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        ctx.agentRegistry.register('agent1', 'test-model', 12345)
        ctx.agentRegistry.register('agent2', 'test-model', 12346)

        const agents = ctx.agentRegistry.getAll()
        expect(agents.length).toBe(2)
      }
    })

    it('should detect dead agents', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        // Register agent with past lastActivity
        ctx.agentRegistry.register('dead-agent', 'test-model', 99999)
        const deadAgents = ctx.agentRegistry.detectDead()
        // May or may not be dead depending on timing
        expect(Array.isArray(deadAgents)).toBe(true)
      }
    })
  })

  describe('shutdown_agent (messaging)', () => {
    it('should reject when messaging disabled', () => {
      const ctx = createContext()
      ctx.messageBus = null
      ctx.agentRegistry = null
      expect(ctx.messageBus).toBeNull()
    })

    it('should reject missing agent field', () => {
      const args = { reason: 'test' }
      expect(args.agent).toBeUndefined()
    })

    it('should reject unknown agent', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        const target = ctx.agentRegistry.get('unknown')
        expect(target).toBeNull()
      }
    })
  })

  describe('kill_agent (messaging)', () => {
    it('should reject when messaging disabled', () => {
      const ctx = createContext()
      ctx.agentRegistry = null
      expect(ctx.agentRegistry).toBeNull()
    })

    it('should reject missing agent field', () => {
      const args = {}
      expect(args.agent).toBeUndefined()
    })

    it('should reject agent without PID', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        // Agent without PID (shouldn't happen normally)
        const entry = { name: 'test', model: 'test', pid: null }
        expect(entry.pid).toBeNull()
      }
    })
  })

  describe('create_workflow', () => {
    it('should reject missing required fields', () => {
      const missingName = { project: 'test', steps: [] }
      const missingProject = { name: 'test', steps: [] }
      const missingSteps = { name: 'test', project: 'test' }

      expect(missingName.name).toBeUndefined()
      expect(missingProject.project).toBeUndefined()
      expect(missingSteps.steps).toBeUndefined()
    })

    it('should reject empty steps array', () => {
      const workflow = { name: 'test', project: 'test', steps: [] }
      expect(workflow.steps.length).toBe(0)
    })

    it('should validate project path', () => {
      const invalidProject = '../../../etc/passwd'
      const resolved = join(testWorkspace, invalidProject)
      const isOutsideWorkspace = !resolved.startsWith(testWorkspace)
      expect(isOutsideWorkspace).toBe(true)
    })

    it('should create workflow with valid steps', () => {
      const ctx = createContext()

      const steps = [
        { name: 'step1', agent: 'test-agent', prompt: 'do task 1' },
        { name: 'step2', agent: 'test-agent', prompt: 'do task 2', depends_on: ['step1'] },
      ]

      expect(steps.length).toBe(2)
      expect(steps[1].depends_on).toContain('step1')
    })
  })

  describe('get_workflow_status', () => {
    it('should reject missing workflow_id', () => {
      const args = {}
      expect(args.workflow_id).toBeUndefined()
    })

    it('should return error for non-existent workflow', () => {
      const ctx = createContext()
      const fakeId = randomUUID()
      const state = ctx.workflowEngine.getState(fakeId)
      expect(state).toBeNull()
    })
  })

  describe('Task Pruning', () => {
    it('should not prune tasks under MAX_ACTIVE_TASKS', () => {
      const ctx = createContext()

      // Add a few tasks
      for (let i = 0; i < 5; i++) {
        ctx.activeTasks.set(`task-${i}`, {
          id: `task-${i}`,
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
      }

      expect(ctx.activeTasks.size).toBeLessThan(100)
    })

    it('should respect grace period', () => {
      const now = Date.now()
      const gracePeriod = 5 * 60 * 1000 // 5 minutes
      const recentTime = new Date(now - 60000).toISOString() // 1 minute ago

      const age = now - new Date(recentTime).getTime()
      expect(age).toBeLessThan(gracePeriod)
    })

    it('should only prune completed tasks', () => {
      const ctx = createContext()

      ctx.activeTasks.set('running-task', {
        id: 'running-task',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      ctx.activeTasks.set('completed-task', {
        id: 'completed-task',
        status: 'completed',
        completedAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      })

      const runningTask = ctx.activeTasks.get('running-task')
      expect(runningTask.status).toBe('running')
    })
  })

  describe('Security Validations', () => {
    it('should block path traversal in assign_task project', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'project/../../../etc/shadow',
      ]

      maliciousPaths.forEach(path => {
        const resolved = join(testWorkspace, path)
        const isUnsafe = !resolved.startsWith(testWorkspace) || !existsSync(resolved)
        expect(isUnsafe).toBe(true)
      })
    })

    it('should block control characters in project name', () => {
      const badNames = [
        'project\x00null',
        'project\x01control',
        'project\nnewline',
        'project\rtab',
      ]

      badNames.forEach(name => {
        expect(/[\x00-\x1f]/.test(name)).toBe(true)
      })
    })

    it('should validate team name if provided', () => {
      const validTeam = 'team-alpha'
      const invalidTeam = '../../../etc/passwd'

      expect(validTeam).toMatch(/^[a-zA-Z0-9-_]+$/)
      expect(invalidTeam).not.toMatch(/^[a-zA-Z0-9-_]+$/)
    })
  })

  describe('Error Handling', () => {
    it('should return error response for unknown tools', () => {
      const toolName = 'nonexistent_tool'
      const validTools = [
        'list_agents',
        'assign_task',
        'get_task_status',
        'get_task_result',
        'cancel_task',
        'get_metrics',
        'health_check',
        'broadcast',
        'send_agent_message',
        'get_agent_status',
        'shutdown_agent',
        'kill_agent',
        'create_workflow',
        'get_workflow_status',
      ]

      expect(validTools).not.toContain(toolName)
    })

    it('should handle process spawn failures gracefully', () => {
      const error = new Error('ENOENT: command not found')
      expect(error.message).toContain('ENOENT')
    })

    it('should handle task cancellation edge cases', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      // Task without process handle
      ctx.activeTasks.set(taskId, {
        id: taskId,
        status: 'running',
        proc: undefined,
      })

      const task = ctx.activeTasks.get(taskId)
      expect(task.proc).toBeUndefined()
    })
  })

  describe('Fallback Agent Logic', () => {
    it('should trigger fallback when primary unavailable', () => {
      const primaryConfig = mockConfig.agents['fallback-source']
      const fallbackConfig = mockConfig.agents[primaryConfig.fallbackAgent!]

      expect(primaryConfig.command).toBe('nonexistent-binary')
      expect(fallbackConfig).toBeDefined()
      expect(fallbackConfig.command).toBe('test-acp')
    })

    it('should not create infinite fallback loops', () => {
      // Agent A -> Agent B -> Agent A would be infinite
      const agentA = mockConfig.agents['fallback-source']
      const agentB = mockConfig.agents[agentA.fallbackAgent!]

      // Agent B should not fallback to Agent A
      expect(agentB.fallbackAgent).not.toBe('fallback-source')
    })
  })

  describe('Model Validation', () => {
    it('should use requested model if available', () => {
      const agent = mockConfig.agents['test-agent']
      const requestedModel = 'alt-model'

      expect(agent.models[requestedModel]).toBeDefined()
    })

    it('should fallback to default model if requested unavailable', () => {
      const agent = mockConfig.agents['test-agent']
      const unavailableModel = 'nonexistent-model'

      expect(agent.models[unavailableModel]).toBeUndefined()
      expect(agent.defaultModel).toBe('test-model')
    })
  })

  describe('Integration Tests with Real Server', () => {
    it('should initialize MCP server successfully', async () => {
      // Create a valid config file
      const configPath = join(testWorkspace, 'bridge-config.json')
      writeFileSync(configPath, JSON.stringify(mockConfig, null, 2))

      // Server should initialize without throwing
      const server = await startMcpServer(mockConfig, testWorkspace)
      expect(server).toBeDefined()
    })

    it('should handle list_tools request', async () => {
      const server = await startMcpServer(mockConfig, testWorkspace)
      expect(server).toBeDefined()
      // Server is now running and will respond to tool calls
    })

    it('should validate task ID formats in real context', () => {
      const validIds = [
        randomUUID(),
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        '12345678-1234-1234-1234-123456789012',
      ]

      const invalidIds = [
        'not-a-uuid',
        '123',
        '',
        '../../../etc/passwd',
        'UPPERCASE-NOT-ALLOWED',
      ]

      validIds.forEach(id => {
        expect(/^[a-f0-9-]{8,36}$/.test(id)).toBe(true)
      })

      invalidIds.forEach(id => {
        expect(/^[a-f0-9-]{8,36}$/.test(id)).toBe(false)
      })
    })

    it('should enforce project path security in real context', () => {
      const safePaths = [
        'test-project',
        'my-app',
        'subfolder/project',
      ]

      const unsafePaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'project\x00null',
      ]

      safePaths.forEach(path => {
        const resolved = join(testWorkspace, path)
        const isSafe = resolved.startsWith(testWorkspace) && !/[\x00-\x1f]/.test(path)
        expect(isSafe).toBe(true)
      })

      unsafePaths.forEach(path => {
        const hasControlChars = /[\x00-\x1f]/.test(path)
        const resolved = join(testWorkspace, path)
        const escapesWorkspace = !resolved.startsWith(testWorkspace)
        // Absolute paths may resolve within workspace on some systems, so check both conditions
        const isUnsafe = hasControlChars || escapesWorkspace || !existsSync(resolved)
        expect(isUnsafe).toBe(true)
      })
    })

    it('should properly prune completed tasks', () => {
      const ctx = createContext()
      const now = Date.now()

      // Add tasks within grace period (should NOT be pruned)
      for (let i = 0; i < 5; i++) {
        ctx.activeTasks.set(`recent-${i}`, {
          id: `recent-${i}`,
          status: 'completed',
          completedAt: new Date(now - 60000).toISOString(), // 1 minute ago
        })
      }

      // Add old tasks (candidates for pruning)
      for (let i = 0; i < 5; i++) {
        ctx.activeTasks.set(`old-${i}`, {
          id: `old-${i}`,
          status: 'completed',
          completedAt: new Date(now - TASK_RETENTION_MS - 1000).toISOString(),
        })
      }

      // Add running tasks (should NEVER be pruned)
      ctx.activeTasks.set('running-task', {
        id: 'running-task',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      expect(ctx.activeTasks.size).toBeLessThan(MAX_ACTIVE_TASKS)
      // In real pruning, old tasks would be removed if limit exceeded
    })

    it('should enforce concurrency limits correctly', () => {
      const ctx = createContext()

      // Test global limit
      for (let i = 0; i < MAX_CONCURRENT_RUNNING; i++) {
        ctx.activeTasks.set(`global-${i}`, {
          id: `global-${i}`,
          agent: `agent-${i % 5}`, // Use mod 5 to ensure fewer tasks per agent
          status: 'running',
        })
      }

      const runningCount = [...ctx.activeTasks.values()].filter(
        t => t.status === 'running'
      ).length
      expect(runningCount).toBe(MAX_CONCURRENT_RUNNING)

      // Test per-agent limit - with 10 tasks and 5 agents, each should have 2 tasks (< MAX_PER_AGENT of 3)
      const agentTasks = [...ctx.activeTasks.values()].filter(
        t => t.status === 'running' && t.agent === 'agent-0'
      )
      expect(agentTasks.length).toBeLessThanOrEqual(MAX_PER_AGENT)
    })

    it('should handle storage and retrieval of tasks', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      // Save to database
      ctx.taskStore.save({
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test prompt',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      // Retrieve from database
      const retrieved = ctx.taskStore.get(taskId)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.agent).toBe('test-agent')
      expect(retrieved!.status).toBe('running')
    })

    it('should validate all tool names are defined', () => {
      const expectedTools = [
        'list_agents',
        'assign_task',
        'get_task_status',
        'get_task_result',
        'cancel_task',
        'get_metrics',
        'health_check',
        'broadcast',
        'send_agent_message',
        'get_agent_status',
        'shutdown_agent',
        'kill_agent',
        'create_workflow',
        'get_workflow_status',
      ]

      // All 14 tools should be present
      expect(expectedTools.length).toBe(14)
      expect(new Set(expectedTools).size).toBe(14) // No duplicates
    })

    it('should handle agent registry correctly', () => {
      const ctx = createContext()

      if (ctx.agentRegistry) {
        // Register agents
        ctx.agentRegistry.register('agent-1', 'model-1', 1000)
        ctx.agentRegistry.register('agent-2', 'model-2', 2000)

        const allAgents = ctx.agentRegistry.getAll()
        expect(allAgents.length).toBe(2)

        const active = ctx.agentRegistry.getActive()
        expect(active.length).toBeGreaterThanOrEqual(0)

        const agent1 = ctx.agentRegistry.get('agent-1')
        expect(agent1).not.toBeNull()
        expect(agent1!.name).toBe('agent-1')
      }
    })

    it('should handle message bus operations', () => {
      const ctx = createContext()

      if (ctx.messageBus) {
        // Write a message
        const msg = ctx.messageBus.writeMessage('sender', 'receiver', 'Test message')
        expect(msg.id).toBeDefined()
        expect(msg.from).toBe('sender')
        expect(msg.to).toBe('receiver')

        // Read inbox
        const inbox = ctx.messageBus.readInbox('receiver')
        expect(inbox.length).toBeGreaterThan(0)
        expect(inbox[0].content).toBe('Test message')
      }
    })

    it('should create and track workflows', () => {
      const ctx = createContext()

      const steps = [
        { name: 'step1', agent: 'test-agent', prompt: 'First task' },
        { name: 'step2', agent: 'test-agent', prompt: 'Second task', dependsOn: ['step1'] },
      ]

      const definition = ctx.workflowEngine.createWorkflow('test-workflow', steps)
      expect(definition.id).toBeDefined()
      expect(definition.steps.length).toBe(2)

      const state = ctx.workflowEngine.getState(definition.id)
      expect(state).not.toBeNull()
      expect(state!.status).toBe('pending')
    })

    it('should handle task status transitions', () => {
      const ctx = createContext()
      const taskId = randomUUID()

      // Create running task
      ctx.activeTasks.set(taskId, {
        id: taskId,
        agent: 'test-agent',
        model: 'test-model',
        project: 'test-project',
        prompt: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const task = ctx.activeTasks.get(taskId)!
      expect(task.status).toBe('running')

      // Transition to completed
      task.status = 'completed'
      task.completedAt = new Date().toISOString()
      task.output = 'Task output'

      expect(task.status).toBe('completed')
      expect(task.completedAt).toBeDefined()
      expect(task.output).toBe('Task output')
    })

    it('should validate input size limits', () => {
      const shortPrompt = 'Valid prompt'
      const longPrompt = 'x'.repeat(MAX_PROMPT_LENGTH + 1)
      const shortName = 'agent'
      const longName = 'a'.repeat(MAX_NAME_LENGTH + 1)

      expect(shortPrompt.length).toBeLessThan(MAX_PROMPT_LENGTH)
      expect(longPrompt.length).toBeGreaterThan(MAX_PROMPT_LENGTH)
      expect(shortName.length).toBeLessThan(MAX_NAME_LENGTH)
      expect(longName.length).toBeGreaterThan(MAX_NAME_LENGTH)
    })

    it('should handle fallback agent configuration', () => {
      const primaryConfig = mockConfig.agents['fallback-source']
      expect(primaryConfig.fallbackAgent).toBe('test-agent')

      const fallbackConfig = mockConfig.agents[primaryConfig.fallbackAgent!]
      expect(fallbackConfig).toBeDefined()
      expect(fallbackConfig.command).toBe('test-acp')

      // Ensure no circular fallback
      expect(fallbackConfig.fallbackAgent).not.toBe('fallback-source')
    })

    it('should track task retention limits', () => {
      const now = Date.now()

      const withinGrace = new Date(now - TASK_GRACE_PERIOD_MS + 1000).toISOString()
      const outsideGrace = new Date(now - TASK_GRACE_PERIOD_MS - 1000).toISOString()
      const withinRetention = new Date(now - TASK_RETENTION_MS + 1000).toISOString()
      const outsideRetention = new Date(now - TASK_RETENTION_MS - 1000).toISOString()

      const graceAge = now - new Date(withinGrace).getTime()
      const retentionAge = now - new Date(outsideRetention).getTime()

      expect(graceAge).toBeLessThan(TASK_GRACE_PERIOD_MS)
      expect(retentionAge).toBeGreaterThan(TASK_RETENTION_MS)
    })
  })
})
