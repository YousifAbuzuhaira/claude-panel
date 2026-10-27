import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const STATE = '/tmp/claude-progress/sess-1/phases.json'
export const LEARN_STATUS = '/home/yousif/.config/claude-learn/status.json'

export type Host = {
  /** The latest panel state the mod wrote, parsed. */
  panel: () => PanelState | undefined
  writes: { path: string; text: string }[]
  runs: string[][]
  spawned: string[][]
  toasts: string[]
  /** What the Bash log reads as; a test sets it as its run goes on. */
  log: string
}

export type PanelState = {
  plan: { title: string; items: { name: string; status: string }[]; done: number; total: number } | null
  runs: { id: string; label: string; status: string; count: string; ratio: number | null; passed: number; failed: number }[]
  focus: string | null
}

/**
 * A session the test plays the world of: a WezTerm-on-WSL bash host, and a
 * panel that comes up (`ready`), comes up and is closed with its ✕, fails to
 * start, or the host isn't WezTerm.
 */
export function answerHost(
  on: On,
  options: { panel: 'comes-up' | 'fails' | 'closes'; terminal?: string; learnStatus?: string; off?: boolean } = { panel: 'comes-up' },
) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {
    TERM_PROGRAM: options.terminal ?? 'WezTerm',
    WSL_DISTRO_NAME: 'Ubuntu',
    SHELL: '/bin/bash',
    HOME: '/home/yousif',
    ...(options.off ? { CLAUDE_PROGRESS_OFF: '1' } : {}),
  })
  mock.store(on)
  const host: Host = {
    writes: [],
    runs: [],
    spawned: [],
    toasts: [],
    log: '',
    panel: () => {
      const last = host.writes.filter(write => write.path === STATE).at(-1)
      return last ? (JSON.parse(last.text) as PanelState) : undefined
    },
  }
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/home/yousif/repo' }))
  on('fs.write', (_$, e) => {
    if (e.path !== STATE) host.log = ''
    host.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  // Learn's status file reads as the test set it (nothing by default); every other read is the Bash log.
  on('fs.read', (_$, e) => ({ value: e.path === LEARN_STATUS ? (options.learnStatus ?? '') : host.log }))
  on('process.run', (_$, e) => {
    host.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$, e) {
    host.spawned.push([...e.argv])
    if (options.panel === 'comes-up') {
      yield { stream: 'stdout' as const, text: '{"event":"ready","paneId":0}\r\n' }
      await clock.sleep(3_600_000)
    }
    if (options.panel === 'closes') {
      // Comes up, then the person presses its ✕ a second later.
      yield { stream: 'stdout' as const, text: '{"event":"ready","paneId":0}\r\n' }
      await clock.sleep(1_000)
      yield { stream: 'stdout' as const, text: '{"event":"closed"}\r\n' }
    }
    return { value: { code: options.panel === 'fails' ? 1 : 0, signal: null } }
  })
  on('ui.toast', (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })

  return { clock, host }
}

export const PLAN = [
  { name: 'Schema', status: 'done' },
  { name: 'API', status: 'in_progress' },
  { name: 'UI', status: 'todo' },
]

export const COMMAND_RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
