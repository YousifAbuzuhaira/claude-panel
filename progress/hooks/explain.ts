// /explain: the code you're working on, explained as short video clips. The session writes the
// plan (it has the code and what you're debugging in hand) and hands it to Learn through the
// explain_plan tool; Learn checks it against the files and this chat, then makes and plays the
// clips. Pure helpers only: the calls on `$` live in register.tsx.

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
              properties: { file: { type: 'string', description: "Relative to this session's folder." }, from: { type: 'integer' }, to: { type: 'integer' }, expect: { type: 'string', description: 'A few words found in those lines, so a moved line is caught.' } },
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
  "Hands Learn a plan for short narrated video clips explaining code from this session (the /explain command). Learn checks the plan against the files and this chat, refusing with what to fix, then makes the clips and opens the player. Call it only when /explain asked you to."

/** What /explain asks the session to do: plan the clips and hand them over. */
export function explainBrief(what: string): string {
  const topic = what.replace(/\s+/g, ' ').trim().slice(0, 300)
  return [
    `Explain ${topic ? `"${topic}"` : 'what we are working on'} to me as short narrated video clips, made by Learn. Don't explain it here in text: plan the clips and hand them to Learn.`,
    '',
    `1. Look at the code first (read the files that matter), then write the plan and call the tool mcp__progress__${EXPLAIN_TOOL} with it. If its schema isn't loaded, load it with ToolSearch (select:mcp__progress__${EXPLAIN_TOOL}).`,
    '2. One clip per mechanism, in the order they build on each other, 1 to 12 clips. Clip 1 (level 1) is the mental model; level 2 clips add the mechanism and its code; level 3 the failure modes and edges. The player lets me pick how deep to go.',
    "3. Each clip's facts are plain sentences: what it does, why, what happens next. Mark each fact's basis: code (the clip's anchored lines show it) or session (this chat says it, with a quote of 4 words or more copied word for word from one message). Nothing else: no outside facts, no made-up examples.",
    '4. Anchor the code each clip shows by file and line range (from 1, relative to this folder, at most 60 lines) with a few words from those lines in "expect". Learn reads the lines from disk: never paste code into a fact.',
    "5. Each clip opens with a guess question: 3 options, one right, each wrong one a believable mistake, each with a one-sentence why, and a quote from the clip's facts or code that states the right answer. Make it about the clip's central mechanism.",
    '6. If a fact describes something that really went wrong in this work (a bug we fixed, a failing test, an idea that turned out false), list its number in "failure": the clip opens on it.',
    '7. The map: "flow" when something moves from part to part (a request through services), "parts" for parts of one whole, "none" under 3 clips. At most 4 top boxes, labels of 1 to 3 words; each clip in one box.',
    '',
    'If Learn refuses the plan, fix what it lists and call the tool again. When it accepts, tell me in one line that the clips are being made and the player is opening. Keep your reply short.',
  ].join('\n')
}

/** The helper that checks a plan and starts making it: the plan goes on its standard input. */
export function explainArgv({ pluginRoot, sessionId, cwd, isWindows = false }: { pluginRoot: string; sessionId: string; cwd: string; isWindows?: boolean }): string[] {
  const helper = isWindows ? ['node', `${pluginRoot}/learn/learn.mjs`] : ['bash', `${pluginRoot}/learn/learn.sh`]
  return [...helper, 'explain', 'start', '--session', sessionId, '--cwd', cwd]
}

export type ExplainAnswer = { ok: true; id: string; clips: number } | { ok: false; problems: string[] }

/** The helper's last line: the explainer made, or what to fix. Anything else is a failure to report. */
export function readExplainAnswer(stdout: string): ExplainAnswer | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.ok === true && typeof value.id === 'string' && /^x[0-9a-f]{12,20}$/i.test(value.id)) return { ok: true, id: value.id, clips: typeof value.clips === 'number' ? value.clips : 0 }
    if (value.ok === false && Array.isArray(value.problems)) return { ok: false, problems: value.problems.filter((item): item is string => typeof item === 'string').slice(0, 30) }
  } catch {}
  return null
}

/** The tool's answer when the plan is refused: what to fix, as a list the session works through. */
export const refusalText = (problems: string[]) => `Learn refused the plan. Fix these and call ${EXPLAIN_TOOL} again:\n${problems.map(problem => `- ${problem}`).join('\n')}`
