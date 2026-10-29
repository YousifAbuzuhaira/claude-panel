import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PhasePlan, TestRun } from '../types'
import { isLearnBusy, learnStatusPath, readLearnStatus } from './learn'
import type { LearnStatus } from './learn'
import {
  bar, buildColor, buildRatio, collapsedLine, frontTab, GAMES, isGame, learnLabel, PANE_ID, phasesLabel, runMark,
  statusLine, testsFooter, testsLabel,
} from './pane'
import type { Tab } from './pane'
import { runCount, runRatio } from './format'
import { emptyProgress, feed, hasFailed } from './parse'
import { describePlan, PHASES_GUIDE, PHASES_TOOL_SCHEMA, readPhasesInput } from './phases'
import { macPanelArgv, panelState, readAppPath, readEvents, widgetArgv, widgetStatePath, WINDOW_SCRIPTS, windowArgv } from './widget'
import type { WidgetEvent } from './widget'
import { isTestCommand, runKey, shortLabel, wrapCommand } from './wrap'

// Everything shows in one place: on WezTerm-on-WSL, the floating panel over the
// chat's WezTerm window (widget/PhasesWidget.ps1); anywhere else (macOS, Linux, any
// terminal), a Claude Code pane drawn here, with the same Phases, Tests and Learn tabs.
// Learn and the games open in the browser from web/server.mjs, wherever there is no WPF.

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
// The pane (off WezTerm-on-WSL): the tab in front, and the newest run it has seen.
let paneTab: Tab = 'phases'
let lastFocus: string | null = null
let isPaneOpen = false
let lastPlanTitle: string | null = null
// macOS: whether this is a Mac that can draw the floating panel (else the pane).
let isMacHost: Promise<boolean> | null = null

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
  $.ui.status(undefined)
  if (isPaneOpen) {
    isPaneOpen = false
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  }
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

  // Contract 1: the state file is written on every setup, for any panel to read.
  const sessionId = await $.session.id()
  await $.fs.write(widgetStatePath(sessionId), panelState(sessionId, plan, runs, learn))

  const distro = await panelDistro($)
  if (distro === null) {
    if (!(await macHost($)) || (hasPanelFailed && panel === null)) {
      await syncPane($, plan, runs)
      return
    }
    // The floating panel over the terminal, as on WezTerm-on-WSL; the status line too.
    $.ui.status(statusLine(plan, runs, learn))
    if (isPaneOpen) {
      isPaneOpen = false
      await $.ui.close({ id: PANE_ID }).catch(() => undefined)
    }
    if (panel === null && !isDismissed) {
      // Looked up at each start, so a changed window app is built and used without a reload.
      const binary = await macPanelBinary($)
      if (binary === null) {
        isMacHost = Promise.resolve(false)
        await syncPane($, plan, runs)
        return
      }
      const [terminal, itermSession] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('ITERM_SESSION_ID')])
      const argv = macPanelArgv({ binary, pluginRoot: $.plugin.root, sessionId, terminal, itermSession })
      panel = { stop: () => undefined, isReady: false }
      panel.stop = launchPanel($, argv, event => void onPanelEvent($, event).catch(() => undefined))
    }
    return
  }

  if (panel === null && !isDismissed && !hasPanelFailed) {
    const root = await $.session.root().catch(() => undefined)
    const argv = widgetArgv({ distro, pluginRoot: $.plugin.root, sessionId, title: sessionTitle, root })
    panel = { stop: () => undefined, isReady: false }
    panel.stop = launchPanel($, argv, event => void onPanelEvent($, event).catch(() => undefined))
  }
}

// --- The pane (every setup but WezTerm on WSL) -------------------------------------------

/** Keeps the status line and the pane's front tab current, and opens the pane for something new. */
async function syncPane($: EngineInterface, plan: PhasePlan | null, runs: readonly TestRun[]) {
  // A new plan comes to the front, as a new run does.
  const planTitle = plan && plan.items.length > 0 ? plan.title : null
  if (planTitle !== null && planTitle !== lastPlanTitle) paneTab = 'phases'
  lastPlanTitle = planTitle
  paneTab = frontTab({ current: paneTab, plan, runs, learn, lastFocus })
  lastFocus = runs.at(-1)?.id ?? null
  $.ui.status(statusLine(plan, runs, learn))
  if (isDismissed && !isPinned) return
  if (!isPaneOpen) {
    isPaneOpen = true
    await $.ui.open({ id: PANE_ID, title: 'Progress', rows: 12 }).catch(() => {
      isPaneOpen = false
    })
  }
  $.ui.invalidate('ui.render')
}

/** Opens Learn or a game: its WPF window on WSL (any terminal), else the browser page from web/server.mjs. */
async function openPage($: EngineInterface, page: string): Promise<string> {
  const distro = await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)
  const script = WINDOW_SCRIPTS[page]
  if (distro && script) {
    try {
      const argv = windowArgv({ distro, pluginRoot: $.plugin.root, script, sessionId: await $.session.id() })
      // Detached: the window stays when the session ends, as the panel's own launches do.
      await $.process.run(['bash', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'open-window', ...argv])
      return `Opening ${script.replace('.ps1', '')}.`
    } catch (error) {
      return `Couldn't open it: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    // The window sticks to this session's terminal window (macOS).
    const [terminal, itermSession] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('ITERM_SESSION_ID')])
    const follow = terminal ? ['--terminal', terminal, '--iterm-session', itermSession ?? ''] : []
    const ran = await $.process.run(['bash', `${$.plugin.root}/web/web.sh`, 'open', page, ...follow])
    const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; url?: string; error?: string; shown?: string }
    if (answer.ok && answer.shown === 'window') return `Opened ${page === 'learn' ? 'Learn' : page.replace('games/', '')} in its own window.`
    if (answer.ok && answer.url) return `Opened ${answer.url} in your browser.`
    return `Couldn't open it: ${answer.error ?? (ran.stderr.trim() || 'no answer')}`
  } catch (error) {
    return `Couldn't open it: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** A Mac, where the floating panel is the window app (unless CLAUDE_PANEL_PANE=1 asks for the pane). */
function macHost($: EngineInterface): Promise<boolean> {
  isMacHost ??= (async () => {
    try {
      if ((await $.env.get('CLAUDE_PANEL_PANE').catch(() => undefined)) === '1') return false
      return (await $.process.run(['uname', '-s'])).stdout.trim() === 'Darwin'
    } catch {
      return false
    }
  })()
  return isMacHost
}

/** The floating panel's binary, built by web.sh with swiftc when missing or changed; null without Swift. */
async function macPanelBinary($: EngineInterface): Promise<string | null> {
  try {
    const ran = await $.process.run(['bash', `${$.plugin.root}/web/web.sh`, 'app-path'])
    return readAppPath(ran.stdout)
  } catch {
    return null
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
  if (isPaneOpen) $.ui.invalidate('ui.render')
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
      name: 'learn',
      description: 'Open Learn: courses built from free videos and docs by your own Claude',
      immediate: true,
    })
    await $.command.register({
      name: 'games',
      description: 'Open a game while Claude works: sudoku, 2048, typing or chess',
      argumentHint: '[sudoku|2048|typing|chess]',
      immediate: true,
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
    // The wrapper parses in bash and zsh (macOS's default) alike.
    const isKnownShell = /(^|\/)(bash|zsh)$/.test((await $.env.get('SHELL')) ?? '')
    if (!isKnownShell || !isTestCommand(e.command)) return next(e)

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
    if ((await panelDistro($)) === null && panel === null) {
      // No floating panel here (or it failed): the pane, opened from the person's own command, seats at any width.
      isPaneOpen = true
      const opened = await $.ui.open({ id: PANE_ID, title: 'Progress', rows: 12 })
      if (!opened.isPlaced) return { text: `The progress pane is open but not drawn yet (${opened.reason}).` }
    } else if (panel === null) return { text: 'The floating panel could not start. /phases tries again.' }
    const plan = await read($, phases)
    const runs = await read($, testRuns)
    if (plan === null && runs.length === 0) return { text: 'Panel opened, empty for now: it fills with a plan or a test run. Its ✕ closes it.' }

    return { text: plan ? describePlan(plan) : 'Showing the test runs.' }
  })

  on('command.run', { command: 'learn' }, async $ => ({ text: await openPage($, 'learn') }))

  on('command.run', { command: 'games' }, async ($, e) => {
    const name = e.args.trim().toLowerCase()
    if (!name) return { text: `Games: ${GAMES.map(game => game.id).join(', ')}. Try /games sudoku.` }
    if (!isGame(name)) return { text: `No game called "${name}". Games: ${GAMES.map(game => game.id).join(', ')}.` }
    return { text: await openPage($, `games/${name}`) }
  })

  // ✕ on the pane means what ✕ on the floating panel means: hidden until something new.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    isPaneOpen = false
    if (e.origin.kind === 'person') {
      isDismissed = true
      isPinned = false
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const plan = await read($, phases)
    const runs = await read($, testRuns)
    const isInline = e.props.placement === 'inline'
    const ROOM = isInline ? 6 : 40
    const show = (tab: Tab) => () => {
      paneTab = tab
      $.ui.invalidate('ui.render')
    }
    const open = (page: string) => () => {
      void openPage($, page).then(text => $.ui.toast(text))
    }

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab:phases" plain={paneTab === 'phases' ? undefined : true} variant={paneTab === 'phases' ? 'primary' : undefined} onPress={show('phases')}>
          {phasesLabel(plan)}
        </Button>
        <Button key="tab:tests" plain={paneTab === 'tests' ? undefined : true} variant={paneTab === 'tests' ? 'primary' : undefined} onPress={show('tests')}>
          {testsLabel(runs)}
        </Button>
        <Button key="tab:learn" plain={paneTab === 'learn' ? undefined : true} variant={paneTab === 'learn' ? 'primary' : undefined} onPress={show('learn')}>
          {learnLabel(learn)}
        </Button>
      </Box>
    )

    let body
    if (paneTab === 'tests') {
      const newest = [...runs].reverse()
      body = (
        <Box flexDirection="column">
          {newest.length === 0 && <Text dimColor>No test runs yet.</Text>}
          {newest.slice(0, isInline ? 2 : newest.length).map(run => {
            const mark = runMark(run)
            return (
              <Box key={`run:${run.id}`} flexDirection="column">
                <Text>
                  <Text color={mark.color}>{mark.glyph}</Text> <Text bold>{run.label}</Text>
                </Text>
                <Text>
                  {'  '}
                  <Text color={mark.color ?? 'claude'}>{bar(runRatio(run))}</Text> {runCount(run)}  <Text color="success">✓{run.passed}</Text>
                  {run.failed > 0 && <Text color="error"> ✗{run.failed}</Text>}
                </Text>
              </Box>
            )
          })}
          {runs.length > 0 && <Text dimColor>{testsFooter(runs)}</Text>}
        </Box>
      )
    } else if (paneTab === 'learn') {
      const build = learn?.build
      const course = learn?.course
      body = (
        <Box flexDirection="column">
          {build && (
            <Text>
              <Text bold color={buildColor(build)}>{build.topic}</Text> <Text dimColor>{build.message}</Text>
            </Text>
          )}
          {build && build.total > 0 && (
            <Text>
              <Text color={buildColor(build)}>{bar(buildRatio(build))}</Text> {build.done}/{build.total} pages
            </Text>
          )}
          {course && <Text bold>{course.title}</Text>}
          {course && <Text dimColor>Page {course.page} of {course.total}{course.next ? ` · next: ${course.next}` : ''}</Text>}
          {!build && !course && <Text dimColor>Courses from free videos and docs, written by your own Claude.</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="open:learn" variant="primary" onPress={open('learn')}>{course ? 'Carry on reading' : 'Open Learn'}</Button>
            {GAMES.map(game => (
              <Button key={`game:${game.id}`} onPress={open(`games/${game.id}`)}>{game.label}</Button>
            ))}
          </Box>
        </Box>
      )
    } else if (plan === null || plan.items.length === 0) {
      body = <Text dimColor>No plan yet.</Text>
    } else {
      const now = plan.items.findIndex(item => item.status !== 'done')
      const first = isInline ? Math.max(0, Math.min(now, plan.items.length - ROOM)) : 0
      const shown = plan.items.slice(first, first + ROOM)
      const { done, total } = { done: plan.items.filter(item => item.status === 'done').length, total: plan.items.length }
      body = (
        <Box flexDirection="column">
          <Text bold>{plan.title}</Text>
          {shown.map((item, i) => (
            <Text key={`item:${first + i}`}>
              {item.status === 'done' && <Text color="success">[✓] </Text>}
              {item.status === 'done' && <Text dimColor>{item.name}</Text>}
              {item.status === 'in_progress' && <Text bold color="claude">[▸] {item.name}</Text>}
              {item.status === 'todo' && <Text>[ ] {item.name}</Text>}
            </Text>
          ))}
          <Text dimColor>{done} of {total} done</Text>
        </Box>
      )
    }

    if (isInline && (e.viewport?.rows ?? 24) < 16) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text>{collapsedLine(paneTab, plan, runs, learn)}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
      </Box>
    )
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
