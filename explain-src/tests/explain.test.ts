// The explain plugin on its own: /explain, /clips, the tool, and the notices, with the engine and
// the helper (learn.sh) played by the test. `claude plugin test` runs these on the built plugin.
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { acceptedText, explainBrief, explainToolName, FIRST_RUN, openFileArgv } from '../hooks/explain'
import { stoppedNotice } from '../hooks/learn'

const ID = 'x202611240900abcd'
const STATUS = '/home/me/.config/claude-learn/status.json'
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const PLAN = { title: 'Tokens', shape: 'none', boxes: [], clips: [] }

type Command = { name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }

/** The session, and a helper that answers each subcommand with a line of JSON. */
function world(
  on: On,
  options: { voice?: unknown; start?: unknown; latest?: unknown; resume?: unknown; commands?: Command[]; mac?: boolean; windows?: boolean; status?: () => string } = {},
) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {
    ...(options.windows ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } : { HOME: '/home/me', ...(options.mac ? {} : { WSL_DISTRO_NAME: 'Ubuntu' }) }),
  })
  const seen = { runs: [] as string[][], stdin: [] as string[], submitted: [] as string[], rows: [] as string[], hidden: [] as string[], status: [] as (string | undefined)[], registered: [] as string[] }
  const answers: Record<string, unknown> = {
    voice: options.voice ?? { ready: true, needsSetup: false, setupMb: 350 },
    start: options.start ?? { ok: true, id: ID, clips: 6, wanted: 4, depth: 2 },
    latest: options.latest ?? null,
    resume: options.resume ?? { making: false },
  }
  on('process.run', (_$, e) => {
    seen.runs.push([...e.argv])
    if (e.init?.stdin !== undefined) seen.stdin.push(String(e.init.stdin))
    const sub = ['voice', 'start', 'latest', 'resume'].find(word => e.argv.includes(word))
    const stdout = e.argv[0] === 'uname' ? 'Darwin\n' : sub ? `${JSON.stringify(answers[sub])}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.list', () => ({ value: options.commands ?? [] }))
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  // The chat's lines: `$.ui.log` is drawn, while an appended system row is not (only Ctrl+O shows it).
  on('ui.log', (_$, e) => {
    if (e.to === 'transcript') seen.rows.push(e.text)
    return { value: undefined }
  })
  on('session.append', (_$, e) => {
    seen.hidden.push(JSON.stringify(e.message.content))
    return { message: e.message, uuid: 'row' } as never
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/home/me/repo' }))
  on('fs.read', (_$, e) => ({ value: e.path === STATUS ? (options.status?.() ?? '') : '' }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  return { clock, seen }
}

const build = (patch: Record<string, unknown> = {}) => JSON.stringify({ at: new Date(1_000).toISOString(), build: { id: 'j1', kind: 'explain', explain: ID, topic: 'Tokens', step: 'clips', state: 'running', message: 'Tokens: clip 2 of 4, writing', done: 1, total: 4, ...patch } })

describe('/explain', () => {
  test('asks Claude to plan the clips, in a turn of its own, naming this plugin’s tool and a depth to fall back on', async ($, on) => {
    const { clock, seen } = world(on)
    expect(await $.command.run({ command: 'explain', args: 'how tokens\n move', ...RUN })).toMatchObject({ text: 'Asking Claude to plan the clips.' })
    expect(seen.submitted).toEqual([])
    await clock.advance(400)
    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain('made on this computer: how tokens move')
    expect(seen.submitted[0]).toContain('mcp__explain__explain_plan')
    expect(seen.submitted[0]).toContain("If you can't ask, use depth 2.")
    expect(seen.submitted[0]).not.toMatch(/mcp__progress__|made by Learn/)
  })

  test('the first time, says the voice is got too; nothing else is asked', async ($, on) => {
    world(on, { voice: { ready: false, needsSetup: true, setupMb: 350 } })
    expect((await $.command.run({ command: 'explain', args: '', ...RUN })).text).toContain('350 MB, once')
  })

  test('where the voice can’t run, or with no Node, says why before anything is planned', async ($, on) => {
    const { clock, seen } = world(on, { voice: { ready: false, needsSetup: false, reason: 'The video voice needs an Apple Silicon Mac: its engine has no Intel build.' } })
    expect((await $.command.run({ command: 'explain', args: 'x', ...RUN })).text).toContain('Apple Silicon')
    await clock.advance(1_000)
    expect(seen.submitted).toEqual([])
  })

  test('a helper that can’t start (no Node 22) is said, and nothing is planned', async ($, on) => {
    const { clock, seen } = world(on, { voice: { event: 'fatal', error: 'Learn needs Node 22 or newer' } })
    expect((await $.command.run({ command: 'explain', args: 'x', ...RUN })).text).toContain('Node 22')
    await clock.advance(1_000)
    expect(seen.submitted).toEqual([])
  })

  test('with the progress plugin here, stands aside: it neither checks the voice nor submits a brief', async ($, on) => {
    const { clock, seen } = world(on, { commands: [{ name: 'learn', description: 'Open Learn', source: 'plugin', plugin: 'progress@claude-panel' }] })
    await $.command.run({ command: 'explain', args: 'x', ...RUN }).catch(() => undefined)
    await clock.advance(1_000)
    expect(seen.runs).toEqual([])
    expect(seen.submitted).toEqual([])
  })

  test("someone's own /learn command, or another plugin's, doesn't turn it off", async ($, on) => {
    const { clock, seen } = world(on, { commands: [{ name: 'learn', description: 'mine', source: 'user' }, { name: 'learn', description: 'other', source: 'plugin', plugin: 'tutor' }] })
    await $.command.run({ command: 'explain', args: 'x', ...RUN })
    await clock.advance(400)
    expect(seen.submitted).toHaveLength(1)
  })
})

describe('the tool', () => {
  test('the plan goes to the helper on stdin, with depth 2 when it has none, and the reply is one line', async ($, on) => {
    const { seen } = world(on)
    const answer = await $.tool.call({ tool: explainToolName('explain'), ...PLAN, extra: 'dropped' } as never)
    expect(seen.runs.at(-1)?.slice(0, 4)).toEqual(['bash', expect.stringMatching(/learn\/learn\.sh$/), 'explain', 'start'])
    expect(JSON.parse(seen.stdin[0] ?? '{}')).toMatchObject({ title: 'Tokens', depth: 2 })
    expect(seen.stdin[0]).not.toContain('dropped')
    expect(answer).toMatchObject({ result: expect.stringContaining('and /clips opens them as one file.') })
  })

  test('on Windows itself the helper runs in Node, as explain-cli.mjs (there is no learn.mjs here)', async ($, on) => {
    const { seen } = world(on, { windows: true })
    await $.tool.call({ tool: explainToolName('explain'), ...PLAN, depth: 1 } as never)
    expect(seen.runs.at(-1)?.slice(0, 2)).toEqual(['node', expect.stringMatching(/learn\/explain-cli\.mjs$/)])
    expect(JSON.parse(seen.stdin[0] ?? '{}').depth).toBe(1)
  })

  test('what the helper refuses goes back as a list to fix', async ($, on) => {
    world(on, { start: { ok: false, problems: ['Clip 2: a quote that is not in this chat'] } })
    const answer = await $.tool.call({ tool: explainToolName('explain'), ...PLAN } as never)
    expect(JSON.stringify(answer)).toContain('Clip 2: a quote that is not in this chat')
  })
})

describe('notices', () => {
  test('a clip ready is said once in the chat, and the job is on the status line while it runs', async ($, on) => {
    let status = build()
    const { clock, seen } = world(on, { status: () => status })
    await $.tool.call({ tool: explainToolName('explain'), ...PLAN } as never)
    await clock.advance(3_500)
    expect(seen.rows.filter(row => row.includes('1 of 4 clips of "Tokens" are ready'))).toHaveLength(1)
    expect(seen.status.at(-1)).toBe('explain · Tokens: clip 2 of 4, writing')
    await clock.advance(6_000)
    expect(seen.rows).toHaveLength(1)
    expect(seen.hidden).toEqual([])
    status = build({ state: 'done', message: '4 clips ready', done: 4, file: '/home/me/explainers/tokens-abcd.html' })
    await clock.advance(3_500)
    expect(seen.rows.at(-1)).toContain('as one file: ~/explainers/tokens-abcd.html')
    // At the finish Claude is told once too, in a row only it reads.
    expect(seen.hidden).toHaveLength(1)
    expect(seen.hidden[0]).toContain('All 4 clips of \\"Tokens\\" are ready')
    expect(seen.hidden[0]).toContain('~/explainers/tokens-abcd.html')
    await clock.advance(9_000)
    expect(seen.hidden).toHaveLength(1)
    expect(seen.status.at(-1)).toBeUndefined()
  })

  test("a job that stopped says so once, since there's no panel to show it; another chat's is none of this chat's business", async ($, on) => {
    let status = build()
    const { clock, seen } = world(on, { status: () => status })
    await $.tool.call({ tool: explainToolName('explain'), ...PLAN } as never)
    await clock.advance(3_500)
    status = build({ state: 'failed', message: 'Stopped at voice: voice setup failed', done: 1 })
    await clock.advance(3_500)
    await clock.advance(6_000)
    const stops = seen.rows.filter(row => row.includes('Stopped at voice'))
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain('/clips carries on')
    status = build({ explain: 'x202611249999ffff', state: 'failed', message: 'not mine' })
    await clock.advance(3_500)
    expect(seen.rows.join(' ')).not.toContain('not mine')
  })

  test('only a stop before the last clip is a stop: done, running and other builds are none', () => {
    const base = { id: 'j1', kind: 'explain', explain: ID, topic: 'Tokens', step: 'clips', message: 'Paused', done: 1, total: 4 }
    expect(stoppedNotice({ ...base, state: 'paused' }, ID)?.text).toBe('"Tokens": Paused · 1 of 4 clips ready · /clips carries on')
    expect(stoppedNotice({ ...base, state: 'running' }, ID)).toBeNull()
    expect(stoppedNotice({ ...base, state: 'failed', done: 4 }, ID)).toBeNull()
    expect(stoppedNotice({ ...base, state: 'failed', explain: 'x202611249999ffff' }, ID)).toBeNull()
    expect(stoppedNotice({ ...base, state: 'failed', kind: 'video' }, ID)).toBeNull()
    expect(stoppedNotice(null, ID)).toBeNull()
  })
})

describe('/clips', () => {
  const FILE = '/home/me/explainers/tokens-abcd.html'
  test('opens the newest file made here, as a double-click does', async ($, on) => {
    const { seen } = world(on, { latest: { id: ID, title: 'Tokens', file: FILE, ready: 4, clips: 4 } })
    expect((await $.command.run({ command: 'clips', args: '', ...RUN })).text).toBe(`Opened ${FILE}`)
    expect(seen.runs.at(-1)).toEqual(['explorer.exe', '\\\\wsl.localhost\\Ubuntu\\home\\me\\explainers\\tokens-abcd.html'])
    expect(seen.runs.some(argv => argv.includes('resume'))).toBe(false)
  })

  test('opens the one this chat made, carries on making what is missing, and says what is still to come', async ($, on) => {
    const { seen } = world(on, { latest: { id: ID, title: 'Tokens', file: FILE, ready: 2, clips: 4 }, resume: { making: true } })
    await $.tool.call({ tool: explainToolName('explain'), ...PLAN } as never)
    expect((await $.command.run({ command: 'clips', args: '', ...RUN })).text).toBe(`Opened ${FILE} (2 of 4 clips, the rest being made)`)
    expect(seen.runs.some(argv => argv.includes('latest') && argv.includes(ID))).toBe(true)
    expect(seen.runs.some(argv => argv.includes('resume') && argv.includes(ID))).toBe(true)
  })

  test('before its first clip, says so and opens nothing; with nothing made at all, says how', async ($, on) => {
    const { seen } = world(on, { latest: { id: ID, title: 'Tokens', file: null, ready: 0, clips: 4 }, resume: { making: true } })
    expect((await $.command.run({ command: 'clips', args: '', ...RUN })).text).toContain('still being made')
    expect(seen.runs.some(argv => argv[0] === 'explorer.exe')).toBe(false)
  })

  test('with no explainer anywhere, says how to make one', async ($, on) => {
    world(on)
    expect((await $.command.run({ command: 'clips', args: '', ...RUN })).text).toBe('No clips yet: /explain <what> makes some.')
  })
})

describe('the shared pieces', () => {
  test('a file opens by its own platform’s way', () => {
    const path = '/home/me/explainers/a b.html'
    expect(openFileArgv({ path, platform: 'linux', distro: 'Ubuntu' })).toEqual(['explorer.exe', '\\\\wsl.localhost\\Ubuntu\\home\\me\\explainers\\a b.html'])
    expect(openFileArgv({ path: 'C:/Users/me/a.html', platform: 'win32' })).toEqual(['explorer.exe', 'C:\\Users\\me\\a.html'])
    expect(openFileArgv({ path, platform: 'darwin' })).toEqual(['open', path])
    expect(openFileArgv({ path, platform: 'linux' })).toEqual(['xdg-open', path])
  })

  test('the reply names no Learn, and the first run says the voice is being got', () => {
    const answer = { clips: 6, wanted: 4, depth: 2 as const }
    const text = acceptedText(answer, { library: false, firstRun: true })
    expect(text).toContain(FIRST_RUN)
    expect(text).not.toContain('/learn library')
    expect(acceptedText(answer, { library: false })).not.toContain(FIRST_RUN)
  })

  test('each plugin names its own tool in its brief', () => {
    expect(explainBrief('x', { plugin: 'explain' })).toContain('mcp__explain__explain_plan')
    expect(explainBrief('x')).toContain('mcp__progress__explain_plan')
    expect(explainBrief('x')).toContain('made by Learn: x')
  })
})
