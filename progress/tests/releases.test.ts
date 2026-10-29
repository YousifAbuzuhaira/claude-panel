import { describe, expect, test } from 'claude-code/testing'

import {
  compareVersion, isReleaseNew, isReleaseUnseen, lacksReleaseNote, laterVersion, newestRelease, readPluginVersion, readReleases,
  releaseLine, releasesLabel, releasesName, shortDate,
} from '../hooks/releases'
import { RELEASES } from './host'

describe('releases.json', () => {
  test('the entries are read in the file order, newest first, with who and when', () => {
    const releases = readReleases(RELEASES)
    expect(releases.map(release => release.version)).toEqual(['0.2.0', '0.1.0'])
    expect(releases[0]).toEqual({
      version: '0.2.0',
      date: '2026-10-29',
      by: 'Mahmood',
      notes: ['macOS: the panel floats with the terminal', 'Linux: a Claude Code pane plus browser pages'],
    })
  })

  test('a release keeps three notes at most, and a note that is not text is left out', () => {
    const raw = JSON.stringify({
      v: 1,
      releases: [{ version: '0.3.0', date: '2026-10-30', by: 'Yousif', notes: ['a', 7, 'b', '', 'c', 'd'] }],
    })
    expect(readReleases(raw)[0]?.notes).toEqual(['a', 'b', 'c'])
  })

  test('an entry with no version is skipped; a date not written YYYY-MM-DD is dropped', () => {
    const raw = JSON.stringify({
      v: 1,
      releases: [{ date: '2026-10-30', by: 'Yousif', notes: ['x'] }, { version: '0.1.1', date: 'last week', by: 'Yousif' }],
    })
    expect(readReleases(raw)).toEqual([{ version: '0.1.1', date: '', by: 'Yousif', notes: [] }])
  })

  test('nonsense, half a write, or the wrong shape reads as no releases', () => {
    expect(readReleases('')).toEqual([])
    expect(readReleases('{"v":1,"releases":[{"version":"0.2')).toEqual([])
    expect(readReleases(JSON.stringify({ v: 1, releases: 'none' }))).toEqual([])
    expect(readReleases('null')).toEqual([])
  })

  test("plugin.json's version is read; one without a version reads as none", () => {
    expect(readPluginVersion(JSON.stringify({ name: 'progress', version: '0.3.0' }))).toBe('0.3.0')
    expect(readPluginVersion(JSON.stringify({ name: 'progress' }))).toBeNull()
    expect(readPluginVersion('not json')).toBeNull()
  })
})

describe('the Releases tab label', () => {
  test('versions compare by number, as the WPF and Mac panels compare them', () => {
    expect(compareVersion('0.10.0', '0.9.1')).toBe(1)
    expect(compareVersion('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersion('0.2', '0.2.0')).toBe(0)
    expect(compareVersion('0.1.1', '0.2.0')).toBe(-1)
    expect(compareVersion('1.0.0-beta', '0.9.0')).toBe(1)
  })

  test('the dot shows while the newest entry is newer than what was seen, and never for an older one', () => {
    expect(isReleaseUnseen('0.2.0', undefined)).toBe(true)
    expect(isReleaseUnseen('0.2.0', '0.1.1')).toBe(true)
    expect(isReleaseUnseen('0.2.0', '0.2.0')).toBe(false)
    // Back on an older copy (both copies share the store): what was seen is newer, so no dot comes back.
    expect(isReleaseUnseen('0.2.0', '0.3.0')).toBe(false)
    expect(isReleaseUnseen(null, undefined)).toBe(false)
  })

  test('the newest is the first entry, else the plugin itself', () => {
    const entry = (version: string) => ({ version, date: '', by: '', notes: [] })
    expect(newestRelease([entry('0.2.0'), entry('0.1.0')], '0.3.0')).toBe('0.2.0')
    expect(newestRelease([], '0.3.0')).toBe('0.3.0')
    expect(newestRelease([], null)).toBeNull()
  })

  test('opening the tab remembers the later of what was seen and the newest entry', () => {
    expect(laterVersion(undefined, '0.2.0')).toBe('0.2.0')
    expect(laterVersion('0.1.1', '0.2.0')).toBe('0.2.0')
    expect(laterVersion('0.3.0', '0.2.0')).toBe('0.3.0')
    expect(laterVersion('0.2.0', null)).toBe('0.2.0')
    expect(laterVersion(7, null)).toBeNull()
  })

  test('the entries newer than what had been seen wear the new mark; with nothing seen, the newest alone', () => {
    expect(isReleaseNew('0.3.0', '0.1.1', 0)).toBe(true)
    expect(isReleaseNew('0.2.0', '0.1.1', 1)).toBe(true)
    expect(isReleaseNew('0.1.1', '0.1.1', 2)).toBe(false)
    expect(isReleaseNew('0.3.0', null, 0)).toBe(true)
    expect(isReleaseNew('0.2.0', null, 1)).toBe(false)
  })

  test('a plugin newer than its newest entry shipped without its release note', () => {
    const list = [{ version: '0.2.0', date: '', by: '', notes: [] }]
    expect(lacksReleaseNote('0.3.0', list)).toBe(true)
    expect(lacksReleaseNote('0.2.0', list)).toBe(false)
    expect(lacksReleaseNote('0.3.0', [])).toBe(false)
    expect(lacksReleaseNote(null, list)).toBe(false)
  })

  test('the tab reads as the version, and says it is new to a screen reader rather than with the glyph', () => {
    expect(releasesLabel('0.2.0')).toBe('v0.2.0')
    expect(releasesName('0.2.0', true)).toBe('v0.2.0, new')
    expect(releasesName('0.2.0', false)).toBe('v0.2.0')
  })

  test('with no version known the tab is still there, named Releases', () => {
    expect(releasesLabel(null)).toBe('Releases')
    expect(releasesName(null, false)).toBe('Releases')
  })

  test("each entry's heading is version, short date and who made it", () => {
    expect(releaseLine({ version: '0.2.0', date: '2026-10-29', by: 'Mahmood', notes: [] })).toBe('0.2.0 · 29 Oct · Mahmood')
    expect(releaseLine({ version: '0.1.1', date: '', by: 'Yousif', notes: [] })).toBe('0.1.1 · Yousif')
    expect(shortDate('2026-01-05')).toBe('5 Jan')
    expect(shortDate('2026-13-05')).toBe('2026-13-05')
  })
})
