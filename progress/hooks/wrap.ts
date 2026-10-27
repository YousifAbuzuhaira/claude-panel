// Spots a test run in a Bash command and wraps the runners so their output
// is copied to a log the mod can read while the command still runs.

const PACKAGE_TOOLS = new Set(['pnpm', 'npm', 'yarn', 'npx', 'bun', 'bunx', 'turbo'])
const FLAGS_WITH_VALUE = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace', '--cwd'])
const SUBCOMMANDS = new Set(['exec', 'run', 'x', 'dlx'])
const PREFIX_WORDS = new Set(['env', 'time', 'nice', 'command', 'exec'])
// A script that lives in a test folder or is named like a test: a custom
// suite (`tsx test/e2e/platform.ts`) rather than a runner.
const TEST_PATH = /(^|\/)(tests?|e2e|__tests__|spec)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/

/**
 * The commands the wrapper shadows with a shell function for one call; the
 * launchers (`timeout`, `env`, `nice`) too, since a program they start never
 * sees the shell's functions.
 */
export const WRAPPED = [
  'pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'node', 'tsx', 'vitest', 'jest', 'turbo', 'playwright',
  'timeout', 'env', 'nice',
] as const

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1)

function isTestWords(words: readonly string[]): boolean {
  const [first, ...rest] = words
  if (first === undefined) return false
  const name = basename(first)

  if (name === 'vitest' || name === 'jest') return true
  if (name === 'playwright') return rest.includes('test')
  if (name === 'node' || name === 'tsx') return rest.includes('--test') || rest.some(word => TEST_PATH.test(word))
  if (name === 'bun' && rest[0] === 'test') return true
  if (!PACKAGE_TOOLS.has(name)) return false

  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? ''
    if (FLAGS_WITH_VALUE.has(word)) i++
    else if (!word.startsWith('-')) positional.push(word)
  }
  if (positional[0] !== undefined && SUBCOMMANDS.has(positional[0])) positional.shift()
  const target = positional[0]
  if (target === undefined) return false
  if (/^test(:|$)/.test(target) || (name === 'npm' && target === 't')) return true

  return isTestWords(positional)
}

function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0) {
    const word = words[0] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIX_WORDS.has(word)) words.shift()
    else if (word === 'timeout') words.splice(0, 2)
    else break
  }

  return words
}

/** True when any command of the line runs a test suite; quoted text (a grep pattern) is no command. */
export function isTestCommand(command: string): boolean {
  return command
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""')
    .split(/&&|\|\||[;|\n()]/)
    .some(segment => isTestWords(commandWords(segment)))
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * The command with a prefix that shadows each runner by a function for this
 * call alone: the runner's output goes on to wherever the command sends it,
 * a copy lands in `logPath`, and its exit status is kept. The command itself
 * is untouched, so `cd`, pipes and `&&` behave as written.
 */
export function wrapCommand(command: string, logPath: string): string {
  const shadows = WRAPPED.map(name => `${name}(){ __kp command ${name} "$@"; }`).join('; ')

  return (
    `__kp_log=${quote(logPath)}; ` +
    `__kp(){ "$@" 2>&1 | tee -a "$__kp_log"; local __kp_rc=\${PIPESTATUS[0]}; ` +
    `printf '\\n\\036@kp-exit %s\\n' "$__kp_rc" >>"$__kp_log"; return "$__kp_rc"; }; ` +
    `${shadows}\n${command}`
  )
}

const segmentsOf = (command: string) => command.split(/&&|\|\||[;|\n]/).map(part => part.trim())

// The test command's own words: no variables, launchers or redirections.
function cleanTestSegment(command: string): string {
  const segments = segmentsOf(command)
  const test = segments.find(segment => isTestWords(commandWords(segment))) ?? segments[0] ?? command

  return commandWords(test.replace(/\s+\d*>>?&?\s*\S+/g, '')).join(' ')
}

/** A short name for the run: the test command itself, without a leading `cd`. */
export function shortLabel(command: string): string {
  return cleanTestSegment(command).slice(0, 80)
}

/**
 * What a run's total is remembered under: the folders it `cd`s into and its
 * test command, so a log name or a variable that changes run to run does not
 * lose the estimate, and two packages' `pnpm test` stay apart.
 */
export function runKey(command: string): string {
  const folders = segmentsOf(command)
    .map(segment => /^cd\s+(\S+)$/.exec(segment)?.[1])
    .filter(folder => folder !== undefined)

  return [...folders, cleanTestSegment(command)].join(' | ')
}
