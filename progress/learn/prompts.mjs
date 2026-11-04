// What Claude is asked at each step, and the JSON shape each structured answer must take.
// The builder's calls run with no tools except research (web search and fetch).

const LEARNER = 'The learner is a strong software engineer, but assume they know nothing of THIS subject: its words, ideas and notation are new to them. They study in the minutes while their coding agent works. They want depth and real practice, not marketing or fluff.';

// Diagrams: Mermaid that learn/diagram.mjs can lay out (anything else shows as code).
export const DIAGRAM_RULE = [
  '- Anything that is a flow, an architecture, a request between parts, a state machine or a pipeline gets a diagram, as a ```mermaid block right after the text it explains; add as many as help the reader see it. Only `flowchart TD`, `flowchart LR` or `sequenceDiagram`. At most 12 boxes, labels of 4 words or fewer, edge labels of 1-3 words; no subgraph, classDef, style or HTML. Skip a diagram that would only repeat a list, and never add one for decoration. Use a table to compare things side by side.',
].join('\n');
const CHAT_DIAGRAMS = 'When a picture would make an answer clearer, you may include one small diagram as a ```mermaid block (flowchart TD/LR or sequenceDiagram only, at most 10 boxes, short labels); the app draws it.';

/** How a source that has sections is named to Claude: a web page, a document, a chat brief. */
const describeSource = source => (source.kind === 'doc'
  ? `document "${source.title}" (${[source.docType, source.pages ? `${source.pages} pages` : null].filter(Boolean).join(', ')})`
  : source.kind === 'chat'
    ? `brief "${source.title}", written from the learner's own chat with their coding agent`
    : `web page "${source.title}" (${source.url})`);

// --- Research -----------------------------------------------------------------------

export const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    courseTitle: { type: 'string', description: 'A short course title, e.g. "Kubernetes deployments in practice"' },
    summary: { type: 'string', description: 'One or two sentences on what the course will cover' },
    asks: { type: 'array', items: { type: 'string' }, description: 'Every separate thing the learner named, in their words' },
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['youtube', 'web'] },
          url: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string', description: 'YouTube channel or site name' },
          lengthMin: { type: ['number', 'null'], description: 'Video length in minutes, or reading time for a page' },
          level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
          why: { type: 'string', description: 'One sentence to the learner on why this source is worth it' },
          covers: { type: 'array', items: { type: 'number' }, description: 'The numbers of the asks this source teaches well (0 is the first)' },
          recommended: { type: 'boolean', description: 'True for the sources the course should be built from' },
        },
        required: ['kind', 'url', 'title', 'channel', 'lengthMin', 'level', 'why', 'covers', 'recommended'],
      },
    },
  },
  required: ['courseTitle', 'summary', 'asks', 'candidates'],
};

export function researchPrompt({ topic, category, known, videos, asks = [], missing = [] }) {
  return [
    `Find the best FREE material to build a course on: ${topic}`,
    `It goes in the learner's "${category}" category. ${LEARNER}`,
    '',
    'The course must cover EVERYTHING they named, not a part of it. First list each separate thing they named in "asks", in their words: "Docker, Kubernetes and Terraform" is three.',
    ...(missing.length ? [
      `An earlier search found nothing good for: ${missing.join('; ')}. Search again for those only.`,
      `Keep "asks" exactly as this list, so "covers" uses the same numbers: ${asks.map((ask, number) => `${number}: ${ask}`).join('; ')}.`,
    ] : []),
    '',
    known.learned.length ? `Already learned (don't build around these): ${known.learned.join('; ')}` : 'Nothing marked learned yet in this area.',
    known.seen.length ? `Read about before but not yet learned: ${known.seen.join('; ')}` : '',
    '',
    'YouTube results found by search (id, title, channel, minutes, views):',
    ...videos.map(video => `- ${video.url} | ${video.title} | ${video.channel} | ${video.lengthMin ?? '?'} min | ${video.views ?? '?'} views`),
    '',
    'Do this:',
    '1. Use WebSearch (and WebFetch to check) to find 2-4 strong open written sources: official documentation, freeCodeCamp, MIT Missing Semester, CS50 notes, well-known GitHub guides or engineering blogs. Nothing behind a login or paywall (no Udemy, Coursera, LinkedIn Learning, member-only Medium).',
    '2. You may search YouTube for better videos than the list above, but give normal watch URLs (https://www.youtube.com/watch?v=...).',
    '3. Return 5-8 candidates mixing videos and pages, more when they named many things. Prefer well-structured videos with chapters from reputable channels, recent enough to be current, and pages with real commands and code. Avoid clickbait, near-duplicates and shallow listicles. In "covers", give the number of each ask a source teaches well.',
    '4. Mark as recommended the sources the course should be built from: together they must cover every ask, and pair video explanations with a written source that has the real commands and code. Use as many as that takes.',
  ].filter(line => line !== '').join('\n');
}

// --- Outline ---------------------------------------------------------------------------

export const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'Two sentences on what the learner will be able to do after the course' },
    pages: {
      type: 'array',
      minItems: 3,
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          part: { type: 'string', description: 'The name of the part of the course this page belongs to' },
          covers: { type: 'array', items: { type: 'number' }, description: 'The numbers of the asks this page teaches' },
          outcomes: { type: 'array', items: { type: 'string' }, description: 'What the learner can do after this page, 1-3 items, each starting with a verb' },
          subtopics: { type: 'array', items: { type: 'string' }, description: 'Everything the page covers, as short items' },
          sourceId: { type: 'string', description: 'The main source this page teaches from' },
          fromSec: { type: ['number', 'null'], description: 'For a video: where the part this page covers starts, in seconds' },
          toSec: { type: ['number', 'null'], description: 'For a video: where it ends, in seconds' },
          sections: { type: 'array', items: { type: 'string' }, description: 'For a web page: the exact headings this page draws on' },
          support: {
            type: 'array',
            description: 'Other sources this page also draws on, e.g. the docs section with the real commands for a video page',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string' },
                fromSec: { type: ['number', 'null'] },
                toSec: { type: ['number', 'null'] },
                sections: { type: 'array', items: { type: 'string' } },
              },
              required: ['sourceId'],
            },
          },
          concepts: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                id: { type: ['string', 'null'], description: 'The catalogue id when this is the same idea as an existing concept, else null' },
                name: { type: 'string' },
                definition: { type: 'string', description: 'One line' },
                parent: { type: ['string', 'null'], description: 'A broader concept: a catalogue id, or the name of another concept in this outline' },
                aliases: { type: 'array', items: { type: 'string' } },
                match: { type: 'string', enum: ['existing', 'new'] },
                reason: { type: 'string', description: 'Why it matches that existing concept, or why it is new' },
              },
              required: ['id', 'name', 'definition', 'parent', 'aliases', 'match', 'reason'],
            },
          },
        },
        required: ['title', 'part', 'covers', 'outcomes', 'subtopics', 'sourceId', 'fromSec', 'toSec', 'sections', 'support', 'concepts'],
      },
    },
  },
  required: ['title', 'summary', 'pages'],
};

export function outlinePrompt({ topic, title, category, sources, catalogue, asks = [], missing = [] }) {
  return [
    `Plan a course on "${topic}" (working title: ${title}), from the sources below. ${LEARNER}`,
    '',
    ...(asks.length ? [
      'The learner asked for all of these, and every one must get its own pages. In "covers", give the numbers each page teaches:',
      ...asks.map((ask, number) => `${number}: ${ask}`),
      '',
    ] : []),
    ...(missing.length ? [`Your last plan had no page for: ${missing.join('; ')}. Plan those too.`, ''] : []),
    'Rules:',
    '- Cover everything the sources teach on what the learner asked. One main idea per page, as many pages as that takes, at most 40. Never leave something out to keep the course short; never add a page just to fill it out.',
    '- Order the pages so that each one only needs what came before it (not necessarily source order): what a thing is and why it exists before how to configure it, tune it or use it with something else. Start from what a software engineer already knows.',
    '- Group the pages into 2-7 parts, each a short name in "part", with a part\'s pages next to each other. A short course may have one part.',
    '- Give each page 1-3 outcomes: what the learner will be able to do after it, starting with a verb (trace, choose, explain why, spot, fix), never "understand" or "know". The page and its questions will be built from these.',
    '- The last page is a practical task that uses the whole course on something real, so the learner pulls it together.',
    '- Each page teaches from one main source: a time window of a video (fromSec/toSec, using the chapters and timestamps) or named headings of a web page, document or brief (sections, copied exactly). Add support sources where they help, especially written docs that have the real commands for a video page.',
    '- Skip intros, outros, sponsor segments, channel promotion and off-topic tangents.',
    '- Tag each page with 1-6 concepts. A concept is one idea that can be explained and checked in a few minutes (e.g. "Docker named volumes", not "Docker"). Give a broader parent where one fits.',
    '- The learner keeps ONE catalogue of concepts across all courses. Before inventing a concept, look for the same idea in the catalogue, even under different wording, and reuse its id with match "existing". Only create a concept (id null, match "new") when nothing there is the same idea. Say why in "reason".',
    `- New concepts go in the "${category}" category; you don't set that.`,
    '',
    'CATALOGUE (id | name | parent | other names | category):',
    catalogue || '(empty: this is the first course)',
    '',
    'SOURCES:',
    ...sources.map(source => source.kind === 'youtube'
      ? [`### ${source.id}: video "${source.title}" by ${source.channel}, ${Math.round((source.durationSec || 0) / 60)} min`,
         source.chapters.length ? `Chapters:\n${source.chapters.map(chapter => `- ${chapter.start}s-${chapter.end}s ${chapter.title}`).join('\n')}` : 'No chapters.',
         'Transcript sample ([m:ss] at each line):', source.excerpt].join('\n')
      : [`### ${source.id}: ${describeSource(source)}`, 'Headings with the start of each section:', source.excerpt].join('\n')),
  ].join('\n');
}

// --- A page ----------------------------------------------------------------------------------

export const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string', description: 'The full lesson in Markdown' },
  },
  required: ['markdown'],
};

export function pagePrompt({ course, page, position, total, prevTitles, nextTitle, concepts, material, learned, missing = [] }) {
  return [
    `Write page ${position} of ${total} of the course "${course.title}": "${page.title}". ${LEARNER}`,
    page.note ? `This is a rewrite of the page, and the learner asked: "${page.note}". Follow that.` : '',
    page.added && !page.note ? 'The learner added this page by hand, on a topic the sources may only partly cover: say so plainly and mark what you add (added).' : '',
    (page.outcomes || []).length ? `After this page the learner must be able to: ${page.outcomes.join('; ')}.` : '',
    page.subtopics.length ? `It must cover ALL of these: ${page.subtopics.join('; ')}.` : '',
    missing.length ? `Your last version left these out, so teach them properly this time: ${missing.join('; ')}.` : '',
    prevTitles.length ? `Earlier pages: ${prevTitles.join('; ')}.` : 'This is the first page.',
    nextTitle ? `The next page is "${nextTitle}", so don't teach that here.` : 'This is the last page: make it a practical task that uses the whole course on something real.',
    learned.length ? `The learner already knows: ${learned.join('; ')}. Build on that rather than re-explaining it.` : '',
    '',
    'Concepts this page must teach (id: name: definition):',
    ...concepts.map(concept => `- ${concept.id}: ${concept.name}: ${concept.definition}`),
    '',
    'How to write it:',
    '- A full lesson: as long as it takes to cover everything above properly, and no longer. Cover it all; never skim something to save space. The page title is shown above it, so start with a short paragraph on why this matters, tied to something a software engineer already knows, then ## sections.',
    '- Keep each ## section short and about one thing: quick questions sit between sections. Headings say the point ("Greedy search repeats itself"), not just a label ("Greedy search").',
    '- Teach in your own words. Never copy the transcript; it is speech, and the learner can watch the video for that.',
    '- Never assume a word of this subject. Explain each one in plain words the first time it appears on this page, even if an earlier page did. Say what a thing is before you use its name. Keep notation out until the idea is clear, and read any formula out in words.',
    '- Explain what it is, why it exists, how it works underneath, and how it is used in real work.',
    '- Every concept gets at least one worked example with real values, walked through step by step so the reader sees what happens at each step. Start small enough to follow in your head, then show the real command or code in a fenced block with a language (```bash, ```yaml, ```ts...).',
    '- Mark these with a callout, a quote block whose first line names its kind:',
    '  > [!example] A short title',
    '  > The worked example, which may hold code blocks and lists.',
    '  [!key] for the one idea to remember from a section (at most a few on a page); [!warning] for a common mistake and how to spot it; [!analogy] for a comparison with something a software engineer already knows.',
    '- Cite once per paragraph, at its end, not after every sentence: after something from a video, the time it is said as [m:ss] or [h:mm:ss] (when the material has more than one video, the video\'s id first, as in [s4 1:05]); after something from a web page, document or brief, [sec: Exact Heading].',
    '- When you add something that is NOT in the material below (a fact, a command, a caveat, an example of your own), put (added) right after that sentence, or once after a whole example.',
    DIAGRAM_RULE,
    '- End with a short "## Recap" of the key points. Do not put any questions in the Markdown.',
    '',
    'MATERIAL:',
    material,
  ].filter(line => line !== '').join('\n');
}

// --- A page's terms and questions, from the finished page ----------------------------------------

const QUESTION_FIELDS = {
  quote: { type: 'string', description: 'The exact words of the page that give the answer, copied character for character, 8-40 words' },
  section: { type: 'string', description: 'The exact ## heading those words are under' },
  concepts: { type: 'array', items: { type: 'string' }, description: 'Ids of the concepts this tests' },
};

export const TEACH_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'The word exactly as the page writes it' },
          aka: { type: 'array', items: { type: 'string' }, description: 'Other spellings the page uses for it' },
          def: { type: 'string', description: 'One or two plain sentences, with no other jargon in them' },
          key: { type: 'boolean', description: 'True for the few a reader needs before starting the page' },
        },
        required: ['term', 'aka', 'def', 'key'],
      },
    },
    quick: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          guess: { type: 'boolean', description: 'True for the one question asked before the page teaches its answer' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                right: { type: 'boolean' },
                why: { type: 'string', description: 'One sentence on why this option is right or wrong' },
              },
              required: ['text', 'right', 'why'],
            },
          },
          ...QUESTION_FIELDS,
        },
        required: ['q', 'guess', 'options', 'quote', 'section', 'concepts'],
      },
    },
    closing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          points: { type: 'array', items: { type: 'string' }, description: 'The 2-3 things a good answer must say' },
          answer: { type: 'string', description: 'A model answer in 1-3 sentences' },
          ...QUESTION_FIELDS,
        },
        required: ['q', 'points', 'answer', 'quote', 'section', 'concepts'],
      },
    },
  },
  required: ['terms', 'quick', 'closing'],
};

/** `repair` (what failed last time) asks only for replacements. */
export function teachPrompt({ page, concepts, markdown, repair = null }) {
  return [
    `Below is a finished page of a course, "${page.title}". ${LEARNER}`,
    `Write what helps them learn from it. Everything must come from THIS PAGE: never ask about, or rely on, anything the page doesn't teach.`,
    (page.outcomes || []).length ? `The page's goals: ${page.outcomes.join('; ')}. Your questions must test these.` : '',
    '',
    ...(repair ? [
      'Some of your first attempt didn\'t pass. Write only what is asked for here; what passed is kept.',
      ...repair.failed.map(item => `- Replace this question (${item.reason}): ${item.q}`),
      ...repair.unknown.map(word => `- A newcomer couldn't understand "${word}" from the page: define it in terms.`),
      ...repair.untested.map(id => `- No closing question tests concept ${id}: write one.`),
      ...repair.quick.map(check => `- Already kept, so don't ask this again in other words: ${check.q}`),
      '',
    ] : []),
    'TERMS: every word, abbreviation or piece of notation of this subject on the page that a strong software engineer who has never studied it might not know, including ones earlier pages taught. Everyday programming words (function, API, JSON) need none. A term is a word or short phrase: never a whole command, an address, a value from an example, or the page\'s marks [m:ss], [sec: ...] and (added). Set key true on the few (at most 6) a reader needs before starting the page. A definition uses plain words, with a tiny example where that helps.',
    '',
    'QUICK CHECKS: a question that takes seconds, about one for each ## section that teaches something, in page order, as many as the page has real ideas to test and no more. Don\'t force one where there\'s nothing worth asking.',
    '- Test understanding, not wording: apply the idea to a small case.',
    '- 3-4 short options, exactly one right. Each wrong option is a mistake someone learning this would really make, ideally one the page warns about. All options about the same length and style. No "all of the above", no trick wording.',
    '- "why" says in one sentence why that option is right or wrong.',
    '- "quote" is copied exactly from the page and is what gives the answer. Never base a check on a sentence marked (added): that is not from the source.',
    '- You may set guess true on ONE question, about the page\'s main idea, asked before the reader has read it: a curious guess, not a test.',
    '',
    'CLOSING QUESTIONS: the real test of the page. The learner answers in their own words, and passing is what lets them mark a concept as learned.',
    '- Every concept below must be tested by at least one. Prefer one question that tests several related concepts: use as few as that takes, at most 3.',
    '- Each asks them to explain or apply what the page taught, on a case like the page\'s, and must be fully answerable from this page alone.',
    '- "points" are the 2-3 things a good answer must say, each a single idea taken from the page, so a clear explanation in a few sentences can pass.',
    '',
    'Concepts (id: name):',
    ...concepts.map(concept => `- ${concept.id}: ${concept.name}`),
    '',
    'THE PAGE:',
    markdown,
  ].filter(line => line !== '').join('\n');
}

export const READER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          choice: { type: ['number', 'null'], description: 'The number of the option the page supports, or null if the page does not let you tell' },
        },
        required: ['id', 'choice'],
      },
    },
    closing: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, answerable: { type: 'boolean' } },
        required: ['id', 'answerable'],
      },
    },
    unknown: { type: 'array', items: { type: 'string' }, description: 'Words or notation you could not understand from the page' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Listed subtopics the page does not really explain' },
  },
  required: ['answers', 'closing', 'unknown', 'missing'],
};

/** Sees only the page, and never the answers. */
export function readerPrompt({ page, markdown, terms, quick, closing }) {
  return [
    'You are testing a page of a course, as a reader. You are a strong software engineer who knows NOTHING of this subject. All you know is the page below: use no outside knowledge, even if you have it.',
    '',
    'Do these:',
    '1. For each quiz question, give the number of the option THE PAGE supports, or null if the page does not let you tell.',
    '2. For each open question, say whether you could answer it fully from this page alone.',
    '3. In "unknown", list each word or piece of notation you could not understand from the page, unless the glossary below explains it. Leave out everyday programming words, whole commands, values from examples, and the page\'s marks: [m:ss] and [sec: ...] are citations and (added) is a note.',
    (page.subtopics || []).length ? `4. In "missing", list any of these subtopics the page does not really explain: ${page.subtopics.join('; ')}.` : '4. Leave "missing" empty.',
    '',
    'GLOSSARY:',
    ...(terms.length ? terms.map(item => `- ${item.term}: ${item.def}`) : ['(none)']),
    '',
    'QUIZ:',
    ...quick.flatMap(check => [`[${check.id}] ${check.q}`, ...check.options.map((option, number) => `  ${number}: ${option.text}`)]),
    '',
    'OPEN QUESTIONS:',
    ...closing.map(check => `[${check.id}] ${check.q}`),
    '',
    'THE PAGE:',
    markdown,
  ].filter(line => line !== '').join('\n');
}

// --- A course from one of the learner's chats -----------------------------------

export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'False when the chat has nothing about the focus' },
    courseTitle: { type: 'string', description: 'A short title for the course' },
    summary: { type: 'string', description: 'One or two sentences: what the learner will understand afterwards' },
    category: { type: 'string', description: 'One of their category names if one fits, else a new short one' },
    sections: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'A short, distinct heading' },
          text: { type: 'string', description: 'The section in Markdown: several paragraphs, with the code and commands that matter in fenced blocks' },
        },
        required: ['heading', 'text'],
      },
    },
  },
  required: ['found', 'courseTitle', 'summary', 'category', 'sections'],
};

export function chatBriefPrompt({ focus, title, project, cwd, categories }) {
  return [
    `The learner wants a course about something they did with their coding agent (Claude Code) in one of their chats${title ? `, "${title}"` : ''}${project ? `, in the project ${project}` : ''}. ${LEARNER}`,
    `What the course should cover: ${focus}`,
    '',
    'The file chat.txt in the current folder is that whole chat, oldest first: the learner\'s messages (LEARNER), the agent\'s replies (CLAUDE), a line for each tool call (commands run, files read and edited, with short before/after), cut-down results, and marks where the chat was compacted. It is long: do NOT read it whole. Search it with Grep for the words of the focus and its likely terms, then Read the parts that matter (offset and limit). Follow the thread: the problem, the attempts, what was decided, what was changed, how it was checked.',
    cwd ? `You may also read the project's files under ${cwd} (read only) to see the code as it is now; prefer what the code shows when the chat is unclear.` : '',
    '',
    'Then write the study material a course will be built from: 6-15 sections, each several paragraphs, in teaching order, covering:',
    '- the problem and its context, in plain terms;',
    '- what was built or changed, and how it works underneath;',
    '- why: each decision with the options that were rejected and the reasons;',
    '- the code and commands that matter, as short excerpts in fenced blocks with a language;',
    '- the problems hit, how they were found, and how they were fixed;',
    '- how it was checked, and what to remember next time.',
    'Teach the engineering ideas underneath too (the general knowledge a reader needs to understand it), not only the story of this chat; put (added) after a fact you add from your own knowledge rather than from the chat or the code.',
    'Write for the learner, as "you". Never copy a secret: tokens, passwords, keys, connection strings or .env values stay out; write <hidden> instead.',
    'If the chat has nothing about the focus, set found to false, say so in the summary, and leave sections empty.',
    '',
    `Their categories: ${categories.join(', ') || '(none yet)'}`,
  ].filter(line => line !== '').join('\n');
}

// --- One page added by hand ----------------------------------------------------

export const PAGE_PLAN_SCHEMA = OUTLINE_SCHEMA.properties.pages.items;

export function pagePlanPrompt({ course, topic, titles, sources, catalogue }) {
  return [
    `The learner wants one more page in their course "${course.title}", about: ${topic}. ${LEARNER}`,
    `The course's pages so far: ${titles.join('; ')}.`,
    '',
    'Plan that single page, the same way the course was planned:',
    '- Give it a clear title, 1-3 outcomes (what the learner can do after it, starting with a verb) and its subtopics. Do not repeat what the existing pages already teach. Leave "part" empty and "covers" empty.',
    '- Bind it to the source that covers the topic best (a video time window or exact headings of a web page or document), with support sources where they help. If no source covers it well, pick the closest one; the writer will mark what it adds.',
    '- Tag it with 1-6 concepts, reusing catalogue ids for the same idea before making new ones, with a reason for each.',
    '',
    'CATALOGUE (id | name | parent | other names | category):',
    catalogue || '(empty)',
    '',
    'SOURCES:',
    ...sources.map(source => source.kind === 'youtube'
      ? [`### ${source.id}: video "${source.title}" by ${source.channel}, ${Math.round((source.durationSec || 0) / 60)} min`,
         source.chapters.length ? `Chapters:\n${source.chapters.map(chapter => `- ${chapter.start}s-${chapter.end}s ${chapter.title}`).join('\n')}` : 'No chapters.',
         'Transcript sample:', source.excerpt].join('\n')
      : [`### ${source.id}: ${describeSource(source)}`, 'Headings with the start of each section:', source.excerpt].join('\n')),
  ].join('\n');
}

// --- Concepts --------------------------------------------------------------------------------

export const TIDY_SCHEMA = {
  type: 'object',
  properties: {
    merges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keep: { type: 'string', description: 'Id to keep' },
          drop: { type: 'string', description: 'Id that is the same idea and should fold into keep' },
          reason: { type: 'string' },
        },
        required: ['keep', 'drop', 'reason'],
      },
    },
  },
  required: ['merges'],
};

export const tidyPrompt = catalogue => [
  'Below is a learner\'s catalogue of software-engineering concepts (id | name | parent | other names | category).',
  'Find pairs that are the SAME idea under different names (e.g. "CI basics" and "Continuous integration fundamentals"). Do not merge a concept with a broader or narrower one, or two related but different ideas.',
  'For each pair, keep the one with the clearer name. Return an empty list when there are none.',
  '',
  catalogue,
].join('\n');

export const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: ['string', 'null'], description: 'The catalogue id when the learner means an existing concept, else null' },
    name: { type: 'string', description: 'A clear concept name' },
    definition: { type: 'string', description: 'One line' },
    parent: { type: ['string', 'null'], description: 'A catalogue id of a broader concept, or null' },
  },
  required: ['id', 'name', 'definition', 'parent'],
};

export const matchPrompt = (text, catalogue) => [
  `A learner wants to add "${text}" to their list of learned concepts.`,
  'If it is the same idea as a concept in their catalogue below, return that id. Otherwise return id null with a clear name, a one-line definition, and a broader parent id from the catalogue if one fits.',
  '',
  'CATALOGUE (id | name | parent | other names | category):',
  catalogue || '(empty)',
].join('\n');

// --- Chats -------------------------------------------------------------------------------------

export function pageChatSystem({ course, page, concepts, sourceLinks }) {
  return [
    `You are the learner's tutor for one page of their course "${course.title}": page ${page.n}, "${page.title}". ${LEARNER}`,
    '',
    'Answer questions about this page and its topic like a senior engineer mentoring a colleague: direct, concrete, with examples and commands where they help. Keep answers short unless asked to go deeper. You may search the web for current facts; say when you do.',
    '',
    'The page ends with closing questions, and passing one is what lets the learner mark its concepts as learned. When they answer one, judge it against its key points and the page:',
    '- If it gets the substance of every key point in their own words, say so, say why it is right, and end your message with this line exactly, listing the concept ids that question tests. Wording and small slips do not matter; understanding does.',
    '[[mark-learned: id1, id2]]',
    '- If any key point is missing or wrong, do NOT write that line. Say what they got right, then give a hint or ask a smaller question that leads them to the missing point, one step at a time, and point them to the part of the page that covers it. Let them try again.',
    '- Be strict and fair: a vague answer, a guess or words copied from the page do not pass. Asking for help, or being told the answer, does not pass either; they must then say it themselves.',
    'The app turns that line into a button the learner may click. Never say you marked anything yourself; only the learner can.',
    'Give the model answer only after they have really tried, or if they ask (and then the question stays unpassed).',
    CHAT_DIAGRAMS,
    '',
    'Concepts on this page (id: name: definition):',
    ...concepts.map(concept => `- ${concept.id}: ${concept.name}: ${concept.definition}`),
    '',
    'Closing questions, with what passing takes (keep these to yourself until the learner has answered):',
    ...page.checks.map((check, i) => [`${i + 1}. ${check.q}`, (check.points || []).length ? `   Key points: ${check.points.join('; ')}` : '', `   Model answer: ${check.answer}`, check.quote ? `   From the page: ${check.quote}` : '', `   Tests: ${check.concepts.join(', ')}`].filter(Boolean).join('\n')),
    '',
    'Sources:',
    ...sourceLinks.map(link => `- ${link}`),
    '',
    'THE PAGE:',
    page.markdown,
  ].join('\n');
}

export function advisorSystem({ categories, courses, learned, seen, workFolders }) {
  return [
    `You advise a software engineer on what to learn next. ${LEARNER}`,
    '',
    'First work out what they are asking.',
    'When they NAME what they want to learn ("teach me X and Y"), do not give a menu. Say in two or three sentences what the course will cover, then give ONE build line that names everything they asked for, leaving nothing out. Only suggest splitting it if they ask.',
    'When they ask what to learn next, ground your advice in what they actually build. You may read their work folders (read only) with Read, Glob and Grep: start with package.json files, Dockerfiles, compose files, CI config and the main source folders to see the real stack and practices. Look for gaps: things their work depends on that they have not learned. Give 3-5 suggestions; for each: the topic, why it matters for them (point at what in their work), and what they already know that it builds on, ending with a build line.',
    'A build line is this, on a line of its own; the app turns it into a button that builds the course straight away:',
    '[[build: <everything the course should cover> | <category name>]]',
    'Use one of their category names when one fits, or a new short one. Never say you started a build; only the learner can.',
    CHAT_DIAGRAMS,
    '',
    `Their categories: ${categories.join(', ') || '(none yet)'}`,
    'Their courses (title, category, pages read/total):',
    ...(courses.length ? courses.map(course => `- ${course.title} | ${course.category} | ${course.read}/${course.pages}`) : ['(none yet)']),
    '',
    'Learned (marked by the learner):',
    ...(learned.length ? learned.map(line => `- ${line}`) : ['(nothing yet)']),
    '',
    'Read about but not marked learned:',
    ...(seen.length ? seen.map(line => `- ${line}`) : ['(nothing)']),
    '',
    `Work folders: ${workFolders.join(', ') || '(none set: give general advice for a software engineer, and say they can add work folders in Settings)'}`,
  ].join('\n');
}
