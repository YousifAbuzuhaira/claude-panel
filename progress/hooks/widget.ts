// The floating panel: a small Windows window (widget/PhasesWidget.ps1) owned
// by the chat's WezTerm window, with a Phases and a Tests tab. The mod writes
// the plan and the test runs to a file the panel reads, and runs the widget as a child for the session's life: ending
// the loop, or removing the file, ends the widget. Pure helpers only: the
// calls on `$` live in register.tsx.

import type { PhasePlan, TestRun } from '../types'
import { runCount, runRatio, runTotals } from './format'
import type { LearnStatus } from './learn'
import { LEARN_SCRIPT } from './pages'
import { phaseCounts } from './phases'

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const STATE_ROOT = '/tmp/claude-progress'

export type WidgetEvent = {
  event: 'ready' | 'closed' | 'alive' | 'duplicate' | 'error' | 'exited'
  message?: string
  /** On `ready` from the WPF panel: the WezTerm window it follows (PhasesWidget.ps1 Send-Event). */
  hwnd?: number
  paneId?: number
  guiPid?: number
}

/** The WezTerm window a `ready` names, for the windows /learn and /games open to follow; null when it names none. */
export function readOwnerHwnd(event: WidgetEvent): number | null {
  const hwnd = event.event === 'ready' ? event.hwnd : undefined
  return typeof hwnd === 'number' && Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null
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
export function panelState(
  sessionId: string,
  plan: PhasePlan | null,
  runs: readonly TestRun[],
  learn: LearnStatus | null = null,
  title?: string,
): string {
  const hasPlan = plan !== null && plan.items.length > 0
  const counts = hasPlan ? phaseCounts(plan) : null
  return JSON.stringify({
    v: 2,
    sessionId,
    // The chat's title, so a window that shows every chat (Learn's footer) can name each one.
    ...(title ? { title } : {}),
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

// A course id as Learn's helper writes it: safe to pass through bash and on to Windows unquoted.
const COURSE_ID = /^[\w.-]{1,80}$/

/**
 * The command that starts a game window, or Learn's launcher, from WSL, any
 * terminal. With `ownerHwnd` (the WezTerm window the panel reported) a game
 * follows it, as the panel's own launches do; `view` and `courseId` send Learn
 * to one of its views and a course (Learn.ps1 opens it in an Edge app window,
 * or sends the Learn already open there and brings it forward).
 */
export function windowArgv(options: {
  distro: string
  pluginRoot: string
  script: string
  sessionId: string
  ownerHwnd?: number | null
  view?: string
  courseId?: string
}): string[] {
  const { distro, pluginRoot, script, sessionId, ownerHwnd, view, courseId } = options
  const argv = [
    POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', windowsPath(distro, `${pluginRoot}/widget/${script}`),
    '-SessionId', sessionId,
  ]
  if (typeof ownerHwnd === 'number' && Number.isSafeInteger(ownerHwnd) && ownerHwnd > 0) argv.push('-OwnerHwnd', String(ownerHwnd))
  // Only Learn takes a view and a course: a game would refuse the unknown parameter and not open.
  if (script === LEARN_SCRIPT) {
    if (view) argv.push('-View', view)
    if (courseId && COURSE_ID.test(courseId)) argv.push('-CourseId', courseId)
  }

  return argv
}

/** The command that starts the floating panel on macOS: the window app (mac/ClaudePanel.swift) in panel mode. */
export function macPanelArgv(options: {
  binary: string
  pluginRoot: string
  sessionId: string
  terminal?: string
  itermSession?: string
}): string[] {
  const { binary, pluginRoot, sessionId, terminal, itermSession } = options
  const argv = [binary, '--panel', widgetStatePath(sessionId), '--html', `${pluginRoot}/mac/panel.html`, '--root', pluginRoot]
  if (terminal) argv.push('--terminal', terminal)
  if (itermSession) argv.push('--iterm-session', itermSession)

  return argv
}

/** The binary `web.sh app-path` printed, or null where the window app can't be built. */
export function readAppPath(stdout: string): string | null {
  try {
    const answer = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; binary?: unknown }
    return answer.ok && typeof answer.binary === 'string' ? answer.binary : null
  } catch {
    return null
  }
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
