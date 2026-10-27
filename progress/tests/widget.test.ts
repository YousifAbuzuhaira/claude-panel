import { describe, expect, test } from 'claude-code/testing'

import { panelState, readEvents, widgetArgv } from '../hooks/widget'
import { answerHost, COMMAND_RUN, PLAN } from './host'

describe('panel life', () => {
  test('a panel that never comes up says so once and is not retried until /phases', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'fails' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await clock.settle()
    expect(host.toasts.length).toBe(1)
    expect(host.toasts[0]).toContain("couldn't start")

    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned.length).toBe(1)

    await $.command.run({ command: 'phases', args: '', ...COMMAND_RUN })
    expect(host.spawned.length).toBe(2)
  })

  test('outside WezTerm on WSL there is no panel, and the person hears why once', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up', terminal: 'vscode' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned).toEqual([])
    expect(host.toasts).toEqual(['progress: the floating panel needs WezTerm on WSL.'])
  })
})

describe('panel helpers', () => {
  test('the state carries the plan counts, each run as drawn, and the newest run as focus', () => {
    const state = JSON.parse(
      panelState('s', { title: 'Ship it', items: PLAN as never }, [
        { id: 'r1', label: 'pnpm test', isSubagent: false, status: 'passed', done: 94, passed: 94, failed: 0, skipped: 0, total: 94, estimate: null },
        { id: 'r2', label: 'tsx test/e2e/x.ts', isSubagent: true, status: 'running', done: 12, passed: 12, failed: 0, skipped: 0, total: null, estimate: 156 },
      ]),
    )
    expect(state.plan).toMatchObject({ title: 'Ship it', done: 1, total: 3 })
    expect(state.runs[1]).toMatchObject({ label: 'agent: tsx test/e2e/x.ts', count: '12/~156' })
    expect(Math.abs(state.runs[1].ratio - 12 / 156) < 1e-9).toBe(true)
    expect(state.focus).toBe('r2')
    expect(state.totals).toEqual({ runs: 2, tests: 106, passed: 106, failed: 0 })
  })

  test('an estimate the run has gone past is dropped, not shown as 98/~22', () => {
    const state = JSON.parse(
      panelState('s', null, [{ id: 'r1', label: 'pnpm test:e2e', isSubagent: false, status: 'running', done: 98, passed: 97, failed: 1, skipped: 0, total: null, estimate: 22 }]),
    )
    expect(state.runs[0]).toMatchObject({ count: '98', ratio: null })
    expect(state.totals).toEqual({ runs: 1, tests: 98, passed: 97, failed: 1 })
  })

  test('events split across pieces are read once whole', () => {
    const first = readEvents('', '{"event":"ready"}\r\n{"event":"al')
    expect(first.events).toEqual([{ event: 'ready' }])
    const second = readEvents(first.pending, 'ive"}\nnoise\n')
    expect(second.events).toEqual([{ event: 'alive' }])
    expect(second.pending).toBe('')
  })

  test('an empty title is left out of the command', () => {
    const argv = widgetArgv({ distro: 'Ubuntu', pluginRoot: '/home/y/mods/progress', sessionId: 's', title: '' })
    expect(argv).not.toContain('-Title')
    expect(argv).toContain('\\\\wsl.localhost\\Ubuntu\\home\\y\\mods\\progress\\widget\\PhasesWidget.ps1')
  })
})
