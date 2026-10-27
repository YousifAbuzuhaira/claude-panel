import { describe, expect, test } from 'claude-code/testing'

import { isTestCommand, runKey, shortLabel, wrapCommand } from '../hooks/wrap'

const TEST_COMMANDS = [
  'pnpm test',
  'pnpm --filter @keops-ai/contracts test',
  'pnpm -F people-api run test:unit',
  'cd apps/products/flowrunner/api && pnpm test 2>&1 | tail -20',
  'npx vitest run src/a.test.ts',
  'pnpm exec vitest run -t "carry"',
  'node --test "src/**/*.test.ts"',
  'tsx --test src/a.test.ts',
  'turbo run test --filter=clarity',
  'npm test',
  'npm t',
  'CI=1 pnpm test',
  'timeout 300 pnpm test',
  './node_modules/.bin/vitest run',
  'npx playwright test',
  'cd apps/products/flowrunner/api && S=/tmp/x && FLOWRUNNER_E2E_SHOTS=$S/shots timeout 1200 npx tsx --env-file-if-exists=../.env test/e2e/platform.ts > $S/e2e7.log 2>&1; echo exit=$?',
  'tsx scripts/../test/smoke.ts',
  'node src/a.spec.mjs',
]

const OTHER_COMMANDS = [
  'pnpm build',
  'pnpm --filter test build',
  'grep -r vitest packages',
  'cat vitest.config.ts',
  'node scripts/migrate.js',
  'echo pnpm test',
  'git status',
  'pnpm install',
  'tsx src/index.ts',
  'npx tsx scripts/seed.ts',
  'ps -eo args | grep -E "platform|vitest|--test" | grep -v grep',
]

describe('wrap', () => {
  test('spots test runs', () => {
    for (const command of TEST_COMMANDS) expect([command, isTestCommand(command)]).toEqual([command, true])
  })

  test('leaves other commands alone', () => {
    for (const command of OTHER_COMMANDS) expect([command, isTestCommand(command)]).toEqual([command, false])
  })

  test('the wrapped command ends with the original, untouched', () => {
    const command = "cd x && pnpm test 2>&1 | tail -5"
    const wrapped = wrapCommand(command, "/tmp/it's.log")
    expect(wrapped.endsWith(`\n${command}`)).toBe(true)
    expect(wrapped).toContain(`__kp_log='/tmp/it'\\''s.log'`)
    expect(wrapped).toContain('pnpm(){ __kp command pnpm "$@"; }')
    expect(wrapped).toContain('${PIPESTATUS[0]}')
  })

  test('launchers are shadowed too, so `timeout npx …` is copied', () => {
    expect(wrapCommand('timeout 60 npx tsx test/e2e/a.ts', '/tmp/a.log')).toContain('timeout(){ __kp command timeout "$@"; }')
  })

  test('a run key survives a changing log name and keeps packages apart', () => {
    const run = (n: number) =>
      `cd apps/x/api && S=/tmp/s && FLOWRUNNER_E2E_SHOTS=$S/shots timeout 1200 npx tsx test/e2e/platform.ts > $S/e2e${n}.log 2>&1; echo exit=$?`
    expect(runKey(run(7))).toBe(runKey(run(8)))
    expect(runKey(run(7))).toBe('apps/x/api | npx tsx test/e2e/platform.ts')
    expect(runKey('cd packages/a && pnpm test')).not.toBe(runKey('cd packages/b && pnpm test'))
  })

  test('labels drop the cd, the redirections and the pipe', () => {
    expect(shortLabel('cd apps/x && pnpm test 2>&1 | tail -20')).toBe('pnpm test')
    expect(shortLabel('pnpm --filter a test > /dev/null')).toBe('pnpm --filter a test')
  })
})
