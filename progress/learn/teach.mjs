// What a page's terms and questions must pass before the reader sees them. Pure.
// A question stays only if its quote is really on the page, the quote isn't something Claude
// added from its own knowledge, and a reader who saw only the page reached the same answer.
import { createHash } from 'node:crypto';
import { inlineText, parseInline } from './markdown.mjs';

const MIN_QUOTE_WORDS = 5;
const MAX_QUICK = 12;
const CITE = /\[(?:s\d{1,2}\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]|\[sec:[^\]]*\]/g;
const ADDED = /\(added\)/g;

export const tokens = text => String(text ?? '').toLowerCase().replace(CITE, ' ').replace(ADDED, ' ').match(/[\p{L}\p{N}]+/gu) || [];

/** A term is a word or short phrase, not a mark on the page, a command or a value from an example. */
export const isTerm = text => {
  const word = String(text ?? '').trim();
  return word.length > 0 && word.length <= 40 && tokens(word).length > 0 && !/["\\%{}]/.test(word) && !/^(0x|\d)/.test(word);
};

/** A question's id, the same as long as its words are. */
export const checkId = text => `q${createHash('sha1').update(tokens(text).join(' ')).digest('hex').slice(0, 10)}`;

export function shuffled(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The page's words in order, each knowing whether its sentence was marked (added). */
export function pageMap(markdown) {
  // "(added)" follows its sentence: pulled inside, so splitting keeps it with that sentence.
  const text = String(markdown ?? '').replace(/([.!?])\s*\(added\)/g, ' (added)$1');
  const words = [];
  const added = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const mark = /\(added\)/.test(sentence);
    for (const word of tokens(sentence)) {
      words.push(word);
      added.push(mark);
    }
  }
  return { words, added, text: ` ${words.join(' ')} ` };
}

/** The words a quote covers on the page, as `{ start, end }`; null when it isn't there. */
export function spanOf(quote, map) {
  const words = tokens(quote);
  if (words.length < MIN_QUOTE_WORDS) return null;
  const at = map.text.indexOf(` ${words.join(' ')} `);
  if (at < 0) return null;
  const start = map.text.slice(0, at + 1).trim().split(' ').filter(Boolean).length;
  return { start, end: start + words.length };
}

/** Where a quote sits: 'missing', 'added', or 'sourced'. */
export function quoteState(quote, map) {
  const span = spanOf(quote, map);
  if (!span) return 'missing';
  return map.added.slice(span.start, span.end).some(Boolean) ? 'added' : 'sourced';
}

/** The right option gives itself away when it's much longer than every wrong one. */
export function givesItselfAway(options) {
  const right = options.find(option => option.right);
  const wrong = options.filter(option => !option.right);
  if (!right || !wrong.length) return false;
  const longest = Math.max(...wrong.map(option => String(option.text).length));
  return String(right.text).length > 40 && String(right.text).length > longest * 1.6;
}

const pageConcepts = (list, conceptIds) => (list || []).filter(id => conceptIds.includes(id));
const reasonOf = state => (state === 'added' ? 'its quote is something you added, not from the source' : 'its quote is not on the page');

/**
 * What Claude wrote for a page, tidied: `quick` and `closing` hold what passed, `failed` says why
 * the rest didn't, so one repair can be asked for.
 */
export function tidyAids(raw, { markdown, conceptIds, headings }, random = Math.random) {
  const map = pageMap(markdown);
  const known = new Map(headings.map(heading => [tokens(heading).join(' '), heading]));
  const sectionOf = name => known.get(tokens(name).join(' ')) || null;
  const failed = [];
  const quick = [];
  for (const item of raw.quick || []) {
    const q = String(item?.q || '').trim();
    const options = (item?.options || []).map(option => ({ text: String(option?.text || '').trim(), right: Boolean(option?.right), why: String(option?.why || '').trim() })).filter(option => option.text);
    if (!q) continue;
    const state = quoteState(item.quote, map);
    let reason = null;
    if (options.length < 3 || options.length > 5) reason = 'it needs 3-4 options';
    else if (options.filter(option => option.right).length !== 1) reason = 'it needs exactly one right option';
    else if (state !== 'sourced') reason = reasonOf(state);
    else if (givesItselfAway(options)) reason = 'the right option is much longer than the others';
    if (reason) {
      failed.push({ q, reason });
      continue;
    }
    quick.push({ id: checkId(q), q, options: shuffled(options, random), quote: String(item.quote), section: sectionOf(item.section), concepts: pageConcepts(item.concepts, conceptIds), guess: Boolean(item.guess) });
  }
  const closing = [];
  for (const item of raw.closing || []) {
    const q = String(item?.q || '').trim();
    if (!q) continue;
    const state = quoteState(item.quote, map);
    if (state === 'missing') {
      failed.push({ q, reason: reasonOf(state) });
      continue;
    }
    const concepts = pageConcepts(item.concepts, conceptIds);
    if (!concepts.length) {
      failed.push({ q, reason: 'it names no concept of this page' });
      continue;
    }
    closing.push({
      id: checkId(q),
      q,
      answer: String(item.answer || ''),
      points: (item.points || []).map(point => String(point).trim()).filter(Boolean).slice(0, 5),
      quote: String(item.quote),
      section: sectionOf(item.section),
      concepts,
    });
  }
  const terms = [];
  const seen = new Set();
  for (const item of raw.terms || []) {
    const term = String(item?.term || '').trim().slice(0, 80);
    const def = String(item?.def || '').trim().slice(0, 500);
    const key = term.toLowerCase();
    if (!isTerm(term) || !def || seen.has(key)) continue;
    seen.add(key);
    terms.push({ term, aka: (item.aka || []).map(other => String(other).trim()).filter(Boolean).slice(0, 5), def, key: Boolean(item.key) });
  }
  return { terms, quick, closing, failed };
}

/** What the blind reader found. Its choice is an index into the options as they're stored. */
export function applyReader(aids, reading, conceptIds) {
  const answers = new Map((reading?.answers || []).map(answer => [answer.id, answer]));
  const open = new Map((reading?.closing || []).map(answer => [answer.id, answer]));
  const failed = [...aids.failed];
  const quick = aids.quick.filter(check => {
    const choice = answers.get(check.id)?.choice;
    const right = Number.isInteger(choice) && check.options[choice]?.right === true;
    if (!right) failed.push({ q: check.q, reason: Number.isInteger(choice) ? 'a reader of the page chose a different answer' : 'the page does not let a reader tell the answer' });
    return right;
  });
  const closing = aids.closing.filter(check => {
    const answerable = open.get(check.id)?.answerable !== false;
    if (!answerable) failed.push({ q: check.q, reason: 'it can\'t be answered fully from the page' });
    return answerable;
  });
  const tested = new Set(closing.flatMap(check => check.concepts));
  const named = new Set(aids.terms.flatMap(item => [item.term, ...item.aka].map(text => text.toLowerCase())));
  return {
    ...aids,
    quick,
    closing,
    failed,
    unknown: [...new Set((reading?.unknown || []).map(word => String(word).trim()).filter(word => isTerm(word) && !named.has(word.toLowerCase())))],
    missing: (reading?.missing || []).map(String).filter(Boolean),
    untested: conceptIds.filter(id => !tested.has(id)),
  };
}

/** Two rounds of the same page put together: what passed in either, each once. */
export function mergeAids(first, second) {
  const once = (a, b, key) => [...new Map([...a, ...b].map(item => [key(item), item])).values()];
  const terms = once(first.terms, second.terms, item => item.term.toLowerCase());
  const named = new Set(terms.flatMap(item => [item.term, ...item.aka].map(text => text.toLowerCase())));
  return {
    ...second,
    terms,
    quick: once(first.quick, second.quick, item => item.id),
    closing: once(first.closing, second.closing, item => item.id),
    unknown: second.unknown.filter(word => !named.has(word.toLowerCase())),
  };
}

/** A concept no question tests still gets one, or the lock on Learned would strand it. */
export function closingFor(concept) {
  const q = `In your own words, explain ${concept.name}, using an example from this page.`;
  return { id: checkId(q), q, answer: concept.definition || '', points: [], quote: null, section: null, concepts: [concept.id], plain: true };
}

/** A quick check as the block a window draws. */
export function checkBlock(check, ctx = {}) {
  return {
    t: 'check',
    id: check.id,
    ...(check.guess ? { guess: 1 } : {}),
    q: parseInline(check.q, ctx),
    options: check.options.map(option => ({ inlines: parseInline(option.text, ctx), why: parseInline(option.why, ctx), ...(option.right ? { right: 1 } : {}) })),
    concepts: check.concepts,
  };
}

/** Checks go at the end of the section they test; a guess before the page's first heading. */
export function placeChecks(blocks, checks) {
  const out = [...blocks];
  const isHeading = block => block.t === 'h';
  const titleOf = block => tokens(inlineText(block.inlines)).join(' ');
  const recapAt = () => {
    const found = out.findIndex(block => isHeading(block) && /^(recap|summary)\b/.test(titleOf(block)));
    return found < 0 ? out.length : found;
  };
  for (const { block, section } of checks) {
    if (block.guess) {
      const first = out.findIndex(isHeading);
      out.splice(first < 0 ? 0 : first, 0, block);
      continue;
    }
    const start = section ? out.findIndex(item => isHeading(item) && titleOf(item) === tokens(section).join(' ')) : -1;
    if (start < 0) {
      out.splice(recapAt(), 0, block);
      continue;
    }
    let end = start + 1;
    while (end < out.length && !(isHeading(out[end]) && out[end].level <= out[start].level)) end++;
    out.splice(end, 0, block);
  }
  return out;
}

/** The course's words: a page's newest definitions replace its old ones. */
export function mergeTerms(list, terms, n) {
  const others = (list || []).filter(item => item.n !== n);
  const taken = new Set(others.map(item => item.term.toLowerCase()));
  return [...others, ...terms.filter(item => !taken.has(item.term.toLowerCase())).map(({ term, aka, def }) => ({ term, aka, def, n }))];
}

export { MAX_QUICK };
