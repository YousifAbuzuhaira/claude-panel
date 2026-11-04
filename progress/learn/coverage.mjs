// What the learner asked for, held against what a course covers. Pure.
// `asks` are the separate things they named, in order; a source or a page says which it covers
// by their numbers (0 first), so nothing they asked for can quietly fall out.

const MAX_ASKS = 12;

export function cleanAsks(asks) {
  const seen = new Set();
  const out = [];
  for (const ask of Array.isArray(asks) ? asks : []) {
    const text = String(ask ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, MAX_ASKS);
}

/** The numbers in `list` that name a real ask, once each. */
export const askNumbers = (list, count) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter(number => Number.isInteger(number) && number >= 0 && number < count);

/** The asks nothing in `items` (sources or pages, each with `covers`) covers. */
export function uncovered(asks, items) {
  const covered = new Set(items.flatMap(item => item.covers || []));
  return asks.filter((ask, number) => !covered.has(number));
}

/** `picks` plus whatever it takes for every ask to have a source, where one exists. */
export function picksCovering(candidates, asks, picks) {
  const chosen = [...picks];
  asks.forEach((ask, number) => {
    const has = candidates.some(candidate => chosen.includes(candidate.id) && (candidate.covers || []).includes(number));
    if (has) return;
    const extra = candidates.find(candidate => (candidate.covers || []).includes(number));
    if (extra) chosen.push(extra.id);
  });
  return chosen;
}
