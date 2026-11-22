// /explain: the code you're working on, explained as short video clips. The command hands the
// session the brief below as your message, once the command has returned (a turn of its own at
// once); the session writes the plan (it has the code and what you're debugging in hand), asks
// how deep to go, and hands it to Learn through the explain_plan tool; Learn checks it against the
// files and this chat, then makes the clips. Nothing opens by itself: /clips, the Library and the
// panel open them. Pure helpers only: the calls on `$` live in register.tsx.

export const EXPLAIN_TOOL = 'explain_plan'

const QUESTION = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'The guess question that opens the clip, asked before it teaches.' },
    options: {
      type: 'array',
      description: 'Exactly 3, one right. Each wrong one a believable mistake.',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, why: { type: 'string', description: 'One sentence.' }, right: { type: 'boolean' } },
        required: ['text', 'why', 'right'],
      },
    },
    quote: { type: 'string', description: "At least 4 words, word for word from this clip's facts or anchored code, stating the right answer." },
  },
  required: ['q', 'options', 'quote'],
} as const

export const EXPLAIN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What the clips explain, in a few words.' },
    shape: { type: 'string', enum: ['flow', 'parts', 'none'], description: 'The map: flow when something moves from part to part, parts for parts of one whole, none under 3 clips or with no structure.' },
    boxes: {
      type: 'array',
      description: 'The map: at most 4 top boxes (parent null), each with up to 4 children. Labels 1 to 3 words.',
      items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, parent: { type: ['string', 'null'] } }, required: ['id', 'label', 'parent'] },
    },
    depth: { type: 'integer', enum: [1, 2, 3], description: 'How deep to go, as the person picked when asked in the chat before this call: 1 the idea (level 1 clips), 2 the mechanism and its code (levels 1 and 2), 3 everything. Left out only when they could not be asked; the player asks instead.' },
    clips: {
      type: 'array',
      description: 'One per mechanism, in teaching order, 1 to 12.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          box: { type: ['string', 'null'], description: 'Its box on the map; null with shape none.' },
          level: { type: 'integer', enum: [1, 2, 3], description: '1 the mental model (clip 1 always), 2 the mechanism and its code, 3 the rest: failure modes, edges.' },
          facts: {
            type: 'array',
            description: 'What the clip teaches, one fact each, in order, as plain sentences.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                basis: { type: 'string', enum: ['code', 'session'], description: 'code: the anchored code shows it. session: this chat says it.' },
                quote: { type: 'string', description: 'For a session fact: at least 4 words copied word for word from one message of this chat.' },
              },
              required: ['text', 'basis'],
            },
          },
          anchors: {
            type: 'array',
            description: 'The code the clip shows, by file and lines (from 1), read from disk by Learn. At most 60 lines each.',
            items: {
              type: 'object',
              properties: { file: { type: 'string', description: "Relative to this session's folder, or a full or ~/ path under your home folder. Files that look like secrets are refused." }, from: { type: 'integer' }, to: { type: 'integer' }, expect: { type: 'string', description: 'A few words found in those lines, so a moved line is caught.' } },
              required: ['file', 'from', 'to', 'expect'],
            },
          },
          guess: QUESTION,
          failure: { type: 'array', items: { type: 'integer' }, description: 'Numbers (from 0) of facts that describe something that really went wrong in this work: a bug fixed, a failing test, an idea that turned out false.' },
          handoff: { type: ['string', 'null'], description: 'Flow only: at most 8 words naming what passes from the previous clip\'s box into this one.' },
        },
        required: ['title', 'box', 'level', 'facts', 'anchors', 'guess'],
      },
    },
  },
  required: ['title', 'shape', 'boxes', 'clips'],
} as const

export const EXPLAIN_TOOL_DESCRIPTION =
  "Hands Learn a plan for short narrated video clips explaining code from this session (the /explain command), with the depth the person picked. Learn checks the plan against the files and this chat, refusing with what to fix, then makes the clips. Nothing opens by itself. Call it only when /explain asked you to."

/** The helper that checks a plan and starts making it: the plan goes on its standard input. */
export function explainArgv({ pluginRoot, sessionId, cwd, isWindows = false }: { pluginRoot: string; sessionId: string; cwd: string; isWindows?: boolean }): string[] {
  const helper = isWindows ? ['node', `${pluginRoot}/learn/learn.mjs`] : ['bash', `${pluginRoot}/learn/learn.sh`]
  return [...helper, 'explain', 'start', '--session', sessionId, '--cwd', cwd]
}

export type ExplainAnswer = { ok: true; id: string; clips: number; wanted: number; depth: 1 | 2 | 3 | null } | { ok: false; problems: string[] }

/** The helper's last line: the explainer made, or what to fix. Anything else is a failure to report. */
export function readExplainAnswer(stdout: string): ExplainAnswer | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.ok === true && typeof value.id === 'string' && /^x[0-9a-f]{12,20}$/i.test(value.id)) {
      const clips = typeof value.clips === 'number' ? value.clips : 0
      const depth = value.depth === 1 || value.depth === 2 || value.depth === 3 ? value.depth : null
      return { ok: true, id: value.id, clips, wanted: typeof value.wanted === 'number' ? value.wanted : clips, depth }
    }
    if (value.ok === false && Array.isArray(value.problems)) return { ok: false, problems: value.problems.filter((item): item is string => typeof item === 'string').slice(0, 30) }
  } catch {}
  return null
}

/** The tool's answer when the plan is refused: what to fix, as a list the session works through. */
export const refusalText = (problems: string[]) => `Learn refused the plan. Fix these and call ${EXPLAIN_TOOL} again:\n${problems.map(problem => `- ${problem}`).join('\n')}`

const DEPTHS = { 1: 'the idea', 2: 'the mechanism', 3: 'everything' } as const

/** The tool's answer when Learn takes the plan: what was started, and the one line to reply with. */
export function acceptedText(answer: { clips: number; wanted: number; depth: 1 | 2 | 3 | null }): string {
  const plural = (n: number) => `${n} clip${n === 1 ? '' : 's'}`
  const made = answer.depth ? `${plural(answer.wanted)} (of ${answer.clips}; depth: ${DEPTHS[answer.depth]})` : `${plural(answer.clips)}; the player will ask how deep to go after the first`
  const line = `Making ${plural(answer.depth ? answer.wanted : answer.clips)}, the first in about 3 minutes; a notice here says when each is ready. /clips opens them; /learn library lists every explainer.`
  return `Learn accepted the plan and is making ${made}. Nothing was opened. Reply with this one line and nothing else: "${line}"`
}

/**
 * What /explain hands the session, as your own message: plan the clips from the code, ask how deep
 * to go, then hand the plan to Learn. `what` is what you typed after /explain.
 */
export function explainBrief(what: string): string {
  const topic = what.replace(/\s+/g, ' ').trim().slice(0, 500)
  return [
    `Explain this to me as short narrated video clips, made by Learn: ${topic || 'what we are working on'}`,
    '',
    "Don't explain it here in text: plan the clips and hand them to Learn.",
    '',
    '0. First reply with one short line, such as "Planning clips about X: reading the code", before any tool call, so I know it has started.',
    '1. Look at the code first (read the files that matter), then write the whole plan and hold it: don\'t call the tool yet.',
    '2. One clip per mechanism, in the order they build on each other, 1 to 12 clips. Clip 1 (level 1) is the mental model; level 2 clips add the mechanism and its code; level 3 the failure modes and edges.',
    "3. Each clip's facts are plain sentences: what it does, why, what happens next. Mark each fact's basis: code (the clip's anchored lines show it) or session (this chat says it, with a quote of 4 words or more copied word for word from one message). Nothing else: no outside facts, no made-up examples.",
    '4. Anchor the code each clip shows by file and line range (from 1, at most 60 lines) with a few words from those lines in "expect". Prefer anchors of at most 18 lines, with lines under 110 characters: longer ones are split into parts or shown small. The file is relative to this session\'s folder, or a full or ~/ path anywhere under my home folder; files that look like secrets (.env, keys, credentials) are refused. Learn reads the lines from disk: never paste code into a fact.',
    "5. Each clip opens with a guess question: 3 options, one right, each wrong one a believable mistake, each with a one-sentence why, and a quote from the clip's facts or code that states the right answer. Make it about the clip's central mechanism. (Learn uses it only when my Questions setting is on.)",
    '6. If a fact describes something that really went wrong in this work (a bug we fixed, a failing test, an idea that turned out false), list its number in "failure": the clip opens on it.',
    '7. The map: "flow" when something moves from part to part (a request through services), "parts" for parts of one whole, "none" under 3 clips. At most 4 top boxes, labels of 1 to 3 words; each clip in one box.',
    '8. Ask me once how deep to go, with AskUserQuestion (header "Depth", question "How deep should it go?"). One option per depth that adds clips, N counting your plan\'s clips up to that level: "The idea · N clips" (depth 1: level 1), "The mechanism, and the code that does it · N clips" (depth 2: levels 1 and 2), "Everything, with failure modes and edges · N clips" (depth 3: all). Leave out a depth that adds no clip; with one option left, don\'t ask and use it. If you can\'t ask, leave "depth" out.',
    `9. Call the tool mcp__progress__${EXPLAIN_TOOL} with the plan and "depth" (1, 2 or 3). If its schema isn't loaded, load it with ToolSearch (select:mcp__progress__${EXPLAIN_TOOL}). If Learn refuses the plan, fix what it lists and call it again with the same depth, without asking again.`,
    '10. When it accepts, reply with the one line the tool gives you, and nothing else. Nothing opens by itself.',
  ].join('\n')
}
