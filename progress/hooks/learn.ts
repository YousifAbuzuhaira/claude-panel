// The panel's Learn tab: what Learn's helper writes to ~/.config/claude-learn/status.json
// (a build going on, the course in front), read back safely. Pure helpers only: the
// calls on `$` live in register.tsx.

export type LearnBuild = {
  id: string
  topic: string
  step: string
  state: 'running' | 'waiting-picks' | 'paused' | 'failed' | 'done'
  message: string
  done: number
  total: number
}

export type LearnCourse = { id: string; title: string; page: number; total: number; next: string }

export type LearnStatus = { build: LearnBuild | null; course: LearnCourse | null }

const STATES = new Set(['running', 'waiting-picks', 'paused', 'failed', 'done'])
// A finished build still shows for this long ("Ready: ...").
const DONE_SHOWN_MS = 60 * 60_000

export const learnStatusPath = (home: string) => `${home}/.config/claude-learn/status.json`

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
