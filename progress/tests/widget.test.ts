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

  test('on WezTerm on WSL the floating panel starts, and no pane or status line shows', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned.length).toBe(1)
    expect(host.spawned[0]?.[0]).toContain('powershell.exe')
    expect(host.opened).toEqual([])
    expect(host.status.filter(text => text !== undefined)).toEqual([])
  })

  test('on WSL, /learn and /games open the WPF windows, not the browser', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up' })
    await $.command.run({ command: 'learn', args: '', ...COMMAND_RUN })
    await $.command.run({ command: 'games', args: 'chess', ...COMMAND_RUN })
    const launched = host.runs.filter(argv => argv[0] === 'bash')
    expect(launched.length).toBe(2)
    expect(launched[0]?.join(' ')).toContain('\\\\wsl.localhost\\Ubuntu\\')
    expect(launched[0]?.join(' ')).toContain('Learn.ps1')
    expect(launched[1]?.join(' ')).toContain('ChessPuzzles.ps1')
    expect(launched.some(argv => argv.join(' ').includes('web.sh'))).toBe(false)
  })

  test('on macOS the floating panel is the window app in panel mode, told which iTerm session to follow', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app', mac: true })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await clock.settle()
    expect(host.spawned.length).toBe(1)
    expect(host.spawned[0]).toEqual([
      '/cache/ClaudePanel', '--panel', '/tmp/claude-progress/sess-1/phases.json', '--html', expect.stringContaining('/mac/panel.html'),
      '--root', expect.any(String), '--terminal', 'iTerm.app', '--iterm-session', 'w0t1p0:ABC-123',
    ])
    expect(host.opened).toEqual([])
    expect(host.status.at(-1)).toBe('Phases 1/3')
  })

  test('on macOS a panel that never comes up falls back to the pane', async ($, on) => {
    const { clock, host } = answerHost(on, { panel: 'fails', terminal: 'iTerm.app', mac: true })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await clock.settle()
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned.length).toBe(1)
    expect(host.opened).toEqual(['progress'])
  })

  test('outside WezTerm on WSL the state file is still written, and a pane opens once in place of the panel', async ($, on) => {
    const { host } = answerHost(on, { panel: 'comes-up', terminal: 'iTerm.app' })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    await $.tool.call({ tool: 'mcp__progress__phases_write', title: 'Ship it', phases: PLAN })
    expect(host.spawned).toEqual([])
    expect(host.panel()?.plan).toMatchObject({ title: 'Ship it', done: 1, total: 3 })
    expect(host.opened).toEqual(['progress'])
    expect(host.status.at(-1)).toBe('Phases 1/3')
    expect(host.toasts).toEqual([])
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
