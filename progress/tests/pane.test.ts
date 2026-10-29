import { describe, expect, test } from 'claude-code/testing'

import { collapsedLine, fitReleases, frontTab, pageLabel, wrappedRows } from '../hooks/pane'
import type { Tab } from '../hooks/pane'
import { readReleases } from '../hooks/releases'
import type { PhasePlan, TestRun } from '../types'
import { answerHost, COMMAND_RUN, PLAN, RELEASES } from './host'

const PLAN_OF = (title: string): PhasePlan => ({ title, items: PLAN as PhasePlan['items'] })
const RUN = (id: string): TestRun => ({
  id, label: 'pnpm test', isSubagent: false, status: 'passed', done: 3, passed: 3, failed: 0, skipped: 0, total: 3, estimate: null,
})
const BUILDING = { build: { id: 'j1', topic: 'DevOps', step: 'pages', state: 'running' as const, message: 'Writing', done: 1, total: 4 }, course: null }

// The pane, as a docked Claude Code pane draws it.
const PANE = {
  plugin: 'progress',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

describe('the tab in front', () => {
  test('a clicked tab stays in front where the old rules snapped it back', () => {
    // No plan and a run: Tests used to win over a click on Phases at once.
    const runs = [RUN('r1')]
    expect(frontTab({ current: 'phases', manual: 'phases', plan: null, runs, learn: null, lastFocus: 'r1', lastPlanTitle: null })).toEqual({
      tab: 'phases',
      manual: 'phases',
    })
    // Only a build going: Learn used to win over a click on Tests.
    expect(frontTab({ current: 'tests', manual: 'tests', plan: null, runs: [], learn: BUILDING, lastFocus: null, lastPlanTitle: null })).toEqual({
      tab: 'tests',
      manual: 'tests',
    })
  })

  test('a new run brings Tests forward and lets go of the clicked tab', () => {
    const front = frontTab({ current: 'learn', manual: 'learn', plan: null, runs: [RUN('r1'), RUN('r2')], learn: null, lastFocus: 'r1', lastPlanTitle: null })
    expect(front).toEqual({ tab: 'tests', manual: null })
  })

  test('a new plan brings Phases forward and lets go of the clicked tab; the same plan again does not', () => {
    const plan = PLAN_OF('Ship it')
    expect(frontTab({ current: 'releases', manual: 'releases', plan, runs: [], learn: null, lastFocus: null, lastPlanTitle: null })).toEqual({
      tab: 'phases',
      manual: null,
    })
    expect(frontTab({ current: 'learn', manual: 'learn', plan, runs: [], learn: null, lastFocus: null, lastPlanTitle: 'Ship it' })).toEqual({
      tab: 'learn',
      manual: 'learn',
    })
  })

  test('with no click the old rules hold', () => {
    const plan = PLAN_OF('Ship it')
    const base = { manual: null, learn: null, lastFocus: 'r1', lastPlanTitle: 'Ship it' }
    expect(frontTab({ ...base, current: 'phases', plan: null, runs: [RUN('r1')] }).tab).toBe('tests')
    expect(frontTab({ ...base, current: 'tests', plan, runs: [] }).tab).toBe('phases')
    expect(frontTab({ ...base, current: 'tests', plan: null, runs: [], learn: BUILDING }).tab).toBe('learn')
    expect(frontTab({ ...base, current: 'phases', plan, runs: [RUN('r1')] }).tab).toBe('phases')
  })

  test('Releases is never brought forward for the person', () => {
    const plans = [null, PLAN_OF('Ship it')]
    const runLists = [[], [RUN('r1')], [RUN('r1'), RUN('r2')]]
    const learns = [null, BUILDING]
    const currents: Tab[] = ['phases', 'tests', 'learn']
    for (const plan of plans)
      for (const runs of runLists)
        for (const learn of learns)
          for (const current of currents)
            for (const lastFocus of [null, 'r1'])
              for (const lastPlanTitle of [null, 'Ship it'])
                expect(frontTab({ current, manual: null, plan, runs, learn, lastFocus, lastPlanTitle }).tab).not.toBe('releases')
  })

  test('the inline pane says the newest release in one line', () => {
    expect(collapsedLine('releases', null, [], null, readReleases(RELEASES))).toBe(
      '0.2.0 · 29 Oct · Mahmood: macOS: the panel floats with the terminal',
    )
    expect(collapsedLine('releases', null, [], null, [])).toBe('No releases listed.')
  })

  test('an inline pane shows the releases that fit, the newest always', () => {
    const release = (version: string, notes: number) => ({ version, date: '2026-10-29', by: 'Yousif', notes: Array(notes).fill('n') as string[] })
    const list = [release('0.3.0', 3), release('0.2.0', 2), release('0.1.0', 3)]
    // 4 rows, a gap, 3 rows, a gap, 4 rows: all three in 13.
    expect(fitReleases(list, 13).map(one => one.version)).toEqual(['0.3.0', '0.2.0', '0.1.0'])
    // In 10 the third is left out and its "+1 earlier" line takes a row: the first two still fit in the 9 left.
    expect(fitReleases(list, 10).map(one => one.version)).toEqual(['0.3.0', '0.2.0'])
    // In 8 the first two would fit alone, but not with the "+1 earlier" line under them.
    expect(fitReleases(list, 8).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases(list, 2).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases([], 8)).toEqual([])
    // In a narrow pane a long note wraps: the second release no longer fits.
    const long = [{ ...release('0.3.0', 0), notes: ['x'.repeat(60)] }, release('0.2.0', 2)]
    expect(fitReleases(long, 6, 32).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases(long, 6).map(one => one.version)).toEqual(['0.3.0', '0.2.0'])
  })

  test('a line is counted in the rows it wraps to, broken between words', () => {
    expect(wrappedRows('aaa bbb ccc', 7)).toBe(2)
    expect(wrappedRows('aaa bbb ccc', 11)).toBe(1)
    // Words go whole to the next row: 17 characters over 9 cells, but three rows, not two.
    expect(wrappedRows('aaaaa bbbbb ccccc', 9)).toBe(3)
    // A word longer than the row runs on over the next.
    expect(wrappedRows('x'.repeat(25), 10)).toBe(3)
    expect(wrappedRows('', 10)).toBe(1)
    expect(wrappedRows('anything at all', 0)).toBe(1)
  })

  test('pages are named for people', () => {
    expect(pageLabel('learn')).toBe('Learn')
    expect(pageLabel('games')).toBe('the games')
    expect(pageLabel('games/chess')).toBe('Chess')
  })
})

describe('the pane', () => {
  test('the version is the fourth tab, dotted until it is opened, and opening it remembers the version', async ($, on) => {
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    for (const surface of SURFACES) {
      const before = await $.ui.mount({ ...PANE, surface })
      expect((await before.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0 ●')
      await before.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:releases' })
    // The press writes the seen version to the store before it redraws.
    await clock.settle()
    await ui.unmount()

    for (const surface of SURFACES) {
      const after = await $.ui.mount({ ...PANE, surface })
      expect((await after.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0')
      expect((await after.find({ key: 'tab:releases' }))?.props.variant).toBe('primary')
      expect((await after.find({ type: 'Text', text: /29 Oct · Mahmood/ }))?.text).toContain(' · 29 Oct · Mahmood')
      expect(await after.find({ type: 'Text', text: /macOS: the panel floats with the terminal/ })).toBeDefined()
      expect(await after.find({ type: 'Text', text: /27 Oct · Yousif/ })).toBeDefined()
      await after.unmount()
    }
  })

  test('a version seen in an earlier session shows no dot', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', store: { seenRelease: '0.2.0' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0')
    await ui.unmount()
  })

  test('inline, the Releases tab draws only what the rows the layout gave it hold, and says how many it left out', async ($, on) => {
    const entry = (version: string) => ({ version, date: '2026-10-29', by: 'Yousif', notes: ['one note', 'two notes', 'three notes'] })
    const releases = JSON.stringify({ v: 1, releases: [entry('0.3.0'), entry('0.2.0'), entry('0.1.0')] })
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', releases, manifest: JSON.stringify({ version: '0.3.0' }) })
    const inline = (bodyRows: number) => ({ ...PANE, surface: 'terminal' as const, props: { ...PANE.props, placement: 'inline' as const, scroll: { offset: 0, bodyRows } } })
    const ui = await $.ui.mount(inline(11))
    await ui.press({ key: 'tab:releases' })
    await clock.settle()
    await ui.unmount()

    // 11 rows: the tabs and a gap, then 0.3.0's four and "+2 earlier" under them (0.2.0 would need five more).
    const tight = await $.ui.mount(inline(11))
    expect(await tight.find({ type: 'Text', text: /0\.3\.0/ })).toBeDefined()
    expect(await tight.find({ type: 'Text', text: /0\.2\.0/ })).toBeUndefined()
    expect(await tight.find({ type: 'Text', text: /\+2 earlier/ })).toBeDefined()
    await tight.unmount()

    // 17 rows hold all three, so nothing says any were left out.
    const roomy = await $.ui.mount(inline(17))
    expect(await roomy.find({ type: 'Text', text: /0\.1\.0/ })).toBeDefined()
    expect(await roomy.find({ type: 'Text', text: /earlier/ })).toBeUndefined()
    await roomy.unmount()
  })

  test('inline with few rows, the Learn tab drops the build bar first, then its message, never the buttons', async ($, on) => {
    const learnStatus = JSON.stringify({
      v: 1,
      at: '2026-10-27T10:00:00.000Z',
      build: { id: 'j1', topic: 'DevOps', step: 'pages', state: 'running', message: 'Writing page 4/12', done: 4, total: 12 },
      course: { id: 'devops-1a2b', title: 'DevOps basics', page: 4, total: 12, next: 'Rollbacks' },
    })
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', learnStatus })
    await clock.advance(3_500)
    await clock.settle()
    const inline = (bodyRows: number) => ({ ...PANE, surface: 'terminal' as const, props: { ...PANE.props, placement: 'inline' as const, scroll: { offset: 0, bodyRows } } })
    const ui = await $.ui.mount(inline(10))
    await ui.press({ key: 'tab:learn' })
    await ui.unmount()

    // 10 rows: the tabs and a gap, then all eight.
    const roomy = await $.ui.mount(inline(10))
    expect(await roomy.find({ type: 'Text', text: /Writing page 4\/12/ })).toBeDefined()
    expect(await roomy.find({ type: 'Text', text: /4\/12 pages/ })).toBeDefined()
    await roomy.unmount()

    // 9: the bar goes.
    const nine = await $.ui.mount(inline(9))
    expect(await nine.find({ type: 'Text', text: /Writing page 4\/12/ })).toBeDefined()
    expect(await nine.find({ type: 'Text', text: /4\/12 pages/ })).toBeUndefined()
    await nine.unmount()

    // 8: the message goes too; the topic, the course and every button stay.
    const eight = await $.ui.mount(inline(8))
    expect(await eight.find({ type: 'Text', text: /Writing page/ })).toBeUndefined()
    expect(await eight.find({ type: 'Text', text: /^DevOps$/ })).toBeDefined()
    expect(await eight.find({ type: 'Text', text: /DevOps basics/ })).toBeDefined()
    expect((await eight.find({ key: 'open:learn' }))?.text).toBe('Carry on reading')
    expect((await eight.findAll({ type: 'Button' })).filter(button => (button.key ?? '').startsWith('game:'))).toHaveLength(4)
    await eight.unmount()
  })

  test('a clicked tab stays through an update of the same plan; a new plan takes the front', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:learn' })
    await ui.unmount()

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN.map(p => ({ ...p, status: 'done' })) })
    const same = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await same.find({ key: 'tab:learn' }))?.props.variant).toBe('primary')
    await same.unmount()

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship the next thing', phases: PLAN })
    const fresh = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await fresh.find({ key: 'tab:phases' }))?.props.variant).toBe('primary')
    expect((await fresh.find({ key: 'tab:learn' }))?.props.variant).toBeUndefined()
    await fresh.unmount()
  })

  test('the phase in progress is marked [●], not the collapsed ▸', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /\[●\] API/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▸/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the Learn tab opens Learn from its own row, and each game from the games row', async ($, on) => {
    // WSL in another terminal: the pane, and the WPF windows (unowned: no panel named a window).
    const { clock, host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:learn' })
    await ui.unmount()

    const learnTab = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await learnTab.find({ key: 'open:learn' }))?.text).toBe('Open Learn')
    const keys = (await learnTab.findAll({ type: 'Button' })).map(button => button.key ?? '')
    expect(keys.filter(key => key.startsWith('game:'))).toEqual(['game:sudoku', 'game:2048', 'game:typing', 'game:chess'])
    await learnTab.press({ key: 'game:chess' })
    // The window opens in the background of the press.
    await clock.settle()
    const launched = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(launched.join(' ')).toContain('ChessPuzzles.ps1')
    expect(launched).not.toContain('-OwnerHwnd')
    await learnTab.unmount()
  })
})

describe('/learn and /games', () => {
  test('/learn settings opens Learn at Settings, owned by the WezTerm window the panel follows', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', hwnd: 1312 })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await clock.settle()

    expect(await $.command.run({ command: 'learn', args: 'settings', ...COMMAND_RUN })).toMatchObject({ text: 'Opening Learn (settings).' })
    const learn = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(learn.join(' ')).toContain('Learn.ps1')
    expect(learn).toEqual(expect.arrayContaining(['-View', 'settings', '-OwnerHwnd', '1312']))

    await $.command.run({ command: 'games', args: 'sudoku', ...COMMAND_RUN })
    const game = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(game.join(' ')).toContain('Sudoku.ps1')
    expect(game).toEqual(expect.arrayContaining(['-OwnerHwnd', '1312']))
    expect(game).not.toContain('-View')
  })

  test('/learn with a view it does not have says which it has and opens nothing', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up' })
    const answer = await $.command.run({ command: 'learn', args: 'courses', ...COMMAND_RUN })
    expect(answer).toMatchObject({ text: 'Learn has no view called "courses". Views: library, course, learned, ask, settings.' })
    expect(host.runs.filter(argv => argv[0] === 'bash')).toEqual([])
  })

  test('/games with no name lists the games on WSL, and opens the games page elsewhere', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up' })
    expect(await $.command.run({ command: 'games', args: '', ...COMMAND_RUN })).toMatchObject({
      text: 'Games: sudoku, 2048, typing, chess. Try /games sudoku.',
    })
    expect(host.runs.filter(argv => argv[0] === 'bash')).toEqual([])
  })

  test('off WSL, /games opens the games page and /learn ask opens Learn at Ask, following the terminal', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', mac: true })
    await $.command.run({ command: 'games', args: '', ...COMMAND_RUN })
    await $.command.run({ command: 'learn', args: 'ask', ...COMMAND_RUN })
    const opens = host.runs.filter(argv => argv[0] === 'bash' && argv[2] === 'open')
    expect(opens[0]).toEqual(['bash', expect.stringContaining('/web/web.sh'), 'open', 'games', '--terminal', 'iTerm.app', '--iterm-session', 'w0t1p0:ABC-123'])
    expect(opens[1]).toEqual([
      'bash', expect.stringContaining('/web/web.sh'), 'open', 'learn', '--view', 'ask', '--terminal', 'iTerm.app', '--iterm-session', 'w0t1p0:ABC-123',
    ])
  })
})
