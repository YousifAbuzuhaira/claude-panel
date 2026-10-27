// What Claude is asked at each step, and the JSON shape each structured answer must take.
// The builder's calls run with no tools except research (web search and fetch).

const LEARNER = 'The learner is a working software engineer who studies in the minutes while their coding agent works. They want depth and real practice, not marketing or fluff.';

// --- Research -----------------------------------------------------------------------

export const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    courseTitle: { type: 'string', description: 'A short course title, e.g. "Kubernetes deployments in practice"' },
    summary: { type: 'string', description: 'One or two sentences on what the course will cover' },
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
          recommended: { type: 'boolean', description: 'True for the 2-4 sources the course should be built from' },
        },
        required: ['kind', 'url', 'title', 'channel', 'lengthMin', 'level', 'why', 'recommended'],
      },
    },
  },
  required: ['courseTitle', 'summary', 'candidates'],
};

export function researchPrompt({ topic, category, known, videos }) {
  return [
    `Find the best FREE material to build a course on: ${topic}`,
    `It goes in the learner's "${category}" category. ${LEARNER}`,
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
    '3. Return 5-8 candidates mixing videos and pages. Prefer well-structured videos with chapters from reputable channels, recent enough to be current, and pages with real commands and code. Avoid clickbait, near-duplicates and shallow listicles.',
    '4. Mark 2-4 as recommended: together they should cover the topic well, at most about 3 hours of video in total, and pair video explanations with a written source that has the real commands and code.',
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
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtopics: { type: 'array', items: { type: 'string' }, description: 'What the page covers, 2-6 short items' },
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
        required: ['title', 'subtopics', 'sourceId', 'fromSec', 'toSec', 'sections', 'support', 'concepts'],
      },
    },
  },
  required: ['title', 'summary', 'pages'],
};

export function outlinePrompt({ topic, title, category, sources, catalogue }) {
  return [
    `Plan a course on "${topic}" (working title: ${title}), from the sources below. ${LEARNER}`,
    '',
    'Rules:',
    '- One page per topic or subtopic, 6-16 pages, in the order that is best for learning (not necessarily source order).',
    '- Each page teaches from one main source: a time window of a video (fromSec/toSec, using the chapters and timestamps) or named headings of a web page (sections, copied exactly). Add support sources where they help, especially written docs that have the real commands for a video page.',
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
      : [`### ${source.id}: web page "${source.title}" (${source.url})`, 'Headings with the start of each section:', source.excerpt].join('\n')),
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
    '- Cite as you go: after something from a video, put the time it is said as [m:ss] or [h:mm:ss]. When the material has more than one video, put the video\'s id first, as in [s4 1:05]. After something from a web page, put [sec: Exact Heading].',
    '- When you add something that is NOT in the material below (a fact, a command, a caveat), put (added) right after that sentence.',
    '- End with a short "## Recap" of the key points. Do not put the check questions in the Markdown.',
    '- Then write 2-3 check questions that test understanding (why, what would happen if, which would you choose), each tagged with the concept ids it tests, with a model answer.',
    '',
    'MATERIAL:',
    material,
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
    '- Give it a clear title and 2-6 subtopics. Do not repeat what the existing pages already teach.',
    '- Bind it to the source that covers the topic best (a video time window or exact web headings), with support sources where they help. If no source covers it well, pick the closest one; the writer will mark what it adds.',
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
      : [`### ${source.id}: web page "${source.title}" (${source.url})`, 'Headings with the start of each section:', source.excerpt].join('\n')),
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
    'Ground your advice in what they actually build. You may read their work folders (read only) with Read, Glob and Grep: start with package.json files, Dockerfiles, compose files, CI config and the main source folders to see the real stack and practices. Look for gaps: things their work depends on that they have not learned.',
    'Give 3-5 suggestions unless asked otherwise. For each: the topic, why it matters for them (point at what in their work), and what they already know that it builds on. End each suggestion with this line, which the app turns into a "Build this" button:',
    '[[build: <topic to research> | <category name>]]',
    'Use one of their category names when one fits, or a new short one.',
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
