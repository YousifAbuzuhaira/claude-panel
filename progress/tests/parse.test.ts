import { describe, expect, test } from 'claude-code/testing'

import { emptyProgress, feed, hasFailed } from '../hooks/parse'
import { NODE_TAP_FAIL, VITEST_FAIL, VITEST_PASS, VITEST_TURBO } from './fixtures'

describe('parse', () => {
  test('vitest pass: per-file lines add up, the summary is final', () => {
    const progress = feed(emptyProgress(), VITEST_PASS)
    expect(progress.done).toBe(94)
    expect(progress.passed).toBe(94)
    expect(progress.summary).toEqual({ total: 94, passed: 94, failed: 0, skipped: 0 })
    expect(hasFailed(progress)).toBe(false)
  })

  test('vitest fail: failed and skipped come from the file line and the summary', () => {
    const progress = feed(emptyProgress(), VITEST_FAIL)
    expect(progress.summary).toEqual({ total: 5, passed: 3, failed: 1, skipped: 1 })
    expect(progress.failed).toBeGreaterThan(0)
    expect(hasFailed(progress)).toBe(true)
  })

  test('turbo prefixes do not change the counts', () => {
    const progress = feed(emptyProgress(), VITEST_TURBO)
    expect(progress.done).toBe(94)
    expect(progress.summary).toEqual({ total: 94, passed: 94, failed: 0, skipped: 0 })
  })

  test('node TAP: top-level results are the live units, the # counts are final', () => {
    const progress = feed(emptyProgress(), NODE_TAP_FAIL)
    expect(progress.done).toBe(4)
    expect(progress.passed).toBe(2)
    expect(progress.failed).toBe(2)
    expect(progress.summary).toEqual({ total: 6, passed: 4, failed: 2, skipped: 0 })
  })

  test('feeding line by line gives what feeding it whole gives', () => {
    const lines = VITEST_PASS.split('\n')
    let progress = emptyProgress()
    for (let i = 0; i < lines.length; i += 3) progress = feed(progress, lines.slice(i, i + 3).join('\n'))
    expect(progress).toEqual(feed(emptyProgress(), VITEST_PASS))
  })

  test('a runner exit marker counts, and a non-zero one fails the run', () => {
    const progress = feed(emptyProgress(), ' ✓ a.test.ts (2 tests) 3ms\n\x1e@kp-exit 1\n')
    expect(progress.exits).toEqual([1])
    expect(hasFailed(progress)).toBe(true)
  })

  test('a custom suite: its own check lines count, log noise does not', () => {
    const log = [
      'Running pending migrations...',
      'Migrations complete.',
      ' ✓ self sign-up is sealed',
      '[11:22:41 UTC] WARN: Staff already exist; ask an admin for an invitation.',
      '    code: "VALIDATION_ERROR"',
      ' ✓ bootstrap works once only',
      ' ✗ the webhook arrived',
      '',
      '1 check(s) failed',
    ].join('\n')
    const progress = feed(emptyProgress(), log)
    expect(progress).toMatchObject({ done: 3, passed: 2, failed: 1, runner: null })
    expect(hasFailed(progress)).toBe(true)
  })

  test('a suite that says how many checks it will run gives the total up front', () => {
    const progress = feed(emptyProgress(), 'Running 40 checks\n \u2713 one\n \u2713 two\n')
    expect(progress).toMatchObject({ announced: 40, done: 2, runner: null })
  })

  test('a TAP plan before any result is a total; one at the end is not new news', () => {
    expect(feed(emptyProgress(), 'TAP version 13\n1..12\nok 1 - a\n').announced).toBe(12)
    expect(feed(emptyProgress(), NODE_TAP_FAIL).announced).toBeNull()
  })

  test("vitest's per-test lines inside a failing file are not counted twice", () => {
    const progress = feed(emptyProgress(), VITEST_FAIL)
    expect(progress.runner).toBe('vitest')
    expect(progress.done).toBe(8)
  })

  test('playwright: the announced total and list lines', () => {
    const log = 'Running 3 tests using 2 workers\n  ✓  1 [chromium] › a.spec.ts:3:1 › one (1.1s)\n  ✘  2 [chromium] › a.spec.ts:9:1 › two (2.0s)\n'
    const progress = feed(emptyProgress(), log)
    expect(progress.announced).toBe(3)
    expect(progress.done).toBe(2)
    expect(progress.failed).toBe(1)
  })
})
