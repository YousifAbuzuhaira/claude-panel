// A page to a video's script: Claude writes each section as scenes (data, never code), and each
// is tested as the player would draw it, repaired, or rebuilt from the page. Then someone who only
// watches answers the questions, and a check compares the script with the page, both ways.
import { READER_SCHEMA, readerPrompt } from './prompts.mjs';
import { faultsBySection, firstTaught, flattenPage, hearing, keptOnScreen, longClips, mendSection, mergeTiny, plainScenes, settleMasks, settleScenes, spokenBudget, spokenWords, stopsOf, testOpener, testSection, tidyPronounce, withBlockRead } from './video-check.mjs';
import { OPENER_SCHEMA, OPENER_WORDS, applyPlan, checkPlan, makePlan } from './video-plan.mjs';

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
          trap: { type: 'boolean' },
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

const PRONUNCIATION = `PRONUNCIATION. A text-to-speech voice will read "say" aloud. In "pronounce", list every word it would get wrong, with "written" exactly as it appears in "say" and "spoken" as it should be read: an ID or exact value read digit by digit or in full, a letter-by-letter acronym, a name from code. For example {"written":"1917","spoken":"1 thousand 9 hundred and 17"} or {"written":"cl100k_base","spoken":"C L 100 K base"}. Leave out ordinary words and acronyms said as words. An empty list is fine.`;

const DRAWING = `THE STAGE is 1120 wide and 630 high. Keep everything inside x 40 to 1080 and y 96 to 500. The title sits above and subtitles below. Do not let objects overlap unless one is an outline around another or a label inside a box.

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
"beats":[{"say":"Start with 12.","do":[{"on":"12","show":["a"]}]},{"say":"Bring in 30 beside it.","do":[{"on":"30","show":["b"]}]},{"say":"Now watch the total climb to 42.","do":[{"on":"total","show":["go","sum"]},{"on":"climb","set":{"sum":{"value":42},"a":{"fade":true},"b":{"fade":true}}}]},{"say":"Look closer at the result.","do":[{"on":"closer","camera":{"x":880,"y":270,"zoom":1.6}}]}]}`;

const RULES = `You write one section of a narrated, animated explainer video for a page of a course. It sits beside the page and teaches ALL of it: someone who only watches must learn everything in the blocks below. The learner is a strong software engineer who knows nothing of this subject.

MOTION IS THE POINT. The learner should SEE the idea happen, like a great animated explainer, not read slides.
- A beat is ONE spoken sentence of at most 22 words. Every beat changes the screen, and the change lands on the word that names it, using "on".
- Things move instead of just appearing. If a byte becomes a token, that same object travels or changes. Use "spawnAt" so a new object comes out of the one that produced it.
- Show processes running: an outline box sliding along a row one position per beat, a number counting up, bars growing and shrinking together, a row collapsing, arrows that flow.
- Trade-offs are two things moving against each other at once.
- Code is traced: put it on the left and, on the right, the values changing as the voice reaches each line. This layout always fits: code at x 40, y 100, w 540, h 396, and two rows at x 600, w 480, one at y 120 for what goes in and one at y 290 for what comes out. Move the code's "lines" and set the rows' "items" as the voice walks through it. If the code needs more width than that, give it what the check asks for and move the rows below it or drop them.
- A worked example runs step by step with its real values, never summarised.
- Fade what is not being discussed (set fade true). The camera frames the picture by itself, so you never need "camera": lay things out and let the scene grow.
- Keep the picture growing through a scene. Do not clear and restart. Never hide something the voice will name again: fade it instead, so the learner can look back at it.
- This section is one clip of the video. Start each new scene of it by carrying at least one object over by its id, at a new place, unless the new scene shows code, a table or a diagram.
- Very little text on screen: 1 to 5 words per object, and never a sentence. The voice carries the words. Never a bullet list of text.
- Fill the stage: big objects, boxes at least 80 wide. Leave no scene as one small thing in the middle.
- A scene has 3 to 10 beats. Start a new scene when the picture changes completely.

COVERAGE:
- Teach every block below, in order: every idea, number, warning, step of every example, table row, diagram and code block. List its number in the "covers" of the scene that teaches it. Every number must appear.
- Add nothing: no facts, comparisons or examples the blocks do not have. Every scene's "quote" is copied word for word from a block and backs it.
- You may draw what a block only says in words. A value on screen must be in the blocks or follow directly from them, such as the eight bits of byte 72.
- Never invent an example, sample text, ID, count or split that the blocks do not give. If a block gives no real values, draw it with words or shapes instead of made-up values.
- A block marked "disputed" corrects the block before it. Teach what the correction says, and never state the disputed claim as fact.

VOICE: a good teacher sitting beside the learner, in your own spoken words, not the page's sentences. Plain words. Talk about what is on screen. Never read code or symbols out character by character. Say what a technical word means the first time in the video, using the glossary, but not a word an earlier section already explained. Never say "the page", "this scene" or "the video". Write numbers as digits.
SAY EACH FACT ONCE. No signposting ("now let's look at", "here's the key idea"), no summary at the end of a section, no saying again what the voice just said. A block that repeats an earlier one is covered in one sentence. Teaching everything does not mean saying it twice.

${PRONUNCIATION}

${DRAWING}

QUESTIONS. Add each quiz question below once, as its own scene: {"title":"Quick check","covers":[],"quote":null,"check":"its id","objects":[],"beats":[{"say":"","do":[]}]}. The player reads it out. It must come after the voice has fully taught its answer, except GUESS FIRST ones, which come before.`;

const MASK_RULE = 'MASKED LINE: once in this clip, after you have shown the mechanism in pictures and while its code is on screen, hide the one line that carries it out and let the learner pick it: add {"on": "word", "mask": {"id": "the code object", "line": its line number from 0, "choices": ["wrong version 1", "wrong version 2"]}} to an action. The beat with the mask asks, in one sentence, what that line has to do ("So what must line 6 set before the call goes out?"); the player stops there until the learner picks, and your next beat says what the line does. The two wrong versions look like lines of this code, in its style and about its length, wrong the way someone who missed the idea would get it wrong, and are no line of the page\'s code. Never in the clip\'s first scene.';

const describe = block => `[${block.n}] (${block.t}${block.asset !== undefined ? ` ${block.asset}` : ''}${block.callout ? `, ${block.callout}` : ''})`;

/** Glossary words a section before this one already explains. */
const earlierTerms = ({ taught, sections }, section) => [...(taught || [])].filter(([, at]) => sections.indexOf(at) < sections.indexOf(section)).map(([term]) => term);

function sectionRequest(page, material, section, repair) {
  const { blocks, quiz, sections } = material;
  const mine = blocks.filter(block => block.section === section);
  const questions = quiz.filter(q => q.section === section);
  return [
    RULES, '',
    `PAGE: ${page.title}`,
    `SECTIONS OF THE PAGE: ${sections.join(' / ')}`,
    `THIS SECTION: ${section}`, '',
    'GLOSSARY:', ...(page.terms || []).map(term => `- ${term.term}: ${term.def}`), '',
    ...(earlierTerms(material, section).length ? [`ALREADY EXPLAINED IN EARLIER SECTIONS (use these words, don't explain them again): ${earlierTerms(material, section).join('; ')}`, ''] : []),
    'BLOCKS OF THIS SECTION:',
    ...mine.flatMap(block => [describe(block), block.text, '']),
    ...(material.masks?.has(section) ? [`${MASK_RULE}${material.patterns?.[section] ? ` This clip repeats the pattern of clip "${material.patterns[section]}": show the shape briefly, and mask the step that repeats.` : ''}`, ''] : []),
    ...(material.traps?.[section]?.length ? [`REAL FAILURE: blocks ${material.traps[section].join(', ')} describe something that really went wrong. Open this clip by showing that failure as it happened (after any GUESS FIRST question) and give the scenes that show it "trap": true. A trap scene shows only what went wrong, never the fix; the player marks it as a wrong turn. Then teach the rest.`, ''] : []),
    'QUIZ:',
    ...(questions.length ? questions.flatMap(q => [`[${q.id}] ${q.guess ? 'GUESS FIRST, before this is taught' : `after block ${q.after} is taught`}: ${q.q}`, `  Answer: ${q.options.find(option => option.right)?.text}`]) : ['(none in this section)']),
    ...(repair ? ['', 'YOUR LAST ANSWER:', JSON.stringify(repair.result), '', 'IT FAILED THESE CHECKS. Return all of it with these fixed and everything else kept:', ...repair.problems.map(problem => `- ${problem}`)] : []),
  ].join('\n');
}

function claimRequest(page, { blocks }, heard, openersHeard = '') {
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
    ...(openersHeard ? [
      '',
      'OPENERS: each plays out a wrong answer to a question before a clip teaches, taking it as true for a moment to show where it breaks; the screen marks it as a wrong turn. Taking the wrong answer as true is not a claim. List in "added" only what an opener states as fact that the page does not support, giving its [opener ...] heading as the section.',
      openersHeard,
    ] : []),
  ].join('\n');
}

const OPENER_RULES = `You write short opening scenes for one clip of a narrated, animated explainer video. The learner has just been asked the guess question below and picked a WRONG option. Before the clip teaches, play their answer out: take it as true for a moment, show it running into what the blocks say, and stop where it breaks. The clip itself teaches the right answer straight after, so don't teach the whole clip here.
- One scene per wrong option: 2 to 4 beats, 25 to 50 words in all.
- Start from their answer, in plain words ("Say the second call just waits."). Never say "wrong", "you picked" or "incorrect": the screen already marks it as a wrong turn.
- Use only facts from the blocks below and add nothing. The scene's "quote" is copied word for word from a block and backs where the answer breaks.
- Draw it with boxes, labels, rows, numbers, bars, dots and arrows. No code, tables or diagrams.
- Voice: a good teacher beside the learner, plain words, numbers as digits.`;

function openerRequest(page, material, section, question, wrong, repair) {
  const mine = material.blocks.filter(block => block.section === section);
  return [
    OPENER_RULES, '', PRONUNCIATION, '', DRAWING, '',
    `PAGE: ${page.title}`,
    `THIS CLIP: ${section}`, '',
    `THE GUESS QUESTION: ${question.q}`,
    ...question.options.map((option, k) => `  option ${k}${option.right ? ' (right)' : ' (WRONG: write an opener for it)'}: ${option.text}. Why: ${option.why}`),
    '',
    'BLOCKS OF THIS CLIP:',
    ...mine.flatMap(block => [describe(block), block.text, '']),
    `Give one opener for each of options ${wrong.map(({ k }) => k).join(' and ')}, with "option" its number.`,
    ...(repair ? ['', 'YOUR LAST ANSWER:', JSON.stringify(repair.result), '', 'IT FAILED THESE CHECKS. Return all of it with these fixed and everything else kept:', ...repair.problems.map(problem => `- ${problem}`)] : []),
  ].join('\n');
}

const recapOf = page => (page.blocks || []).at(-1)?.items?.map(item => (item.inlines || []).filter(part => !part.added).map(part => part.s).join('')) || [];

function watcherRequest(page, { quiz, allQuiz }, heard) {
  // Watching alone must answer every question on the page, not only those the video asks.
  quiz = allQuiz || quiz;
  return readerPrompt({
    // What the page set out to teach; an older page, saved without its subtopics, falls back to its recap.
    page: { title: page.title, subtopics: [...(page.outcomes || []), ...((page.subtopics || []).length ? page.subtopics : recapOf(page))] },
    markdown: heard,
    terms: [],
    quick: quiz.map(q => ({ id: q.id, q: q.q, options: q.options.map(option => ({ text: option.text })) })),
    closing: (page.checks || []).map(check => ({ id: check.id, q: check.q })),
  });
}

/**
 * `ask(prompt, schema)` is one Claude call. Returns the script `narrate.py` records. `plan`, when
 * given, is the plan already made (an explainer's clip, from your session): it is checked and used
 * instead of asking for one.
 */
export async function writeScript({ page, ask, onStep = () => {}, plan = null }) {
  const started = Date.now();
  // The page's sections are the video's clips, tiny ones joined to a neighbour. The plan adds the
  // map, a guess question opening each clip and the failures a clip opens on; without one (it
  // failed), the clips play as they are.
  let material = mergeTiny(flattenPage(page));
  onStep('planning the clips', 0.02);
  const planned = plan ? (({ plan: checked, problems }) => ({ plan: checked, firstProblems: problems, problemsLeft: problems }))(checkPlan(plan, material)) : await makePlan({ page, material, ask }).catch(error => ({ error }));
  let map = null;
  if (planned.plan) ({ material, map } = applyPlan(page, material, planned.plan));
  material.taught = firstTaught(page.terms, material.blocks);
  const { sections, blocks, assets, quiz, allQuiz } = material;
  const written = new Map();
  const rebuilt = new Set();
  const firstProblems = {};
  const forClaude = {};
  const whyRebuilt = {};
  const readOut = [];
  const mended = [];
  const shortened = [];
  const polished = [];
  const firstSoft = {};
  const openers = new Map(); // question id: { scenes: { option: scene }, pronounce }
  const openerStats = { asked: 0, made: 0, dropped: 0, droppedByCheck: 0 };
  // A wrong guess played out before its clip: one try, one repair, then what still fails is dropped.
  const makeOpeners = async (section, question) => {
    const wrong = question.options.map((option, k) => ({ option, k })).filter(({ option }) => !option.right);
    if (!wrong.length) return;
    openerStats.asked += wrong.length;
    const judge = result => {
      const kept = {};
      const problems = [];
      for (const { k } of wrong) {
        const item = (result?.openers || []).find(entry => entry.option === k);
        if (!item?.scene) { problems.push(`There is no opener for option ${k}`); continue; }
        const [scene] = settleScenes({ scenes: [{ covers: [], check: null, ...item.scene }] }, assets).scenes;
        const wrongs = testOpener(scene, `Opener for option ${k}`, assets, material.pageText, OPENER_WORDS);
        if (wrongs.length) problems.push(...wrongs);
        else kept[k] = scene;
      }
      return { kept, problems, pronounce: result?.pronounce || [] };
    };
    let result = await ask(openerRequest(page, material, section, question, wrong, null), OPENER_SCHEMA);
    let judged = judge(result);
    const pronounce = [...judged.pronounce];
    if (judged.problems.length) {
      result = await ask(openerRequest(page, material, section, question, wrong, { result, problems: judged.problems.slice(0, 10) }), OPENER_SCHEMA);
      const again = judge(result);
      judged = { ...judged, kept: { ...again.kept, ...judged.kept } };
      pronounce.push(...again.pronounce);
    }
    openerStats.made += Object.keys(judged.kept).length;
    openerStats.dropped += wrong.length - Object.keys(judged.kept).length;
    if (Object.keys(judged.kept).length) openers.set(question.id, { scenes: judged.kept, pronounce });
  };
  const rebuild = (section, problems) => {
    rebuilt.add(section);
    whyRebuilt[section] = problems.slice(0, 8);
    written.set(section, { scenes: plainScenes(section, material), pronounce: [] });
  };
  // Small misses are fixed here, so Claude only ever hears about what code can't fix. A masked line
  // that doesn't hold is taken out here too, and goes back to Claude as polish.
  const maskNotes = new WeakMap();
  const attempt = async (section, repair) => {
    const settled = settleMasks(settleScenes(await ask(sectionRequest(page, material, section, repair), SCENE_SCHEMA), assets), material, section);
    maskNotes.set(settled.result, settled.notes);
    return settled.result;
  };
  let finished = 0;
  await Promise.all(sections.map(async section => {
    if (blocks.some(block => block.section === section)) {
      // Length and what's kept on screen are polish, never failures: asked for once more, and kept
      // only when the answer still passes and is no worse on either.
      const limit = spokenBudget(blocks.filter(block => block.section === section));
      const lengthHint = result => (spokenWords(result?.scenes) > limit * 1.3 ? [`The narration runs ${spokenWords(result.scenes)} words for about ${limit} words of page: say each fact once, cut signposts and summaries, and keep every block covered.`] : []);
      const softAll = result => [...keptOnScreen(result?.scenes), ...(maskNotes.get(result) || [])];
      const soft = result => softAll(result).slice(0, 8);
      const polish = result => [...lengthHint(result), ...soft(result)];
      let result = await attempt(section, null);
      let problems = testSection(section, result, material);
      firstProblems[section] = problems.length;
      firstSoft[section] = keptOnScreen(result?.scenes).length;
      if (problems.length) forClaude[section] = problems.slice(0, 8);
      for (let round = 0; round < REPAIRS && problems.length; round++) {
        result = await attempt(section, { result, problems: [...problems, ...polish(result)] });
        problems = testSection(section, result, material);
      }
      if (!problems.length && polish(result).length) {
        const better = await attempt(section, { result, problems: polish(result) });
        const [softNow, softThen] = [softAll(better).length, softAll(result).length];
        const [wordsNow, wordsThen] = [spokenWords(better?.scenes), spokenWords(result.scenes)];
        const noWorse = softNow <= softThen && wordsNow <= Math.max(wordsThen, limit * 1.3);
        if (!testSection(section, better, material).length && noWorse && (softNow < softThen || wordsNow < wordsThen)) {
          if (wordsNow < wordsThen) shortened.push(section);
          polished.push(section);
          result = better;
        }
      }
      // Repairs ran out: keep the scenes that pass, and read out only what the failing ones taught.
      const mend = problems.length ? mendSection(section, result, material) : null;
      if (mend && !testSection(section, mend, material).length) {
        written.set(section, mend);
        mended.push(section);
      } else if (problems.length) rebuild(section, problems);
      else written.set(section, result);
    } else {
      written.set(section, { scenes: plainScenes(section, material), pronounce: [] }); // questions alone
    }
    const guess = quiz.find(q => q.section === section && q.guess);
    if (guess) await makeOpeners(section, guess).catch(() => {});
    finished++;
    onStep(`writing the script, section ${finished} of ${sections.length}`, (finished / sections.length) * 0.8);
  }));
  const allScenes = () => sections.flatMap(section => written.get(section).scenes.map(scene => ({ ...scene, section })));
  const openerScenes = () => [...openers].flatMap(([id, made]) => Object.entries(made.scenes).map(([k, scene]) => ({ ...scene, section: `opener ${id} ${k}` })));
  // An opener the claim check doubts is dropped, never mended: its clip plays without it.
  const dropDoubted = claims => {
    for (const item of claims?.added || []) {
      const [, id, k] = /^opener (\S+) (\d+)/.exec(item.section || '') || [];
      if (!id || !openers.get(id)?.scenes[k]) continue;
      delete openers.get(id).scenes[k];
      openerStats.droppedByCheck++;
    }
    return { ...claims, added: (claims?.added || []).filter(item => !/^opener /.test(item.section || '')) };
  };
  const review = async () => {
    const heard = hearing(allScenes(), assets);
    const [reading, rawClaims] = await Promise.all([ask(watcherRequest(page, material, heard), READER_SCHEMA), ask(claimRequest(page, material, heard, hearing(openerScenes(), assets)), CLAIM_SCHEMA)]);
    const claims = dropDoubted(rawClaims);
    return { reading, claims, faults: faultsBySection({ claims, reading, blocks, quiz: allQuiz, sections }, rebuilt) };
  };
  onStep('checking it against the page', 0.82);
  let checked = await review();
  const firstClaims = { added: checked.claims.added?.length || 0, dropped: checked.claims.dropped?.length || 0 };
  if (checked.faults.size) {
    onStep('fixing what the check found', 0.86);
    await Promise.all([...checked.faults].map(async ([section, problems]) => {
      const result = await attempt(section, { result: written.get(section), problems });
      const left = testSection(section, result, material);
      // A fix that breaks the drawing is mended like a first try: the scenes that pass stay.
      const mend = left.length ? mendSection(section, result, material) : null;
      if (!left.length) written.set(section, result);
      else if (mend && !testSection(section, mend, material).length) {
        written.set(section, mend);
        if (!mended.includes(section)) mended.push(section);
      } else rebuild(section, left);
    }));
    onStep('checking it against the page again', 0.93);
    checked = await review();
    // A second miss isn't worth a third try: the page's own words can't be wrong about the page.
    // Something wrong takes the section's scenes with it. Something only left out doesn't: that
    // block is read out where it belongs, so one small gap costs a section none of its motion.
    const { added = [], dropped = [] } = checked.claims;
    for (const [section, problems] of faultsBySection({ claims: { added }, reading: checked.reading, blocks, quiz: allQuiz, sections }, rebuilt)) rebuild(section, problems);
    for (const block of dropped.map(item => blocks.find(other => other.n === item.block)).filter(block => block && !rebuilt.has(block.section))) {
      const kept = written.get(block.section);
      written.set(block.section, { ...kept, scenes: withBlockRead(kept.scenes, block) });
      readOut.push(block.n);
    }
  }
  const scenes = allScenes();
  const teaching = scenes.filter(scene => !scene.check);
  const madeOpeners = Object.fromEntries([...openers].map(([id, made]) => [id, made.scenes]).filter(([, made]) => Object.keys(made).length));
  const beats = teaching.flatMap(scene => scene.beats);
  const actions = beats.flatMap(beat => beat.do || []);
  const answers = new Map((checked.reading?.answers || []).map(answer => [answer.id, answer.choice]));
  return {
    title: page.title,
    sections,
    scenes,
    assets,
    quiz,
    plan: map,
    openers: madeOpeners,
    pronounce: tidyPronounce([...[...written.values()].flatMap(result => result.pronounce || []), ...[...openers.values()].flatMap(made => made.pronounce)], [...scenes, ...openerScenes()]),
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
      clips: sections.length,
      stops: Math.max(0, ...sections.map(section => stopsOf(scenes.filter(scene => scene.section === section)))),
      masks: { planned: material.masks?.size || 0, made: scenes.reduce((total, scene) => total + (scene.masks || []).length, 0) },
      groupQuestions: allQuiz.filter(q => q.group).length,
      plan: planned.plan ? {
        shape: planned.plan.shape,
        boxes: planned.plan.boxes.length,
        guesses: allQuiz.filter(q => q.videoOnly && q.guess).length,
        traps: Object.keys(material.traps || {}).length,
        splits: planned.plan.splits.length,
        firstProblems: planned.firstProblems.length,
        problemsLeft: planned.problemsLeft.slice(0, 12),
      } : { failed: String(planned.error?.message || planned.error || 'no plan').slice(0, 200) },
      openers: openerStats,
      clipWords: sections.map(section => spokenWords(scenes.filter(scene => scene.section === section))),
      longClips: longClips(sections, scenes),
      rebuilt: [...rebuilt],
      whyRebuilt,
      mended,
      shortened,
      polished,
      firstSoft,
      softLeft: Object.fromEntries(sections.filter(section => !rebuilt.has(section)).map(section => [section, keptOnScreen(scenes.filter(scene => scene.section === section))]).filter(([, left]) => left.length)),
      quizShown: quiz.length,
      quizAll: allQuiz.length,
      readOut,
      firstProblems,
      forClaude,
      firstClaims,
      claimsLeft: { added: checked.claims.added || [], dropped: checked.claims.dropped || [] },
      watcher: {
        quick: `${allQuiz.filter(q => q.options[answers.get(q.id)]?.right).length}/${allQuiz.length}`,
        closing: `${(checked.reading?.closing || []).filter(item => item.answerable).length}/${(checked.reading?.closing || []).length}`,
        unknown: checked.reading?.unknown || [],
        missing: checked.reading?.missing || [],
      },
    },
  };
}
