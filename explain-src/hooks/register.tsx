// The explain plugin: /explain and /clips, and nothing else of the progress plugin (no panel, no
// Learn, no courses). Built by progress/tools/build-explain.mjs from the same code: explain.ts and
// learn.ts are the progress plugin's own, and learn/ holds only what making clips needs, run
// through learn.sh (explain-cli.mjs). Clips are made on this computer, each explainer saved as one
// HTML file in ~/explainers; /clips opens it. When the progress plugin is here too, it owns
// /explain (the same making, plus its player and Library), and this one stands aside.
import type { EngineInterface, Register, Timer } from 'claude-code'

import { acceptedText, EXPLAIN_TOOL, EXPLAIN_TOOL_DESCRIPTION, EXPLAIN_TOOL_SCHEMA, explainArgv, explainBrief, explainToolName, openFileArgv, readExplainAnswer, refusalText } from './explain'
import { learnStatusPath, readLearnStatus, readyNote, readyNotice, stoppedNotice } from './learn'

const PLUGIN = 'explain'
// The brief goes in once the command has returned: submitted inside the hook it waits for your next message.
const SUBMIT_MS = 300
const POLL_MS = 3000

let isOff = false
let lastExplainer: string | null = null
let clipsTold = 0
let stopTold = ''
let statusText = ''
let settingUpVoice = false
let pollTimer: Timer | null = null

/** Windows itself: Windows sets OS in every process, and WSL has it only when passed through WSLENV. */
async function isWindowsHost($: EngineInterface): Promise<boolean> {
  const [os, distro] = await Promise.all([$.env.get('OS').catch(() => undefined), $.env.get('WSL_DISTRO_NAME').catch(() => undefined)])
  return os === 'Windows_NT' && !distro
}

/** Home as the helper (Node's os.homedir()) sees it: USERPROFILE on Windows, else HOME. */
async function homeOf($: EngineInterface): Promise<string | undefined> {
  if (await isWindowsHost($)) return (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  return $.env.get('HOME').catch(() => undefined)
}

/**
 * The progress plugin, when it's enabled too: it owns /explain then. Known by its own `/learn`, and
 * never by the name alone: someone's own /learn command must not turn this off. Asked each time,
 * since plugins load in any order.
 */
async function progressIsHere($: EngineInterface): Promise<boolean> {
  const commands = await $.command.list().catch(() => [])
  return commands.some(command => command.source === 'plugin' && command.name === 'learn' && /^progress(?:@|$)/.test(command.plugin ?? ''))
}

/** The helper with these arguments: learn.sh (which finds Node 22) runs explain-cli.mjs; on Windows, Node straight. */
async function helper($: EngineInterface, args: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
  const base = (await isWindowsHost($)) ? ['node', `${$.plugin.root}/learn/explain-cli.mjs`] : ['bash', `${$.plugin.root}/learn/learn.sh`, 'explain']
  return $.process.run([...base, ...args], { timeoutMs: options.timeoutMs ?? 60_000, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) })
}

/** The last line of a helper's output as JSON, or null. */
function lastJson(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout.trim().split('\n').at(-1) || 'null') as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Opens a file with its default app: the browser, for an explainer. */
async function openFile($: EngineInterface, path: string): Promise<void> {
  const distro = await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)
  let platform = 'linux'
  if (await isWindowsHost($)) platform = 'win32'
  else if (!distro) platform = (await $.process.run(['uname', '-s']).catch(() => ({ stdout: '' }))).stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
  // explorer.exe says it failed even when it opened the file: what it says is no guide.
  await $.process.run(openFileArgv({ path, platform, distro: distro || null }), { timeoutMs: 15_000 }).catch(() => undefined)
}

/** The job's progress, pinned under the prompt while it runs, and a notice in the chat as each clip is ready. */
async function poll($: EngineInterface) {
  if (!lastExplainer) return
  let text = ''
  const home = await homeOf($)
  try {
    if (home) text = await $.fs.read(learnStatusPath(home))
  } catch {
    return
  }
  if (text === statusText) return
  statusText = text
  const status = readLearnStatus(text, await $.clock.now())
  const build = status?.build?.kind === 'explain' && status.build.explain === lastExplainer ? status.build : null
  $.ui.status(build?.state === 'running' ? `explain · ${build.message || 'making clips'}` : undefined)
  // A line in the chat, which the model never reads, so no turn starts. Not `$.session.append`: the
  // engine files its system rows at level `info`, which only the detailed view (Ctrl+O) draws.
  const say = (line: string) => $.ui.log(line)
  const notice = readyNotice(build, lastExplainer, clipsTold, home || '')
  if (notice) {
    clipsTold = notice.done
    say(notice.text)
    // At the finish Claude is told too, in a row only it reads, so "are they done?" needs no looking.
    const note = readyNote(build, home || '')
    if (note) void $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } }).catch(() => undefined)
  }
  // There's no panel here to show a job that stopped: said once for each stop.
  const stopped = stoppedNotice(build, lastExplainer)
  if (stopped && stopped.key !== stopTold) {
    stopTold = stopped.key
    say(stopped.text)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isOff = (await $.env.get('CLAUDE_PROGRESS_OFF').catch(() => undefined)) === '1'
    if (isOff) return next(e)
    await $.tool.register({ name: EXPLAIN_TOOL, description: EXPLAIN_TOOL_DESCRIPTION, inputSchema: EXPLAIN_TOOL_SCHEMA, isDeferred: true })
    if (!(await progressIsHere($))) {
      // Not immediate: typed during a turn, it waits for that turn to end, then starts its own.
      await $.command.register({ name: 'explain', description: 'Have Claude explain code from this chat as short narrated video clips, e.g. /explain how the gateway mints tokens', argumentHint: '<what to explain>' })
      await $.command.register({ name: 'clips', description: 'Open the clips /explain made, as one file in your browser', immediate: true })
    }
    const started = await next(e)
    pollTimer?.cancel()
    pollTimer = $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    return started
  })

  on('command.run', { command: 'explain' }, async ($, e, next) => {
    if (isOff || (await progressIsHere($))) return next(e)
    // The helper and the voice run on this computer: say now if they can't (no Node 22, a machine
    // the voice has no build for), before Claude plans anything.
    const voice = lastJson((await helper($, ['voice']).catch(() => ({ stdout: '' }))).stdout)
    const problem = voice?.reason ?? voice?.error ?? (voice ? null : 'its helper gave no answer (it needs Node 22 or newer)')
    if (problem) return { text: `/explain can't make clips here: ${String(problem)}` }
    settingUpVoice = voice?.needsSetup === true
    const brief = explainBrief(e.args, { plugin: PLUGIN })
    $.clock.after(SUBMIT_MS, () => void $.prompt.submit({ text: brief, asUser: true }).catch(() => undefined))
    return { text: settingUpVoice ? 'Asking Claude to plan the clips. First run: the voice gets set up too (about 350 MB, once).' : 'Asking Claude to plan the clips.' }
  }).catch(() => ({ text: '/explain could not start: try it again.' }))

  // The file of the explainer this chat made last, else the newest one made here.
  on('command.run', { command: 'clips' }, async ($, e, next) => {
    if (isOff || (await progressIsHere($))) return next(e)
    const found = lastJson((await helper($, ['latest', ...(lastExplainer ? [lastExplainer] : [])]).catch(() => ({ stdout: '' }))).stdout)
    if (!found) return { text: 'No clips yet: /explain <what> makes some.' }
    // Making that stopped (a restart, a failure) carries on when you open it; one going on is left alone.
    const missing = Number(found.ready) < Number(found.clips)
    const making = missing && lastJson((await helper($, ['resume', String(found.id)]).catch(() => ({ stdout: '' }))).stdout)?.making === true
    const rest = missing ? ` (${String(found.ready)} of ${String(found.clips)} clips${making ? ', the rest being made' : ''})` : ''
    if (typeof found.file !== 'string') return { text: `The first clip of "${String(found.title)}" is still being made: a notice here says when it is ready.` }
    if (making && !lastExplainer) {
      lastExplainer = String(found.id)
      clipsTold = Number(found.ready)
    }
    await openFile($, found.file)
    return { text: `Opened ${found.file}${rest}` }
  }).catch(() => ({ text: '/clips could not open the file: it is in ~/explainers.' }))

  on('tool.call', { tool: new RegExp(`^${explainToolName(PLUGIN)}$`) }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main session hands over an explainer.' }
    const { tool, tool_use_id, consent, ...plan } = e as unknown as Record<string, unknown>
    void tool
    void tool_use_id
    void consent
    for (const key of Object.keys(plan)) if (!['title', 'shape', 'boxes', 'clips', 'depth'].includes(key)) delete plan[key]
    // No player here asks the depth later: a plan without one would stop after its first clip.
    plan.depth ??= 2
    const [sessionId, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    // The plan is checked against the files and this chat, with one Claude call: up to a few minutes.
    const argv = explainArgv({ pluginRoot: $.plugin.root, sessionId, cwd, isWindows: await isWindowsHost($), entry: 'explain-cli.mjs' })
    const ran = await $.process.run(argv, { stdin: JSON.stringify(plan), timeoutMs: 6 * 60_000 })
    const answer = readExplainAnswer(ran.stdout)
    if (!answer) return { deny: `The plan couldn't be taken: ${(ran.stderr.trim() || ran.stdout.trim()).split('\n').at(-1) || 'no answer'}` }
    if (!answer.ok) return { deny: refusalText(answer.problems) }
    lastExplainer = answer.id
    clipsTold = 0
    stopTold = ''
    statusText = ''
    return { result: acceptedText(answer, { library: false, firstRun: settingUpVoice }) }
  }).catch(() => ({ deny: 'The plan failed to go through; tell the person, and explain in text instead if they want.' }))
}
