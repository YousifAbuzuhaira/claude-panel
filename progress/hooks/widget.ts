// The floating panel: a small Windows window (widget/PhasesWidget.ps1) owned
// by the chat's WezTerm window, with a Phases and a Tests tab. The mod writes
// the plan and the test runs to a file the panel reads, and runs the widget as a child for the session's life: ending
// the loop, or removing the file, ends the widget. Pure helpers only: the
// calls on `$` live in register.tsx.

import type { PhasePlan, TestRun } from '../types'
import { runCount, runRatio, runTotals } from './format'
import type { LearnStatus } from './learn'
import { phaseCounts } from './phases'

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const STATE_ROOT = '/tmp/claude-progress'

export type WidgetEvent = {
  event: 'ready' | 'closed' | 'alive' | 'duplicate' | 'error' | 'exited'
  message?: string
}

/** A WSL path as Windows reaches it: `\\wsl.localhost\<distro>\...`. */
export const windowsPath = (distro: string, path: string) =>
  `\\\\wsl.localhost\\${distro}${path.replaceAll('/', '\\')}`

export const widgetStatePath = (sessionId: string) => `${STATE_ROOT}/${sessionId}/phases.json`

/**
 * What the panel reads: the plan with its counts, and the test runs drawn as
 * the panel draws them. `focus` names the newest run: when it changes, the
 * panel turns to its Tests tab. `totals` adds up the runs shown.
 */
export function panelState(sessionId: string, plan: PhasePlan | null, runs: readonly TestRun[], learn: LearnStatus | null = null): string {
  const hasPlan = plan !== null && plan.items.length > 0
  const counts = hasPlan ? phaseCounts(plan) : null
  return JSON.stringify({
    v: 2,
    sessionId,
    plan: hasPlan && counts ? { title: plan.title, items: plan.items, done: counts.done, total: counts.total } : null,
    runs: runs.map(run => ({
      id: run.id,
      label: run.isSubagent ? `agent: ${run.label}` : run.label,
      status: run.status,
      count: runCount(run),
      ratio: runRatio(run),
      passed: run.passed,
      failed: run.failed,
      skipped: run.skipped,
    })),
    focus: runs.at(-1)?.id ?? null,
    totals: runTotals(runs),
    learn,
  })
}

/** The command that starts the widget from WSL. */
export function widgetArgv(options: {
  distro: string
  pluginRoot: string
  sessionId: string
  title?: string
  root?: string
}): string[] {
  const { distro, pluginRoot, sessionId, title, root } = options
  const argv = [
    POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(distro, `${pluginRoot}/widget/PhasesWidget.ps1`),
    '-StateFile', windowsPath(distro, widgetStatePath(sessionId)),
    '-SessionId', sessionId,
  ]
  // An empty argument would not survive the trip to Windows: leave it out.
  if (title) argv.push('-Title', title)
  if (root) argv.push('-Root', root)

  return argv
}

/** Splits what the widget printed into events, keeping an unfinished last line. */
export function readEvents(pending: string, text: string): { events: WidgetEvent[]; pending: string } {
  const lines = (pending + text).split(/\r?\n/)
  const rest = lines.pop() ?? ''
  const events: WidgetEvent[] = []
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<WidgetEvent>
      if (typeof value.event === 'string') events.push(value as WidgetEvent)
    } catch {
      // not an event: the widget's own noise
    }
  }

  return { events, pending: rest }
}
