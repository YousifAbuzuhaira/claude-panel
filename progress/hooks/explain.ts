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

/**
 * The helper, for an `explain …` command. `entry` is what Node runs on Windows (where `bash` is
 * WSL's): learn.mjs here, explain-cli.mjs in the explain plugin, which carries no learn.mjs
 * (learn.sh finds which by itself).
 */
export function helperArgv({ pluginRoot, isWindows = false, entry = 'learn.mjs' }: { pluginRoot: string; isWindows?: boolean; entry?: string }, args: string[]): string[] {
  const helper = isWindows ? ['node', `${pluginRoot}/learn/${entry}`] : ['bash', `${pluginRoot}/learn/learn.sh`]
  return [...helper, 'explain', ...args]
}

/** The last line of a helper's output as JSON, or null. */
export function lastJson(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout.trim().split('\n').at(-1) || 'null') as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The helper that checks a plan and starts making it: the plan goes on its standard input. `wiki` is the workspace picked for it. */
export function explainArgv({ sessionId, cwd, wiki = null, ...where }: { pluginRoot: string; sessionId: string; cwd: string; isWindows?: boolean; entry?: string; wiki?: WikiTo | null }): string[] {
  return helperArgv(where, ['start', '--session', sessionId, '--cwd', cwd, ...(wiki ? ['--wiki', wiki] : [])])
}

/** The tool's full name in a session: `mcp__<plugin>__explain_plan` (progress, or the explain plugin). */
export const explainToolName = (plugin = 'progress') => `mcp__${plugin}__${EXPLAIN_TOOL}`

// --- The wiki ------------------------------------------------------------------------------------
// Asked beside the depth, each time, only with a wiki key on this computer; "No" comes first and an
// answer holds for that explainer alone. What you clicked is read from the question's own result,
// never from what Claude says you picked.

export type WikiTo = 'personal' | 'shared'

const WIKI_HEADER = 'Wiki'
const WIKI_LABELS = { personal: 'My personal workspace', shared: 'Shared workspace' } as const
const WIKI_PLACES = { personal: 'your personal workspace', shared: 'the shared workspace' } as const

/** Learn's settings file, where `"wiki": "off"` stops the question. */
export const learnSettingsPath = (home: string) => `${home}/.config/claude-learn/settings.json`

/** Whether /explain asks about the wiki: a key is set, and the setting isn't off. */
export function asksWiki(key: string | undefined, settings: string): boolean {
  if (!key) return false
  try {
    return (JSON.parse(settings) as { wiki?: unknown } | null)?.wiki !== 'off'
  } catch {
    return true
  }
}

/**
 * The workspace clicked in an AskUserQuestion's result: null for No (or anything that isn't one of
 * the two workspaces, or an answer nobody gave), undefined when it didn't ask about the wiki.
 */
export function wikiPicked(result: unknown): WikiTo | null | undefined {
  const { questions, answers, afkTimeoutMs } = (result && typeof result === 'object' ? result : {}) as { questions?: unknown; answers?: unknown; afkTimeoutMs?: unknown }
  const asked = (Array.isArray(questions) ? questions : []).find((item: { header?: unknown } | null) => typeof item?.header === 'string' && item.header.trim().toLowerCase() === WIKI_HEADER.toLowerCase()) as { question?: unknown } | undefined
  if (!asked) return undefined
  const answer = answers && typeof answers === 'object' && typeof asked.question === 'string' ? (answers as Record<string, unknown>)[asked.question] : null
  if (typeof answer !== 'string' || afkTimeoutMs !== undefined) return null
  const text = answer.trim().toLowerCase()
  if (/^(?:my )?personal workspace$/.test(text)) return 'personal'
  return /^(?:the )?shared workspace$/.test(text) ? 'shared' : null
}

/** What /clips wiki says, from the helper's answer (wikiCommand in learn/wiki.mjs). */
export function wikiReply(answer: Record<string, unknown> | null): string {
  if (!answer) return '/clips wiki could not run: try it again.'
  if (typeof answer.asking === 'boolean') return answer.asking ? '/explain asks about the wiki (when WIKI_API_KEY is set).' : "/explain no longer asks about the wiki. /clips wiki on brings it back."
  const place = answer.to === 'personal' || answer.to === 'shared' ? WIKI_PLACES[answer.to] : null
  if (answer.found !== true) return 'No clips were asked onto the wiki: /explain asks each time (when WIKI_API_KEY is set).'
  const title = String(answer.title)
  if (!place) return `"${title}" was not asked onto the wiki: /explain asks each time (when WIKI_API_KEY is set).`
  if (answer.waiting === true) return `"${title}" goes on the wiki (${place}) once all its clips are ready: ${String(answer.ready)} of ${String(answer.clips)} are.`
  const urls = Array.isArray(answer.urls) ? answer.urls.map(String) : []
  if (answer.error) return `"${title}" is not on the wiki: ${String(answer.error)}. /clips wiki tries again.`
  return `"${title}" is on the wiki (${place}): ${urls.join(' ')}`
}

export type ExplainAnswer = { ok: true; id: string; clips: number; wanted: number; depth: 1 | 2 | 3 | null; wiki: WikiTo | null } | { ok: false; problems: string[] }

/** The helper's last line: the explainer made, or what to fix. Anything else is a failure to report. */
export function readExplainAnswer(stdout: string): ExplainAnswer | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.ok === true && typeof value.id === 'string' && /^x[0-9a-f]{12,20}$/i.test(value.id)) {
      const clips = typeof value.clips === 'number' ? value.clips : 0
      const depth = value.depth === 1 || value.depth === 2 || value.depth === 3 ? value.depth : null
      const wiki = value.wiki === 'personal' || value.wiki === 'shared' ? value.wiki : null
      return { ok: true, id: value.id, clips, wanted: typeof value.wanted === 'number' ? value.wanted : clips, depth, wiki }
    }
    if (value.ok === false && Array.isArray(value.problems)) return { ok: false, problems: value.problems.filter((item): item is string => typeof item === 'string').slice(0, 30) }
  } catch {}
  return null
}

/** The tool's answer when the plan is refused: what to fix, as a list the session works through. */
export const refusalText = (problems: string[]) => `Learn refused the plan. Fix these and call ${EXPLAIN_TOOL} again:\n${problems.map(problem => `- ${problem}`).join('\n')}`

const DEPTHS = { 1: 'the idea', 2: 'the mechanism', 3: 'everything' } as const

/** First use of the voice in the explain plugin: said once, in the reply. */
export const FIRST_RUN = 'First run: getting the voice (about 350 MB, once), so the first clip takes a few minutes longer.'

/**
 * The tool's answer when Learn takes the plan: what was started, and the one line to reply with.
 * In the explain plugin (`library: false`) there is no Learn to list explainers, and `/clips`
 * opens the file; `firstRun` adds that the voice is being set up. With the wiki asked about
 * (`wikiAsked`), the line says either way, so an answer taken wrong shows at once.
 */
export function acceptedText(
  answer: { clips: number; wanted: number; depth: 1 | 2 | 3 | null; wiki?: WikiTo | null },
  { library = true, firstRun = false, wikiAsked = false }: { library?: boolean; firstRun?: boolean; wikiAsked?: boolean } = {},
): string {
  const plural = (n: number) => `${n} clip${n === 1 ? '' : 's'}`
  const made = answer.depth ? `${plural(answer.wanted)} (of ${answer.clips}; depth: ${DEPTHS[answer.depth]})` : `${plural(answer.clips)}; the player will ask how deep to go after the first`
  const count = plural(answer.depth ? answer.wanted : answer.clips)
  const one = (answer.depth ? answer.wanted : answer.clips) === 1
  const wiki = answer.wiki ? ` ${one ? 'Once ready it goes' : 'Once all are ready they go'} on the wiki (${WIKI_PLACES[answer.wiki]}).` : wikiAsked ? ' Nothing goes on the wiki.' : ''
  const line = library
    ? `Making ${count}, the first in about 3 minutes; a notice here says when each is ready. /clips opens them; /learn library lists every explainer.${wiki}`
    : `${firstRun ? `${FIRST_RUN} ` : ''}Making ${count}, the first in about 3 minutes; a notice here says when each is ready, and /clips opens them as one file.${wiki}`
  return `Learn accepted the plan and is making ${made}. Nothing was opened. Reply with this one line and nothing else: "${line}"`
}

/**
 * How to open a file (an exported explainer) with its default app: on WSL and Windows, explorer.exe
 * (it opens a file as a double-click does; on WSL the file's \\wsl.localhost path), on a Mac
 * `open`, elsewhere `xdg-open`.
 */
export function openFileArgv({ path, platform, distro = null }: { path: string; platform: string; distro?: string | null }): string[] {
  if (platform === 'win32') return ['explorer.exe', path.replaceAll('/', '\\')]
  if (distro) return ['explorer.exe', `\\\\wsl.localhost\\${distro}${path.replaceAll('/', '\\')}`]
  if (platform === 'darwin') return ['open', path]
  return ['xdg-open', path]
}

// Its options' labels are what wikiPicked reads: asked in any other words, the answer counts as No.
const WIKI_STEP = ` In the same AskUserQuestion call ask a second question (header "${WIKI_HEADER}", question "Put the finished clips on the Keops wiki too?", multiSelect false), even when there is no depth to ask about, with exactly these labels in this order: "No, this machine only" (they stay in ~/explainers), "${WIKI_LABELS.personal}" (only you can open them there), "${WIKI_LABELS.shared}" (everyone in Keops can open them, and the code they show). Recommend none of them. My answer is read from my click: say nothing about the wiki in the tool call.`

/**
 * What /explain hands the session, as your own message: plan the clips from the code, ask how deep
 * to go, then hand the plan to Learn. `what` is what you typed after /explain; `plugin` names the
 * tool (progress, or the explain plugin, which has no player to ask the depth later). `wiki` has it
 * ask about the wiki in the same question.
 */
export function explainBrief(what: string, { plugin = 'progress', wiki = false }: { plugin?: string; wiki?: boolean } = {}): string {
  const topic = what.replace(/\s+/g, ' ').trim().slice(0, 500)
  const tool = explainToolName(plugin)
  const noDepth = plugin === 'progress' ? 'If you can\'t ask, leave "depth" out.' : 'If you can\'t ask, use depth 2.'
  return [
    `Explain this to me as short narrated video clips, made ${plugin === 'progress' ? 'by Learn' : 'on this computer'}: ${topic || 'what we are working on'}`,
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
    '8. Ask me once how deep to go, with AskUserQuestion (header "Depth", question "How deep should it go?"). One option per depth that adds clips, N counting your plan\'s clips up to that level: "The idea · N clips" (depth 1: level 1), "The mechanism, and the code that does it · N clips" (depth 2: levels 1 and 2), "Everything, with failure modes and edges · N clips" (depth 3: all). Leave out a depth that adds no clip; with one option left, ' + (wiki ? 'use it without asking. ' : 'don\'t ask and use it. ') + noDepth + (wiki ? WIKI_STEP : ''),
    `9. Call the tool ${tool} with the plan and "depth" (1, 2 or 3). If its schema isn't loaded, load it with ToolSearch (select:${tool}). If Learn refuses the plan, fix what it lists and call it again with the same depth, without asking again.`,
    '10. When it accepts, reply with the one line the tool gives you, and nothing else. Nothing opens by itself.',
  ].join('\n')
}
