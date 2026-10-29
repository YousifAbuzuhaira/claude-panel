import { describe, expect, test } from 'claude-code/testing'

import { GAMES, isGame, openingText, pageLabel, windowScript } from '../hooks/pages'
import { collapsedLine, fitReleases, fitRuns, fitTabs, frontTab, shortTabLabels, tabLabels, wrappedRows } from '../hooks/pane'
import type { Tab } from '../hooks/pane'
import { readReleases } from '../hooks/releases'
import type { PhasePlan, TestRun } from '../types'
import { VITEST_PASS } from './fixtures'
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

// Learn's status file with a course in front and no build going.
const COURSE_STATUS = JSON.stringify({
  v: 1,
  at: '2026-10-27T10:00:00.000Z',
  build: null,
  course: { id: 'devops-1a2b', title: 'DevOps basics', page: 4, total: 12, next: 'Rollbacks' },
})

// The tab in front is drawn bold, the others plain: every tab keeps its width.
const isFront = (found: { children: unknown[] } | undefined) =>
  (found?.children ?? []).some(child => {
    const props = (child as { props?: Record<string, unknown> } | null)?.props
    return props?.bold === true || props?.weight === 'semibold' || props?.weight === 'bold'
  })

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
    expect(frontTab({ current: 'learn', manual: 'learn', plan, runs: [], learn: null, lastFocus: null, lastPlanTitle: null })).toEqual({
      tab: 'phases',
      manual: null,
    })
    expect(frontTab({ current: 'learn', manual: 'learn', plan, runs: [], learn: null, lastFocus: null, lastPlanTitle: 'Ship it' })).toEqual({
      tab: 'learn',
      manual: 'learn',
    })
  })

  test('Releases, once opened, stays through a new plan and a new run until another tab is picked', () => {
    const plan = PLAN_OF('Ship it')
    expect(frontTab({ current: 'releases', manual: 'releases', plan, runs: [], learn: null, lastFocus: null, lastPlanTitle: null })).toEqual({
      tab: 'releases',
      manual: 'releases',
    })
    expect(
      frontTab({ current: 'releases', manual: 'releases', plan: null, runs: [RUN('r1'), RUN('r2')], learn: BUILDING, lastFocus: 'r1', lastPlanTitle: null }),
    ).toEqual({ tab: 'releases', manual: 'releases' })
    // Picked away from it later: that run is no longer new, so the picked tab stays.
    expect(frontTab({ current: 'releases', manual: 'learn', plan: null, runs: [RUN('r1'), RUN('r2')], learn: null, lastFocus: 'r2', lastPlanTitle: null })).toEqual({
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
    // The version and its first note, as the WPF panel's collapsed line reads: no author to read as the speaker.
    expect(collapsedLine('releases', null, [], null, readReleases(RELEASES))).toBe('v0.2.0 · macOS: the panel floats with the terminal')
    expect(collapsedLine('releases', null, [], null, [{ version: '0.1.1', date: '2026-10-27', by: 'Yousif', notes: [] }])).toBe(
      '0.1.1 · 27 Oct · Yousif',
    )
    expect(collapsedLine('releases', null, [], null, [])).toBe('No releases listed.')
  })

  test('an inline pane shows the releases that fit, the newest always', () => {
    const release = (version: string, notes: number) => ({ version, date: '2026-10-29', by: 'Yousif', notes: Array(notes).fill('n') as string[] })
    const list = [release('0.3.0', 3), release('0.2.0', 2), release('0.1.0', 3)]
    // A heading row and a row per short note: 4 rows, a gap, 3 rows, a gap, 4 rows: all three in 13.
    expect(fitReleases(list, 13).map(one => one.version)).toEqual(['0.3.0', '0.2.0', '0.1.0'])
    // In 10 the third is left out and its "+1 earlier" line takes a row: the first two still fit in the 9 left.
    expect(fitReleases(list, 10).map(one => one.version)).toEqual(['0.3.0', '0.2.0'])
    // In 8 the first two would fit alone, but not with the "+1 earlier" line under them.
    expect(fitReleases(list, 8).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases(list, 2).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases([], 8)).toEqual([])
    // In a narrow pane a long note wraps under its own text, 4 cells in (28 of 32): 3 rows, so the second release no longer fits.
    const long = [{ ...release('0.3.0', 0), notes: ['x'.repeat(60)] }, release('0.2.0', 2)]
    expect(fitReleases(long, 6, 32).map(one => one.version)).toEqual(['0.3.0'])
    expect(fitReleases(long, 6).map(one => one.version)).toEqual(['0.3.0', '0.2.0'])
    // The heading is cut to one row, however narrow: only the notes wrap.
    const wordy = [{ version: '0.3.0', date: '2026-10-30', by: 'Somebody With A Long Name', notes: ['n'] }, release('0.2.0', 1)]
    expect(fitReleases(wordy, 5, 20).map(one => one.version)).toEqual(['0.3.0', '0.2.0'])
  })

  test('an inline pane shows the newest runs the room holds, the totals line when it fits too', () => {
    expect(fitRuns(4, 10)).toEqual({ shown: 4, hasFooter: true })
    expect(fitRuns(4, 5)).toEqual({ shown: 2, hasFooter: true })
    expect(fitRuns(4, 4)).toEqual({ shown: 1, hasFooter: true })
    // Two rows: one run, and no totals line cut in half under it.
    expect(fitRuns(4, 2)).toEqual({ shown: 1, hasFooter: false })
    expect(fitRuns(4, 1)).toEqual({ shown: 1, hasFooter: false })
    expect(fitRuns(0, 8)).toEqual({ shown: 0, hasFooter: false })
  })

  test('the tab row gives up counts, Learn first and a live test count last, before it wraps', () => {
    const live: TestRun = { ...RUN('r1'), status: 'running', done: 1234, total: 5678, passed: 1234 }
    const plan: PhasePlan = { title: 'Ship it', items: Array.from({ length: 14 }, (_, i) => ({ name: `p${i}`, status: i < 12 ? 'done' : 'todo' })) }
    const learn = { build: { ...BUILDING.build, done: 12, total: 40 }, course: null }
    const full = tabLabels(plan, [live], learn)
    const short = shortTabLabels([live], learn)
    expect(full).toEqual({ phases: 'Phases 12/14', tests: 'Tests ● 1234/5678', learn: 'Learn 12/40' })
    expect(short).toEqual({ phases: 'Phases', tests: 'Tests ●', learn: 'Learn ●' })
    // 12 + 17 + 11, three gaps of 2 and 'v0.3.0' with room for its ' ●': 54 cells.
    expect(fitTabs(full, short, 'v0.3.0', 54)).toEqual({ labels: full, rows: 1 })
    expect(fitTabs(full, short, 'v0.3.0', 53)).toEqual({ labels: { ...full, learn: 'Learn ●' }, rows: 1 })
    // 52 holds the full labels and the bare version, but the dot's room is kept whether it
    // shows or not, so clearing it never brings a count back.
    expect(fitTabs(full, short, 'v0.3.0', 52)).toEqual({ labels: { ...full, learn: 'Learn ●' }, rows: 1 })
    expect(fitTabs(full, short, 'v0.3.0', 46)).toEqual({ labels: { ...full, phases: 'Phases', learn: 'Learn ●' }, rows: 1 })
    expect(fitTabs(full, short, 'v0.3.0', 34)).toEqual({ labels: short, rows: 1 })
    // Narrower still, the version goes to a row of its own.
    expect(fitTabs(full, short, 'v0.3.0', 30)).toEqual({ labels: short, rows: 2 })
    // The width unknown: the full labels on one row.
    expect(fitTabs(full, short, 'v0.3.0', 0)).toEqual({ labels: full, rows: 1 })
    // A finished run keeps its mark when short.
    expect(shortTabLabels([{ ...RUN('r1'), status: 'failed' }], null)).toEqual({ phases: 'Phases', tests: 'Tests ✗', learn: 'Learn' })
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

  test('one list of pages gives the games, their WPF windows and their names', () => {
    expect(GAMES.map(game => game.id)).toEqual(['sudoku', '2048', 'typing', 'chess'])
    expect(GAMES.map(game => game.label)).toEqual(['Sudoku', '2048', 'Typing', 'Chess'])
    expect(isGame('2048')).toBe(true)
    expect(isGame('learn')).toBe(false)
    expect(windowScript('learn')).toBe('Learn.ps1')
    expect(windowScript('games/typing')).toBe('TypeTest.ps1')
    // The games page is a web page alone: no WPF window behind it.
    expect(windowScript('games')).toBeUndefined()
    expect(windowScript('nothing')).toBeUndefined()
  })

  test('a course opens by its title in the message; a view by its name', () => {
    expect(openingText('learn', { view: 'course', courseTitle: 'DevOps basics' }, false)).toBe('Opening DevOps basics in Learn.')
    expect(openingText('learn', { view: 'course', courseTitle: 'DevOps basics' }, true)).toBe("Opened DevOps basics in Learn's window.")
    expect(openingText('learn', { view: 'settings' }, false)).toBe('Opening Learn (settings).')
    expect(openingText('games/chess', {}, true)).toBe('Opened Chess in its own window.')
  })
})

describe('the pane', () => {
  test('the version is the fourth tab, dotted until it is opened, and opening it remembers the version', async ($, on) => {
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    for (const surface of SURFACES) {
      const before = await $.ui.mount({ ...PANE, surface })
      const tab = await before.find({ key: 'tab:releases' })
      // The dot is drawn in the accent, the version beside it dim on its own: the tab itself is not dimmed.
      expect(tab?.props.label).toBe('v0.2.0, new')
      expect(tab?.props.dimColor).not.toBe(true)
      expect(await before.find({ type: 'Text', text: /^ ●$/ })).toMatchObject({ props: { color: 'claude' } })
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
      expect(isFront(await after.find({ key: 'tab:releases' }))).toBe(true)
      expect(isFront(await after.find({ key: 'tab:phases' }))).toBe(false)
      expect((await after.find({ type: 'Text', text: /29 Oct · Mahmood/ }))?.text).toContain(' · 29 Oct · Mahmood')
      expect(await after.find({ type: 'Text', text: /macOS: the panel floats with the terminal/ })).toBeDefined()
      expect(await after.find({ type: 'Text', text: /27 Oct · Yousif/ })).toBeDefined()
      // Each note sits after its own dim ·, so a wrapped one can't be read as the next.
      expect((await after.findAll({ type: 'Text', text: /^·$/ })).length).toBe(3)
      // Nothing was seen before: the newest alone wears the new mark while the tab shows.
      expect((await after.findAll({ type: 'Text', text: /^●$/ })).length).toBe(1)
      await after.unmount()
    }
  })

  test('the entries newer than the version seen before wear the new mark; going back to an older copy brings no dot', async ($, on) => {
    const entry = (version: string) => ({ version, date: '2026-10-29', by: 'Yousif', notes: ['a note'] })
    const releases = JSON.stringify({ v: 1, releases: [entry('0.3.0'), entry('0.2.0'), entry('0.1.0')] })
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', releases, manifest: JSON.stringify({ version: '0.3.0' }), store: { seenRelease: '0.1.0' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'tab:releases' }))?.props.label).toBe('v0.3.0, new')
    await ui.press({ key: 'tab:releases' })
    await clock.settle()
    await ui.unmount()
    const opened = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await opened.find({ key: 'tab:releases' }))?.props.label).toBe('v0.3.0')
    // 0.3.0 and 0.2.0 are new since 0.1.0; 0.1.0 itself is not.
    expect((await opened.findAll({ type: 'Text', text: /^●$/ })).length).toBe(2)
    await opened.unmount()
  })

  test('a copy older than the version seen shows no dot', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', store: { seenRelease: '0.3.0' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0')
    await ui.unmount()
  })

  test('a plugin version with no entry of its own says so at the top of Releases', async ($, on) => {
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', manifest: JSON.stringify({ version: '0.3.0' }) })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:releases' })
    await clock.settle()
    await ui.unmount()
    const opened = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await opened.find({ type: 'Text', text: 'v0.3.0 has no release note yet' })).toMatchObject({ props: { color: 'error' } })
    await opened.unmount()
  })

  test('every tab is plain, so none moves when another comes to the front; a narrow pane drops counts first', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', store: { seenRelease: '0.2.0' } })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    const wide = await $.ui.mount({ ...PANE, surface: 'terminal' })
    for (const key of ['tab:phases', 'tab:tests', 'tab:learn', 'tab:releases']) expect((await wide.find({ key }))?.props.plain).toBe(true)
    expect((await wide.find({ key: 'tab:phases' }))?.props.label).toBe('Phases 1/3')
    expect(isFront(await wide.find({ key: 'tab:phases' }))).toBe(true)
    expect((await wide.find({ key: 'tab:tests' }))?.props.dimColor).toBe(true)
    await wide.unmount()

    // 'Phases 1/3', 'Tests', 'Learn' and 'v0.2.0' with their gaps and room for its dot take 34 cells: in 30, Phases gives up its count.
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
    expect((await narrow.find({ key: 'tab:phases' }))?.props.label).toBe('Phases')
    await narrow.unmount()
  })

  test('opening Releases clears the dot without re-fitting the tab row', async ($, on) => {
    const { clock } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    // 33 cells: 'Phases 1/3', 'Tests', 'Learn' and 'v0.2.0' take 32, but with the dot's room 34,
    // so Phases gives up its count while the dot shows, and keeps it given up once it clears.
    const tight = { ...PANE, surface: 'terminal' as const, props: { ...PANE.props, bodyColumns: 33 } }
    const before = await $.ui.mount(tight)
    expect((await before.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0, new')
    expect(await before.find({ type: 'Text', text: /^ ●$/ })).toBeDefined()
    expect((await before.find({ key: 'tab:phases' }))?.props.label).toBe('Phases')
    await before.press({ key: 'tab:releases' })
    await clock.settle()
    await before.unmount()

    const after = await $.ui.mount(tight)
    expect((await after.find({ key: 'tab:releases' }))?.props.label).toBe('v0.2.0')
    expect(await after.find({ type: 'Text', text: /^ ●$/ })).toBeUndefined()
    expect((await after.find({ key: 'tab:phases' }))?.props.label).toBe('Phases')
    expect((await after.find({ key: 'tab:tests' }))?.props.label).toBe('Tests')
    expect((await after.find({ key: 'tab:learn' }))?.props.label).toBe('Learn')
    await after.unmount()
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
    expect(isFront(await same.find({ key: 'tab:learn' }))).toBe(true)
    await same.unmount()

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship the next thing', phases: PLAN })
    const fresh = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(isFront(await fresh.find({ key: 'tab:phases' }))).toBe(true)
    expect(isFront(await fresh.find({ key: 'tab:learn' }))).toBe(false)
    await fresh.unmount()
  })

  test('Releases stays in front through a new plan', async ($, on) => {
    answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:releases' })
    await ui.unmount()

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship the next thing', phases: PLAN })
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(isFront(await after.find({ key: 'tab:releases' }))).toBe(true)
    expect(isFront(await after.find({ key: 'tab:phases' }))).toBe(false)
    await after.unmount()
  })

  test('inline with little room, the Tests tab shows the newest run and leaves the totals line out', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    // Each run prints a whole vitest run (94 tests) to its log, then ends.
    on('tool.call', { tool: 'Bash' }, () => {
      host.log = VITEST_PASS
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    // A moment later, so the two runs are two rows even where a call carries no id of its own.
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Bash', command: 'pnpm test --filter api' })
    const inline = (bodyRows: number) => ({ ...PANE, surface: 'terminal' as const, props: { ...PANE.props, placement: 'inline' as const, scroll: { offset: 0, bodyRows } } })
    // 4 rows: the tabs and a gap, then one run's two rows.
    const tight = await $.ui.mount(inline(4))
    expect(isFront(await tight.find({ key: 'tab:tests' }))).toBe(true)
    expect(await tight.find({ type: 'Text', text: /pnpm test --filter api/ })).toBeDefined()
    expect(await tight.find({ type: 'Text', text: /^pnpm test$/ })).toBeUndefined()
    expect(await tight.find({ type: 'Text', text: /tests in 2 runs/ })).toBeUndefined()
    await tight.unmount()
    // 7: both runs and the totals line.
    const roomy = await $.ui.mount(inline(7))
    expect(await roomy.find({ type: 'Text', text: /^pnpm test$/ })).toBeDefined()
    expect(await roomy.find({ type: 'Text', text: /tests in 2 runs/ })).toBeDefined()
    await roomy.unmount()
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

  test('Carry on reading opens the course in front, by its id, and the toast names it', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', learnStatus: COURSE_STATUS })
    await clock.advance(3_500)
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:learn' })
    await ui.unmount()

    const learnTab = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await learnTab.find({ key: 'open:learn' }))?.text).toBe('Carry on reading')
    await learnTab.press({ key: 'open:learn' })
    await clock.settle()
    const launched = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(launched).toEqual(expect.arrayContaining(['-View', 'course', '-CourseId', 'devops-1a2b']))
    expect(host.toasts.at(-1)).toBe('Opening DevOps basics in Learn.')
    await learnTab.unmount()
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
    // The label never shrinks, so a games row that wraps can't break it into 'Game' / 's'.
    expect((await learnTab.find({ key: 'games:label' }))?.props.flexShrink).toBe(0)
    expect(await learnTab.find({ type: 'Text', text: 'Games' })).toMatchObject({ props: { dimColor: true } })
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
  test('/learn course opens the course in front, by its id, and names it', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', learnStatus: COURSE_STATUS })
    await clock.advance(3_500)
    await clock.settle()
    expect(await $.command.run({ command: 'learn', args: 'course', ...COMMAND_RUN })).toMatchObject({ text: 'Opening DevOps basics in Learn.' })
    const learn = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(learn).toEqual(expect.arrayContaining(['-View', 'course', '-CourseId', 'devops-1a2b']))
  })

  test('/learn course with no course open yet opens the Library and says so', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up' })
    expect(await $.command.run({ command: 'learn', args: 'course', ...COMMAND_RUN })).toMatchObject({
      text: 'No course open yet. Opening Learn (library).',
    })
    const learn = host.runs.filter(argv => argv[0] === 'bash').at(-1) ?? []
    expect(learn).toEqual(expect.arrayContaining(['-View', 'library']))
    expect(learn).not.toContain('-CourseId')
  })

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
