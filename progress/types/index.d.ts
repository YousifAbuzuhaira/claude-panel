export type TestRunStatus = 'running' | 'passed' | 'failed'

export type TestRun = {
  id: string
  label: string
  isSubagent: boolean
  status: TestRunStatus
  done: number
  passed: number
  failed: number
  skipped: number
  /** Exact, once the runner announced it or printed its summary. */
  total: number | null
  /** The last run of the same command, until `total` is known. */
  estimate: number | null
  /** Where its output is teed, and what its total is remembered under: so a reload can pick the run up again. */
  log?: string
  key?: string
}

export type PhaseStatus = 'todo' | 'in_progress' | 'done'

export type Phase = { name: string; status: PhaseStatus }

export type PhasePlan = { title: string; items: Phase[] }

declare module 'claude-code' {
  interface PluginState {
    progress: { testRuns: TestRun[]; phases: PhasePlan | null }
  }
}
