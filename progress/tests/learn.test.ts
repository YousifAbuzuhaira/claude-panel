import { describe, expect, test } from 'claude-code/testing'

import { courseArgv, isLearnBusy, learnStatusPath, readLearnStatus } from '../hooks/learn'
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
