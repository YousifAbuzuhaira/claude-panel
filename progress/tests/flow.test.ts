import { describe, expect, test } from 'claude-code/testing'

import { VITEST_PASS } from './fixtures'
import { answerHost, COMMAND_RUN, PLAN, STATE } from './host'

describe('Tests tab', () => {
  test('a Bash test run fills the Tests tab live, settles, and is remembered', async ($, on) => {
    const { clock, host } = answerHost(on)
    const seen: { command: string; midway?: string }[] = []

    on('tool.call', { tool: 'Bash' }, async (_$, e) => {
      host.log = VITEST_PASS.split('\n').slice(0, 9).join('\n') + '\n'
      await clock.advance(500)
      seen.push({ command: e.command, midway: host.panel()?.runs.at(-1)?.count })
      host.log = VITEST_PASS
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    expect(seen[0]?.command).toContain('pnpm(){ __kp command pnpm "$@"; }')
    expect(seen[0]?.command.endsWith('\npnpm test')).toBe(true)
    expect(seen[0]?.midway).toBe('33')
    expect(host.panel()?.runs.at(-1)).toMatchObject({ status: 'passed', count: '94/94', passed: 94, failed: 0 })
    expect(host.spawned.length).toBe(1)

    // A finished run stays on the tab; the next run of it shows the remembered total.
    await clock.advance(10_000)
    expect(host.panel()?.runs.length).toBe(1)
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    expect(seen[1]?.midway).toBe('33/~94')
    expect(host.panel()?.runs.length).toBe(2)
    expect(host.spawned.length).toBe(1)
  })

  test('other commands pass through untouched', async ($, on) => {
    const { host } = answerHost(on)
    let command = ''
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      command = e.command
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'Bash', command: 'pnpm build' })
    expect(command).toBe('pnpm build')
    expect(host.panel()).toBeUndefined()
  })
})

describe('Phases tab', () => {
  test('the first plan opens the panel once; updates only rewrite its file', async ($, on) => {
    const { clock, host } = answerHost(on)
    const written = await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(written).toMatchObject({ result: 'Phases 1/3 done; now: API.' })
    await clock.settle()
    expect(host.spawned.length).toBe(1)
    expect(host.spawned[0]).toEqual(
      expect.arrayContaining(['-StateFile', '\\\\wsl.localhost\\Ubuntu\\tmp\\claude-progress\\sess-1\\phases.json', '-Root', '/home/yousif/repo']),
    )
    expect(host.panel()?.plan).toMatchObject({ title: 'Ship it', done: 1, total: 3 })

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN.map(p => ({ ...p, status: 'done' })) })
    expect(host.spawned.length).toBe(1)
    expect(host.panel()?.plan).toMatchObject({ done: 3 })
  })

  test('refuses a second in_progress; an empty list with no runs closes the panel', async ($, on) => {
    const { host } = answerHost(on)
    const refused = await $.tool.call({
      tool: 'mcp__progress__phases_write',
      phases: [
        { name: 'A', status: 'in_progress' },
        { name: 'B', status: 'in_progress' },
      ],
    })
    expect(refused).toMatchObject({ deny: 'Only one phase can be in_progress at a time.' })

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(await $.tool.call({ tool: 'mcp__progress__phases_write', phases: [] })).toMatchObject({ result: 'Phases cleared.' })
    expect(host.runs).toContainEqual(['rm', '-f', STATE])
  })

  test('/phases clear empties the panel; /clear does too', async ($, on) => {
    const { host } = answerHost(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(await $.command.run({ command: 'phases', args: 'clear', ...COMMAND_RUN })).toMatchObject({
      text: 'Progress panel cleared.',
    })
    expect(host.runs).toContainEqual(['rm', '-f', STATE])

    host.runs.length = 0
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: undefined as never })
    expect(host.runs).toContainEqual(['rm', '-f', STATE])
  })

  test('the guide joins the system prompt when the tool is offered', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    const ask = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }

    const offered = await $.prompt.compose({ ...ask, tools: ['mcp__progress__phases_write'] })
    expect(offered.sections.at(-1)).toMatchObject({ id: 'progress:phases', scope: 'session' })

    const notOffered = await $.prompt.compose({ ...ask, tools: [] })
    expect(notOffered.sections.length).toBe(1)
  })
})

describe('Opening the panel by hand', () => {
  test('/phases opens an empty panel that stays up, even after a plan comes and goes', async ($, on) => {
    const { clock, host } = answerHost(on)
    const opened = await $.command.run({ command: 'phases', args: '', ...COMMAND_RUN })
    expect(opened).toMatchObject({ text: expect.stringContaining('empty for now') })
    await clock.settle()
    expect(host.spawned.length).toBe(1)
    expect(host.panel()).toMatchObject({ plan: null, runs: [] })

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await $.tool.call({ tool: 'mcp__progress__phases_write', phases: [] })
    expect(host.runs).not.toContainEqual(['rm', '-f', STATE])
    expect(host.panel()?.plan).toBeNull()
    expect(host.spawned.length).toBe(1)

    await $.command.run({ command: 'phases', args: 'clear', ...COMMAND_RUN })
    expect(host.runs).toContainEqual(['rm', '-f', STATE])
  })

  test('its ✕ lets go: an empty panel closes again, and /phases brings it back', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'closes' })
    await $.command.run({ command: 'phases', args: '', ...COMMAND_RUN })
    await clock.advance(1_000)
    await clock.settle()

    await $.tool.call({ tool: 'mcp__progress__phases_write', phases: [] })
    expect(host.runs).toContainEqual(['rm', '-f', STATE])

    await $.command.run({ command: 'phases', args: '', ...COMMAND_RUN })
    expect(host.spawned.length).toBe(2)
  })

  test('outside WezTerm on WSL, /phases says why and nothing starts', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up', terminal: 'vscode' })
    const opened = await $.command.run({ command: 'phases', args: '', ...COMMAND_RUN })
    expect(opened).toMatchObject({ text: expect.stringContaining('needs WezTerm on WSL') })
    expect(host.spawned).toEqual([])
    expect(host.toasts.length).toBe(1)
  })
})
