// The panel's Learn tab: what Learn's helper writes to ~/.config/claude-learn/status.json
// (a build going on, the course in front), read back safely. Pure helpers only: the
// calls on `$` live in register.tsx.

export type LearnBuild = {
  id: string
  /** `explain` for an explainer's clips (/explain), else a course's build, pages or videos. */
  kind?: string
  /** The explainer an `explain` build makes: what the tab's "Watch clips" opens. */
  explain?: string | null
  /** That explainer as one file you can pass on (~/explainers/...html), once a clip is in it. */
  file?: string | null
  topic: string
  step: string
  state: 'running' | 'waiting-picks' | 'paused' | 'failed' | 'done'
  message: string
  done: number
  total: number
}

export type LearnCourse = { id: string; title: string; page: number; total: number; next: string }

export type LearnStatus = { build: LearnBuild | null; course: LearnCourse | null }

const EXPLAIN_ID = /^x[0-9a-f]{12,20}$/
const STATES = new Set(['running', 'waiting-picks', 'paused', 'failed', 'done'])
// A finished build still shows for this long ("Ready: ...").
const DONE_SHOWN_MS = 60 * 60_000

// `home` is what Learn's helper calls home (Node's os.homedir()): HOME, or USERPROFILE on Windows.
export const learnStatusPath = (home: string) => `${home}/.config/claude-learn/status.json`

/** The views `/learn <view>` opens: Learn's own tabs. */
export const LEARN_VIEWS = ['library', 'course', 'review', 'learned', 'ask', 'settings'] as const

export type LearnView = (typeof LEARN_VIEWS)[number]

export const isLearnView = (name: string): name is LearnView => (LEARN_VIEWS as readonly string[]).includes(name)

/**
 * `/course <what>`: Learn's helper builds a course from this chat about `focus` (the helper reads
 * the chat's saved record; nothing is sent to this chat). Leading dashes are taken off, so the
 * focus can't be read as a flag.
 */
export function courseArgv({ pluginRoot, sessionId, focus, isWindows = false, audience = 'self' }: { pluginRoot: string; sessionId: string; focus: string; isWindows?: boolean; audience?: 'self' | 'team' }): string[] {
  const what = focus.replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '').slice(0, 300)
  // On Windows `bash` is WSL's launcher (or missing): Node runs the helper straight, as the server does.
  const helper = isWindows ? ['node', `${pluginRoot}/learn/learn.mjs`] : ['bash', `${pluginRoot}/learn/learn.sh`]
  // /course is typed inside the chat itself, so by default the course is for the one who was in it.
  return [...helper, 'build', 'start', '--chat', sessionId, '--audience', audience, '--focus', what]
}

const text = (value: unknown, max = 120) => (typeof value === 'string' ? value.slice(0, max) : '')
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

/** The status file's text, or null when it says nothing worth a tab line. */
export function readLearnStatus(raw: string, now: number): LearnStatus | null {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null

  const at = typeof value.at === 'string' ? Date.parse(value.at) : NaN
  const b = value.build as Record<string, unknown> | null | undefined
  let build: LearnBuild | null = null
  if (b && typeof b === 'object' && typeof b.state === 'string' && STATES.has(b.state)) {
    const isStale = b.state === 'done' && (!Number.isFinite(at) || now - at > DONE_SHOWN_MS)
    if (!isStale) {
      build = {
        id: text(b.id, 60),
        kind: text(b.kind, 20),
        explain: b.kind === 'explain' && typeof b.explain === 'string' && EXPLAIN_ID.test(b.explain) ? b.explain : null,
        file: b.kind === 'explain' && typeof b.file === 'string' && /\.html$/.test(b.file) && b.file.length <= 400 ? b.file : null,
        topic: text(b.topic),
        step: text(b.step, 20),
        state: b.state as LearnBuild['state'],
        message: text(b.message, 160),
        done: count(b.done),
        total: count(b.total),
      }
    }
  }

  const c = value.course as Record<string, unknown> | null | undefined
  const course: LearnCourse | null =
    c && typeof c === 'object' && typeof c.id === 'string'
      ? { id: text(c.id, 80), title: text(c.title), page: count(c.page), total: count(c.total), next: text(c.next) }
      : null

  return build || course ? { build, course } : null
}

/** A build that is working right now keeps the panel up. */
export const isLearnBusy = (status: LearnStatus | null) => status?.build?.state === 'running'

/**
 * The notice for an explainer whose making stopped (failed or paused) before its last clip: the
 * explain plugin has no panel to show it. `key` is this stop, so it's told once; null when nothing
 * stopped, or the build is another chat's explainer or a course's.
 */
export function stoppedNotice(build: LearnBuild | null | undefined, explainer: string | null): { key: string; text: string } | null {
  if (!build || !explainer || build.kind !== 'explain' || build.explain !== explainer) return null
  if ((build.state !== 'failed' && build.state !== 'paused') || (build.total > 0 && build.done >= build.total)) return null
  // One stopped by hand goes on only when you say so; one that failed goes on when you open it.
  const goOn = build.state === 'paused' ? '/clips resume makes the rest' : '/clips carries on'
  return { key: `${build.id}:${build.state}:${build.message}`, text: `"${build.topic}": ${build.message || 'stopped'} · ${build.done} of ${build.total} clips ready · ${goOn}` }
}

/**
 * The notice this chat gets when more clips of the explainer it asked for are ready: shown in the
 * chat, never read by the model. `told` is how many it was already told about. Null when there's
 * nothing new, or the build is another chat's explainer or a course's. The last one names the file
 * you can pass on, under `home` shown as ~.
 */
export function readyNotice(build: LearnBuild | null | undefined, explainer: string | null, told: number, home = ''): { done: number; text: string } | null {
  if (!build || !explainer || build.kind !== 'explain' || build.explain !== explainer || build.done <= told) return null
  const ready =
    build.total <= 1 ? `The clip of "${build.topic}" is ready · /clips opens it` : `${build.done} of ${build.total} clips of "${build.topic}" are ready · /clips opens them`
  const file = shownPath(build.file, home)
  const text = file && build.done >= build.total ? `${ready} · as one file: ${file}` : ready
  return { done: build.done, text }
}

/** A path under home as the person would write it. */
const shownPath = (file: string | null | undefined, home: string) => (file && home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file || null)

/**
 * What Claude is told when the last clip is ready, as a row only the model reads (it starts no turn
 * and isn't drawn): the person's own notice is a line the model never sees, so without this "are
 * they done?" sends it looking on disk. Null before the last clip.
 */
export function readyNote(build: LearnBuild | null | undefined, home = ''): string | null {
  if (!build || build.total < 1 || build.done < build.total) return null
  const file = shownPath(build.file, home)
  const clips = build.total === 1 ? `The clip of "${build.topic}" is ready` : `All ${build.total} clips of "${build.topic}" are ready`
  return `[/explain, not typed by the person] ${clips}${file ? `, as one file: ${file}` : ''}. They were told in the chat, and /clips opens it. There is nothing to do or say now; use this only if they ask.`
}
