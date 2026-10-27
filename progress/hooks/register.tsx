import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { TestRun } from '../types'
import { isLearnBusy, learnStatusPath, readLearnStatus } from './learn'
import type { LearnStatus } from './learn'
import { emptyProgress, feed, hasFailed } from './parse'
import { describePlan, PHASES_GUIDE, PHASES_TOOL_SCHEMA, readPhasesInput } from './phases'
import { panelState, readEvents, widgetArgv, widgetStatePath } from './widget'
import type { WidgetEvent } from './widget'
import { isTestCommand, runKey, shortLabel, wrapCommand } from './wrap'

// Everything shows in one place: the floating panel over the chat's WezTerm
// window (widget/PhasesWidget.ps1), a Phases tab and a Tests tab.

const LOG_ROOT = '/tmp/claude-progress'
const POLL_MS = 500
const QUIET_AFTER_EXIT_MS = 5_000
const IDLE_LIMIT_MS = 15 * 60_000
const RUNS_KEPT = 4
const TOTALS_KEY = 'totals'
const TOTALS_KEPT = 100
const LEARN_POLL_MS = 3_000

const testRuns = atom({ plugin: 'progress', key: 'testRuns' } as const, [])
const phases = atom({ plugin: 'progress', key: 'phases' } as const, null)

type Totals = Record<string, number>

async function rememberedTotal($: EngineInterface, key: string): Promise<number | null> {
  const totals = (await $.store.get(TOTALS_KEY)) as Totals | undefined
  const total = totals?.[key]

  return typeof total === 'number' && total > 0 ? total : null
}

async function rememberTotal($: EngineInterface, key: string, total: number): Promise<void> {
  const totals: Totals = { ...((await $.store.get(TOTALS_KEY)) as Totals | undefined) }
  delete totals[key]
  totals[key] = total
  const keys = Object.keys(totals)
  for (const old of keys.slice(0, Math.max(0, keys.length - TOTALS_KEPT))) delete totals[old]
  await $.store.set(TOTALS_KEY, totals)
}

// --- The panel ------------------------------------------------------------------

// Module state: a reload ends the child, and session.start shows the panel again.
let panel: { stop: () => void; isReady: boolean } | null = null
let isDismissed = false
let hasPanelFailed = false
let hasToldNoPanel = false
// /phases opened it by hand: it stays up even with nothing to show, until ✕.
let isPinned = false
let sessionTitle: string | undefined
// Claude runs started by Learn's helper set CLAUDE_PROGRESS_OFF=1: the mod stays out of them.
let isOff = false
// What Learn's helper last wrote: a build going on, the course in front.
let learn: LearnStatus | null = null
let learnText = ''
let learnTimer: Timer | null = null
let syncing: Promise<void> = Promise.resolve()

/** The WezTerm-on-WSL distro the panel runs from; null anywhere else. */
async function panelDistro($: EngineInterface): Promise<string | null> {
  try {
    const [terminal, distro] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('WSL_DISTRO_NAME')])
    return terminal === 'WezTerm' && distro ? distro : null
  } catch {
    return null
  }
}

/** Runs the panel as a child for the session's life; its end is `exited`. */
function launchPanel($: EngineInterface, argv: string[], onEvent: (event: WidgetEvent) => void) {
  const child = $.process.spawn({ argv })
  let isStopped = false

  void (async () => {
    let pending = ''
    try {
      for await (const { stream, text } of child) {
        if (isStopped) break
        if (stream !== 'stdout') continue
        const read = readEvents(pending, text)
        pending = read.pending
        for (const event of read.events) onEvent(event)
      }
    } catch {
      // it could not start, or its relay went: either way it is gone
    }
    onEvent({ event: 'exited' })
  })()

  return () => {
    isStopped = true
    void child.return({ code: null, signal: null }).catch(() => undefined)
  }
}

async function stopPanel($: EngineInterface) {
  panel?.stop()
  panel = null
  try {
    // The panel also leaves on its own within two seconds of its file going.
    await $.process.run(['rm', '-f', widgetStatePath(await $.session.id())])
  } catch {
    // nothing written for this session
  }
}

async function onPanelEvent($: EngineInterface, event: WidgetEvent) {
  if (event.event === 'ready') {
    if (panel) panel.isReady = true
  } else if (event.event === 'closed') {
    // ✕: hidden until something new happens (a new plan, a new test run, /phases).
    isDismissed = true
    isPinned = false
  } else if (event.event === 'exited' || event.event === 'error') {
    const wasReady = panel?.isReady === true
    panel = null
    if (!wasReady && !hasPanelFailed) {
      hasPanelFailed = true
      $.ui.toast(`progress: the floating panel couldn't start${event.message ? ` (${event.message})` : ''}. /phases tries again.`)
    }
  }
}

/** Writes what the panel shows and starts it when needed; one sync at a time. */
function syncPanel($: EngineInterface): Promise<void> {
  syncing = syncing.then(() => doSyncPanel($)).catch(() => undefined)
  return syncing
}

async function doSyncPanel($: EngineInterface) {
  const plan = await read($, phases)
  const runs = await read($, testRuns)
  const hasPlan = plan !== null && plan.items.length > 0
  if (!hasPlan && runs.length === 0 && !isPinned && !isLearnBusy(learn)) {
    await stopPanel($)
    return
  }

  const distro = await panelDistro($)
  if (distro === null) {
    if (!hasToldNoPanel) $.ui.toast('progress: the floating panel needs WezTerm on WSL.')
    hasToldNoPanel = true
    return
  }

  const sessionId = await $.session.id()
  await $.fs.write(widgetStatePath(sessionId), panelState(sessionId, plan, runs, learn))
  if (panel === null && !isDismissed && !hasPanelFailed) {
    const root = await $.session.root().catch(() => undefined)
    const argv = widgetArgv({ distro, pluginRoot: $.plugin.root, sessionId, title: sessionTitle, root })
    panel = { stop: () => undefined, isReady: false }
    panel.stop = launchPanel($, argv, event => void onPanelEvent($, event).catch(() => undefined))
  }
}

/** Picks up Learn's status file; a change redraws the panel's Learn tab. */
async function pollLearn($: EngineInterface) {
  let text = ''
  try {
    const home = await $.env.get('HOME')
    if (home) text = await $.fs.read(learnStatusPath(home))
  } catch {
    // Learn has never run here
  }
  if (text === learnText) return
  learnText = text
  learn = text ? readLearnStatus(text, await $.clock.now()) : null
  await syncPanel($)
}

// --- Test runs --------------------------------------------------------------------

const dropRun = async ($: EngineInterface, id: string) => {
  await update($, testRuns, list => list.filter(one => one.id !== id))
  await syncPanel($)
}

type Tracker = {
  /** The command ended: read the rest of the log and settle the run. */
  finish: (fallbackText: string | undefined, isError: boolean) => Promise<void>
  /** The command went to the background: settle once its runners exit. */
  finishOnExit: () => void
  /** The call never ran: drop the run without a trace. */
  cancel: () => Promise<void>
}

/** Polls a run's log on a timer and keeps its row in `testRuns` and the panel current. */
function trackRun($: EngineInterface, run: { id: string; log: string; key: string }): Tracker {
  let progress = emptyProgress()
  let consumed = 0
  let lastGrowth = 0
  let isFinished = false
  let isBackground = false
  let queue: Promise<void> = Promise.resolve()

  // Polls and the finish run one at a time, so no text is read twice.
  const serial = (step: () => Promise<void>) => (queue = queue.then(step, step))

  const publish = async (fields: Partial<TestRun>) => {
    await update($, testRuns, list => list.map(one => (one.id === run.id ? { ...one, ...fields } : one)))
    await syncPanel($)
  }

  const removeLog = () => void $.process.run(['rm', '-f', run.log]).catch(() => undefined)

  // Whole lines only while the run goes on: the read may end inside a line.
  const readLog = async (isFinal: boolean): Promise<boolean> => {
    let text: string
    try {
      text = await $.fs.read(run.log)
    } catch {
      return false
    }
    const end = isFinal ? text.length : text.lastIndexOf('\n') + 1
    if (end <= consumed) return false
    progress = feed(progress, text.slice(consumed, end))
    consumed = end

    return true
  }

  // A finished run stays on the Tests tab, with the few before it.
  const settle = async (fallbackText: string | undefined, isError: boolean) => {
    if (isFinished) return
    isFinished = true
    timer.cancel()
    await readLog(true)
    removeLog()

    if (progress.done === 0 && progress.summary === null && fallbackText) {
      progress = feed(emptyProgress(), fallbackText)
    }
    if (progress.done === 0 && progress.summary === null) {
      await dropRun($, run.id)
      return
    }

    const { summary } = progress
    const counts = summary
      ? { done: summary.total, total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped }
      : { done: progress.done, total: progress.done, passed: progress.passed, failed: progress.failed, skipped: progress.skipped }
    await publish({ ...counts, status: hasFailed(progress) || isError ? 'failed' : 'passed' })
    if (progress.done > 0 && run.key) await rememberTotal($, run.key, progress.done)
  }

  const poll = async () => {
    if (isFinished) return
    const now = await $.clock.now()
    if (lastGrowth === 0) lastGrowth = now

    if (await readLog(false)) {
      lastGrowth = now
      await publish({
        done: progress.done,
        passed: progress.passed,
        failed: progress.failed,
        skipped: progress.skipped,
        total: progress.announced,
      })
      return
    }

    const quiet = now - lastGrowth
    const hasExited = isBackground && progress.exits.length > 0 && quiet > QUIET_AFTER_EXIT_MS
    if (hasExited || quiet > IDLE_LIMIT_MS) await settle(undefined, false)
  }

  const timer: Timer = $.clock.every(POLL_MS, () => void serial(poll))

  return {
    finish: (fallbackText, isError) => serial(() => settle(fallbackText, isError)),
    finishOnExit: () => {
      isBackground = true
    },
    cancel: () =>
      serial(async () => {
        isFinished = true
        timer.cancel()
        removeLog()
        await dropRun($, run.id)
      }),
  }
}

/**
 * A reload ends the timers but not the test commands: their output still goes
 * to their logs. Pick each run still going up again, reading its log from the
 * start; one whose log is gone is settled as it stands.
 */
async function resumeRuns($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const running = (await read($, testRuns)).filter(run => run.status === 'running')
  for (const run of running) {
    const log = run.log ?? `${LOG_ROOT}/${sessionId}/${run.id.replace(/[^\w-]/g, '_')}.log`
    const isLive = await $.fs.read(log).then(
      () => true,
      () => false,
    )
    if (!isLive) {
      await update($, testRuns, list =>
        list.map(one => (one.id === run.id ? { ...one, status: (one.failed > 0 ? 'failed' : 'passed') as TestRun['status'], total: one.done } : one)),
      )
      continue
    }
    trackRun($, { id: run.id, log, key: run.key ?? '' }).finishOnExit()
  }
  if (running.length) await syncPanel($)
}

// --- Hooks ------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isOff = (await $.env.get('CLAUDE_PROGRESS_OFF').catch(() => undefined)) === '1'
    if (isOff) return next(e)

    await $.tool.register({
      name: 'phases_write',
      description:
        "Track the phases of a multi-phase task in the person's floating progress panel. Send the full list every time; an empty list clears it.",
      inputSchema: PHASES_TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'phases',
      description: 'Open the floating progress panel, empty or not (/phases clear empties and closes it)',
      argumentHint: '[clear]',
      immediate: true,
    })

    const started = await next(e)
    void syncPanel($)
    void resumeRuns($).catch(() => undefined)
    learnTimer?.cancel()
    learnTimer = $.clock.every(LEARN_POLL_MS, () => void pollLearn($).catch(() => undefined))
    void pollLearn($).catch(() => undefined)

    return started
  })

  // The session's title names its WezTerm pane: the panel finds its pane by it.
  on('classic.SessionStart', ($, e, next) => {
    if (e.session_title) sessionTitle = e.session_title
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', ($, e, next) => {
    if (e.session_title) sessionTitle = e.session_title
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (isOff || !e.tools.includes('mcp__progress__phases_write')) return composed

    return {
      sections: [...composed.sections, { id: 'progress:phases', text: PHASES_GUIDE, scope: 'session' as const }],
    }
  })

  // A test command runs with its runners shadowed so their output also lands
  // in a log, which a timer reads to move the panel's Tests tab.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isOff) return next(e)
    const isBash = /(^|\/)bash$/.test((await $.env.get('SHELL')) ?? '')
    if (!isBash || !isTestCommand(e.command)) return next(e)

    const id = e.tool_use_id ?? `run-${await $.clock.now()}`
    const log = `${LOG_ROOT}/${await $.session.id()}/${id.replace(/[^\w-]/g, '_')}.log`
    const key = runKey(e.command)
    await $.fs.write(log, '')

    const run: TestRun = {
      id,
      label: shortLabel(e.command),
      isSubagent: e.agentId !== undefined,
      status: 'running',
      done: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: null,
      estimate: await rememberedTotal($, key),
      log,
      key,
    }
    await update($, testRuns, list => [...list.filter(one => one.id !== id).slice(-(RUNS_KEPT - 1)), run])
    isDismissed = false
    await syncPanel($)
    const tracker = trackRun($, { id, log, key })

    const ran = await next({ ...e, command: wrapCommand(e.command, log) })
    if (ran.deny !== undefined) {
      await tracker.cancel()
      return ran
    }

    const record = ran.result as { backgroundTaskId?: unknown } | undefined
    if (typeof record?.backgroundTaskId === 'string') tracker.finishOnExit()
    else await tracker.finish(ran.text, ran.isError === true)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__progress__phases_write' }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Phases are tracked by the main session; nothing changed.' }

    const input = readPhasesInput(e as unknown as Record<string, unknown>)
    if ('error' in input) return { deny: input.error }

    if (input.items.length === 0) {
      await update($, phases, () => null)
      await syncPanel($)
      return { result: 'Phases cleared.' }
    }

    const previous = await read($, phases)
    if (previous === null || previous.title !== input.title) isDismissed = false
    await update($, phases, () => input)
    await syncPanel($)

    return { result: describePlan(input) }
  }).catch(() => ({ deny: 'The phases tracker failed; carry on without it.' }))

  on('command.run', { command: 'phases' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      isPinned = false
      await update($, phases, () => null)
      await update($, testRuns, () => [])
      await syncPanel($)
      return { text: 'Progress panel cleared.' }
    }

    isDismissed = false
    hasPanelFailed = false
    isPinned = true
    await syncPanel($)
    if (panel === null) return { text: 'The panel could not open here: it needs WezTerm on WSL.' }
    const plan = await read($, phases)
    const runs = await read($, testRuns)
    if (plan === null && runs.length === 0) return { text: 'Panel opened, empty for now: it fills with a plan or a test run. Its ✕ closes it.' }

    return { text: plan ? describePlan(plan) : 'Showing the test runs.' }
  })

  on('session.end', async ($, e, next) => {
    if (isOff) return next(e)
    learnTimer?.cancel()
    learnTimer = null
    isPinned = false
    await stopPanel($)
    if (e.reason === 'clear') {
      await update($, phases, () => null)
      await update($, testRuns, () => [])
    }

    return next(e)
  })
}
