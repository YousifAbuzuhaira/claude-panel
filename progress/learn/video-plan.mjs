// A video's plan, made once per page before its clips are written: the map in the player's title
// band (the same for every clip, so clips written apart still agree on it), the guess question that
// opens each clip, the real failures a clip may open on, and where a long clip holds two ideas.
// Claude proposes it; everything here that decides what stands is pure.
import { createHash } from 'node:crypto';
import { norm, spokenBudget, videoQuiz } from './video-check.mjs';

const MAX_BOXES = 4; // at once: the most a viewer tracks by eye
const MAX_LABEL = 22;
const MAX_HANDOFF_WORDS = 8;
const MIN_QUOTE_WORDS = 5;
const LONG_CLIP = 430;

const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);

const QUESTION = {
  type: ['object', 'null'],
  properties: {
    q: { type: 'string' },
    options: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, why: { type: 'string' }, right: { type: 'boolean' } }, required: ['text', 'why', 'right'] } },
    quote: { type: 'string' },
  },
  required: ['q', 'options', 'quote'],
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    shape: { type: 'string', enum: ['flow', 'parts', 'none'] },
    boxes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, parent: { type: ['string', 'null'] } }, required: ['id', 'label', 'parent'] } },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clip: { type: 'string' },
          box: { type: ['string', 'null'] },
          handoff: { type: ['string', 'null'] },
          handoffQuote: { type: ['string', 'null'] },
          guess: QUESTION,
          trap: { type: 'array', items: { type: 'integer' } },
          mask: { type: 'boolean' },
          patternOf: { type: ['string', 'null'] },
          patternQuote: { type: ['string', 'null'] },
        },
        required: ['clip', 'box', 'handoff', 'handoffQuote', 'guess', 'trap', 'mask', 'patternOf', 'patternQuote'],
      },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          box: { type: 'string' },
          q: { type: 'string' },
          options: QUESTION.properties.options,
          needs: { type: 'array', items: { type: 'string' } },
          quotes: { type: 'array', items: { type: 'object', properties: { clip: { type: 'string' }, quote: { type: 'string' } }, required: ['clip', 'quote'] } },
        },
        required: ['box', 'q', 'options', 'needs', 'quotes'],
      },
    },
    splits: { type: 'array', items: { type: 'object', properties: { clip: { type: 'string' }, at: { type: 'integer' }, title: { type: 'string' } }, required: ['clip', 'at', 'title'] } },
  },
  required: ['shape', 'boxes', 'clips', 'splits', 'groups'],
};

// The plan's rules, one per thing it decides. With questions off (Learn's setting), a video has no
// guess, masked line, repeated-pattern step or group question, so the plan isn't asked for them.
const PLAN_INTRO = `You plan a narrated, animated explainer video made from a page of a course. The video is a playlist of clips, one per section below, each written separately later. You decide what follows. Use only the page: nothing from outside it.`;
const PLAN_MAP = `THE MAP, drawn in the title band of every clip, the current clip's box lit, so the learner always sees where they are in the whole.
- "shape": "flow" when the clips follow something moving from one part to the next (a request through services, data through stages); "parts" when they are parts of one whole (components, rules, options); "none" when there is no such structure or there are fewer than 3 clips.
- "boxes": at most 4 with "parent" null. A box may have up to 4 children (parent: its id), two levels at most. Labels are 1 to 3 words and at most 22 characters, naming the thing itself (a service, a stage, a part), never a sentence.
- Each clip goes in exactly one box ("box"), the most specific one. Several clips may share a box. With "none", boxes is empty and every "box" is null.`;
const PLAN_HANDOFF = `THE HANDOFF, flow only. For a clip whose box differs from the previous clip's, "handoff" is at most 8 words naming what passes from the previous box into this one (a request, a token, a page), and "handoffQuote" copies at least 5 words, word for word, from a block that says so. Otherwise both are null.`;
const PLAN_GUESS = `THE GUESS QUESTION that opens each clip, before anything is taught: someone who already knows the clip's central mechanism gets it right; someone who doesn't plausibly gets it wrong. Exactly 3 options and one right. Each wrong option is a believable mistake a strong engineer new to this would make, never a joke. Each option has a one-sentence "why". The clip's own blocks must state the right answer: "quote" copies at least 5 words of them, word for word, that back it. A clip marked HAS A GUESS ALREADY gets null.`;
const PLAN_TRAP = `"trap": the numbers of the clip's blocks that describe something that really went wrong: a bug, a failed approach, a rejected option, an idea that turned out false. The clip will open by showing it. Empty for most clips. Never stretch this.`;
const PLAN_MASK = `"mask": true for a clip whose code (marked CODE below) carries out the mechanism the clip explains, so the clip can show the mechanism first, then hide the one line that does it and let the learner pick it. Only a clip marked CODE can have it, and most clips don't.`;
const PLAN_PATTERN = `"patternOf": the name of an EARLIER clip whose pattern this clip repeats (the same check in another route, a second adapter on the same interface), with "patternQuote" copying at least 5 words of this clip's blocks that show the repeat. This clip will show the shape and leave the repeated step for the learner, so give it "mask" true when it is marked CODE. Otherwise both are null.`;
const PLAN_GROUPS = `"groups": for a top box (parent null) holding two or more clips, at most one question that needs two or three of its clips together to answer: what connects them, not a fact from one. "needs" names those clips; "quotes" gives, for each, at least 5 words of its blocks, word for word, that the answer rests on. 3 options, one right, each with a why. It is asked at the end of the box's last clip. Leave groups empty when the shape is "none".`;
const PLAN_TAIL = `"splits": only for a clip marked LONG. If it really holds two separate mechanisms, give the block number where the second begins ("at", not the clip's first block) and a title for the new clip. Otherwise leave splits empty.

Give one entry in "clips" for every clip below, in order, with "clip" its exact name.`;

/** The planning rules, numbered: everything with questions on, the map, handoff and traps without. */
export function planRules(questions = true) {
  const parts = questions ? [PLAN_MAP, PLAN_HANDOFF, PLAN_GUESS, PLAN_TRAP, PLAN_MASK, PLAN_PATTERN, PLAN_GROUPS] : [PLAN_MAP, PLAN_HANDOFF, PLAN_TRAP];
  return [PLAN_INTRO, ...parts.map((text, k) => `${k + 1}. ${text}`), PLAN_TAIL].join('\n\n');
}

const QUESTION_FIELDS = ['guess', 'mask', 'patternOf', 'patternQuote'];

/** The plan's schema: without questions, no guess, mask, pattern or groups to fill in. */
export function planSchema(questions = true) {
  if (questions) return PLAN_SCHEMA;
  const clip = PLAN_SCHEMA.properties.clips.items;
  const { groups, ...properties } = PLAN_SCHEMA.properties;
  void groups;
  return {
    ...PLAN_SCHEMA,
    properties: {
      ...properties,
      clips: { ...PLAN_SCHEMA.properties.clips, items: { ...clip, properties: Object.fromEntries(Object.entries(clip.properties).filter(([key]) => !QUESTION_FIELDS.includes(key))), required: clip.required.filter(key => !QUESTION_FIELDS.includes(key)) } },
    },
    required: PLAN_SCHEMA.required.filter(key => key !== 'groups'),
  };
}

const describe = block => `[${block.n}] (${block.t}${block.callout ? `, ${block.callout}` : ''})`;

/** The planning request: every clip with its blocks, its size and the guess it already has. */
export function planRequest(page, material, repair = null, questions = true) {
  const { blocks, sections, quiz } = material;
  return [
    planRules(questions), '',
    `PAGE: ${page.title}`, '',
    ...sections.flatMap(section => {
      const mine = blocks.filter(block => block.section === section);
      const size = spokenBudget(mine);
      const guess = questions && quiz.find(q => q.section === section && q.guess);
      return [
        `## CLIP: ${section}${size > LONG_CLIP ? ' (LONG)' : ''}${questions && maskable(material, section) ? ' (CODE)' : ''}${guess ? ` (HAS A GUESS ALREADY: ${guess.q})` : ''}`,
        ...mine.flatMap(block => [describe(block), block.text]),
        '',
      ];
    }),
    ...(repair ? ['YOUR LAST ANSWER:', JSON.stringify(repair.plan), '', 'IT FAILED THESE CHECKS. Return all of it with these fixed and everything else kept:', ...repair.problems.map(problem => `- ${problem}`)] : []),
  ].join('\n');
}

/** A clip with code worth a masked line: a block of at least 4 lines that do something. */
export function maskable({ blocks, assets }, section) {
  return blocks.some(block => block.section === section && block.t === 'code' && String(assets.code[block.asset]?.text || '').split('\n').filter(line => /[A-Za-z_]\w/.test(line)).length >= 4);
}

const quoted = (quote, text) => words(norm(quote)).length >= MIN_QUOTE_WORDS && norm(text).includes(norm(quote));

/**
 * What's wrong with a plan, as problems Claude can fix, and the plan cut back to what passes: a
 * map that fails goes (no map), a guess that fails goes (that clip has no gate), a trap or a split
 * that doesn't hold is dropped. The video is made either way. With questions off, the plan's guesses,
 * masked lines, patterns and group questions are dropped unasked: none is a problem.
 */
export function checkPlan(plan, material, { questions = true } = {}) {
  const { blocks, sections, quiz } = material;
  const problems = [];
  const clipText = section => blocks.filter(block => block.section === section).map(block => block.text).join(' ');
  const given = new Map((plan?.clips || []).map(entry => [entry?.clip, entry]));
  for (const section of sections) if (!given.has(section)) problems.push(`Clip "${section}" has no entry in "clips"`);
  for (const name of given.keys()) if (!sections.includes(name)) problems.push(`"${name}" is not one of the clips`);

  // The map.
  let shape = ['flow', 'parts', 'none'].includes(plan?.shape) ? plan.shape : 'none';
  const boxes = shape === 'none' ? [] : (plan?.boxes || []).map(box => ({ id: String(box?.id ?? ''), label: String(box?.label ?? '').trim(), parent: box?.parent ?? null }));
  const mapProblems = [];
  const ids = new Map(boxes.map(box => [box.id, box]));
  if (shape !== 'none') {
    if (sections.length < 3) mapProblems.push('With fewer than 3 clips the shape is "none"');
    if (ids.size !== boxes.length || boxes.some(box => !box.id)) mapProblems.push('Every box needs its own id');
    const top = boxes.filter(box => !box.parent);
    if (!top.length || top.length > MAX_BOXES) mapProblems.push(`The map has ${top.length} top boxes: give it 1 to ${MAX_BOXES}`);
    for (const box of boxes) {
      if (!box.label || box.label.length > MAX_LABEL || words(box.label).length > 3) mapProblems.push(`Box "${box.label}" needs a label of 1 to 3 words and at most ${MAX_LABEL} characters`);
      if (box.parent && !ids.has(box.parent)) mapProblems.push(`Box "${box.label}" has a parent that isn't a box`);
      if (box.parent && ids.get(box.parent)?.parent) mapProblems.push(`Box "${box.label}" is a third level: two at most`);
      if (boxes.filter(child => child.parent === box.id).length > MAX_BOXES) mapProblems.push(`Box "${box.label}" has more than ${MAX_BOXES} children`);
    }
    for (const section of sections) if (!ids.has(given.get(section)?.box)) mapProblems.push(`Clip "${section}" needs a box from the map`);
  }
  problems.push(...mapProblems);
  if (mapProblems.length) shape = 'none';

  // The handoff, the guess, the trap: each per clip.
  const clips = sections.map((section, k) => {
    const entry = given.get(section) || {};
    const box = shape === 'none' ? null : entry.box;
    let handoff = null;
    if (shape === 'flow' && entry.handoff && k > 0 && box !== (given.get(sections[k - 1])?.box)) {
      if (words(entry.handoff).length > MAX_HANDOFF_WORDS) problems.push(`Clip "${section}": the handoff is over ${MAX_HANDOFF_WORDS} words`);
      else if (!quoted(entry.handoffQuote, `${clipText(sections[k - 1])} ${clipText(section)}`)) problems.push(`Clip "${section}": the handoff's quote is not word for word from the two clips' blocks`);
      else handoff = String(entry.handoff).trim();
    }
    let guess = null;
    const hasOne = !questions || quiz.some(q => q.section === section && q.guess);
    if (entry.guess && !hasOne) {
      const options = entry.guess.options || [];
      const before = problems.length;
      if (!String(entry.guess.q || '').trim()) problems.push(`Clip "${section}": the guess question is empty`);
      if (options.length !== 3 || options.filter(option => option.right).length !== 1) problems.push(`Clip "${section}": the guess needs exactly 3 options and one right`);
      if (options.some(option => !String(option.text || '').trim() || !String(option.why || '').trim())) problems.push(`Clip "${section}": every option needs its text and a why`);
      if (!quoted(entry.guess.quote, clipText(section))) problems.push(`Clip "${section}": the guess's quote is not word for word from this clip's blocks`);
      if (problems.length === before) guess = { q: String(entry.guess.q).trim(), options: options.map(option => ({ text: String(option.text).trim(), why: String(option.why).trim(), right: Boolean(option.right) })), quote: entry.guess.quote };
    } else if (!entry.guess && !hasOne && given.has(section)) problems.push(`Clip "${section}" needs a guess question`);
    const mine = new Set(blocks.filter(block => block.section === section).map(block => block.n));
    const trap = (entry.trap || []).filter(n => mine.has(n));
    let patternOf = null;
    if (questions && entry.patternOf) {
      if (sections.indexOf(entry.patternOf) === -1 || sections.indexOf(entry.patternOf) >= k) problems.push(`Clip "${section}": "patternOf" must name an earlier clip`);
      else if (!quoted(entry.patternQuote, clipText(section))) problems.push(`Clip "${section}": the pattern's quote is not word for word from this clip's blocks`);
      else patternOf = entry.patternOf;
    }
    // A masked line only where there's code to mask; never a problem, just not done.
    const mask = questions && Boolean(entry.mask || patternOf) && maskable(material, section);
    return { clip: section, box, handoff, guess, trap, mask, patternOf };
  });

  // Group questions: one per top box with two clips or more, asked at the end of its last clip.
  const inBox = id => clips.filter(entry => entry.box === id || boxes.find(box => box.id === entry.box)?.parent === id).map(entry => entry.clip);
  const groups = [];
  for (const group of shape === 'none' || !questions ? [] : plan?.groups || []) {
    const box = boxes.find(item => item.id === group?.box && !item.parent);
    const members = box ? inBox(box.id) : [];
    const needs = [...new Set(group?.needs || [])];
    const options = group?.options || [];
    const before = problems.length;
    if (!box || members.length < 2) problems.push(`Group question on "${group?.box}": it needs a top box holding two clips or more`);
    else if (groups.some(item => item.box === box.id)) problems.push(`Box "${box.label}" has two group questions: keep one`);
    else {
      if (needs.length < 2 || needs.some(name => !members.includes(name))) problems.push(`Group question on "${box.label}": "needs" must name two or three of its own clips`);
      for (const name of needs) if (!quoted((group.quotes || []).find(item => item.clip === name)?.quote, clipText(name))) problems.push(`Group question on "${box.label}": no quote word for word from clip "${name}"`);
      if (!String(group.q || '').trim() || options.length !== 3 || options.filter(option => option.right).length !== 1 || options.some(option => !String(option.text || '').trim() || !String(option.why || '').trim())) problems.push(`Group question on "${box.label}": it needs a question, 3 options with whys, and one right`);
    }
    if (problems.length === before) groups.push({ box: box.id, q: String(group.q).trim(), options: options.map(option => ({ text: String(option.text).trim(), why: String(option.why).trim(), right: Boolean(option.right) })), needs, last: sections.filter(name => members.includes(name)).at(-1) });
  }
  // A clip ends on at most one question: one closing a group has no masked line.
  for (const entry of clips) if (groups.some(group => group.last === entry.clip)) entry.mask = false;

  const splits = (plan?.splits || []).filter(split => {
    const mine = blocks.filter(block => block.section === split?.clip);
    return mine.length && spokenBudget(mine) > LONG_CLIP && mine.some(block => block.n === split.at) && mine[0].n !== split.at && String(split.title || '').trim() && !sections.includes(String(split.title).trim());
  }).map(split => ({ clip: split.clip, at: split.at, title: String(split.title).trim() }));

  return { problems, plan: { shape, boxes: shape === 'none' ? [] : boxes, clips, splits, groups } };
}

const questionId = (page, section, q) => `v${createHash('sha256').update(`${page.title}\n${section}\n${q}`).digest('hex').slice(0, 10)}`;

/**
 * The material with the plan in it: a long clip split where the plan says, and each clip's guess
 * question in the quiz as a video-only question, asked first in its clip. Watching must answer it
 * too, so it joins `allQuiz`.
 */
export function applyPlan(page, material, plan) {
  let blocks = material.blocks.map(block => ({ ...block }));
  let allQuiz = material.allQuiz.map(q => ({ ...q }));
  const sections = [...material.sections];
  const clips = plan.clips.map(entry => ({ ...entry }));
  for (const split of plan.splits || []) {
    const at = sections.indexOf(split.clip);
    if (at === -1) continue;
    for (const block of blocks) if (block.section === split.clip && block.n >= split.at) block.section = split.title;
    for (const q of allQuiz) if (q.section === split.clip && !q.guess && q.after >= split.at) q.section = split.title;
    sections.splice(at + 1, 0, split.title);
    const entry = clips.find(item => item.clip === split.clip);
    const half = { clip: split.title, box: entry?.box ?? null, handoff: null, guess: null, trap: (entry?.trap || []).filter(n => n >= split.at), mask: false, patternOf: null };
    // The guess goes with the half that teaches its answer.
    if (entry?.guess && norm(blocks.filter(block => block.section === split.title).map(block => block.text).join(' ')).includes(norm(entry.guess.quote))) [half.guess, entry.guess] = [entry.guess, null];
    if (entry) entry.trap = entry.trap.filter(n => n < split.at);
    clips.splice(clips.indexOf(entry) + 1, 0, half);
  }
  for (const entry of clips) {
    if (!entry.guess) continue;
    const first = blocks.find(block => block.section === entry.clip);
    allQuiz.push({ id: questionId(page, entry.clip, entry.guess.q), guess: true, videoOnly: true, after: (first?.n ?? 0) - 1, section: entry.clip, q: entry.guess.q, options: entry.guess.options.map(({ text, why, right }) => ({ text, why, right })) });
  }
  // A group's question closes its box's last clip, in place of that clip's own end question.
  for (const group of plan.groups || []) {
    const last = blocks.filter(block => block.section === group.last).at(-1);
    allQuiz.push({ id: questionId(page, group.last, group.q), guess: false, videoOnly: true, group: group.needs, after: last?.n ?? 0, section: group.last, q: group.q, options: group.options.map(({ text, why, right }) => ({ text, why, right })) });
  }
  // In clip order, each clip's guess first.
  allQuiz = allQuiz.map((q, k) => ({ q, k })).sort((a, b) => sections.indexOf(a.q.section) - sections.indexOf(b.q.section) || Number(b.q.guess) - Number(a.q.guess) || a.k - b.k).map(({ q }) => q);
  blocks = blocks.sort((a, b) => a.n - b.n);
  const traps = Object.fromEntries(clips.filter(entry => entry.trap.length).map(entry => [entry.clip, entry.trap]));
  // A clip with a masked line asks no end question: the mask is its second stop.
  const masks = new Set(clips.filter(entry => entry.mask).map(entry => entry.clip));
  const patterns = Object.fromEntries(clips.filter(entry => entry.patternOf).map(entry => [entry.clip, entry.patternOf]));
  return {
    material: { ...material, blocks, allQuiz, sections, quiz: videoQuiz(allQuiz, masks), traps, masks, patterns },
    map: { shape: plan.shape, boxes: plan.boxes, clips: clips.map(({ clip, box, handoff }) => ({ clip, box, handoff })) },
  };
}

/** The plan for a page: asked once, repaired once, then cut back to what passes. Null when nothing came back. */
export async function makePlan({ page, material, ask, questions = true }) {
  let plan = await ask(planRequest(page, material, null, questions), planSchema(questions));
  let checked = checkPlan(plan, material, { questions });
  const first = checked.problems;
  if (first.length) {
    plan = await ask(planRequest(page, material, { plan, problems: first.slice(0, 20) }, questions), planSchema(questions));
    checked = checkPlan(plan, material, { questions });
  }
  return { plan: checked.plan, firstProblems: first, problemsLeft: checked.problems };
}

// --- Openers: a wrong guess played out ------------------------------------------------------

export const OPENER_SCHEMA = {
  type: 'object',
  properties: {
    openers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'integer' },
          scene: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              quote: { type: ['string', 'null'] },
              objects: { type: 'array', items: { type: 'object' } },
              beats: { type: 'array', items: { type: 'object', properties: { say: { type: 'string' }, do: { type: 'array', items: { type: 'object' } } }, required: ['say', 'do'] } },
            },
            required: ['title', 'quote', 'objects', 'beats'],
          },
        },
        required: ['option', 'scene'],
      },
    },
    pronounce: { type: 'array', items: { type: 'object', properties: { written: { type: 'string' }, spoken: { type: 'string' } }, required: ['written', 'spoken'] } },
  },
  required: ['openers', 'pronounce'],
};

export const OPENER_WORDS = { least: 15, most: 60 };
