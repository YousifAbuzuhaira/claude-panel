import type { Phase, PhasePlan, PhaseStatus } from '../types'

const STATUSES: readonly PhaseStatus[] = ['todo', 'in_progress', 'done']
const MAX_PHASES = 30
const MAX_NAME = 120

export const PHASES_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'What the whole job is, in a few words (the pane title). Keep it the same across updates of one plan.',
    },
    phases: {
      type: 'array',
      description: 'The full list of phases, every time, in order. An empty list clears the tracker.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name for the phase.' },
          status: { type: 'string', enum: STATUSES },
        },
        required: ['name', 'status'],
      },
    },
  },
  required: ['phases'],
} as const

/** The tool's input checked and trimmed, or why it is refused. */
export function readPhasesInput(input: Record<string, unknown>): { title: string; items: Phase[] } | { error: string } {
  const { title, phases } = input
  if (!Array.isArray(phases)) return { error: '`phases` must be an array.' }
  if (phases.length > MAX_PHASES) return { error: `At most ${MAX_PHASES} phases.` }

  const items: Phase[] = []
  for (const phase of phases) {
    const name = typeof phase?.name === 'string' ? phase.name.trim() : ''
    const status = STATUSES.find(one => one === phase?.status)
    if (name === '' || status === undefined) {
      return { error: "Each phase needs a non-empty `name` and a `status` of 'todo', 'in_progress' or 'done'." }
    }
    items.push({ name: name.slice(0, MAX_NAME), status })
  }
  if (items.filter(item => item.status === 'in_progress').length > 1) {
    return { error: 'Only one phase can be in_progress at a time.' }
  }

  const name = typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, MAX_NAME) : 'Phases'
  return { title: name, items }
}

export function phaseCounts(plan: PhasePlan): { done: number; total: number; current: Phase | undefined } {
  return {
    done: plan.items.filter(item => item.status === 'done').length,
    total: plan.items.length,
    current: plan.items.find(item => item.status === 'in_progress'),
  }
}

/** The one line the model reads back after each update. */
export function describePlan(plan: PhasePlan): string {
  const { done, total, current } = phaseCounts(plan)
  const next = plan.items.find(item => item.status === 'todo')
  const now = current ? `now: ${current.name}` : next ? `next: ${next.name}` : 'all done'

  return `Phases ${done}/${total} done; ${now}.`
}

export const PHASES_GUIDE = `# Phase tracking
The person watches a floating progress panel over this chat; its Phases tab is fed by the \`mcp__progress__phases_write\` tool.
- For any task with 3 or more distinct phases (an approved plan, a multi-step implementation, a migration), call it before starting work with the full list of phases: short names, the first one \`in_progress\`.
- Each time a phase finishes, call it again with the full list: that phase \`done\`, the next \`in_progress\`. Exactly one phase is \`in_progress\` while work goes on. Update it as you go, not in a batch at the end.
- Keep the same \`title\` for one plan; a new title starts a new plan.
- When the task is finished or abandoned, call it with \`phases: []\`.
- Skip it for small tasks.`
