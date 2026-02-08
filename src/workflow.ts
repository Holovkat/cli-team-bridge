import { randomUUID } from 'crypto'
import { logger } from './logger'

export interface WorkflowStep {
  name: string
  agent: string
  prompt: string
  model?: string
  dependsOn?: string[]
}

export interface WorkflowDefinition {
  id: string
  name: string
  steps: WorkflowStep[]
  createdAt: string
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface StepResult {
  stepName: string
  status: StepStatus
  output?: string
  error?: string | null
  startedAt?: string
  completedAt?: string
  taskId?: string
}

export interface WorkflowState {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  steps: StepResult[]
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export type TaskRunner = (agent: string, prompt: string, model?: string) => Promise<{
  taskId: string
  output: string
  error: string | null
}>

export class WorkflowEngine {
  private workflows = new Map<string, WorkflowState>()

  createWorkflow(name: string, steps: WorkflowStep[]): WorkflowDefinition {
    // Validate dependencies
    const stepNames = new Set(steps.map(s => s.name))
    for (const step of steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepNames.has(dep)) {
            throw new Error(`Step "${step.name}" depends on unknown step "${dep}"`)
          }
        }
      }
    }

    // Detect cycles
    this.detectCycles(steps)

    const workflow: WorkflowDefinition = {
      id: randomUUID(),
      name,
      steps,
      createdAt: new Date().toISOString(),
    }

    const state: WorkflowState = {
      id: workflow.id,
      name,
      status: 'pending',
      steps: steps.map(s => ({ stepName: s.name, status: 'pending' })),
      createdAt: workflow.createdAt,
    }
    this.workflows.set(workflow.id, state)

    logger.info(`[Workflow] Created "${name}" with ${steps.length} steps (id: ${workflow.id})`)
    return workflow
  }

  async execute(
    definition: WorkflowDefinition,
    runner: TaskRunner,
  ): Promise<WorkflowState> {
    const state = this.workflows.get(definition.id)
    if (!state) throw new Error(`Workflow ${definition.id} not found`)

    state.status = 'running'
    state.startedAt = new Date().toISOString()

    const resultsByName = new Map<string, StepResult>()

    // Initialize results map
    for (const sr of state.steps) {
      resultsByName.set(sr.stepName, sr)
    }

    try {
      // Topological execution — run steps when dependencies are met
      const completed = new Set<string>()
      const failed = new Set<string>()

      while (completed.size + failed.size < definition.steps.length) {
        // Find runnable steps (all deps completed, not yet started)
        const runnable = definition.steps.filter(step => {
          if (completed.has(step.name) || failed.has(step.name)) return false
          const result = resultsByName.get(step.name)
          if (result?.status === 'running') return false
          if (!step.dependsOn) return true
          return step.dependsOn.every(dep => completed.has(dep))
        })

        // If nothing is runnable and nothing is running, we're stuck
        const running = [...resultsByName.values()].filter(r => r.status === 'running')
        if (runnable.length === 0 && running.length === 0) {
          // Check for dependency on failed steps
          const blocked = definition.steps.filter(step => {
            if (completed.has(step.name) || failed.has(step.name)) return false
            return step.dependsOn?.some(dep => failed.has(dep))
          })
          for (const step of blocked) {
            const result = resultsByName.get(step.name)!
            result.status = 'skipped'
            result.error = 'Dependency failed'
            failed.add(step.name)
          }
          if (blocked.length === 0) break // Truly stuck
          continue
        }

        // Run all runnable steps concurrently
        const promises = runnable.map(async (step) => {
          const result = resultsByName.get(step.name)!
          result.status = 'running'
          result.startedAt = new Date().toISOString()

          // Build prompt with context from dependencies
          let contextPrompt = step.prompt
          if (step.dependsOn && step.dependsOn.length > 0) {
            const depOutputs = step.dependsOn
              .map(dep => resultsByName.get(dep))
              .filter(r => r?.output)
              .map(r => `--- Output from "${r!.stepName}" ---\n${r!.output}\n--- End ---`)
              .join('\n\n')

            if (depOutputs) {
              contextPrompt = `${depOutputs}\n\n${step.prompt}`
            }
          }

          try {
            logger.info(`[Workflow] Running step "${step.name}" with ${step.agent}`)
            const taskResult = await runner(step.agent, contextPrompt, step.model)
            result.taskId = taskResult.taskId
            result.output = taskResult.output
            result.error = taskResult.error
            result.completedAt = new Date().toISOString()
            result.status = taskResult.error ? 'failed' : 'completed'

            if (result.status === 'completed') {
              completed.add(step.name)
            } else {
              failed.add(step.name)
            }
            logger.info(`[Workflow] Step "${step.name}" ${result.status}`)
          } catch (err) {
            result.status = 'failed'
            result.error = String(err)
            result.completedAt = new Date().toISOString()
            failed.add(step.name)
            logger.error(`[Workflow] Step "${step.name}" failed: ${err}`)
          }
        })

        await Promise.all(promises)
      }

      state.completedAt = new Date().toISOString()
      state.status = failed.size > 0 ? 'failed' : 'completed'
      logger.info(`[Workflow] "${state.name}" ${state.status} (${completed.size}/${definition.steps.length} steps)`)
    } catch (err) {
      state.status = 'failed'
      state.completedAt = new Date().toISOString()
      logger.error(`[Workflow] "${state.name}" error: ${err}`)
    }

    return state
  }

  getState(workflowId: string): WorkflowState | null {
    return this.workflows.get(workflowId) ?? null
  }

  listWorkflows(): WorkflowState[] {
    return [...this.workflows.values()]
  }

  private detectCycles(steps: WorkflowStep[]): void {
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const adj = new Map<string, string[]>()

    for (const step of steps) {
      adj.set(step.name, step.dependsOn ?? [])
    }

    function dfs(node: string): void {
      if (inStack.has(node)) {
        throw new Error(`Cycle detected involving step "${node}"`)
      }
      if (visited.has(node)) return
      inStack.add(node)
      for (const dep of adj.get(node) ?? []) {
        dfs(dep)
      }
      inStack.delete(node)
      visited.add(node)
    }

    for (const step of steps) {
      dfs(step.name)
    }
  }
}
