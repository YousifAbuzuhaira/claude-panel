import { describe, expect, test } from 'claude-code/testing'

import {
  isReleaseUnseen, readPluginVersion, readReleases, releaseLine, releasesLabel, shortDate,
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
  test('the version carries a dot until that version has been seen', () => {
    expect(releasesLabel('0.2.0', undefined)).toBe('v0.2.0 ●')
    expect(releasesLabel('0.2.0', '0.1.1')).toBe('v0.2.0 ●')
    expect(releasesLabel('0.2.0', '0.2.0')).toBe('v0.2.0')
    expect(isReleaseUnseen('0.2.0', '0.1.1')).toBe(true)
    expect(isReleaseUnseen('0.2.0', '0.2.0')).toBe(false)
  })

  test('with no version known the tab is still there, named Releases, with no dot', () => {
    expect(releasesLabel(null, undefined)).toBe('Releases')
    expect(isReleaseUnseen(null, undefined)).toBe(false)
  })

  test("each entry's heading is version, short date and who made it", () => {
    expect(releaseLine({ version: '0.2.0', date: '2026-10-29', by: 'Mahmood', notes: [] })).toBe('0.2.0 · 29 Oct · Mahmood')
    expect(releaseLine({ version: '0.1.1', date: '', by: 'Yousif', notes: [] })).toBe('0.1.1 · Yousif')
    expect(shortDate('2026-01-05')).toBe('5 Jan')
    expect(shortDate('2026-13-05')).toBe('2026-13-05')
  })
})
