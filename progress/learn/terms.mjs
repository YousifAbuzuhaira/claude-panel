// Words explained where they're used. Pure. A page's words come from what was written for it,
// the rest of its course, and the catalogue's concepts, so nothing is explained once and then
// assumed. A word is marked at its first use in each section, and not at all once it's Learned.
const CLEAN = /[.*+?^${}()|[\]\\]/g;
const SHORT = 3; // names this short must match their case: "SFT", not "sft" in another word

const lower = text => String(text).toLowerCase();

/** `[{ term, names, def }]`, nearest first: the page's, its course's, then every concept's. */
export function pageGlossary(page, courseTerms, concepts) {
  const known = new Set(concepts.filter(concept => concept.learned).flatMap(concept => [concept.name, ...(concept.aliases || [])]).map(lower));
  const taken = new Set();
  const out = [];
  const add = (term, others, def) => {
    const names = [term, ...(others || [])].filter(Boolean);
    if (!def || names.some(name => known.has(lower(name)))) return;
    const free = names.filter(name => !taken.has(lower(name)));
    if (!free.length) return;
    for (const name of free) taken.add(lower(name));
    out.push({ term, names: free, def });
  };
  for (const item of page.terms || []) add(item.term, item.aka, item.def);
  for (const item of courseTerms || []) add(item.term, item.aka, item.def);
  for (const concept of concepts) if (!concept.learned) add(concept.name, concept.aliases, concept.definition);
  return out;
}

function matcher(glossary) {
  const names = glossary.flatMap((entry, index) => entry.names.map(name => ({ name, index })));
  if (!names.length) return null;
  names.sort((a, b) => b.name.length - a.name.length);
  const byName = new Map(names.map(item => [lower(item.name), item]));
  const pattern = names.map(item => item.name.replace(CLEAN, '\\$&')).join('|');
  return { byName, regex: new RegExp(`(?<![\\p{L}\\p{N}_-])(${pattern})(?:s|es)?(?![\\p{L}\\p{N}_-])`, 'giu') };
}

/** `{ blocks, used }`: `used` is the words that appear, and an inline's `term` is its place in it. */
export function markTerms(blocks, glossary) {
  const match = matcher(glossary);
  if (!match) return { blocks, used: [] };
  const used = [];
  const usedAt = new Map();
  let seen = new Set();
  const indexOf = entry => {
    if (!usedAt.has(entry)) {
      usedAt.set(entry, used.length);
      used.push({ term: glossary[entry].term, def: glossary[entry].def });
    }
    return usedAt.get(entry);
  };
  const markInline = item => {
    if (item.code || item.link || item.time || item.sec || item.added) return [item];
    const { s: text, ...style } = item;
    const out = [];
    let last = 0;
    for (const found of text.matchAll(match.regex)) {
      const name = match.byName.get(lower(found[1]));
      if (!name || seen.has(name.index)) continue;
      if (name.name.length <= SHORT && found[1] !== name.name) continue;
      seen.add(name.index);
      if (found.index > last) out.push({ ...style, s: text.slice(last, found.index) });
      out.push({ ...style, s: found[0], term: indexOf(name.index) });
      last = found.index + found[0].length;
    }
    if (!out.length) return [item];
    if (last < text.length) out.push({ ...style, s: text.slice(last) });
    return out;
  };
  const markInlines = inlines => (inlines || []).flatMap(markInline);
  const walk = list => list.map(block => {
    switch (block.t) {
      case 'h':
        seen = new Set();
        return block;
      case 'p':
      case 'quote':
        return { ...block, inlines: markInlines(block.inlines) };
      case 'ul':
      case 'ol':
        return { ...block, items: block.items.map(item => ({ ...item, inlines: markInlines(item.inlines) })) };
      case 'table':
        return { ...block, rows: block.rows.map(row => row.map(markInlines)) };
      case 'callout':
        return { ...block, blocks: walk(block.blocks || []) };
      default:
        return block;
    }
  });
  return { blocks: walk(blocks), used };
}
