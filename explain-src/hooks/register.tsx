// The explain plugin: /explain and /clips, and nothing else of the progress plugin (no panel, no
// Learn, no courses). Built by progress/tools/build-explain.mjs from the same code: explain.ts and
// learn.ts are the progress plugin's own, and learn/ holds only what making clips needs, run
// through learn.sh (explain-cli.mjs). Clips are made on this computer, each explainer saved as one
// HTML file in ~/explainers; /clips opens it. When the progress plugin is here too, it owns
// /explain (the same making, plus its player and Library), and this one stands aside.
import type { EngineInterface, Register, Timer } from 'claude-code'

import { acceptedText, asksWiki, EXPLAIN_TOOL, EXPLAIN_TOOL_DESCRIPTION, EXPLAIN_TOOL_SCHEMA, explainArgv, explainBrief, explainToolName, helperArgv, lastJson, learnSettingsPath, openFileArgv, readExplainAnswer, refusalText, wikiPicked, wikiReply, type WikiTo } from './explain'
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
// The wiki, for the /explain going on: whether its question was to be asked, and what was clicked.
let wikiAsked = false
let wikiTo: WikiTo | null = null
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

/** The wiki's key, handed to what may upload: a helper's job outlives this session, so it isn't left to chance. */
async function wikiEnv($: EngineInterface): Promise<Record<string, string>> {
  const key = await $.env.get('WIKI_API_KEY').catch(() => undefined)
  return key ? { WIKI_API_KEY: key } : {}
}

/** Whether /explain asks about the wiki here: a key is set, and the settings don't say off. */
async function offersWiki($: EngineInterface): Promise<boolean> {
  const { WIKI_API_KEY } = await wikiEnv($)
  const home = WIKI_API_KEY ? await homeOf($) : undefined
  return asksWiki(WIKI_API_KEY, home ? await $.fs.read(learnSettingsPath(home)).catch(() => '') : '')
}

/** The helper with these arguments: learn.sh (which finds Node 22) runs explain-cli.mjs; on Windows, Node straight. */
async function helper($: EngineInterface, args: string[], timeoutMs = 60_000) {
  const argv = helperArgv({ pluginRoot: $.plugin.root, isWindows: await isWindowsHost($), entry: 'explain-cli.mjs' }, args)
  return $.process.run(argv, { timeoutMs, env: await wikiEnv($) })
}

/** `/clips wiki [on | off]`: one that asked for the wiki and isn't there, sent again; or whether /explain asks. */
async function wiki($: EngineInterface, what: string): Promise<string> {
  const args = ['wiki', ...(what === 'on' || what === 'off' ? [what] : lastExplainer ? [lastExplainer] : [])]
  return wikiReply(lastJson((await helper($, args, 8 * 60_000)).stdout))
}

/** `/clips stop`: the clips being made (this chat's, else the newest going on), those ready kept. */
async function stopMaking($: EngineInterface): Promise<string> {
  const answer = lastJson((await helper($, ['stop', ...(lastExplainer ? [lastExplainer] : [])])).stdout)
  if (!answer) return '/clips stop could not run: try it again.'
  if (answer.stopped !== true) return 'Nothing is being made.'
  // Said here, so the notice isn't said too; and what was stopped is what /clips is about now.
  stopTold = `${String(answer.job)}:paused:Paused`
  lastExplainer = String(answer.id)
  clipsTold = Number(answer.ready)
  const ready = `${String(answer.ready)} of ${String(answer.clips)} clips are ready. /clips resume makes the rest.`
  return answer.ended === true ? `Stopped "${String(answer.title)}": ${ready}` : `Stopping "${String(answer.title)}" once the voice's installer is done with this piece: ${ready}`
}

/** `/clips resume`: what is missing, made (this chat's explainer, else the newest with clips missing). */
async function carryOn($: EngineInterface): Promise<string> {
  const answer = lastJson((await helper($, ['resume', ...(lastExplainer ? [lastExplainer] : [])])).stdout)
  if (!answer) return '/clips resume could not run: try it again.'
  if (answer.making !== true) return 'Nothing is left to make.'
  lastExplainer = String(answer.id)
  clipsTold = Number(answer.ready)
  statusText = ''
  return `Making the rest of "${String(answer.title)}": ${String(answer.ready)} of ${String(answer.clips)} clips are ready.`
}

/** `/clips model [name]`: which Claude writes the clips (the checks of a plan too). */
async function chooseModel($: EngineInterface, name: string): Promise<string> {
  const answer = lastJson((await helper($, ['model', ...(name ? [name] : [])])).stdout)
  if (!answer) return '/clips model could not run: try it again.'
  const names = Array.isArray(answer.models) ? answer.models.join(', ') : ''
  if (answer.known !== true) return `No model called "${name}". It can be ${names}, or a model's full id (claude-…).`
  if (name) return `Clips are written by ${String(answer.model)}, from the next /explain or /clips resume.`
  return `Clips are written by ${String(answer.model)}. To change it: /clips model <name> (${names}, or a model's full id).`
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
  // Claude Code draws the plugin's name before it.
  $.ui.status(build?.state === 'running' ? build.message || 'making clips' : undefined)
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
      await $.command.register({ name: 'clips', description: 'Open the clips /explain made, as one file in your browser; or stop, resume, choose the model, or send them to the wiki again', argumentHint: '[stop | resume | model <name> | wiki]', immediate: true })
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
    wikiAsked = await offersWiki($)
    wikiTo = null
    const brief = explainBrief(e.args, { plugin: PLUGIN, wiki: wikiAsked })
    $.clock.after(SUBMIT_MS, () => void $.prompt.submit({ text: brief, asUser: true }).catch(() => undefined))
    return { text: settingUpVoice ? 'Asking Claude to plan the clips. First run: the voice gets set up too (about 350 MB, once).' : 'Asking Claude to plan the clips.' }
  }).catch(() => ({ text: '/explain could not start: try it again.' }))

  // The wiki question /explain's brief asks, as you clicked it: what goes up follows this, never
  // what Claude says you picked.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const answered = await next(e)
    const picked = wikiAsked && e.agentId === undefined ? wikiPicked(answered.result) : undefined
    if (picked !== undefined) wikiTo = picked
    return answered
  })

  // The file of the explainer this chat made last, else the newest one made here.
  on('command.run', { command: 'clips' }, async ($, e, next) => {
    if (isOff || (await progressIsHere($))) return next(e)
    const [word = '', name = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'stop') return { text: await stopMaking($) }
    if (word === 'resume') return { text: await carryOn($) }
    if (word === 'model') return { text: await chooseModel($, name) }
    if (word === 'wiki') return { text: await wiki($, name) }
    if (word) return { text: '/clips opens the clips. There is also /clips stop, /clips resume, /clips model <name> and /clips wiki.' }
    const found = lastJson((await helper($, ['latest', ...(lastExplainer ? [lastExplainer] : [])]).catch(() => ({ stdout: '' }))).stdout)
    if (!found) return { text: 'No clips yet: /explain <what> makes some.' }
    // Making that stopped (a restart, a failure) carries on when you open it; one going on is left
    // alone, and so is one you stopped.
    const missing = Number(found.ready) < Number(found.clips)
    const paused = missing && found.paused === true
    const making = missing && !paused && lastJson((await helper($, ['resume', String(found.id)]).catch(() => ({ stdout: '' }))).stdout)?.making === true
    const rest = missing ? ` (${String(found.ready)} of ${String(found.clips)} clips${making ? ', the rest being made' : paused ? '; /clips resume makes the rest' : ''})` : ''
    if (typeof found.file !== 'string' && paused) return { text: `"${String(found.title)}" was stopped before its first clip: /clips resume makes it.` }
    if (typeof found.file !== 'string') return { text: `The first clip of "${String(found.title)}" is still being made: a notice here says when it is ready.` }
    if (making && !lastExplainer) {
      lastExplainer = String(found.id)
      clipsTold = Number(found.ready)
    }
    await openFile($, found.file)
    return { text: `Opened ${found.file}${rest}` }
  }).catch(() => ({ text: '/clips did not work: try it again. The files are in ~/explainers.' }))

  on('tool.call', { tool: new RegExp(`^${explainToolName(PLUGIN)}$`) }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main session hands over an explainer.' }
    const { tool, tool_use_id, consent, ...plan } = e as unknown as Record<string, unknown>
    void tool
    void tool_use_id
    void consent
    const folder = plan.wikiFolder
    for (const key of Object.keys(plan)) if (!['title', 'shape', 'boxes', 'clips', 'depth'].includes(key)) delete plan[key]
    // No player here asks the depth later: a plan without one would stop after its first clip.
    plan.depth ??= 2
    const [sessionId, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    // The plan is checked against the files and this chat, with one Claude call: up to a few minutes.
    const asked = wikiAsked
    const argv = explainArgv({ pluginRoot: $.plugin.root, sessionId, cwd, isWindows: await isWindowsHost($), entry: 'explain-cli.mjs', wiki: asked ? wikiTo : null, folder })
    const ran = await $.process.run(argv, { stdin: JSON.stringify(plan), timeoutMs: 6 * 60_000, env: await wikiEnv($) })
    const answer = readExplainAnswer(ran.stdout)
    if (!answer) {
      const why = (ran.stderr.trim() || ran.stdout.trim()).split('\n').at(-1) || 'no answer'
      // Claude Code's own words when an account can't use a model.
      const change = /selected model/i.test(why) ? ' Ask the person to type "/clips model sonnet", then call this tool again with the same plan.' : ''
      return { deny: `The plan couldn't be taken: ${why}${change}` }
    }
    if (!answer.ok) return { deny: refusalText(answer.problems) }
    lastExplainer = answer.id
    clipsTold = 0
    stopTold = ''
    statusText = ''
    // A Yes to the wiki is for the explainer just taken, never the next.
    wikiAsked = false
    wikiTo = null
    return { result: acceptedText(answer, { library: false, firstRun: settingUpVoice, wikiAsked: asked }) }
  }).catch(() => ({ deny: 'The plan failed to go through; tell the person, and explain in text instead if they want.' }))
}
