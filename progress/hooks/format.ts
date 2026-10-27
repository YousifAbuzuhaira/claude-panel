import type { TestRun } from '../types'

/** The last run's total, while this run hasn't gone past it (then it was wrong: a partial run, or more tests now). */
const usableEstimate = (run: TestRun) => (run.estimate !== null && run.estimate > 0 && run.done <= run.estimate ? run.estimate : null)

/** How full a test run's bar is: exact, capped below full on an estimate, or unknown. */
export function runRatio(run: TestRun): number | null {
  if (run.total !== null && run.total > 0) return run.done / run.total
  const estimate = usableEstimate(run)
  if (estimate !== null) return Math.min(run.done / estimate, 0.99)
  return null
}

/** `42/120`, `42/~120` on an estimate, or `42` with nothing to go on. */
export function runCount(run: TestRun): string {
  if (run.total !== null) return `${run.done}/${run.total}`
  const estimate = usableEstimate(run)
  if (estimate !== null) return `${run.done}/~${estimate}`
  return `${run.done}`
}

/** All the runs on the Tests tab together: how many tests ran, passed and failed. */
export function runTotals(runs: readonly TestRun[]): { runs: number; tests: number; passed: number; failed: number } {
  return {
    runs: runs.length,
    tests: runs.reduce((n, run) => n + run.done, 0),
    passed: runs.reduce((n, run) => n + run.passed, 0),
    failed: runs.reduce((n, run) => n + run.failed, 0),
  }
}
