// A page as material for a video, and what a video's script must pass before it's recorded. Pure.
// Claude writes scenes per section. Each is tested beat by beat, as the player would draw it. A
// section that can't be made to pass is rebuilt here from the page's own blocks: that can't invent
// anything or lose anything, so a video always covers the whole page.
import { createHash } from 'node:crypto';
import { inlineText } from './markdown.mjs';
import { STAGE, numberWidth } from '../web/public/learn/video/model.mjs';

export const MAX_SAY_WORDS = 30;
const MIN_QUOTE_WORDS = 5;
const STILL_BEATS = 0.12;
const CODE_LINES = 18;
const CODE_WIDTH = 112;
const TABLE_ROWS = 6;
const ROUGH = { s: 16, m: 22, l: 30, xl: 46 };
const NUDGE = 30; // the furthest code will move an object back on stage
const LIMITS = { left: STAGE.left - 10, top: STAGE.top - 8, right: STAGE.right + 10, bottom: STAGE.bottom + 12 };

export const norm = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
/** A word as the recorder matches it (narrate.py's `clean`): `1,000` and `non-linear` are one word. */
const spokenWord = word => String(word ?? '').replace(/[^\p{L}\p{N}_']/gu, '').toLowerCase();

/** What the page's text says: its source marks are for reading, not for hearing. */
const plain = inlines => (inlines || []).filter(item => !item.added && !item.time && !item.sec).map(item => item.s || '').join('').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim();

/** A video's version of a page: anything that would change what it should say changes this. */
export function videoStamp(page) {
  const checks = (page.blocks || []).filter(block => block.t === 'check').map(block => block.id);
  const disputes = (page.disputes || []).map(dispute => dispute.quote);
  return createHash('sha256').update(JSON.stringify([page.markdown, checks, disputes])).digest('hex').slice(0, 16);
}

/** A page made before quick questions existed: its course needs updating first. */
export const isOldPage = page => !page?.stats;

/** The page as numbered blocks by section, the things a scene can show, and its questions. */
export function flattenPage(page) {
  const blocks = [];
  const assets = { code: [], table: [], diagram: [] };
  const sections = [];
  const held = [];
  const openSection = name => {
    const taken = sections.filter(other => other === name || other.startsWith(`${name} (`)).length;
    sections.push(taken ? `${name} (${taken + 1})` : name);
  };
  openSection('Introduction');
  const walk = (list, callout) => {
    for (const block of list) {
      const section = sections.at(-1);
      if (block.t === 'h') { openSection(plain(block.inlines) || 'Section'); continue; }
      if (block.t === 'check') { held.push({ block, section, after: blocks.length - 1 }); continue; }
      if (block.t === 'callout') { walk(block.blocks, block.kind === 'disputed' ? 'disputed' : `${block.kind}: ${plain(block.title)}`); continue; }
      const entry = { n: blocks.length, t: block.t, section, callout: callout || null };
      if (block.t === 'p' || block.t === 'quote') entry.text = plain(block.inlines);
      if (block.t === 'ul' || block.t === 'ol') entry.text = block.items.map(item => plain(item.inlines)).join('\n');
      if (block.t === 'code') {
        entry.asset = assets.code.length;
        assets.code.push({ lang: block.lang, text: block.text });
        entry.text = block.text;
      }
      if (block.t === 'table') {
        entry.asset = assets.table.length;
        assets.table.push(block.rows.map(row => row.map(plain)));
        entry.text = block.rows.map((row, k) => `row ${k - 1}: ${row.map(plain).join(' | ')}`).join('\n');
      }
      if (block.t === 'diagram') {
        entry.asset = assets.diagram.length;
        assets.diagram.push(block);
        entry.text = block.nodes.map((node, k) => `node ${k}: ${node.lines.join(' ')}`).join('\n');
      }
      if (entry.text) blocks.push(entry);
    }
  };
  walk(page.blocks || [], null);
  const quiz = held.map(({ block, section, after }) => ({
    id: block.id,
    guess: Boolean(block.guess),
    after,
    section,
    q: plain(block.q),
    options: block.options.map(option => ({ text: plain(option.inlines), why: plain(option.why), right: Boolean(option.right) })),
  }));
  const used = sections.filter(name => blocks.some(block => block.section === name) || quiz.some(q => q.section === name));
  return { blocks, assets, quiz, sections: used, pageText: norm(blocks.map(block => block.text).join(' ')) };
}

// --- Testing a scene ---------------------------------------------------------------------

function rectOf(o, assets) {
  if (o.shape === 'row') {
    const n = (o.items || []).length || 1;
    const cell = Math.max(52, Math.min(112, (o.w - 10 * (n - 1)) / n));
    return { x: o.x, y: o.y, w: o.w, h: cell * 1.05 };
  }
  if (o.shape === 'label') {
    const size = ROUGH[o.size || 'm'];
    const lines = Math.ceil((String(o.text).length * size * 0.56) / (o.w || 300));
    return { x: o.x, y: o.y, w: o.w || 300, h: lines * size * 1.3 };
  }
  if (o.shape === 'number') {
    const size = ROUGH[o.size || 'l'];
    return { x: o.x, y: o.y, w: o.w || 240, h: size * 1.3 + (o.sub ? 24 : 0) };
  }
  if (o.shape === 'table') return { x: o.x, y: o.y, w: o.w, h: 56 * (assets.table[o.asset]?.length || 1) };
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

const inside = (inner, outer) => inner.x >= outer.x - 2 && inner.y >= outer.y - 2 && inner.x + inner.w <= outer.x + outer.w + 2 && inner.y + inner.h <= outer.y + outer.h + 2;

function testPicture(objects, assets, name, when, problems) {
  const shown = [...objects.values()].filter(o => o.visible && !['arrow', 'dot'].includes(o.shape));
  for (const o of shown) {
    const r = rectOf(o, assets);
    if ([r.x, r.y, r.w, r.h].some(value => typeof value !== 'number' || Number.isNaN(value))) {
      problems.push(`${name}: ${o.id} has no position or size`);
      continue;
    }
    if (r.x < LIMITS.left || r.y < LIMITS.top || r.x + r.w > LIMITS.right || r.y + r.h > LIMITS.bottom) problems.push(`${name}, ${when}: ${o.id} leaves the stage (x ${Math.round(r.x)}-${Math.round(r.x + r.w)}, y ${Math.round(r.y)}-${Math.round(r.y + r.h)})`);
    if (o.shape === 'box' && o.text) {
      const fit = Math.min(r.h * 0.42, (r.w - 30) / (String(o.text).length * 0.62));
      if (fit < 16) problems.push(`${name}: "${o.text}" is too long for box ${o.id}`);
    }
    if (o.shape === 'number') {
      const wide = numberWidth(o, ROUGH[o.size || 'l'] * (o.size === 'xl' ? 1.3 : 1)) - 10;
      if (wide > (o.w || 240) || o.x + wide > STAGE.right + 5) problems.push(`${name}: number ${o.id} needs ${Math.round(wide)} of width at x ${o.x}: move it left, widen it or use a smaller size`);
    }
    if (o.shape === 'code') {
      const lines = String(assets.code[o.asset]?.text || '').split('\n');
      const widest = Math.max(...lines.map(line => line.length));
      const font = Math.min((o.w - 36) / (widest * 0.61), (o.h - 30) / (lines.length * 1.45));
      if (font < 13.5) problems.push(`${name}: code ${o.id} is too small to read at ${o.w} by ${o.h}. It needs about ${Math.round(widest * 0.61 * 14 + 36)} by ${Math.round(lines.length * 1.45 * 14 + 30)}: give it the main part of the stage`);
    }
  }
  const solid = shown.filter(o => o.style !== 'outline' && !o.fade && o.shape !== 'bar');
  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      const p = rectOf(solid[a], assets);
      const q = rectOf(solid[b], assets);
      const across = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const down = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (across > 6 && down > 6 && !(solid[a].shape === 'label' && inside(p, q)) && !(solid[b].shape === 'label' && inside(q, p))) problems.push(`${name}, ${when}: ${solid[a].id} overlaps ${solid[b].id}`);
    }
  }
}

const apply = (objects, action) => {
  for (const id of action.show || []) if (objects.has(id)) objects.get(id).visible = true;
  for (const id of action.hide || []) if (objects.has(id)) objects.get(id).visible = false;
  for (const [id, change] of Object.entries(action.set || {})) if (objects.has(id)) Object.assign(objects.get(id), change);
};

/** `diagram 0`, as a block's heading writes it, is asset 0. */
const assetNumber = value => {
  const found = typeof value === 'string' ? /(\d+)\s*$/.exec(value) : null;
  return found ? Number(found[1]) : value;
};

const hasAsset = o => ['code', 'table', 'diagram'].includes(o.shape);

/** How far each object strays past the stage at its worst, across the scene: id to { dx, dy }. */
function strays(scene, assets) {
  const objects = new Map((scene.objects || []).map(o => [o.id, { ...o, visible: Boolean(o.show) }]));
  const worst = new Map();
  const look = () => {
    for (const o of objects.values()) {
      if (!o.visible || ['arrow', 'dot'].includes(o.shape)) continue;
      const r = rectOf(o, assets);
      if ([r.x, r.y, r.w, r.h].some(value => typeof value !== 'number' || Number.isNaN(value))) continue;
      const seen = worst.get(o.id) || { left: 0, right: 0, up: 0, down: 0 };
      seen.left = Math.max(seen.left, LIMITS.left - r.x);
      seen.right = Math.max(seen.right, r.x + r.w - LIMITS.right);
      seen.up = Math.max(seen.up, LIMITS.top - r.y);
      seen.down = Math.max(seen.down, r.y + r.h - LIMITS.bottom);
      worst.set(o.id, seen);
    }
  };
  look();
  for (const beat of scene.beats || []) {
    for (const action of beat.do || []) apply(objects, action);
    look();
  }
  // Past both sides, it's too big to move: that one is Claude's to fix.
  const shift = (low, high) => (low > 0 && high > 0 ? 0 : low > 0 ? Math.ceil(low) : high > 0 ? -Math.ceil(high) : 0);
  const moves = new Map();
  for (const [id, seen] of worst) {
    const [dx, dy] = [shift(seen.left, seen.right), shift(seen.up, seen.down)];
    if ((dx || dy) && Math.abs(dx) <= NUDGE && Math.abs(dy) <= NUDGE) moves.set(id, { dx, dy });
  }
  return moves;
}

const moved = (o, { dx, dy }) => ({ ...o, ...(typeof o.x === 'number' ? { x: o.x + dx } : {}), ...(typeof o.y === 'number' ? { y: o.y + dy } : {}) });

/**
 * Fixes what code can, before anything is tested: an object a little off the stage moves back, all
 * its positions together, and an asset written as `diagram 0` becomes 0. `testSection` still judges
 * the result, so a move that makes an overlap goes to Claude like any other miss.
 */
export function settleScenes(result, assets) {
  const scenes = (result?.scenes || []).map(scene => {
    const objects = (scene.objects || []).map(o => (hasAsset(o) ? { ...o, asset: assetNumber(o.asset) } : o));
    const named = new Map(objects.map(o => [o.id, o]));
    const beats = (scene.beats || []).map(beat => ({
      ...beat,
      do: (beat.do || []).map(action => (action.set ? { ...action, set: Object.fromEntries(Object.entries(action.set).map(([id, change]) => [id, 'asset' in change ? { ...change, asset: assetNumber(change.asset) } : change])) } : action)),
    }));
    const tidy = { ...scene, objects, beats };
    if (scene.check) return tidy;
    const moves = strays(tidy, assets);
    if (!moves.size) return tidy;
    return {
      ...tidy,
      objects: objects.map(o => (moves.has(o.id) ? moved(o, moves.get(o.id)) : o)),
      beats: beats.map(beat => ({
        ...beat,
        do: beat.do.map(action => (action.set ? { ...action, set: Object.fromEntries(Object.entries(action.set).map(([id, change]) => [id, moves.has(id) && named.has(id) ? moved(change, moves.get(id)) : change])) } : action)),
      })),
    };
  });
  return { ...result, scenes };
}

/** Plays a scene through, picture by picture. Adds what's wrong to `problems`. */
export function simulate(scene, name, assets, problems) {
  const objects = new Map((scene.objects || []).map(o => [o.id, { ...o, visible: Boolean(o.show) }]));
  if (objects.size !== (scene.objects || []).length) problems.push(`${name}: two objects share an id`);
  testPicture(objects, assets, name, 'at the start', problems);
  (scene.beats || []).forEach((beat, index) => {
    const said = words(beat.say).map(spokenWord);
    for (const action of beat.do || []) {
      if (action.on && !said.includes(spokenWord(action.on))) problems.push(`${name}, beat ${index}: "on" word "${action.on}" is not in: ${beat.say}`);
      for (const id of [...(action.show || []), ...(action.hide || []), ...Object.keys(action.set || {})]) if (!objects.has(id)) problems.push(`${name}, beat ${index}: unknown object ${id}`);
      apply(objects, action);
    }
    testPicture(objects, assets, name, `beat ${index}`, problems);
  });
  for (const o of scene.objects || []) {
    if (['code', 'table', 'diagram'].includes(o.shape) && !assets[o.shape][o.asset]) problems.push(`${name}: no ${o.shape} ${o.asset}`);
    const shownSomewhere = o.show || (scene.beats || []).some(beat => (beat.do || []).some(action => (action.show || []).includes(o.id)));
    if (!shownSomewhere) problems.push(`${name}: object ${o.id} is never shown: add it to a "show" list`);
  }
  for (const o of [...objects.values()].filter(item => item.shape === 'row')) {
    const n = (o.items || []).length;
    const widest = Math.max(1, ...(o.items || []).map(item => String(item.label).length));
    if (n && (o.w - 10 * (n - 1)) / n < Math.max(44, widest * 13 + 12)) problems.push(`${name}: row ${o.id} is too narrow for ${n} boxes: make it wider`);
  }
}

/** What's wrong with one section's scenes; empty means it can be recorded. */
export function testSection(section, result, { blocks, assets, quiz, pageText }) {
  const problems = [];
  const mine = blocks.filter(block => block.section === section);
  const scenes = result?.scenes || [];
  const covered = new Set(scenes.flatMap(scene => scene.covers || []));
  for (const block of mine) if (!covered.has(block.n)) problems.push(`Block ${block.n} is not covered: ${block.text.slice(0, 70)}`);
  const asked = scenes.filter(scene => scene.check).map(scene => scene.check);
  const myQuiz = quiz.filter(q => q.section === section);
  for (const q of myQuiz) {
    const times = asked.filter(id => id === q.id).length;
    if (times !== 1) problems.push(`Question ${q.id} appears ${times} times`);
  }
  if (asked.join() !== myQuiz.map(q => q.id).filter(id => asked.includes(id)).join()) problems.push('The questions are out of order');
  for (const id of asked) if (!myQuiz.some(q => q.id === id)) problems.push(`Question ${id} is not a question of this section`);
  let beats = 0;
  let still = 0;
  scenes.forEach((scene, index) => {
    if (scene.check) return;
    const label = `Scene ${index} ("${scene.title}")`;
    if (!scene.quote || words(norm(scene.quote)).length < MIN_QUOTE_WORDS || !pageText.includes(norm(scene.quote))) problems.push(`${label}: its quote is not word for word from a block: ${String(scene.quote).slice(0, 80)}`);
    for (const beat of scene.beats || []) {
      beats++;
      if (!(beat.do || []).length) still++;
      if (words(beat.say).length > MAX_SAY_WORDS) problems.push(`${label}: sentence too long: ${beat.say}`);
    }
    simulate(scene, label, assets, problems);
  });
  if (beats && still / beats > STILL_BEATS) problems.push(`${still} of ${beats} beats change nothing on screen: give them actions`);
  return [...new Set(problems)];
}

// --- The plain fallback --------------------------------------------------------------------

const sentencesOf = text => String(text).split(/\n+/).flatMap(line => line.trim().split(/(?<=[.!?])\s+/)).map(line => line.trim()).filter(Boolean);

function pagesOf(list, size) {
  const pages = [];
  for (let at = 0; at < list.length; at += size) pages.push(list.slice(at, at + size));
  return pages;
}

const wrapped = line => (line.length <= CODE_WIDTH ? [line] : pagesOf([...line], CODE_WIDTH).map(chars => chars.join('')));

function proseScene(block, title) {
  const beats = sentencesOf(block.text).map(sentence => {
    const size = sentence.length > 900 ? 's' : sentence.length > 170 ? 'm' : 'l';
    return { say: sentence, do: [{ on: null, show: ['words'], set: { words: { text: sentence, size } } }] };
  });
  return { title, covers: [block.n], quote: null, check: null, plain: true, objects: [{ id: 'words', shape: 'label', x: 80, y: 150, w: 960, text: '', size: 'l' }], beats };
}

function shownScenes(block, title, assets) {
  const held = (seconds, line) => [{ say: line, hold: seconds, do: [{ on: null, show: ['shown'] }] }];
  const scene = (object, line, seconds) => ({ title, covers: [block.n], quote: null, check: null, plain: true, objects: [{ id: 'shown', ...object }], beats: held(seconds, line) });
  if (block.t === 'code') {
    const code = assets.code[block.asset];
    const lines = code.text.split('\n').flatMap(wrapped);
    return pagesOf(lines, CODE_LINES).map((part, index) => {
      assets.code.push({ lang: code.lang, text: part.join('\n') });
      return scene({ shape: 'code', x: 40, y: 100, w: 1040, h: 396, asset: assets.code.length - 1 }, index ? 'And the rest of it.' : 'Here is the code.', Math.min(20, 3 + part.length * 0.8));
    });
  }
  if (block.t === 'table') {
    const [head, ...rows] = assets.table[block.asset];
    return pagesOf(rows, TABLE_ROWS).map((part, index) => {
      assets.table.push([head, ...part]);
      return scene({ shape: 'table', x: 40, y: 100, w: 1040, asset: assets.table.length - 1, rows: part.map((_, k) => k), now: [] }, index ? 'And the rest of it.' : 'Here is the table.', Math.min(20, 3 + part.length * 1.5));
    });
  }
  const nodes = assets.diagram[block.asset].nodes.map((_, k) => k);
  return [scene({ shape: 'diagram', x: 40, y: 96, w: 1040, h: 404, asset: block.asset, nodes }, 'Here is the diagram.', Math.min(20, 3 + nodes.length))];
}

/** A section rebuilt from the page's own blocks, its questions where they belong. */
export function plainScenes(section, { blocks, assets, quiz }) {
  const question = q => ({ title: 'Quick check', covers: [], quote: null, check: q.id, objects: [], beats: [{ say: '', do: [] }] });
  const mine = quiz.filter(q => q.section === section);
  const scenes = mine.filter(q => q.guess).map(question);
  const title = section === 'Introduction' ? 'In brief' : section;
  for (const block of blocks.filter(item => item.section === section)) {
    scenes.push(...(['code', 'table', 'diagram'].includes(block.t) ? shownScenes(block, title, assets) : [proseScene(block, title)]));
    scenes.push(...mine.filter(q => !q.guess && q.after === block.n).map(question));
  }
  const placed = new Set(scenes.filter(scene => scene.check).map(scene => scene.check));
  scenes.push(...mine.filter(q => !placed.has(q.id)).map(question));
  return scenes;
}

/** One block the scenes dropped, read out word for word right after what they did teach. */
export function withBlockRead(scenes, block) {
  const out = [...scenes];
  const last = out.findLastIndex(scene => (scene.covers || []).some(n => n <= block.n));
  out.splice(last + 1, 0, proseScene(block, scenes[last]?.title || block.section));
  return out;
}

// --- What someone watching takes in ----------------------------------------------------------

function onScreen(o, assets) {
  if (o.shape === 'code') return `code:\n${assets.code[o.asset]?.text}`;
  if (o.shape === 'table') return `table:\n${assets.table[o.asset]?.map(row => row.join(' | ')).join('\n')}`;
  if (o.shape === 'diagram') return `diagram: ${assets.diagram[o.asset]?.nodes.map(node => node.lines.join(' ')).join('; ')}`;
  if (o.shape === 'row') return (o.items || []).map(item => item.label + (item.sub ? ` [${item.sub}]` : '')).join(' ');
  return [o.text, o.value, o.sub].filter(value => value !== undefined && value !== null).join(' ');
}

function changesInBeat(beat) {
  const sets = (beat.do || []).flatMap(action => Object.values(action.set || {}));
  return sets.map(change => (change.items ? change.items.map(item => item.label).join(' ') : change.text ?? change.value)).filter(value => value !== undefined);
}

/** The narration and on-screen text as one script, for the blind watcher and the claim check. */
export function hearing(scenes, assets) {
  return scenes.filter(scene => !scene.check).map(scene => [
    `## [${scene.section}] ${scene.title}`,
    ...scene.beats.map(beat => {
      const shown = scene.plain ? [] : changesInBeat(beat);
      return beat.say + (shown.length ? ` (On screen now: ${shown.join('; ')})` : '');
    }),
    `(On screen: ${(scene.objects || []).map(o => onScreen(o, assets)).filter(Boolean).join(' | ')})`,
  ].join('\n')).join('\n\n');
}

/**
 * What the watcher and the claim check found, as work for each section to redo. A section already
 * rebuilt from the page can't have these faults: anything said against one is left out.
 */
export function faultsBySection({ claims, reading, blocks, quiz, sections }, rebuilt = new Set()) {
  const faults = new Map();
  const add = (section, text) => {
    if (!sections.includes(section) || rebuilt.has(section)) return;
    faults.set(section, [...(faults.get(section) || []), text]);
  };
  for (const item of claims?.added || []) {
    const text = `Not supported by the page, remove or correct it wherever it appears: "${item.said}" (${item.why})`;
    for (const section of sections.includes(item.section) ? [item.section] : sections) add(section, text);
  }
  for (const item of claims?.dropped || []) {
    const block = blocks.find(other => other.n === item.block);
    if (block) add(block.section, `The page says this and the video dropped it. Teach it, and cover block ${block.n}: "${item.fact}"`);
  }
  const answers = new Map((reading?.answers || []).map(answer => [answer.id, answer.choice]));
  for (const q of quiz.filter(item => !item.guess)) {
    if (q.options[answers.get(q.id)]?.right) continue;
    add(q.section, `Someone who only watched could not answer this question, so teach its answer before it: "${q.q}" The answer is: ${q.options.find(option => option.right)?.text}`);
  }
  return faults;
}

/** The pronunciations worth keeping: each once, for a word really in the script. */
export function tidyPronounce(list, scenes) {
  const said = ` ${scenes.flatMap(scene => (scene.beats || []).map(beat => beat.say)).join(' ')} `;
  const out = new Map();
  for (const item of list || []) {
    const written = String(item?.written || '').trim();
    const spoken = String(item?.spoken || '').trim();
    if (written && spoken && written !== spoken && said.includes(written)) out.set(written, spoken);
  }
  return [...out].slice(0, 60).map(([written, spoken]) => ({ written, spoken }));
}

/** Roughly how long a page's video and recording will be, and its size. */
export function estimate(wordCount) {
  const minutes = wordCount / 112;
  const scriptMinutes = Math.max(2, Math.round(wordCount / 800));
  const recordingMinutes = Math.max(1, Math.round(minutes * 0.49));
  return { minutes: Math.round(minutes * 10) / 10, scriptMinutes, recordingMinutes, totalMinutes: scriptMinutes + recordingMinutes, mb: Math.round(minutes * 0.53 * 10) / 10 };
}
