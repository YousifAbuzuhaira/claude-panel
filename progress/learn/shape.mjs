// A page's shape: how long it may run, from the material behind it, and which page owns each
// term, so an idea is taught once in a course and only referred to after. Pure.
import { findCategory, stateOf } from './catalogue.mjs';

// Words of a page per word of its material. A chat's brief is dense (facts, not teaching), so
// each of its words takes the most explaining; a transcript is speech, so the least.
const PER_WORD = { chat: 3.2, doc: 1.0, web: 1.0, youtube: 0.8 };
const BASE = 400;
const LEAST = 600;
const MOST = 2400;
const SELF = 0.85; // "I was in this chat": the background the author lived through goes

export const countWords = text => (String(text ?? '').match(/\S+/g) || []).length;

/** At most about this many words of prose for a page, from the words of its material. */
export function pageBudget({ kind, mainWords, supportWords = 0, audience = 'team' }) {
  const raw = BASE + (PER_WORD[kind] ?? 1) * Math.max(0, mainWords || 0) + 0.3 * Math.max(0, supportWords || 0);
  const sized = Math.min(MOST, Math.max(LEAST, raw)) * (audience === 'self' ? SELF : 1);
  return Math.round(sized / 50) * 50;
}

/** The words a reader reads as prose: code, diagrams, cites, marks and table rules left out. */
export function proseWords(markdown) {
  const kept = [];
  let fence = null;
  for (const line of String(markdown ?? '').split('\n')) {
    const bare = line.replace(/^\s*(>\s?)+/, '');
    const open = bare.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (open && bare.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}/.test(bare)) continue;
    kept.push(bare.replace(/\[!\w+\]/g, ' ').replace(/\[(?:s\d{1,2}\s+)?\d{1,2}:\d{2}(?::\d{2})?[^\]]*\]|\[sec:[^\]]*\]/g, ' ').replace(/\(added(?:[;,:][^)\n]*)?\)/g, ' ').replace(/[#|*_`]/g, ' '));
  }
  return countWords(kept.join(' '));
}

/** Over its budget by enough to be worth tightening: a quarter over, and 200 words over. */
export const isOver = (words, budget) => Boolean(budget) && words > budget * 1.25 && words > budget + 200;

/** A tightened page is kept only if the source check finds nothing more wrong or left out than before. */
export const keepTighter = (before, after) => after.dropped.length <= before.dropped.length && after.wrong.length <= before.wrong.length;

const termKey = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Each term or mechanism belongs to the first page that teaches it. Per page: what it owns, what an
 * earlier page owns (with that page's number), and what a later page owns.
 */
export function ownerMap(pages) {
  const owner = new Map();
  pages.forEach((page, at) => {
    for (const term of page.teaches || []) {
      const key = termKey(term);
      if (key && !owner.has(key)) owner.set(key, { term: String(term).trim(), at });
    }
  });
  return pages.map((_, at) => {
    const out = { mine: [], earlier: [], later: [] };
    for (const { term, at: from } of owner.values()) {
      if (from === at) out.mine.push(term);
      else (from < at ? out.earlier : out.later).push({ term, page: from + 1 });
    }
    return out;
  });
}

/** What the learner has learned in this course's category; nothing when the category is new. */
export function learnedFor(catalogue, categoryName) {
  const category = categoryName ? findCategory(catalogue, categoryName) : null;
  if (!category) return [];
  return catalogue.concepts
    .filter(concept => (concept.category === category.id || (concept.alsoUsedIn || []).includes(category.id)) && stateOf(concept) === 'learned')
    .map(concept => concept.name)
    .slice(0, 200);
}
