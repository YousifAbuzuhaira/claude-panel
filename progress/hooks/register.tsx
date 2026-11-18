import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PhasePlan, TestRun } from '../types'
import { courseArgv, isLearnBusy, isLearnView, LEARN_VIEWS, learnStatusPath, readLearnStatus } from './learn'
import { EXPLAIN_TOOL, EXPLAIN_TOOL_DESCRIPTION, EXPLAIN_TOOL_SCHEMA, explainArgv, explainBrief, readExplainAnswer, refusalText } from './explain'
import type { LearnStatus } from './learn'
import { GAMES, isGame, openingText, windowScript } from './pages'
import {
  bar, buildColor, buildRatio, collapsedLine, fitReleases, fitRuns, fitTabs, frontTab, MARK_CELLS, PANE_ID, runMark,
  shortTabLabels, statusLine, TAB_GAP, tabLabels, testsFooter, UNSEEN_MARK, wrappedRows,
} from './pane'
import type { LiveTab, Tab } from './pane'
import { runCount, runRatio } from './format'
import { emptyProgress, feed, hasFailed } from './parse'
import { describePlan, PHASES_GUIDE, PHASES_TOOL_SCHEMA, readPhasesInput } from './phases'
import {
  isReleaseNew, isReleaseUnseen, lacksReleaseNote, laterVersion, newestRelease, readPluginVersion, readReleases, releaseLine,
  releasesLabel, releasesName, SEEN_RELEASE_KEY,
} from './releases'
import type { Release } from './releases'
import {
  macPanelArgv, panelState, readAppPath, readEvents, readOwnerHwnd, removeArgv, stateRoot, widgetArgv, widgetStatePath, windowArgv,
  windowsPowerShell, windowsTerminal,
} from './widget'
import type { WidgetEvent } from './widget'
import { isTestCommand, runKey, shortLabel, wrapCommand } from './wrap'

// Everything shows in one place: on WezTerm-on-WSL, the floating panel over the
// chat's WezTerm window (widget/PhasesWidget.ps1); on Windows itself (Claude Code with
// Git Bash), the same panel over WezTerm, Git Bash's mintty or Windows Terminal; on macOS
// the window app's panel; anywhere else (Linux, any other terminal), a Claude Code pane
// drawn here, with the same Phases, Tests, Learn and Releases tabs. Learn and the games
// open in the browser from web/server.mjs, wherever there is no WPF.

const POLL_MS = 500
const QUIET_AFTER_EXIT_MS = 5_000
const IDLE_LIMIT_MS = 15 * 60_000
const RUNS_KEPT = 4
const TOTALS_KEY = 'totals'
const TOTALS_KEPT = 100
const LEARN_POLL_MS = 3_000
// The body rows the pane asks for inline (a request: the layout may give it fewer).
const PANE_ROWS = 12
// The body columns it asks for docked (a request: at most 45% of the terminal): the tab
// row's full labels fit, and a release note wraps once at most.
const PANE_COLUMNS = 56

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
// The pane (off WezTerm-on-WSL): the tab in front, the one the person clicked (it stays
// until a new run or a new plan), and the newest run and plan it has seen.
let paneTab: Tab = 'phases'
let manualTab: Tab | null = null
let lastFocus: string | null = null
let isPaneOpen = false
let lastPlanTitle: string | null = null
// The WezTerm window the WPF panel follows (its `ready`): /learn and /games windows follow it too.
let ownerHwnd: number | null = null
// releases.json and plugin.json, read once (session.start or the first draw), and the
// newest version the person had opened before they last opened the Releases tab: the
// entries after it wear the new mark.
let releases: Release[] = []
let pluginVersion: string | null = null
let seenBefore: string | null = null
let releasesRead: Promise<void> | null = null
// macOS: whether this is a Mac that can draw the floating panel (else the pane).
let isMacHost: Promise<boolean> | null = null
// Windows itself, no WSL (Claude Code with Git Bash), and where its state and logs go.
let isWinHost: Promise<boolean> | null = null
let stateFolder: Promise<string> | null = null

/** Windows itself: Windows sets OS in every process, and WSL has it only when passed through WSLENV. */
function isWindowsHost($: EngineInterface): Promise<boolean> {
  isWinHost ??= (async () => {
    const [os, distro] = await Promise.all([$.env.get('OS').catch(() => undefined), $.env.get('WSL_DISTRO_NAME').catch(() => undefined)])
    return os === 'Windows_NT' && !distro
  })()
  return isWinHost
}

/** The folder of state files and test logs (stateRoot): /tmp/claude-progress, or Windows' temp folder. */
function stateRootOf($: EngineInterface): Promise<string> {
  stateFolder ??= (async () => {
    if (!(await isWindowsHost($))) return stateRoot()
    const [temp, tmp, profile] = await Promise.all([
      $.env.get('TEMP').catch(() => undefined),
      $.env.get('TMP').catch(() => undefined),
      $.env.get('USERPROFILE').catch(() => undefined),
    ])
    return stateRoot(temp || tmp || (profile ? `${profile}/AppData/Local/Temp` : null))
  })()
  return stateFolder
}

/** Learn's home, as its helper (Node's os.homedir()) sees it: USERPROFILE on Windows, else HOME. */
async function learnHome($: EngineInterface): Promise<string | undefined> {
  if (await isWindowsHost($)) return (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  return $.env.get('HOME')
}

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
    await $.process.run(removeArgv(widgetStatePath(await $.session.id(), await stateRootOf($)), await isWindowsHost($)))
  } catch {
    // nothing written for this session
  }
}

async function onPanelEvent($: EngineInterface, event: WidgetEvent) {
  if (event.event === 'ready') {
    if (panel) panel.isReady = true
    ownerHwnd = readOwnerHwnd(event) ?? ownerHwnd
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
  const stateFile = widgetStatePath(sessionId, await stateRootOf($))
  await $.fs.write(stateFile, panelState(sessionId, plan, runs, learn, sessionTitle))

  const distro = await panelDistro($)
  if (distro === null && (await isWindowsHost($))) {
    // Windows itself: the WPF panel over a terminal it can follow, else (or if it failed) the pane.
    const [termProgram, wtSession] = await Promise.all([$.env.get('TERM_PROGRAM').catch(() => undefined), $.env.get('WT_SESSION').catch(() => undefined)])
    const terminal = windowsTerminal({ termProgram, wtSession })
    if (terminal === null || (hasPanelFailed && panel === null)) {
      await syncPane($, plan, runs)
      return
    }
    $.ui.status(statusLine(plan, runs, learn))
    if (isPaneOpen) {
      isPaneOpen = false
      await $.ui.close({ id: PANE_ID }).catch(() => undefined)
    }
    if (panel === null && !isDismissed) {
      const [root, systemRoot] = await Promise.all([$.session.root().catch(() => undefined), $.env.get('SystemRoot').catch(() => undefined)])
      const powershell = windowsPowerShell(systemRoot)
      const argv = widgetArgv({ pluginRoot: $.plugin.root, sessionId, title: sessionTitle, root, stateFile, powershell, terminal })
      panel = { stop: () => undefined, isReady: false }
      panel.stop = launchPanel($, argv, event => void onPanelEvent($, event).catch(() => undefined))
    }
    return
  }
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
  // A new plan comes to the front, as a new run does; otherwise a clicked tab stays.
  const front = frontTab({ current: paneTab, manual: manualTab, plan, runs, learn, lastFocus, lastPlanTitle })
  paneTab = front.tab
  manualTab = front.manual
  lastPlanTitle = plan && plan.items.length > 0 ? plan.title : null
  lastFocus = runs.at(-1)?.id ?? null
  $.ui.status(statusLine(plan, runs, learn))
  if (isDismissed && !isPinned) return
  if (!isPaneOpen) {
    isPaneOpen = true
    await $.ui.open({ id: PANE_ID, title: 'Progress', rows: PANE_ROWS, columns: PANE_COLUMNS }).catch(() => {
      isPaneOpen = false
    })
  }
  $.ui.invalidate('ui.render')
}

/**
 * Opens Learn (at one of its views, or a course), a game, or the games page. On WSL or on
 * Windows itself (any terminal): a game's WPF window (owned by the terminal window once the
 * panel has named it), or Learn.ps1, which opens Learn in an Edge app window. Else the page
 * from web/server.mjs, in its own window on macOS or the browser.
 * `courseTitle` only names the course in the message.
 */
async function openPage(
  $: EngineInterface,
  page: string,
  deep: { view?: string; courseId?: string; courseTitle?: string; explain?: string } = {},
): Promise<string> {
  const { view, courseId, explain } = deep
  const distro = await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)
  const isWindows = await isWindowsHost($)
  const script = windowScript(page)
  if ((distro || isWindows) && script) {
    try {
      const sessionId = await $.session.id()
      if (distro) {
        const argv = windowArgv({ distro, pluginRoot: $.plugin.root, script, sessionId, ownerHwnd, view, courseId })
        // Detached: the window stays when the session ends, as the panel's own launches do.
        await $.process.run(['bash', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'open-window', ...argv])
      } else {
        const powershell = windowsPowerShell(await $.env.get('SystemRoot').catch(() => undefined))
        const argv = windowArgv({ pluginRoot: $.plugin.root, script, sessionId, ownerHwnd, view, courseId, powershell })
        // Windows has no nohup: detach.mjs starts it on its own, hidden, and returns.
        await $.process.run(['node', `${$.plugin.root}/web/detach.mjs`, ...argv])
      }
      return openingText(page, deep, false)
    } catch (error) {
      return `Couldn't open it: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    // The window sticks to this session's terminal window (macOS).
    const [terminal, itermSession] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('ITERM_SESSION_ID')])
    const follow = terminal ? ['--terminal', terminal, '--iterm-session', itermSession ?? ''] : []
    const toView = [...(view ? ['--view', view] : []), ...(courseId ? ['--course', courseId] : []), ...(explain ? ['--explain', explain] : [])]
    // On Windows `bash` is WSL's launcher (or missing): Node runs the server straight.
    const opener = isWindows ? ['node', `${$.plugin.root}/web/server.mjs`] : ['bash', `${$.plugin.root}/web/web.sh`]
    const ran = await $.process.run([...opener, 'open', page, ...toView, ...follow])
    const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; url?: string; error?: string; shown?: string }
    if (answer.ok && answer.shown === 'window') return openingText(page, deep, true)
    // Learn was open already (a browser tab): it went to the place asked for.
    if (answer.ok && answer.shown === 'existing') return `${openingText(page, deep, false)} It was open already: look for its tab.`
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
      if (await isWindowsHost($)) return false
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

/**
 * Reads releases.json, the plugin's version and what the person had seen once; a
 * missing or broken file leaves the tab empty.
 */
function loadReleases($: EngineInterface): Promise<void> {
  releasesRead ??= (async () => {
    const [list, manifest, seen] = await Promise.all([
      $.fs.read(`${$.plugin.root}/releases.json`).catch(() => ''),
      $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => ''),
      $.store.get(SEEN_RELEASE_KEY).catch(() => undefined),
    ])
    releases = readReleases(list)
    pluginVersion = readPluginVersion(manifest) ?? releases[0]?.version ?? null
    seenBefore = typeof seen === 'string' && seen !== '' ? seen : null
  })().catch(() => undefined)
  return releasesRead
}

/**
 * The person opened the Releases tab: the entries newer than what they had seen
 * before keep the new mark while it shows, and the newest is remembered as seen
 * (never an older one, so going back to an older copy brings no dot back).
 */
async function markReleasesSeen($: EngineInterface) {
  const seen = await $.store.get(SEEN_RELEASE_KEY).catch(() => undefined)
  seenBefore = typeof seen === 'string' && seen !== '' ? seen : null
  const later = laterVersion(seen, newestRelease(releases, pluginVersion))
  if (later && later !== seen) await $.store.set(SEEN_RELEASE_KEY, later).catch(() => undefined)
}

/** Picks up Learn's status file; a change redraws the panel's Learn tab. */
async function pollLearn($: EngineInterface) {
  let text = ''
  try {
    const home = await learnHome($)
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

  const removeLog = () => void (async () => $.process.run(removeArgv(run.log, await isWindowsHost($))))().catch(() => undefined)

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
    const log = run.log ?? `${await stateRootOf($)}/${sessionId}/${run.id.replace(/[^\w-]/g, '_')}.log`
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
      description: 'Open Learn, or one of its views: courses built from free videos and docs by your own Claude',
      argumentHint: `[${LEARN_VIEWS.join('|')}]`,
      immediate: true,
    })
    await $.command.register({
      name: 'course',
      description: 'Build a Learn course about something you did in this chat: /course how we fixed the browser link',
      argumentHint: '<what the course should cover>',
      immediate: true,
    })
    await $.tool.register({
      name: EXPLAIN_TOOL,
      description: EXPLAIN_TOOL_DESCRIPTION,
      inputSchema: EXPLAIN_TOOL_SCHEMA,
      isDeferred: true,
    })
    await $.command.register({
      name: 'explain',
      description: 'Have Claude explain code from this chat as short video clips in Learn: /explain how the gateway mints tokens',
      argumentHint: '<what to explain>',
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
    void loadReleases($)
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
    // The wrapper parses in bash and zsh (macOS's default) alike. On Windows the Bash tool is
    // Git Bash, whatever SHELL says (often nothing, or C:\...\bash.exe).
    const isKnownShell = (await isWindowsHost($)) || /(^|[\\/])(bash|zsh)(\.exe)?$/.test((await $.env.get('SHELL')) ?? '')
    if (!isKnownShell || !isTestCommand(e.command)) return next(e)

    const id = e.tool_use_id ?? `run-${await $.clock.now()}`
    const log = `${await stateRootOf($)}/${await $.session.id()}/${id.replace(/[^\w-]/g, '_')}.log`
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
      const opened = await $.ui.open({ id: PANE_ID, title: 'Progress', rows: PANE_ROWS, columns: PANE_COLUMNS })
      if (!opened.isPlaced) return { text: `The progress pane is open but not drawn yet (${opened.reason}).` }
    } else if (panel === null) return { text: 'The floating panel could not start. /phases tries again.' }
    const plan = await read($, phases)
    const runs = await read($, testRuns)
    if (plan === null && runs.length === 0) return { text: 'Panel opened, empty for now: it fills with a plan or a test run. Its ✕ closes it.' }

    return { text: plan ? describePlan(plan) : 'Showing the test runs.' }
  })

  on('command.run', { command: 'learn' }, async ($, e) => {
    const view = e.args.trim().toLowerCase()
    if (view && !isLearnView(view)) return { text: `Learn has no view called "${view}". Views: ${LEARN_VIEWS.join(', ')}.` }
    if (view === 'course') {
      // The course in front, as Carry on reading opens it; with none yet, the Library, which lists them.
      const course = learn?.course
      if (!course) return { text: `No course open yet. ${await openPage($, 'learn', { view: 'library' })}` }
      return { text: await openPage($, 'learn', { view, courseId: course.id, courseTitle: course.title || undefined }) }
    }
    return { text: await openPage($, 'learn', { view: view || undefined }) }
  })

  on('command.run', { command: 'course' }, async ($, e) => {
    const focus = e.args.trim()
    if (!focus) return { text: 'Say what the course should cover, as in: /course how we fixed the browser link' }
    const sessionId = await $.session.id()
    const ran = await $.process.run(courseArgv({ pluginRoot: $.plugin.root, sessionId, focus, isWindows: await isWindowsHost($) }))
    if (ran.exitCode !== 0) return { text: `Learn couldn't start the build: ${(ran.stderr.trim() || ran.stdout.trim()).split('\n').at(-1) || 'no answer'}` }
    return { text: `Building a Learn course about "${focus}" from this chat. Learn reads the chat's saved record (it asks this chat nothing). Its progress shows on the panel's Learn tab; /learn opens it.` }
  })

  // /explain: this session plans the clips (it has the code and the context), Learn makes them.
  on('command.run', { command: 'explain' }, async ($, e) => {
    const what = e.args.trim()
    void $.prompt.submit({ text: explainBrief(what) })
    return { text: `Planning short video clips${what ? ` about "${what}"` : ''}. Claude reads the code first, then Learn makes the clips and opens the player.` }
  })

  // By pattern: the typed list of MCP tools is the one saved with the mod, made before this tool.
  on('tool.call', { tool: new RegExp(`^mcp__progress__${EXPLAIN_TOOL}$`) }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main session hands Learn an explainer.' }
    const { tool, tool_use_id, consent, ...plan } = e as unknown as Record<string, unknown>
    void tool
    void tool_use_id
    void consent
    for (const key of Object.keys(plan)) if (!['title', 'shape', 'boxes', 'clips'].includes(key)) delete plan[key]
    const [sessionId, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    // Learn checks the plan against the files and this chat, with one Claude call: up to a few minutes.
    const ran = await $.process.run(explainArgv({ pluginRoot: $.plugin.root, sessionId, cwd, isWindows: await isWindowsHost($) }), { stdin: JSON.stringify(plan), timeoutMs: 6 * 60_000 })
    const answer = readExplainAnswer(ran.stdout)
    if (!answer) return { deny: `Learn couldn't take the plan: ${(ran.stderr.trim() || ran.stdout.trim()).split('\n').at(-1) || 'no answer'}` }
    if (!answer.ok) return { deny: refusalText(answer.problems) }
    const opened = await openPage($, 'learn/video', { explain: answer.id })
    return { result: `Learn accepted the plan: ${answer.clips} clip${answer.clips === 1 ? '' : 's'}, made in order, the first in about 2 to 4 minutes. ${opened}` }
  }).catch(() => ({ deny: 'Learn failed to take the plan; tell the person, and explain in text instead if they want.' }))

  on('command.run', { command: 'games' }, async ($, e) => {
    const name = e.args.trim().toLowerCase()
    const names = GAMES.map(game => game.id).join(', ')
    if (!name) {
      // On WSL and Windows each game is its own WPF window, so name one; elsewhere the games page lists them.
      const distro = await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)
      const hasWpf = Boolean(distro) || (await isWindowsHost($))
      return { text: hasWpf ? `Games: ${names}. Try /games sudoku.` : await openPage($, 'games') }
    }
    if (!isGame(name)) return { text: `No game called "${name}". Games: ${names}.` }
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
    await loadReleases($)
    const plan = await read($, phases)
    const runs = await read($, testRuns)
    // Read while drawing, so the write a press of the Releases tab makes draws the tab again.
    const seenRelease = await $.store.get(SEEN_RELEASE_KEY).catch(() => undefined)
    const isUnseen = isReleaseUnseen(newestRelease(releases, pluginVersion), seenRelease)
    const versionText = releasesLabel(pluginVersion)
    const isInline = e.props.placement === 'inline'
    // The labels the row has room for: the counts give way before the row wraps. The
    // version is measured with its dot either way, so opening Releases moves no tab.
    const fitted = fitTabs(tabLabels(plan, runs, learn), shortTabLabels(runs, learn), versionText, e.props.bodyColumns)
    // Inline, the rows the layout gave the body: less the tab row and the gap under it, what a tab may draw.
    const room = Math.max(1, (e.props.scroll?.bodyRows ?? PANE_ROWS) - fitted.rows - 1)
    // A click puts the tab in front and keeps it there until a new run or a new plan
    // (Releases stays through both, until another tab is picked).
    const show = (tab: Tab) => async () => {
      if (tab === 'releases' && paneTab !== 'releases') await markReleasesSeen($)
      paneTab = tab
      manualTab = tab
      $.ui.invalidate('ui.render')
    }
    const open = (page: string, deep?: { view?: string; courseId?: string; courseTitle?: string }) => () => {
      void openPage($, page, deep).then(text => $.ui.toast(text))
    }
    // Every tab is drawn plain, so none changes width when it comes to the front: the
    // one in front bold, the others dim until hovered.
    const liveTab = (tab: LiveTab) => {
      const label = fitted.labels[tab]
      return paneTab === tab ? (
        <Button key={`tab:${tab}`} plain label={label} onPress={show(tab)}>
          <Text bold>{label}</Text>
        </Button>
      ) : (
        <Button key={`tab:${tab}`} plain dimColor label={label} onPress={show(tab)}>
          {label}
        </Button>
      )
    }
    // The version is the Releases tab. Its accent ● says there are notes not opened yet;
    // the version beside it dims on its own, so the dot keeps its colour.
    const versionLook = paneTab === 'releases' ? <Text bold>{versionText}</Text> : isUnseen ? <Text dimColor>{versionText}</Text> : versionText
    const releasesTab = (
      <Button
        key="tab:releases"
        plain
        dimColor={paneTab !== 'releases' && !isUnseen}
        label={releasesName(pluginVersion, isUnseen)}
        onPress={show('releases')}
      >
        {versionLook}
        {isUnseen && <Text color="claude">{UNSEEN_MARK}</Text>}
      </Button>
    )

    // The three live tabs on the left; the version, which is the Releases tab, at the right.
    const tabs = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={TAB_GAP}>
        <Box flexDirection="row" columnGap={TAB_GAP}>
          {liveTab('phases')}
          {liveTab('tests')}
          {liveTab('learn')}
        </Box>
        {releasesTab}
      </Box>
    )

    let body
    if (paneTab === 'releases') {
      const isMissing = lacksReleaseNote(pluginVersion, releases)
      // Docked, the body scrolls; inline, the frame is cut at its rows, so only what fits is drawn.
      const shown = isInline ? fitReleases(releases, room - (isMissing ? 1 : 0), e.props.bodyColumns) : releases
      const earlier = releases.length - shown.length
      // A gap between two releases; the "+N earlier" line sits right under the last one shown.
      body = (
        <Box flexDirection="column">
          {isMissing && (
            <Text color="error" wrap="truncate-end">
              v{pluginVersion} has no release note yet
            </Text>
          )}
          {releases.length === 0 && <Text dimColor>No releases listed.</Text>}
          <Box flexDirection="column" gap={1}>
            {shown.map((release, index) => (
              <Box key={`release:${release.version}`} flexDirection="column">
                {/* One row: the new mark's column, then the version and, dim, when and who. */}
                <Box flexDirection="row">
                  <Box width={MARK_CELLS} flexShrink={0}>
                    {isReleaseNew(release.version, seenBefore, index) && <Text color="claude">●</Text>}
                  </Box>
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text bold>{release.version}</Text>
                      <Text dimColor>{releaseLine(release).slice(release.version.length)}</Text>
                    </Text>
                  </Box>
                </Box>
                {/* Each note under the heading's text, after a dim ·: a wrapped line goes on under the note's text. */}
                {release.notes.map((note, i) => (
                  <Box key={`note:${release.version}:${i}`} flexDirection="row" paddingLeft={MARK_CELLS}>
                    <Box width={2} flexShrink={0}>
                      <Text dimColor>·</Text>
                    </Box>
                    <Box flexShrink={1}>
                      <Text>{note}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
          {earlier > 0 && (
            <Box paddingLeft={MARK_CELLS}>
              <Text dimColor>+{earlier} earlier</Text>
            </Box>
          )}
        </Box>
      )
    } else if (paneTab === 'tests') {
      const newest = [...runs].reverse()
      // Inline, the newest runs the room holds (two rows each), the totals line under them when it fits too.
      const fit = isInline ? fitRuns(newest.length, room) : { shown: newest.length, hasFooter: true }
      body = (
        <Box flexDirection="column">
          {newest.length === 0 && <Text dimColor>No test runs yet.</Text>}
          {newest.slice(0, fit.shown).map(run => {
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
          {runs.length > 0 && fit.hasFooter && <Text dimColor>{testsFooter(runs)}</Text>}
        </Box>
      )
    } else if (paneTab === 'learn') {
      const build = learn?.build
      const course = learn?.course
      // Inline with fewer rows than it all takes, the build's bar goes first, then its message:
      // the topic, the course and the buttons always show.
      const spare = room - 3 - (course ? 2 : 0) - (build || !course ? 1 : 0)
      const hasMessage = Boolean(build?.message) && (!isInline || spare >= 1)
      const hasBar = build !== undefined && build !== null && build.total > 0 && (!isInline || spare >= (hasMessage ? 2 : 1))
      body = (
        <Box flexDirection="column">
          {/* The topic and what the build is doing, a line each, cut with an ellipsis rather than run into each other. */}
          {build && (
            <Text bold color={buildColor(build)} wrap="truncate-end">
              {build.topic}
            </Text>
          )}
          {build && hasMessage && (
            <Text dimColor wrap="truncate-end">
              {build.message}
            </Text>
          )}
          {build && hasBar && (
            <Text>
              <Text color={buildColor(build)}>{bar(buildRatio(build))}</Text> {build.done}/{build.total} pages
            </Text>
          )}
          {course && (
            <Text bold wrap="truncate-end">
              {course.title}
            </Text>
          )}
          {course && (
            <Text dimColor wrap="truncate-end">
              Page {course.page} of {course.total}{course.next ? ` · next: ${course.next}` : ''}
            </Text>
          )}
          {!build && !course && <Text dimColor>Courses from free videos and docs, written by your own Claude.</Text>}
          <Box flexDirection="row" marginTop={1}>
            <Button
              key="open:learn"
              variant="primary"
              onPress={course ? open('learn', { view: 'course', courseId: course.id, courseTitle: course.title || undefined }) : open('learn')}
            >
              {course ? 'Carry on reading' : 'Open Learn'}
            </Button>
          </Box>
          {/* The games on their own row, which wraps rather than clips in a narrow pane: under the first game, not the label,
              which never shrinks, so it stays one word. */}
          <Box flexDirection="row" columnGap={1}>
            <Box key="games:label" flexShrink={0}>
              <Text dimColor>Games</Text>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" flexShrink={1} columnGap={1}>
              {GAMES.map(game => (
                <Button key={`game:${game.id}`} onPress={open(`games/${game.id}`)}>{game.label}</Button>
              ))}
            </Box>
          </Box>
        </Box>
      )
    } else if (plan === null || plan.items.length === 0) {
      body = <Text dimColor>No plan yet.</Text>
    } else {
      // Inline, as many phases as the room leaves under the title (wrapped) and above the count.
      const itemRows = isInline ? Math.max(1, room - wrappedRows(plan.title, e.props.bodyColumns) - 1) : plan.items.length
      const now = plan.items.findIndex(item => item.status !== 'done')
      const first = isInline ? Math.max(0, Math.min(now, plan.items.length - itemRows)) : 0
      const shown = plan.items.slice(first, first + itemRows)
      const { done, total } = { done: plan.items.filter(item => item.status === 'done').length, total: plan.items.length }
      body = (
        <Box flexDirection="column">
          <Text bold>{plan.title}</Text>
          {shown.map((item, i) => (
            <Text key={`item:${first + i}`}>
              {item.status === 'done' && <Text color="success">[✓] </Text>}
              {item.status === 'done' && <Text dimColor>{item.name}</Text>}
              {item.status === 'in_progress' && <Text bold color="claude">[●] {item.name}</Text>}
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
          <Text wrap="truncate-end">{collapsedLine(paneTab, plan, runs, learn, releases)}</Text>
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
