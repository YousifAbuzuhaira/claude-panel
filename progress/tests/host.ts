import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const STATE = '/tmp/claude-progress/sess-1/phases.json'
export const LEARN_STATUS = '/home/yousif/.config/claude-learn/status.json'
// On Windows itself (`windows: true`): the temp folder with forward slashes, and USERPROFILE as home.
export const WIN_TEMP = 'C:\\Users\\yassa\\AppData\\Local\\Temp'
export const WIN_STATE = 'C:/Users/yassa/AppData/Local/Temp/claude-progress/sess-1/phases.json'
export const WIN_LEARN_STATUS = 'C:\\Users\\yassa/.config/claude-learn/status.json'

// What the plugin's releases.json and plugin.json read as, unless a test says otherwise.
export const RELEASES = JSON.stringify({
  v: 1,
  releases: [
    {
      version: '0.2.0',
      date: '2026-10-29',
      by: 'Mahmood',
      notes: ['macOS: the panel floats with the terminal', 'Linux: a Claude Code pane plus browser pages'],
    },
    { version: '0.1.0', date: '2026-10-27', by: 'Yousif', notes: ['The floating panel: Phases, Tests and Learn'] },
  ],
})
export const MANIFEST = JSON.stringify({ name: 'progress', version: '0.2.0' })

export type Host = {
  /** The latest panel state the mod wrote, parsed. */
  panel: () => PanelState | undefined
  writes: { path: string; text: string }[]
  runs: string[][]
  spawned: string[][]
  toasts: string[]
  /** The panes opened (off WezTerm-on-WSL) and each status line set. */
  opened: string[]
  status: (string | undefined)[]
  /** What the Bash log reads as; a test sets it as its run goes on. */
  log: string
}

export type PanelState = {
  plan: { title: string; items: { name: string; status: string }[]; done: number; total: number } | null
  runs: { id: string; label: string; status: string; count: string; ratio: number | null; passed: number; failed: number }[]
  focus: string | null
}

/**
 * A session the test plays the world of: a WezTerm-on-WSL bash host (or, with
 * `windows`, Windows itself: Claude Code with Git Bash, OS=Windows_NT, no SHELL or
 * HOME), and a panel that comes up (`ready`, naming the terminal window `hwnd` when
 * given), comes up and is closed with its ✕, fails to start, or the host isn't WezTerm.
 * `releases`/`manifest` are what the plugin's releases.json and plugin.json read
 * as; `store` seeds what earlier sessions kept.
 */
export function answerHost(
  on: On,
  options: {
    panel: 'comes-up' | 'fails' | 'closes'
    terminal?: string
    learnStatus?: string
    off?: boolean
    mac?: boolean
    windows?: boolean
    wtSession?: string
    hwnd?: number
    releases?: string
    manifest?: string
    store?: Record<string, unknown>
  } = { panel: 'comes-up' },
) {
  const clock = mock.clock(on, { now: 1_000 })
  const state = options.windows ? WIN_STATE : STATE
  const learnStatus = options.windows ? WIN_LEARN_STATUS : LEARN_STATUS
  mock.env(on, {
    ...(options.terminal === '' ? {} : { TERM_PROGRAM: options.terminal ?? 'WezTerm' }),
    ...(options.windows
      ? { OS: 'Windows_NT', TEMP: WIN_TEMP, USERPROFILE: 'C:\\Users\\yassa', SystemRoot: 'C:\\WINDOWS', ...(options.wtSession ? { WT_SESSION: options.wtSession } : {}) }
      : {
          ...(options.mac ? { ITERM_SESSION_ID: 'w0t1p0:ABC-123' } : { WSL_DISTRO_NAME: 'Ubuntu' }),
          SHELL: '/bin/bash',
          HOME: '/home/yousif',
        }),
    ...(options.off ? { CLAUDE_PROGRESS_OFF: '1' } : {}),
  })
  mock.store(on, options.store)
  const host: Host = {
    writes: [],
    runs: [],
    spawned: [],
    toasts: [],
    opened: [],
    status: [],
    log: '',
    panel: () => {
      const last = host.writes.filter(write => write.path === state).at(-1)
      return last ? (JSON.parse(last.text) as PanelState) : undefined
    },
  }
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: options.windows ? 'C:\\Users\\yassa\\repo' : '/home/yousif/repo' }))
  on('fs.write', (_$, e) => {
    if (e.path !== state) host.log = ''
    host.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  // Learn's status file reads as the test set it (nothing by default), the plugin's
  // releases.json and plugin.json as above; every other read is the Bash log.
  on('fs.read', (_$, e) => {
    if (e.path === learnStatus) return { value: options.learnStatus ?? '' }
    if (e.path.endsWith('/releases.json')) return { value: options.releases ?? RELEASES }
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: options.manifest ?? MANIFEST }
    return { value: host.log }
  })
  on('process.run', (_$, e) => {
    host.runs.push([...e.argv])
    // On a Mac host: uname says Darwin and web.sh hands back the window app it built.
    const stdout = !options.mac ? '' : e.argv[0] === 'uname' ? 'Darwin\n' : e.argv[2] === 'app-path' ? '{"ok":true,"binary":"/cache/ClaudePanel"}\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ready = JSON.stringify({ event: 'ready', ...(options.hwnd ? { hwnd: options.hwnd } : {}), paneId: 0 })
  on('process.spawn', async function* (_$, e) {
    host.spawned.push([...e.argv])
    if (options.panel === 'comes-up') {
      yield { stream: 'stdout' as const, text: `${ready}\r\n` }
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
  on('ui.open', (_$, e) => {
    host.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    host.status.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
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
