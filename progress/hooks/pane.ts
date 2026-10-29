// The panel as a Claude Code pane, for every setup but WezTerm on WSL: the same
// Phases, Tests and Learn tabs as widget/PhasesWidget.ps1, drawn inside Claude
// Code itself. Pure helpers only: the drawing and the calls on `$` live in register.tsx.

import type { PhasePlan, TestRun } from '../types'
import { runCount, runRatio, runTotals } from './format'
import type { LearnBuild, LearnStatus } from './learn'
import { phaseCounts } from './phases'

export const PANE_ID = 'progress'
export const BAR_CELLS = 18

export type Tab = 'phases' | 'tests' | 'learn'

export const GAMES = [
  { id: 'sudoku', label: 'Sudoku' },
  { id: '2048', label: '2048' },
  { id: 'typing', label: 'Typing' },
  { id: 'chess', label: 'Chess' },
] as const

export type GameId = (typeof GAMES)[number]['id']

export const isGame = (name: string): name is GameId => GAMES.some(game => game.id === name)

/** An 18-cell bar of █ and ░; all ░ while the ratio is unknown. */
export function bar(ratio: number | null, cells = BAR_CELLS): string {
  const full = ratio === null ? 0 : Math.max(0, Math.min(cells, Math.round(ratio * cells)))
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

const hasPlan = (plan: PhasePlan | null): plan is PhasePlan => plan !== null && plan.items.length > 0

export function phasesLabel(plan: PhasePlan | null): string {
  if (!hasPlan(plan)) return 'Phases'
  const { done, total } = phaseCounts(plan)
  return `Phases ${done}/${total}`
}

export function testsLabel(runs: readonly TestRun[]): string {
  const live = [...runs].reverse().find(run => run.status === 'running')
  if (live) return `Tests ● ${runCount(live)}`
  const last = runs.at(-1)
  if (!last) return 'Tests'
  return last.status === 'failed' ? 'Tests ✗' : 'Tests ✓'
}

export function learnLabel(learn: LearnStatus | null): string {
  const build = learn?.build
  if (build?.state === 'running') return build.total > 0 ? `Learn ${build.done}/${build.total}` : 'Learn ●'
  return 'Learn'
}

/** The run's mark: ● while running (red once anything failed), ✓ passed, ✗ failed. */
export function runMark(run: TestRun): { glyph: string; color: 'success' | 'error' | undefined } {
  if (run.status === 'running') return { glyph: '●', color: run.failed > 0 ? 'error' : undefined }
  return run.status === 'passed' ? { glyph: '✓', color: 'success' } : { glyph: '✗', color: 'error' }
}

export function testsFooter(runs: readonly TestRun[]): string {
  const totals = runTotals(runs)
  const failed = totals.failed > 0 ? ` · ${totals.failed} failed` : ''
  return `${totals.tests} tests in ${totals.runs} run${totals.runs === 1 ? '' : 's'} · ${totals.passed} passed${failed}`
}

export function buildColor(build: LearnBuild): 'error' | 'warning' | 'success' | 'claude' {
  if (build.state === 'failed') return 'error'
  if (build.state === 'waiting-picks') return 'warning'
  if (build.state === 'done') return 'success'
  return 'claude'
}

export const buildRatio = (build: LearnBuild) => (build.total > 0 ? build.done / build.total : null)

/**
 * Which tab comes to the front after a change, as the WPF panel picks it: a new
 * newest run brings Tests forward; no plan but some runs, Tests; no runs while
 * Tests is in front, back to Phases; only a Learn build going, Learn.
 */
export function frontTab(options: {
  current: Tab
  plan: PhasePlan | null
  runs: readonly TestRun[]
  learn: LearnStatus | null
  lastFocus: string | null
}): Tab {
  const { current, plan, runs, learn, lastFocus } = options
  const focus = runs.at(-1)?.id ?? null
  const isBuilding = learn?.build !== null && learn?.build !== undefined
  if (focus !== null && focus !== lastFocus) return 'tests'
  if (!hasPlan(plan) && runs.length > 0) return current === 'learn' ? 'learn' : 'tests'
  if (runs.length === 0 && current === 'tests') return hasPlan(plan) || !isBuilding ? 'phases' : 'learn'
  if (!hasPlan(plan) && runs.length === 0 && isBuilding) return 'learn'
  return current
}

/** One line for the tab in front, for an inline pane with little room. */
export function collapsedLine(tab: Tab, plan: PhasePlan | null, runs: readonly TestRun[], learn: LearnStatus | null): string {
  if (tab === 'tests') {
    const run = runs.at(-1)
    if (run) return `${runMark(run).glyph} ${run.label}  ${bar(runRatio(run), 10)} ${runCount(run)}`
  }
  if (tab === 'learn') {
    const build = learn?.build
    if (build) return `${build.topic}: ${build.message}${build.total > 0 ? ` (${build.done}/${build.total} pages)` : ''}`
    if (learn?.course) return `${learn.course.title} · page ${learn.course.page} of ${learn.course.total}`
    return 'Learn'
  }
  if (hasPlan(plan)) {
    const { done, total } = phaseCounts(plan)
    const now = plan.items.find(item => item.status === 'in_progress') ?? plan.items.find(item => item.status === 'todo')
    return `${now ? now.name : plan.title}  ${done}/${total}`
  }
  return 'No plan yet.'
}

/** The status line under the prompt: something shows even where the pane can't seat. */
export function statusLine(plan: PhasePlan | null, runs: readonly TestRun[], learn: LearnStatus | null): string | undefined {
  const parts: string[] = []
  if (hasPlan(plan)) parts.push(phasesLabel(plan))
  if (runs.length > 0) parts.push(testsLabel(runs))
  if (learn?.build) parts.push(learnLabel(learn))
  return parts.length > 0 ? parts.join(' · ') : undefined
}
