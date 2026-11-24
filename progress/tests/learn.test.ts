import { describe, expect, test } from 'claude-code/testing'

import { acceptedText, EXPLAIN_TOOL, EXPLAIN_TOOL_DESCRIPTION, EXPLAIN_TOOL_SCHEMA, explainArgv, explainBrief, readExplainAnswer, refusalText } from '../hooks/explain'
import { courseArgv, isLearnBusy, learnStatusPath, readLearnStatus, readyNote, readyNotice } from '../hooks/learn'
import { panelState } from '../hooks/widget'
import { answerHost, PLAN, STATE } from './host'

const AT = '2026-10-27T10:00:00.000Z'
const NOW = Date.parse(AT)
const BUILDING = JSON.stringify({
  v: 1,
  at: AT,
  build: { id: 'j1', topic: 'DevOps', step: 'pages', state: 'running', message: 'Writing page 4/12', done: 4, total: 12 },
  course: null,
})
const READING = JSON.stringify({
  v: 1,
  at: AT,
  build: { id: 'j1', topic: 'DevOps', step: 'done', state: 'done', message: 'Ready: DevOps basics', done: 12, total: 12 },
  course: { id: 'devops-1a2b', title: 'DevOps basics', page: 4, total: 12, next: 'Rollbacks' },
})

describe('Learn status file', () => {
  test('a running build is read whole and keeps the panel up', () => {
    const status = readLearnStatus(BUILDING, NOW)
    expect(status?.build).toMatchObject({ topic: 'DevOps', state: 'running', done: 4, total: 12 })
    expect(status?.course).toBeNull()
    expect(isLearnBusy(status)).toBe(true)
  })

  test('a finished build shows for an hour, then only the course is left', () => {
    expect(readLearnStatus(READING, NOW + 10 * 60_000)?.build?.state).toBe('done')
    const later = readLearnStatus(READING, NOW + 2 * 60 * 60_000)
    expect(later?.build).toBeNull()
    expect(later?.course).toMatchObject({ title: 'DevOps basics', page: 4, next: 'Rollbacks' })
    expect(isLearnBusy(later)).toBe(false)
  })

  test("an explainer's build keeps its kind and the explainer it makes, for Watch clips; a bad id or another kind has none", () => {
    const explaining = (build: Record<string, unknown>) => readLearnStatus(JSON.stringify({ v: 1, at: AT, build: { id: 'j2', topic: 'Tokens', step: 'clips', state: 'running', message: 'clip 1 of 3', done: 0, total: 3, ...build }, course: null }), NOW)?.build
    expect(explaining({ kind: 'explain', explain: 'x202611181332459e' })).toMatchObject({ kind: 'explain', explain: 'x202611181332459e' })
    expect(explaining({ kind: 'explain', explain: '../x' })?.explain).toBeNull()
    expect(explaining({ kind: 'video', explain: 'x202611181332459e' })?.explain).toBeNull()
  })

  test('nonsense, half a write, or an unknown state reads as nothing', () => {
    expect(readLearnStatus('', NOW)).toBeNull()
    expect(readLearnStatus('{"v":1,"build":{"state":"runn', NOW)).toBeNull()
    expect(readLearnStatus(JSON.stringify({ v: 1, at: AT, build: { state: 'exploded' }, course: null }), NOW)).toBeNull()
  })

  test('the path is under the home folder, and the panel state carries it', () => {
    expect(learnStatusPath('/home/me')).toBe('/home/me/.config/claude-learn/status.json')
    const state = JSON.parse(panelState('s', null, [], readLearnStatus(BUILDING, NOW)))
    expect(state.learn.build).toMatchObject({ topic: 'DevOps', done: 4 })
  })
})

describe('Learn in a session', () => {
  test('a build going on brings the panel up with no plan and no tests', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', learnStatus: BUILDING })
    await clock.advance(3_500)
    await clock.settle()
    expect(host.spawned.length).toBe(1)
    expect(host.panel()).toMatchObject({ plan: null, runs: [] })
    expect((host.panel() as unknown as { learn: { build: { state: string } } }).learn.build.state).toBe('running')
  })

  test('a course alone does not open the panel, but rides along when a plan does', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', learnStatus: READING })
    await clock.advance(3_500)
    await clock.settle()
    expect(host.spawned.length).toBe(0)
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned.length).toBe(1)
    const written = host.writes.filter(write => write.path === STATE).at(-1)
    expect(JSON.parse(written?.text ?? '{}').learn.course).toMatchObject({ title: 'DevOps basics' })
  })

  test("with CLAUDE_PROGRESS_OFF=1 (Learn's own Claude runs) the mod stays out", async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up', off: true, learnStatus: BUILDING })
    let command = ''
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      command = e.command
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    expect(command).toBe('pnpm test')
    const ask = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
    const composed = await $.prompt.compose({ ...ask, tools: ['mcp__progress__phases_write'] })
    expect(composed.sections.some(section => section.id === 'progress:phases')).toBe(false)
    expect(host.spawned).toEqual([])
  })
})

describe('/course', () => {
  test('starts a build from this chat about the focus, through the helper', () => {
    expect(courseArgv({ pluginRoot: '/p', sessionId: 'abc-123', focus: '  how we fixed\nthe browser link ' })).toEqual([
      'bash', '/p/learn/learn.sh', 'build', 'start', '--chat', 'abc-123', '--audience', 'self', '--focus', 'how we fixed the browser link',
    ])
  })

  test('a course made from inside the chat is for the one who was in it, unless a teammate is named', () => {
    expect(courseArgv({ pluginRoot: '/p', sessionId: 's', focus: 'x' })).toContain('self')
    const argv = courseArgv({ pluginRoot: '/p', sessionId: 's', focus: 'x', audience: 'team' })
    expect(argv[argv.indexOf('--audience') + 1]).toBe('team')
  })

  test('on Windows itself Node runs the helper straight: bash there is WSL\'s launcher', () => {
    expect(courseArgv({ pluginRoot: 'C:\\p', sessionId: 's', focus: '/api routes', isWindows: true })).toEqual([
      'node', 'C:\\p/learn/learn.mjs', 'build', 'start', '--chat', 's', '--audience', 'self', '--focus', '/api routes',
    ])
  })

  test('a focus that starts with dashes is not read as a flag; a long one is cut', () => {
    expect(courseArgv({ pluginRoot: '/p', sessionId: 's', focus: '--mode auto' }).at(-1)).toBe('mode auto')
    expect(courseArgv({ pluginRoot: '/p', sessionId: 's', focus: 'x'.repeat(500) }).at(-1)).toHaveLength(300)
  })
})

describe('/explain', () => {
  test("the tool is explain_plan, and an anchor may name a file anywhere under home, never a secret", () => {
    expect(EXPLAIN_TOOL).toBe('explain_plan')
    const anchor = EXPLAIN_TOOL_SCHEMA.properties.clips.items.properties.anchors.items.properties.file.description
    expect(anchor).toContain('home folder')
    expect(anchor).toContain('secrets are refused')
  })

  test('the plan goes to the helper with this chat and its folder; on Windows Node runs it', () => {
    expect(explainArgv({ pluginRoot: '/p', sessionId: 's', cwd: '/work' })).toEqual(['bash', '/p/learn/learn.sh', 'explain', 'start', '--session', 's', '--cwd', '/work'])
    expect(explainArgv({ pluginRoot: 'C:\\p', sessionId: 's', cwd: 'C:\\w', isWindows: true })[0]).toBe('node')
  })

  test("the helper's last line says the explainer started, or what to fix; anything else is no answer", () => {
    // A 0.17 helper's line: no depth, every clip wanted.
    expect(readExplainAnswer('checking\n{"ok":true,"id":"x202611181332459e","clips":3}')).toEqual({ ok: true, id: 'x202611181332459e', clips: 3, wanted: 3, depth: null })
    expect(readExplainAnswer('{"ok":true,"id":"x202611181332459e","clips":6,"wanted":4,"depth":2}')).toEqual({ ok: true, id: 'x202611181332459e', clips: 6, wanted: 4, depth: 2 })
    expect(readExplainAnswer('{"ok":true,"id":"x202611181332459e","clips":6,"depth":7}')).toMatchObject({ depth: null })
    expect(readExplainAnswer('{"ok":false,"problems":["Clip 2: moved",3]}')).toEqual({ ok: false, problems: ['Clip 2: moved'] })
    expect(readExplainAnswer('{"ok":true,"id":"../x"}')).toBeNull()
    expect(readExplainAnswer('learn: that is not a chat id')).toBeNull()
    expect(refusalText(['a', 'b'])).toBe(`Learn refused the plan. Fix these and call ${EXPLAIN_TOOL} again:\n- a\n- b`)
  })

  test('the plan may carry the depth picked in the chat, 1 to 3, and nothing says the player opens', () => {
    const depth = EXPLAIN_TOOL_SCHEMA.properties.depth
    expect(depth).toMatchObject({ type: 'integer', enum: [1, 2, 3] })
    expect(EXPLAIN_TOOL_SCHEMA.required).not.toContain('depth')
    expect(EXPLAIN_TOOL_DESCRIPTION).not.toMatch(/opens the player/)
    expect(EXPLAIN_TOOL_DESCRIPTION).toContain('Nothing opens by itself')
  })

  test('when Learn takes the plan, nothing has opened, and the session replies with one line naming /clips and the Library', () => {
    const picked = acceptedText({ clips: 6, wanted: 4, depth: 2 })
    expect(picked).toContain('making 4 clips (of 6; depth: the mechanism)')
    expect(picked).toContain('Nothing was opened')
    expect(picked).toContain('"Making 4 clips, the first in about 3 minutes; a notice here says when each is ready. /clips opens them; /learn library lists every explainer."')
    const unpicked = acceptedText({ clips: 1, wanted: 1, depth: null })
    expect(unpicked).toContain('1 clip; the player will ask how deep to go')
    expect(unpicked).toContain('"Making 1 clip,')
  })

  test("a notice in the chat says when more of the explainer it asked for are ready; never another chat's, never twice", () => {
    const build = (done: number, total: number, explain = 'x202611181332459e') => ({ id: 'j2', kind: 'explain', explain, topic: 'Tokens', step: 'clips', state: 'running' as const, message: '', done, total })
    expect(readyNotice(build(1, 4), 'x202611181332459e', 0)).toEqual({ done: 1, text: '1 of 4 clips of "Tokens" are ready · /clips opens them' })
    expect(readyNotice(build(1, 4), 'x202611181332459e', 1)).toBeNull()
    expect(readyNotice(build(1, 1), 'x202611181332459e', 0)?.text).toBe('The clip of "Tokens" is ready · /clips opens it')
    expect(readyNotice(build(2, 4, 'x202611200000bbbb'), 'x202611181332459e', 0)).toBeNull()
    expect(readyNotice(build(2, 4), null, 0)).toBeNull()
    expect(readyNotice({ ...build(2, 4), kind: 'video' }, 'x202611181332459e', 0)).toBeNull()
    expect(readyNotice(null, 'x202611181332459e', 0)).toBeNull()
  })

  test('Claude is told when the last clip is ready, and only then: what, where, and that there is nothing to do', () => {
    const build = (done: number, total: number, file: string | null = '/home/me/explainers/tokens-459e.html') => ({ id: 'j2', kind: 'explain', explain: 'x202611181332459e', file, topic: 'Tokens', step: 'clips', state: 'running' as const, message: '', done, total })
    expect(readyNote(build(3, 4), '/home/me')).toBeNull()
    expect(readyNote(build(0, 0), '/home/me')).toBeNull()
    expect(readyNote(null)).toBeNull()
    expect(readyNote(build(4, 4), '/home/me')).toContain('All 4 clips of "Tokens" are ready, as one file: ~/explainers/tokens-459e.html')
    expect(readyNote(build(1, 1), '/home/me')).toContain('The clip of "Tokens" is ready')
    expect(readyNote(build(4, 4, null))).not.toContain('as one file')
    expect(readyNote(build(4, 4))).toMatch(/not typed by the person.*nothing to do/)
  })

  test('the last notice names the file you can pass on, under home as ~; earlier ones and other builds have none', () => {
    const file = '/home/me/explainers/tokens-459e.html'
    const build = (done: number, total: number) => ({ id: 'j2', kind: 'explain', explain: 'x202611181332459e', file, topic: 'Tokens', step: 'clips', state: 'running' as const, message: '', done, total })
    expect(readyNotice(build(4, 4), 'x202611181332459e', 3, '/home/me')?.text).toBe('4 of 4 clips of "Tokens" are ready · /clips opens them · as one file: ~/explainers/tokens-459e.html')
    expect(readyNotice(build(1, 1), 'x202611181332459e', 0, '/home/other')?.text).toBe(`The clip of "Tokens" is ready · /clips opens it · as one file: ${file}`)
    expect(readyNotice(build(2, 4), 'x202611181332459e', 1, '/home/me')?.text).not.toContain('file')
    const raw = (b: Record<string, unknown>) => JSON.stringify({ at: new Date(0).toISOString(), build: { id: 'j2', topic: 'Tokens', step: 'clips', state: 'running', done: 1, total: 2, ...b } })
    expect(readLearnStatus(raw({ kind: 'explain', explain: 'x202611181332459e', file }), 0)?.build?.file).toBe(file)
    expect(readLearnStatus(raw({ kind: 'explain', explain: 'x202611181332459e', file: '/etc/passwd' }), 0)?.build?.file).toBeNull()
    expect(readLearnStatus(raw({ kind: 'video', file }), 0)?.build?.file).toBeNull()
  })

  test("/explain's brief: what you typed, one line first, the depth asked in the chat, then the tool with it", () => {
    const brief = explainBrief('  how the gateway\n mints tokens ')
    expect(brief.split('\n')[0]).toBe('Explain this to me as short narrated video clips, made by Learn: how the gateway mints tokens')
    expect(explainBrief('')).toContain('made by Learn: what we are working on')
    expect(brief).toContain('First reply with one short line')
    expect(brief).toContain('write the whole plan and hold it')
    expect(brief).toContain('AskUserQuestion')
    expect(brief).toContain('"How deep should it go?"')
    expect(brief).toContain(`mcp__progress__${EXPLAIN_TOOL} with the plan and "depth"`)
    expect(brief).toContain('at most 18 lines')
    expect(brief).toContain('Nothing opens by itself')
    expect(brief).not.toContain('$ARGUMENTS')
  })
})
