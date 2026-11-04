// What Claude is asked at each step, and the JSON shape each structured answer must take.
// The builder's calls run with no tools except research (web search and fetch).

const LEARNER = 'The learner is a strong software engineer, but assume they know nothing of THIS subject: its words, ideas and notation are new to them. They study in the minutes while their coding agent works. They want depth and real practice, not marketing or fluff.';

// Diagrams: Mermaid that learn/diagram.mjs can lay out (anything else shows as code).
export const DIAGRAM_RULE = [
  '- Where a picture would help the reader understand (a flow, an architecture, a request between parts, a state machine, a pipeline), add 1-2 diagrams as ```mermaid blocks, each right after the text it explains. Only `flowchart TD`, `flowchart LR` or `sequenceDiagram`. At most 12 boxes, labels of 4 words or fewer, edge labels of 1-3 words; no subgraph, classDef, style or HTML. Skip a diagram that would only repeat a list, and never add one for decoration.',
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
    '- Order the pages so that each one only needs what came before it (not necessarily source order). Start from what a software engineer already knows.',
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
    checks: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'A question that tests understanding, not recall of wording' },
          answer: { type: 'string', description: 'A model answer in 1-3 sentences' },
          concepts: { type: 'array', items: { type: 'string' }, description: 'Ids of the concepts this question tests' },
        },
        required: ['q', 'answer', 'concepts'],
      },
    },
  },
  required: ['markdown', 'checks'],
};

export function pagePrompt({ course, page, position, total, prevTitles, nextTitle, concepts, material, learned }) {
  return [
    `Write page ${position} of ${total} of the course "${course.title}": "${page.title}". ${LEARNER}`,
    page.note ? `This is a rewrite of the page, and the learner asked: "${page.note}". Follow that.` : '',
    page.added && !page.note ? 'The learner added this page by hand, on a topic the sources may only partly cover: say so plainly and mark what you add (added).' : '',
    page.subtopics.length ? `It covers: ${page.subtopics.join('; ')}.` : '',
    prevTitles.length ? `Earlier pages: ${prevTitles.join('; ')}.` : 'This is the first page.',
    nextTitle ? `The next page is "${nextTitle}", so don't teach that here.` : 'This is the last page.',
    learned.length ? `The learner already knows: ${learned.join('; ')}. Build on that rather than re-explaining it.` : '',
    '',
    'Concepts this page must teach (id: name: definition):',
    ...concepts.map(concept => `- ${concept.id}: ${concept.name}: ${concept.definition}`),
    '',
    'How to write it:',
    '- A full lesson, about 1200-2500 words. The page title is shown above it, so start with a short paragraph, then ## sections.',
    '- Teach in your own words. Never copy the transcript; it is speech, and the learner can watch the video for that.',
    '- Explain what it is, why it exists, how it works underneath, and how it is used in real work. Use concrete examples, real commands and code in fenced blocks with a language (```bash, ```yaml, ```ts...), and common mistakes.',
    '- Cite as you go: after something from a video, put the time it is said as [m:ss] or [h:mm:ss]. When the material has more than one video, put the video\'s id first, as in [s4 1:05]. After something from a web page, document or brief, put [sec: Exact Heading].',
    '- When you add something that is NOT in the material below (a fact, a command, a caveat), put (added) right after that sentence.',
    DIAGRAM_RULE,
    '- End with a short "## Recap" of the key points. Do not put the check questions in the Markdown.',
    '- Then write 2-3 check questions that test understanding (why, what would happen if, which would you choose), each tagged with the concept ids it tests, with a model answer.',
    '',
    'MATERIAL:',
    material,
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
    'The page ends with check questions. When the learner answers one: say plainly what they got right and what they missed or got wrong, then give the key point they need. If their answer is essentially right, end your message with this line exactly, listing the concept ids that question tests:',
    '[[mark-learned: id1, id2]]',
    'The app turns that line into a button the learner may click. Never say you marked anything yourself; only the learner can.',
    'Give the model answer only after they have tried, or if they ask.',
    CHAT_DIAGRAMS,
    '',
    'Concepts on this page (id: name: definition):',
    ...concepts.map(concept => `- ${concept.id}: ${concept.name}: ${concept.definition}`),
    '',
    'Check questions, with model answers (keep these to yourself until the learner has answered):',
    ...page.checks.map((check, i) => `${i + 1}. ${check.q}\n   Model answer: ${check.answer}\n   Tests: ${check.concepts.join(', ')}`),
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
