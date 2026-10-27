import { describe, expect, test } from 'claude-code/testing'

import { isLearnBusy, learnStatusPath, readLearnStatus } from '../hooks/learn'
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
