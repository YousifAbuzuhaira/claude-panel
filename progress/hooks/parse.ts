// Reads a test run's output line by line: vitest's non-TTY reporter, node's
// TAP (what `node --test` prints when not on a terminal), playwright's list
// reporter, and a custom suite's own ` ✓ check` / ` ✗ check` lines. Live
// lines move the counts; summary lines are the final word.

export type Counts = { total: number; passed: number; failed: number; skipped: number }

export type Progress = {
  /** Units finished so far: tests for vitest and playwright, top-level tests for TAP. */
  done: number
  passed: number
  failed: number
  skipped: number
  /** A total printed before the results: playwright's, a TAP plan up front, or a suite's own `Running N checks`. */
  announced: number | null
  /** What the runners' summaries added up to, once one printed. */
  summary: Counts | null
  /** The exit status of each wrapped runner that ended. */
  exits: number[]
  /** The runner the output came from, once a line gave it away; null for a custom suite. */
  runner: 'vitest' | 'tap' | 'playwright' | null
}

export const emptyProgress = (): Progress => ({
  done: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  announced: null,
  summary: null,
  exits: [],
  runner: null,
})

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// `pkg:test: ` (turbo) or `packages/x test: ` (pnpm -r) ahead of a line.
const RUNNER_PREFIX = /^(?:[^\s:]+:[^\s:]*: |[^\s:]+ [^\s:]+: )/

const VITEST_FILE = /[✓❯×↓]\s+\S+\s+\((\d+) tests?((?:\s*\|\s*\d+ [a-z]+)*)\)/
const VITEST_TESTS = /\bTests\s+((?:\d+ [a-z]+(?:\s*\|\s*)?)+)\s*\((\d+)\)/
const TAP_RESULT = /^(not )?ok \d+\b(.*)$/
const TAP_COUNT = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/
const PLAYWRIGHT_RUNNING = /\bRunning (\d+) tests? using \d+ workers?/
const ANNOUNCED = /\bRunning (\d+) (?:checks?|tests?|specs?|cases?)\b/i
const TAP_PLAN = /^1\.\.(\d+)$/
const PLAYWRIGHT_RESULT = /^\s*([✓✘-])\s+\d+ \[/
const PLAYWRIGHT_COUNT = /^\s+(\d+) (passed|failed|flaky|skipped)\b/
const EXIT = /^\x1e@kp-exit (\d+)$/
const VITEST_HEADER = /\bRUN\s+v\d/
const TAP_HEADER = /^TAP version \d+/
const CHECK = /^\s*([✓✔✗✘✖×])\s+\S/
const PASS_MARKS = new Set(['✓', '✔'])

function namedCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [, n, word] of text.matchAll(/(\d+) ([a-z]+)/g)) {
    counts[word ?? ''] = (counts[word ?? ''] ?? 0) + Number(n)
  }

  return counts
}

function addSummary(progress: Progress, add: Partial<Counts>): Progress {
  const was = progress.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0 }

  return {
    ...progress,
    summary: {
      total: was.total + (add.total ?? 0),
      passed: was.passed + (add.passed ?? 0),
      failed: was.failed + (add.failed ?? 0),
      skipped: was.skipped + (add.skipped ?? 0),
    },
  }
}

function readLine(progress: Progress, raw: string): Progress {
  const exit = EXIT.exec(raw)
  if (exit) return { ...progress, exits: [...progress.exits, Number(exit[1])] }

  const line = raw.replace(ANSI, '').replace(RUNNER_PREFIX, '')

  if (VITEST_HEADER.test(line)) return { ...progress, runner: 'vitest' }
  if (TAP_HEADER.test(line)) return { ...progress, runner: progress.runner ?? 'tap' }

  const file = VITEST_FILE.exec(line)
  if (file) {
    const tests = Number(file[1])
    const parts = namedCounts(file[2] ?? '')
    const failed = parts.failed ?? 0
    const skipped = (parts.skipped ?? 0) + (parts.todo ?? 0)
    return {
      ...progress,
      runner: 'vitest',
      done: progress.done + tests,
      passed: progress.passed + Math.max(0, tests - failed - skipped),
      failed: progress.failed + failed,
      skipped: progress.skipped + skipped,
    }
  }

  const tests = VITEST_TESTS.exec(line)
  if (tests) {
    const parts = namedCounts(tests[1] ?? '')
    return addSummary(progress, {
      total: Number(tests[2]),
      passed: parts.passed ?? 0,
      failed: parts.failed ?? 0,
      skipped: (parts.skipped ?? 0) + (parts.todo ?? 0),
    })
  }

  const tap = TAP_RESULT.exec(line)
  if (tap) {
    const isSkip = /#\s*(SKIP|TODO)\b/i.test(tap[2] ?? '')
    return {
      ...progress,
      done: progress.done + 1,
      passed: progress.passed + (tap[1] || isSkip ? 0 : 1),
      failed: progress.failed + (tap[1] && !isSkip ? 1 : 0),
      skipped: progress.skipped + (isSkip ? 1 : 0),
    }
  }

  // A plan before any result is a total announced up front (node prints its plan at the end).
  const plan = TAP_PLAN.exec(line)
  if (plan && progress.done === 0) return { ...progress, announced: Number(plan[1]) }

  const tapCount = TAP_COUNT.exec(line)
  if (tapCount) {
    const n = Number(tapCount[2])
    switch (tapCount[1]) {
      case 'tests': return addSummary(progress, { total: n })
      case 'pass': return addSummary(progress, { passed: n })
      case 'fail':
      case 'cancelled': return addSummary(progress, { failed: n })
      default: return addSummary(progress, { skipped: n })
    }
  }

  const running = PLAYWRIGHT_RUNNING.exec(line)
  if (running) return { ...progress, runner: 'playwright', announced: (progress.announced ?? 0) + Number(running[1]) }

  const announced = progress.runner === null ? ANNOUNCED.exec(line) : null
  if (announced) return { ...progress, announced: (progress.announced ?? 0) + Number(announced[1]) }

  if (progress.announced !== null) {
    const result = PLAYWRIGHT_RESULT.exec(line)
    if (result) {
      return {
        ...progress,
        done: progress.done + 1,
        passed: progress.passed + (result[1] === '✓' ? 1 : 0),
        failed: progress.failed + (result[1] === '✘' ? 1 : 0),
        skipped: progress.skipped + (result[1] === '-' ? 1 : 0),
      }
    }
    const count = PLAYWRIGHT_COUNT.exec(line)
    if (count) {
      const n = Number(count[1])
      const kind = count[2]
      return addSummary(progress, {
        total: n,
        passed: kind === 'passed' || kind === 'flaky' ? n : 0,
        failed: kind === 'failed' ? n : 0,
        skipped: kind === 'skipped' ? n : 0,
      })
    }
  }

  // A custom suite's own check lines; a known runner's are read above.
  const check = progress.runner === null ? CHECK.exec(line) : null
  if (check) {
    const isPass = PASS_MARKS.has(check[1] ?? '')
    return {
      ...progress,
      done: progress.done + 1,
      passed: progress.passed + (isPass ? 1 : 0),
      failed: progress.failed + (isPass ? 0 : 1),
    }
  }

  return progress
}

/** Feeds whole lines; a caller keeps any unfinished last line for later. */
export function feed(progress: Progress, text: string): Progress {
  return text.split('\n').reduce(readLine, progress)
}

/**
 * True when the run failed: by its summary (else its live counts), or by a
 * runner's exit status, which also catches a file that failed to load.
 */
export function hasFailed(progress: Progress): boolean {
  const failed = progress.summary?.failed ?? progress.failed

  return failed > 0 || progress.exits.some(code => code !== 0)
}
