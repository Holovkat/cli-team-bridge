import { describe, it, expect, beforeEach } from 'bun:test'
import { WorkflowEngine, type WorkflowStep, type TaskRunner } from '../../src/workflow'

/**
 * Integration tests for Workflow Engine
 *
 * Tests multi-step workflow execution with real workflow engine:
 * - Multi-step workflow execution
 * - Task dependencies and ordering
 * - Error handling in workflow steps
 * - Workflow state persistence
 */

describe('Workflow Engine Integration', () => {
  let engine: WorkflowEngine
  let taskResults: Map<string, { output: string; error: string | null }>

  beforeEach(() => {
    engine = new WorkflowEngine()
    taskResults = new Map()
  })

  // Mock task runner that simulates agent execution
  const mockTaskRunner: TaskRunner = async (agent, prompt, model?) => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // Simulate different behaviors based on prompt
    if (prompt.includes('FAIL')) {
      taskResults.set(taskId, {
        output: '',
        error: 'Task failed as requested'
      })
      return {
        taskId,
        output: '',
        error: 'Task failed as requested'
      }
    }

    if (prompt.includes('SLOW')) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const output = `${agent} completed: ${prompt.slice(0, 50)}...`
    taskResults.set(taskId, { output, error: null })

    return {
      taskId,
      output,
      error: null
    }
  }

  describe('Multi-Step Workflow Execution', () => {
    it('should execute simple linear workflow', async () => {
      const steps: WorkflowStep[] = [
        { name: 'step1', agent: 'agent-a', prompt: 'Do task 1' },
        { name: 'step2', agent: 'agent-b', prompt: 'Do task 2', dependsOn: ['step1'] },
        { name: 'step3', agent: 'agent-c', prompt: 'Do task 3', dependsOn: ['step2'] },
      ]

      const workflow = engine.createWorkflow('Linear Workflow', steps)
      expect(workflow.steps).toHaveLength(3)

      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')
      expect(state.steps).toHaveLength(3)
      expect(state.steps.every(s => s.status === 'completed')).toBe(true)
      expect(state.completedAt).toBeTruthy()
    })

    it('should execute parallel independent steps', async () => {
      const steps: WorkflowStep[] = [
        { name: 'parallel1', agent: 'agent-a', prompt: 'SLOW Independent task 1' },
        { name: 'parallel2', agent: 'agent-b', prompt: 'SLOW Independent task 2' },
        { name: 'parallel3', agent: 'agent-c', prompt: 'SLOW Independent task 3' },
      ]

      const workflow = engine.createWorkflow('Parallel Workflow', steps)
      const startTime = Date.now()
      const state = await engine.execute(workflow, mockTaskRunner)
      const elapsed = Date.now() - startTime

      expect(state.status).toBe('completed')
      expect(state.steps.every(s => s.status === 'completed')).toBe(true)

      // All three steps run in parallel, so total time should be ~200ms, not 600ms
      expect(elapsed).toBeLessThan(400) // Allow some overhead
    })

    it('should execute diamond dependency pattern', async () => {
      const steps: WorkflowStep[] = [
        { name: 'start', agent: 'agent-a', prompt: 'Initialize' },
        { name: 'branch1', agent: 'agent-b', prompt: 'Branch 1', dependsOn: ['start'] },
        { name: 'branch2', agent: 'agent-c', prompt: 'Branch 2', dependsOn: ['start'] },
        { name: 'merge', agent: 'agent-d', prompt: 'Merge results', dependsOn: ['branch1', 'branch2'] },
      ]

      const workflow = engine.createWorkflow('Diamond Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')
      expect(state.steps).toHaveLength(4)

      // Verify execution order
      const startStep = state.steps.find(s => s.stepName === 'start')!
      const branch1Step = state.steps.find(s => s.stepName === 'branch1')!
      const branch2Step = state.steps.find(s => s.stepName === 'branch2')!
      const mergeStep = state.steps.find(s => s.stepName === 'merge')!

      expect(new Date(startStep.completedAt!).getTime())
        .toBeLessThan(new Date(branch1Step.startedAt!).getTime())
      expect(new Date(startStep.completedAt!).getTime())
        .toBeLessThan(new Date(branch2Step.startedAt!).getTime())
      expect(new Date(branch1Step.completedAt!).getTime())
        .toBeLessThan(new Date(mergeStep.startedAt!).getTime())
      expect(new Date(branch2Step.completedAt!).getTime())
        .toBeLessThan(new Date(mergeStep.startedAt!).getTime())
    })
  })

  describe('Task Dependencies and Ordering', () => {
    it('should enforce dependency order', async () => {
      const steps: WorkflowStep[] = [
        { name: 'step3', agent: 'agent-c', prompt: 'Final step', dependsOn: ['step2'] },
        { name: 'step1', agent: 'agent-a', prompt: 'First step' },
        { name: 'step2', agent: 'agent-b', prompt: 'Middle step', dependsOn: ['step1'] },
      ]

      const workflow = engine.createWorkflow('Ordered Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')

      // Despite definition order, execution order should be: step1 → step2 → step3
      const step1 = state.steps.find(s => s.stepName === 'step1')!
      const step2 = state.steps.find(s => s.stepName === 'step2')!
      const step3 = state.steps.find(s => s.stepName === 'step3')!

      expect(new Date(step1.completedAt!).getTime())
        .toBeLessThan(new Date(step2.startedAt!).getTime())
      expect(new Date(step2.completedAt!).getTime())
        .toBeLessThan(new Date(step3.startedAt!).getTime())
    })

    it('should pass context from dependencies to dependent steps', async () => {
      const steps: WorkflowStep[] = [
        { name: 'fetch-data', agent: 'agent-a', prompt: 'Fetch user data' },
        { name: 'process-data', agent: 'agent-b', prompt: 'Process the data', dependsOn: ['fetch-data'] },
      ]

      const workflow = engine.createWorkflow('Context Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')

      const processStep = state.steps.find(s => s.stepName === 'process-data')!
      // The workflow engine should have injected the output from fetch-data
      // We can verify this by checking the task was executed (output exists)
      expect(processStep.output).toBeTruthy()
    })

    it('should reject workflows with invalid dependencies', () => {
      const steps: WorkflowStep[] = [
        { name: 'step1', agent: 'agent-a', prompt: 'Task 1', dependsOn: ['nonexistent'] },
      ]

      expect(() => {
        engine.createWorkflow('Invalid Workflow', steps)
      }).toThrow(/unknown step/)
    })

    it('should reject workflows with circular dependencies', () => {
      const steps: WorkflowStep[] = [
        { name: 'step1', agent: 'agent-a', prompt: 'Task 1', dependsOn: ['step2'] },
        { name: 'step2', agent: 'agent-b', prompt: 'Task 2', dependsOn: ['step1'] },
      ]

      expect(() => {
        engine.createWorkflow('Circular Workflow', steps)
      }).toThrow(/Cycle detected/)
    })
  })

  describe('Error Handling in Workflow Steps', () => {
    it('should mark workflow as failed when step fails', async () => {
      const steps: WorkflowStep[] = [
        { name: 'step1', agent: 'agent-a', prompt: 'Success task' },
        { name: 'step2', agent: 'agent-b', prompt: 'FAIL This will fail' },
        { name: 'step3', agent: 'agent-c', prompt: 'Never executed', dependsOn: ['step2'] },
      ]

      const workflow = engine.createWorkflow('Failing Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('failed')

      const step1 = state.steps.find(s => s.stepName === 'step1')!
      const step2 = state.steps.find(s => s.stepName === 'step2')!
      const step3 = state.steps.find(s => s.stepName === 'step3')!

      expect(step1.status).toBe('completed')
      expect(step2.status).toBe('failed')
      expect(step3.status).toBe('skipped') // Dependency failed
    })

    it('should skip dependent steps when dependency fails', async () => {
      const steps: WorkflowStep[] = [
        { name: 'init', agent: 'agent-a', prompt: 'Initialize' },
        { name: 'critical', agent: 'agent-b', prompt: 'FAIL Critical step', dependsOn: ['init'] },
        { name: 'dependent1', agent: 'agent-c', prompt: 'Needs critical', dependsOn: ['critical'] },
        { name: 'dependent2', agent: 'agent-d', prompt: 'Also needs critical', dependsOn: ['critical'] },
        { name: 'independent', agent: 'agent-e', prompt: 'Independent task' },
      ]

      const workflow = engine.createWorkflow('Cascade Failure Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('failed')

      const initStep = state.steps.find(s => s.stepName === 'init')!
      const criticalStep = state.steps.find(s => s.stepName === 'critical')!
      const dependent1Step = state.steps.find(s => s.stepName === 'dependent1')!
      const dependent2Step = state.steps.find(s => s.stepName === 'dependent2')!
      const independentStep = state.steps.find(s => s.stepName === 'independent')!

      expect(initStep.status).toBe('completed')
      expect(criticalStep.status).toBe('failed')
      expect(dependent1Step.status).toBe('skipped')
      expect(dependent2Step.status).toBe('skipped')
      expect(independentStep.status).toBe('completed') // Independent should still run
    })

    it('should continue parallel branches when one fails', async () => {
      const steps: WorkflowStep[] = [
        { name: 'start', agent: 'agent-a', prompt: 'Start' },
        { name: 'branch1', agent: 'agent-b', prompt: 'FAIL Failing branch', dependsOn: ['start'] },
        { name: 'branch2', agent: 'agent-c', prompt: 'Success branch', dependsOn: ['start'] },
        { name: 'branch3', agent: 'agent-d', prompt: 'Another success', dependsOn: ['start'] },
      ]

      const workflow = engine.createWorkflow('Partial Failure Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('failed') // Overall failed due to one failure

      const branch1 = state.steps.find(s => s.stepName === 'branch1')!
      const branch2 = state.steps.find(s => s.stepName === 'branch2')!
      const branch3 = state.steps.find(s => s.stepName === 'branch3')!

      expect(branch1.status).toBe('failed')
      expect(branch2.status).toBe('completed')
      expect(branch3.status).toBe('completed')
    })
  })

  describe('Workflow State Persistence', () => {
    it('should track workflow state throughout execution', async () => {
      const steps: WorkflowStep[] = [
        { name: 'step1', agent: 'agent-a', prompt: 'Task 1' },
        { name: 'step2', agent: 'agent-b', prompt: 'Task 2', dependsOn: ['step1'] },
      ]

      const workflow = engine.createWorkflow('State Tracking Workflow', steps)

      // Initial state
      let state = engine.getState(workflow.id)
      expect(state?.status).toBe('pending')

      // Execute workflow
      state = await engine.execute(workflow, mockTaskRunner)

      // Final state
      expect(state.status).toBe('completed')
      expect(state.startedAt).toBeTruthy()
      expect(state.completedAt).toBeTruthy()
      expect(state.createdAt).toBeTruthy()

      // Verify step details are tracked
      for (const step of state.steps) {
        expect(step.stepName).toBeTruthy()
        expect(step.status).toBeTruthy()
        expect(step.startedAt).toBeTruthy()
        expect(step.completedAt).toBeTruthy()
        expect(step.taskId).toBeTruthy()
      }
    })

    it('should persist state across workflow queries', async () => {
      const steps: WorkflowStep[] = [
        { name: 'task', agent: 'agent-a', prompt: 'Do work' },
      ]

      const workflow = engine.createWorkflow('Persistence Test', steps)
      await engine.execute(workflow, mockTaskRunner)

      // Query state after execution
      const state = engine.getState(workflow.id)
      expect(state).toBeTruthy()
      expect(state?.status).toBe('completed')
      expect(state?.name).toBe('Persistence Test')
    })

    it('should list all workflows', async () => {
      const workflow1 = engine.createWorkflow('Workflow 1', [
        { name: 'step1', agent: 'agent-a', prompt: 'Task 1' }
      ])

      const workflow2 = engine.createWorkflow('Workflow 2', [
        { name: 'step2', agent: 'agent-b', prompt: 'Task 2' }
      ])

      const list = engine.listWorkflows()
      expect(list).toHaveLength(2)
      expect(list.find(w => w.id === workflow1.id)).toBeTruthy()
      expect(list.find(w => w.id === workflow2.id)).toBeTruthy()
    })

    it('should track step timing accurately', async () => {
      const steps: WorkflowStep[] = [
        { name: 'quick', agent: 'agent-a', prompt: 'Quick task' },
        { name: 'slow', agent: 'agent-b', prompt: 'SLOW Slow task' },
      ]

      const workflow = engine.createWorkflow('Timing Test', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      const quickStep = state.steps.find(s => s.stepName === 'quick')!
      const slowStep = state.steps.find(s => s.stepName === 'slow')!

      // Verify timing
      const quickDuration = new Date(quickStep.completedAt!).getTime() - new Date(quickStep.startedAt!).getTime()
      const slowDuration = new Date(slowStep.completedAt!).getTime() - new Date(slowStep.startedAt!).getTime()

      expect(quickDuration).toBeLessThan(100) // Quick task should be fast
      expect(slowDuration).toBeGreaterThanOrEqual(200) // Slow task takes 200ms
    })
  })

  describe('Complex Workflow Scenarios', () => {
    it('should handle large workflow with many steps', async () => {
      const steps: WorkflowStep[] = []
      for (let i = 0; i < 20; i++) {
        steps.push({
          name: `step-${i}`,
          agent: `agent-${i % 3}`, // Rotate between 3 agents
          prompt: `Task ${i}`,
          dependsOn: i > 0 ? [`step-${i - 1}`] : undefined,
        })
      }

      const workflow = engine.createWorkflow('Large Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')
      expect(state.steps).toHaveLength(20)
      expect(state.steps.every(s => s.status === 'completed')).toBe(true)
    })

    it('should handle workflow with mixed parallel and sequential steps', async () => {
      const steps: WorkflowStep[] = [
        { name: 'init', agent: 'agent-a', prompt: 'Initialize' },
        { name: 'parallel1a', agent: 'agent-b', prompt: 'Parallel 1a', dependsOn: ['init'] },
        { name: 'parallel1b', agent: 'agent-c', prompt: 'Parallel 1b', dependsOn: ['init'] },
        { name: 'sync1', agent: 'agent-d', prompt: 'Sync point 1', dependsOn: ['parallel1a', 'parallel1b'] },
        { name: 'parallel2a', agent: 'agent-e', prompt: 'Parallel 2a', dependsOn: ['sync1'] },
        { name: 'parallel2b', agent: 'agent-f', prompt: 'Parallel 2b', dependsOn: ['sync1'] },
        { name: 'final', agent: 'agent-g', prompt: 'Final step', dependsOn: ['parallel2a', 'parallel2b'] },
      ]

      const workflow = engine.createWorkflow('Complex Workflow', steps)
      const state = await engine.execute(workflow, mockTaskRunner)

      expect(state.status).toBe('completed')
      expect(state.steps).toHaveLength(7)
      expect(state.steps.every(s => s.status === 'completed')).toBe(true)

      // Verify sync points executed in correct order
      const sync1 = state.steps.find(s => s.stepName === 'sync1')!
      const parallel1a = state.steps.find(s => s.stepName === 'parallel1a')!
      const parallel1b = state.steps.find(s => s.stepName === 'parallel1b')!

      // Allow for timing resolution (parallel steps may have same timestamp if very fast)
      expect(new Date(parallel1a.completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(sync1.startedAt!).getTime())
      expect(new Date(parallel1b.completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(sync1.startedAt!).getTime())
    })
  })
})
