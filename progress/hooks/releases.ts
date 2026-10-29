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

/** The tab's label: the version, with a dot until the person has seen this version's entry. */
export function releasesLabel(version: string | null, seen: unknown): string {
  if (!version) return 'Releases'
  return seen === version ? `v${version}` : `v${version} ●`
}

/** Whether the tab's label carries the not-yet-seen dot. */
export const isReleaseUnseen = (version: string | null, seen: unknown) => version !== null && version !== '' && seen !== version

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
