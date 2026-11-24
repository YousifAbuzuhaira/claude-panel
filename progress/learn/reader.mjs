// The blind reader's prompt: someone who knows nothing of the subject answers a page's questions
// from the page alone. Used by course builds (build.mjs) and by every video's watcher
// (video-script.mjs), so it lives apart from the course prompts. Pure.

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
    unclear: { type: 'array', items: { type: 'string' }, description: 'Decisions or steps on the page you could not follow' },
  },
  required: ['answers', 'closing', 'unknown', 'missing', 'unclear'],
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
    '5. In "unclear", list each decision or step on the page you could not follow: why it was chosen, what it does, or what happens next isn\'t explained enough to act on. Most pages have none.',
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
