// A page to a video's script: Claude writes each section as scenes (data, never code), and each
// is tested as the player would draw it, repaired, or rebuilt from the page. Then someone who only
// watches answers the questions, and a check compares the script with the page, both ways.
import { READER_SCHEMA, readerPrompt } from './prompts.mjs';
import { faultsBySection, flattenPage, hearing, plainScenes, testSection, tidyPronounce, withBlockRead } from './video-check.mjs';

const SECTIONS_AT_ONCE = 4;
const REPAIRS = 2;

export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          covers: { type: 'array', items: { type: 'integer' } },
          quote: { type: ['string', 'null'] },
          check: { type: ['string', 'null'] },
          objects: { type: 'array', items: { type: 'object' } },
          beats: { type: 'array', items: { type: 'object', properties: { say: { type: 'string' }, do: { type: 'array', items: { type: 'object' } } }, required: ['say', 'do'] } },
        },
        required: ['title', 'covers', 'quote', 'check', 'objects', 'beats'],
      },
    },
    pronounce: {
      type: 'array',
      items: { type: 'object', properties: { written: { type: 'string' }, spoken: { type: 'string' } }, required: ['written', 'spoken'] },
    },
  },
  required: ['scenes', 'pronounce'],
};

export const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    added: { type: 'array', items: { type: 'object', properties: { said: { type: 'string' }, why: { type: 'string' }, section: { type: 'string' } }, required: ['said', 'why', 'section'] } },
    dropped: { type: 'array', items: { type: 'object', properties: { fact: { type: 'string' }, block: { type: 'integer' } }, required: ['fact', 'block'] } },
  },
  required: ['added', 'dropped'],
};

const RULES = `You write one section of a narrated, animated explainer video for a page of a course. It sits beside the page and teaches ALL of it: someone who only watches must learn everything in the blocks below. The learner is a strong software engineer who knows nothing of this subject.

MOTION IS THE POINT. The learner should SEE the idea happen, like a great animated explainer, not read slides.
- A beat is ONE spoken sentence of at most 22 words. Every beat changes the screen, and the change lands on the word that names it, using "on".
- Things move instead of just appearing. If a byte becomes a token, that same object travels or changes. Use "spawnAt" so a new object comes out of the one that produced it.
- Show processes running: an outline box sliding along a row one position per beat, a number counting up, bars growing and shrinking together, a row collapsing, arrows that flow.
- Trade-offs are two things moving against each other at once.
- Code is traced: put it on the left and, on the right, the values changing as the voice reaches each line. This layout always fits: code at x 40, y 100, w 540, h 396, and two rows at x 600, w 480, one at y 120 for what goes in and one at y 290 for what comes out. Move the code's "lines" and set the rows' "items" as the voice walks through it. If the code needs more width than that, give it what the check asks for and move the rows below it or drop them.
- A worked example runs step by step with its real values, never summarised.
- Fade what is not being discussed (set fade true). The camera frames the picture by itself, so you never need "camera": lay things out and let the scene grow.
- Keep the picture growing through a scene. Do not clear and restart. Reuse the same object id in the next scene of this section, at a new place, to carry it across.
- Very little text on screen: 1 to 5 words per object, and never a sentence. The voice carries the words. Never a bullet list of text.
- Fill the stage: big objects, boxes at least 80 wide. Leave no scene as one small thing in the middle.
- A scene has 3 to 10 beats. Start a new scene when the picture changes completely.

COVERAGE:
- Teach every block below, in order: every idea, number, warning, step of every example, table row, diagram and code block. List its number in the "covers" of the scene that teaches it. Every number must appear.
- Add nothing: no facts, comparisons or examples the blocks do not have. Every scene's "quote" is copied word for word from a block and backs it.
- You may draw what a block only says in words. A value on screen must be in the blocks or follow directly from them, such as the eight bits of byte 72.
- Never invent an example, sample text, ID, count or split that the blocks do not give. If a block gives no real values, draw it with words or shapes instead of made-up values.
- A block marked "disputed" corrects the block before it. Teach what the correction says, and never state the disputed claim as fact.

VOICE: a good teacher sitting beside the learner, in your own spoken words, not the page's sentences. Plain words. Talk about what is on screen. Never read code or symbols out character by character. Say what a technical word means the first time, using the glossary. Never say "the page", "this scene" or "the video". Write numbers as digits.

PRONUNCIATION. A text-to-speech voice will read "say" aloud. In "pronounce", list every word it would get wrong, with "written" exactly as it appears in "say" and "spoken" as it should be read: an ID or exact value read digit by digit or in full, a letter-by-letter acronym, a name from code. For example {"written":"1917","spoken":"1 thousand 9 hundred and 17"} or {"written":"cl100k_base","spoken":"C L 100 K base"}. Leave out ordinary words and acronyms said as words. An empty list is fine.

THE STAGE is 1120 wide and 630 high. Keep everything inside x 40 to 1080 and y 96 to 500. The title sits above and subtitles below. Do not let objects overlap unless one is an outline around another or a label inside a box.

OBJECTS. Each has a unique "id", a "shape", and starts hidden unless "show" is true. Optional on most: "tone" (ink, dim, accent, green, red, gold, blue), "fade" (true dims it), "spawnAt" (the id of an object it comes out of).
- box: x, y, w, h, text, sub (small line under it), style ("solid", "fill" for a bright filled box, "outline" for an empty frame around something).
- label: x, y, w, text, size (s, m, l, xl), align (left, center), mono (true for values).
- number: x, y, w, value, sub, size (m, l, xl), suffix. Changing "value" counts up or down on screen.
- bar: x, y, w, h. Changing w or h grows it smoothly, and it grows from nothing when shown.
- dot: x, y, w (its diameter). Good for something travelling along a path.
- arrow: "from" and "to" (object ids), or x, y, x2, y2. "flow" true makes it move. "text" for a very short label.
- row: x, y, w, items [{label, sub}], mark [positions to light up]. Boxes in a line, sized for you. Setting a new "items" animates the change, so a merge really collapses on screen.
- code: x, y, w, h, asset (which code block), lines [first, last] lights up lines, from 0.
- table: x, y, w, asset (which table), rows [body rows shown so far], now [rows lit].
- diagram: x, y, w, h, asset (which diagram), nodes [node numbers shown so far]. Give the whole list each time. Show one or two more per beat.

BEATS. {"say": one sentence, "do": [actions]}. An action fires when the voice reaches the word in "on" (null means the start of the sentence): {"on": "word", "show": [ids], "hide": [ids], "set": {"id": {changed fields}}, "camera": {"x": 560, "y": 315, "zoom": 1.5}}. x and y are the point to centre; zoom 1 at the centre is the normal view. "on" must be one exact word from "say". A sentence may have several actions.

A SCENE. Example, on another subject:
{"title":"Adding two numbers","covers":[3],"quote":"exact words from the block","check":null,
"objects":[{"id":"a","shape":"box","x":120,"y":200,"w":200,"h":130,"text":"12","sub":"first"},{"id":"b","shape":"box","x":360,"y":200,"w":200,"h":130,"text":"30","sub":"second"},{"id":"go","shape":"arrow","from":"b","to":"sum","flow":true},{"id":"sum","shape":"number","x":740,"y":210,"w":280,"value":0,"sub":"total","tone":"accent","size":"xl"}],
"beats":[{"say":"Start with 12.","do":[{"on":"12","show":["a"]}]},{"say":"Bring in 30 beside it.","do":[{"on":"30","show":["b"]}]},{"say":"Now watch the total climb to 42.","do":[{"on":"total","show":["go","sum"]},{"on":"climb","set":{"sum":{"value":42},"a":{"fade":true},"b":{"fade":true}}}]},{"say":"Look closer at the result.","do":[{"on":"closer","camera":{"x":880,"y":270,"zoom":1.6}}]}]}

QUESTIONS. Add each quiz question below once, as its own scene: {"title":"Quick check","covers":[],"quote":null,"check":"its id","objects":[],"beats":[{"say":"","do":[]}]}. The player reads it out. It must come after the voice has fully taught its answer, except GUESS FIRST ones, which come before.`;

const describe = block => `[${block.n}] (${block.t}${block.asset !== undefined ? ` ${block.asset}` : ''}${block.callout ? `, ${block.callout}` : ''})`;

function sectionRequest(page, { blocks, quiz, sections }, section, repair) {
  const mine = blocks.filter(block => block.section === section);
  const questions = quiz.filter(q => q.section === section);
  return [
    RULES, '',
    `PAGE: ${page.title}`,
    `SECTIONS OF THE PAGE: ${sections.join(' / ')}`,
    `THIS SECTION: ${section}`, '',
    'GLOSSARY:', ...(page.terms || []).map(term => `- ${term.term}: ${term.def}`), '',
    'BLOCKS OF THIS SECTION:',
    ...mine.flatMap(block => [describe(block), block.text, '']),
    'QUIZ:',
    ...(questions.length ? questions.flatMap(q => [`[${q.id}] ${q.guess ? 'GUESS FIRST, before this is taught' : `after block ${q.after} is taught`}: ${q.q}`, `  Answer: ${q.options.find(option => option.right)?.text}`]) : ['(none in this section)']),
    ...(repair ? ['', 'YOUR LAST ANSWER:', JSON.stringify(repair.result), '', 'IT FAILED THESE CHECKS. Return all of it with these fixed and everything else kept:', ...repair.problems.map(problem => `- ${problem}`)] : []),
  ].join('\n');
}

function claimRequest(page, { blocks }, heard) {
  return [
    'Below are a page of a course and the script of a video made from it. Compare them, both ways. Use no outside knowledge to correct either text: only compare them.',
    '',
    '1. In "added", list every claim in the script that the page does not support: a fact, number, example or comparison missing from the page or saying something different. Do not list rewording, plain-language restatements, or values that follow directly from the page (such as the bits of a byte). The plain meaning of a word the page uses, such as what a tokenizer does, is not a claim. Give the section named in [brackets] in the heading it sits under.',
    '2. In "dropped", list every fact, step, number, warning or example on the page that someone who only watched would not learn. Give its block number. Do not list source marks or differences of wording. A code block, table or diagram shown in full on screen counts as taught.',
    'A block marked "disputed" corrects the one before it: the script should follow the correction.',
    '',
    'THE PAGE:',
    ...blocks.map(block => `${describe(block)} ${block.text}`),
    '',
    'GLOSSARY:',
    ...(page.terms || []).map(term => `- ${term.term}: ${term.def}`),
    '',
    'THE SCRIPT:',
    heard,
  ].join('\n');
}

const recapOf = page => (page.blocks || []).at(-1)?.items?.map(item => (item.inlines || []).filter(part => !part.added).map(part => part.s).join('')) || [];

function watcherRequest(page, { quiz }, heard) {
  return readerPrompt({
    page: { title: page.title, subtopics: [...(page.outcomes || []), ...recapOf(page)] },
    markdown: heard,
    terms: [],
    quick: quiz.map(q => ({ id: q.id, q: q.q, options: q.options.map(option => ({ text: option.text })) })),
    closing: (page.checks || []).map(check => ({ id: check.id, q: check.q })),
  });
}

async function eachAtOnce(list, limit, fn) {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** `ask(prompt, schema)` is one Claude call. Returns the script `narrate.py` records. */
export async function writeScript({ page, ask, onStep = () => {} }) {
  const started = Date.now();
  const material = flattenPage(page);
  const { sections, blocks, assets, quiz } = material;
  const written = new Map();
  const rebuilt = new Set();
  const firstProblems = {};
  const whyRebuilt = {};
  const readOut = [];
  const rebuild = (section, problems) => {
    rebuilt.add(section);
    whyRebuilt[section] = problems.slice(0, 8);
    written.set(section, { scenes: plainScenes(section, material), pronounce: [] });
  };
  const attempt = (section, repair) => ask(sectionRequest(page, material, section, repair), SCENE_SCHEMA);
  let finished = 0;
  await eachAtOnce(sections, SECTIONS_AT_ONCE, async section => {
    if (blocks.some(block => block.section === section)) {
      let result = await attempt(section, null);
      let problems = testSection(section, result, material);
      firstProblems[section] = problems.length;
      for (let round = 0; round < REPAIRS && problems.length; round++) {
        result = await attempt(section, { result, problems });
        problems = testSection(section, result, material);
      }
      if (problems.length) rebuild(section, problems);
      else written.set(section, result);
    } else {
      written.set(section, { scenes: plainScenes(section, material), pronounce: [] }); // questions alone
    }
    finished++;
    onStep(`scenes, section ${finished} of ${sections.length}`);
  });
  const allScenes = () => sections.flatMap(section => written.get(section).scenes.map(scene => ({ ...scene, section })));
  const review = async () => {
    const heard = hearing(allScenes(), assets);
    const [reading, claims] = await Promise.all([ask(watcherRequest(page, material, heard), READER_SCHEMA), ask(claimRequest(page, material, heard), CLAIM_SCHEMA)]);
    return { reading, claims, faults: faultsBySection({ claims, reading, blocks, quiz, sections }, rebuilt) };
  };
  onStep('checking it against the page');
  let checked = await review();
  const firstClaims = { added: checked.claims.added?.length || 0, dropped: checked.claims.dropped?.length || 0 };
  if (checked.faults.size) {
    onStep('fixing what the check found');
    await eachAtOnce([...checked.faults], SECTIONS_AT_ONCE, async ([section, problems]) => {
      const result = await attempt(section, { result: written.get(section), problems });
      const left = testSection(section, result, material);
      if (left.length) rebuild(section, left);
      else written.set(section, result);
    });
    onStep('checking it against the page again');
    checked = await review();
    // A second miss isn't worth a third try: the page's own words can't be wrong about the page.
    // Something wrong takes the section's scenes with it. Something only left out doesn't: that
    // block is read out where it belongs, so one small gap costs a section none of its motion.
    const { added = [], dropped = [] } = checked.claims;
    for (const [section, problems] of faultsBySection({ claims: { added }, reading: checked.reading, blocks, quiz, sections }, rebuilt)) rebuild(section, problems);
    for (const block of dropped.map(item => blocks.find(other => other.n === item.block)).filter(block => block && !rebuilt.has(block.section))) {
      const kept = written.get(block.section);
      written.set(block.section, { ...kept, scenes: withBlockRead(kept.scenes, block) });
      readOut.push(block.n);
    }
  }
  const scenes = allScenes();
  const teaching = scenes.filter(scene => !scene.check);
  const beats = teaching.flatMap(scene => scene.beats);
  const actions = beats.flatMap(beat => beat.do || []);
  const answers = new Map((checked.reading?.answers || []).map(answer => [answer.id, answer.choice]));
  return {
    title: page.title,
    sections,
    scenes,
    assets,
    quiz,
    pronounce: tidyPronounce([...written.values()].flatMap(result => result.pronounce || []), scenes),
    stats: {
      minutes: Math.round((Date.now() - started) / 6000) / 10,
      pageWords: String(page.markdown).split(/\s+/).length,
      spokenWords: beats.map(beat => beat.say).join(' ').split(/\s+/).length,
      scenes: teaching.length,
      beats: beats.length,
      actions: actions.length,
      onWord: actions.filter(action => action.on).length,
      blocks: blocks.length,
      sections: sections.length,
      rebuilt: [...rebuilt],
      whyRebuilt,
      readOut,
      firstProblems,
      firstClaims,
      claimsLeft: { added: checked.claims.added || [], dropped: checked.claims.dropped || [] },
      watcher: {
        quick: `${quiz.filter(q => q.options[answers.get(q.id)]?.right).length}/${quiz.length}`,
        closing: `${(checked.reading?.closing || []).filter(item => item.answerable).length}/${(checked.reading?.closing || []).length}`,
        unknown: checked.reading?.unknown || [],
        missing: checked.reading?.missing || [],
      },
    },
  };
}
