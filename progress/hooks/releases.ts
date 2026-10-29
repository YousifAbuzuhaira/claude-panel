// The Releases tab: what each version brought, read from the releases.json shipped
// beside the plugin (newest first), and the version the plugin is now, from its
// plugin.json. Read back safely, as the Learn status file is. Pure helpers only: the
// calls on `$` live in register.tsx.

export type Release = { version: string; date: string; by: string; notes: string[] }

// Kept short on purpose: a release says who and what in a line or three.
const NOTES_KEPT = 3
const RELEASES_KEPT = 40
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Where the pane remembers, across sessions, the newest version the person has looked at. */
export const SEEN_RELEASE_KEY = 'seenRelease'

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** The entries of releases.json in its own order (newest first); nonsense or half a write reads as none. */
export function readReleases(raw: string): Release[] {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.releases)) return []

  const releases: Release[] = []
  for (const entry of value.releases.slice(0, RELEASES_KEPT) as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const version = text(r.version, 20)
    if (!version) continue
    const date = text(r.date, 10)
    const notes = Array.isArray(r.notes) ? r.notes.map(note => text(note, 120)).filter(note => note !== '') : []
    releases.push({
      version,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      by: text(r.by, 40),
      notes: notes.slice(0, NOTES_KEPT),
    })
  }

  return releases
}

/** The version in plugin.json's text, or null when it names none. */
export function readPluginVersion(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { version?: unknown }
    const version = text(value?.version, 20)
    return version || null
  } catch {
    return null
  }
}

/**
 * -1, 0 or 1 by version number ("0.10.0" after "0.9.1"), as the WPF and Mac panels
 * compare them; a part that isn't a number counts as 0.
 */
export function compareVersion(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map(part => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const step = (left[i] ?? 0) - (right[i] ?? 0)
    if (step !== 0) return Math.sign(step)
  }
  return 0
}

/** The newest version with notes: the first entry of releases.json, else the plugin's own. */
export const newestRelease = (releases: readonly Release[], pluginVersion: string | null): string | null =>
  releases[0]?.version || pluginVersion || null

/**
 * Whether the tab carries the not-yet-seen dot: the newest entry is newer than the
 * newest the person has opened. Going back to an older copy brings no dot back.
 */
export const isReleaseUnseen = (newest: string | null, seen: unknown): boolean =>
  !!newest && (typeof seen !== 'string' || seen === '' || compareVersion(newest, seen) > 0)

/** What opening the tab remembers: the later of what was seen and the newest entry. */
export function laterVersion(seen: unknown, newest: string | null): string | null {
  const before = typeof seen === 'string' && seen !== '' ? seen : null
  if (!newest) return before
  return before && compareVersion(before, newest) >= 0 ? before : newest
}

/**
 * Whether an entry wears the new mark: newer than what had been seen when the tab
 * was opened; with nothing seen before, the newest alone.
 */
export const isReleaseNew = (version: string, seenBefore: string | null, index: number): boolean =>
  seenBefore ? compareVersion(version, seenBefore) > 0 : index === 0

/** The plugin is newer than its newest entry: a version shipped without its release note. */
export const lacksReleaseNote = (pluginVersion: string | null, releases: readonly Release[]): boolean =>
  !!pluginVersion && !!releases[0] && compareVersion(pluginVersion, releases[0].version) > 0

/** The tab's text: the plugin's version, or Releases while none is known. */
export const releasesLabel = (version: string | null): string => (version ? `v${version}` : 'Releases')

/** The tab's name for a screen reader: its text, and that it holds something new. */
export const releasesName = (version: string | null, isUnseen: boolean): string =>
  `${releasesLabel(version)}${isUnseen ? ', new' : ''}`

/** `2026-10-29` as `29 Oct`; anything else as it came. */
export function shortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  return match && month ? `${Number(match[3])} ${month}` : date
}

/** One release's heading: `0.2.0 · 29 Oct · Mahmood`, leaving out what it doesn't say. */
export function releaseLine(release: Release): string {
  return [release.version, shortDate(release.date), release.by].filter(part => part !== '').join(' · ')
}
