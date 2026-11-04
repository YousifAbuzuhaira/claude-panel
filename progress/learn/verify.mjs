// What a fact-check may say about a page. Pure. Sources can be wrong, so a page agreeing with its
// own sources proves nothing: a flag stays only if its quote is really on the page and its evidence
// comes from somewhere else. Flags change nothing in the lesson: a box goes under the passage, and
// a question resting on that passage is held back from the page, Review and the video.
import { inlineText, markdownToBlocks } from './markdown.mjs';
import { pageMap, quoteState, spanOf, tokens } from './teach.mjs';

export const MAX_DISPUTES = 8;

/** A link's address, the same however it was written. */
const addressOf = url => {
  try {
    const { hostname, pathname, search } = new URL(String(url));
    return `${hostname.replace(/^www\./, '')}${pathname.replace(/\/+$/, '')}${search}`.toLowerCase();
  } catch {
    return null;
  }
};

const isWebLink = url => /^https?:\/\//i.test(String(url)) && addressOf(url) !== null;

/** What Claude flagged, tidied: `disputes` hold what passed, `rejected` says why the rest didn't. */
export function tidyDisputes(raw, { markdown, sourceUrls = [], checkIds = [] }) {
  const map = pageMap(markdown);
  const sources = new Set(sourceUrls.map(addressOf).filter(Boolean));
  const known = new Set(checkIds);
  const disputes = [];
  const rejected = [];
  const seen = new Set();
  for (const item of raw?.disputes || []) {
    const quote = String(item?.quote || '').trim();
    const problem = String(item?.problem || '').trim().slice(0, 600);
    const correction = String(item?.correction || '').trim().slice(0, 600);
    const evidence = String(item?.evidence || '').trim();
    const key = tokens(quote).join(' ');
    let reason = null;
    if (quoteState(quote, map) === 'missing') reason = 'its quote is not on the page';
    else if (!problem || !correction) reason = 'it needs a problem and a correction';
    else if (!isWebLink(evidence)) reason = 'it has no evidence link';
    else if (sources.has(addressOf(evidence))) reason = 'its evidence is one of the page\'s own sources';
    else if (seen.has(key)) reason = 'it repeats another flag';
    if (reason) {
      rejected.push({ quote, reason });
      continue;
    }
    seen.add(key);
    disputes.push({ quote, problem, correction, evidence, checks: (item.checks || []).map(String).filter(id => known.has(id)) });
  }
  return { disputes: disputes.slice(0, MAX_DISPUTES), rejected };
}

/** Does this quote sit on a disputed passage? */
function restsOn(quote, disputes, map) {
  const span = spanOf(quote, map);
  if (!span) return false;
  return disputes.some(dispute => {
    const other = spanOf(dispute.quote, map);
    return other && span.start < other.end && other.start < span.end;
  });
}

/** Questions a disputed passage can't be trusted to support: named by the check, or sharing its words. */
export function holdBack(aids, disputes, markdown) {
  if (!disputes.length) return { ...aids, heldBack: [] };
  const map = pageMap(markdown);
  const named = new Set(disputes.flatMap(dispute => dispute.checks));
  const isHeld = check => named.has(check.id) || restsOn(check.quote, disputes, map);
  const heldBack = [...aids.quick, ...aids.closing].filter(isHeld).map(check => check.q);
  return { ...aids, quick: aids.quick.filter(check => !isHeld(check)), closing: aids.closing.filter(check => !isHeld(check)), heldBack };
}

/** All the words a block shows, including those inside a list or a box. */
function blockWords(block) {
  if (block.t === 'callout') return block.blocks.map(blockWords).join(' ');
  if (block.items) return block.items.map(item => inlineText(item.inlines)).join(' ');
  if (block.rows) return block.rows.flat().map(inlineText).join(' ');
  return inlineText(block.inlines);
}

/** A flag as the box a window draws. */
export function disputeBlock(dispute, ctx = {}) {
  return { t: 'callout', kind: 'disputed', title: [], blocks: markdownToBlocks(`${dispute.problem} ${dispute.correction} [Evidence](${dispute.evidence})`, ctx) };
}

/** Each box goes under the block holding its quote; a quote across blocks, after the block it starts in. */
export function placeDisputes(blocks, disputes, ctx = {}) {
  const out = [...blocks];
  for (const dispute of disputes) {
    const words = tokens(dispute.quote);
    const inBlock = wanted => out.findIndex(block => block.t !== 'check' && ` ${tokens(blockWords(block)).join(' ')} `.includes(` ${wanted.join(' ')} `));
    let at = inBlock(words);
    if (at < 0) at = inBlock(words.slice(0, 5));
    // Still lost (a quote in a code block): the end of the page, so the warning is never dropped.
    out.splice(at < 0 ? out.length : at + 1, 0, disputeBlock(dispute, ctx));
  }
  return out;
}
