// The concept catalogue: one list shared by every course, with the person's categories
// as its top level. Pure functions over the catalogue object; library.mjs reads and
// writes it. A concept's state comes from what happened to it: Learned only when the
// person said so, Seen once a page teaching it was opened, otherwise New.

export const emptyCatalogue = () => ({ v: 1, categories: [], concepts: [] });

/** Names compared loosely: case, punctuation and a plural `s` don't make a new concept. */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .split(' ')
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
    .join(' ');
}

const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'concept';

function freshId(prefix, name, taken) {
  const base = `${prefix}${slug(name)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

export const stateOf = concept => (concept.learned ? 'learned' : concept.seen && concept.seen.length ? 'seen' : 'new');

export const conceptById = (catalogue, id) => catalogue.concepts.find(concept => concept.id === id) || null;

/** A concept whose name or one of whose other names matches, or null. */
export function findConcept(catalogue, name) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  return catalogue.concepts.find(concept => normalizeName(concept.name) === wanted || (concept.aliases || []).some(alias => normalizeName(alias) === wanted)) || null;
}

// --- Categories --------------------------------------------------------------------

export function findCategory(catalogue, nameOrId) {
  const wanted = normalizeName(nameOrId);
  return catalogue.categories.find(category => category.id === nameOrId || normalizeName(category.name) === wanted) || null;
}

/** The category by that name, made if it isn't there. */
export function ensureCategory(catalogue, name) {
  const clean = String(name || '').trim().slice(0, 60) || 'General';
  const found = findCategory(catalogue, clean);
  if (found) return found;
  const category = { id: freshId('', clean, new Set(catalogue.categories.map(item => item.id))), name: clean, order: catalogue.categories.length + 1 };
  catalogue.categories.push(category);
  return category;
}

export function renameCategory(catalogue, id, name) {
  const category = catalogue.categories.find(item => item.id === id);
  if (!category) throw new Error('no such category');
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('a category needs a name');
  const clash = findCategory(catalogue, clean);
  if (clash && clash.id !== id) throw new Error(`there is already a category called ${clash.name}`);
  category.name = clean;
  return category;
}

/** Removes a category; its concepts move to `moveTo`. Courses are the library's to move. */
export function removeCategory(catalogue, id, moveTo) {
  if (id === moveTo) throw new Error('pick another category to move things into');
  if (!catalogue.categories.some(item => item.id === moveTo)) throw new Error('no such category to move into');
  catalogue.categories = catalogue.categories.filter(item => item.id !== id);
  for (const concept of catalogue.concepts) {
    if (concept.category === id) concept.category = moveTo;
    concept.alsoUsedIn = (concept.alsoUsedIn || []).filter(other => other !== id && other !== concept.category);
  }
}

// --- Concepts ----------------------------------------------------------------------

export function addConcept(catalogue, { name, definition = '', parent = null, aliases = [], category, by = 'user', at = new Date().toISOString() }) {
  const clean = String(name || '').trim().slice(0, 100);
  if (!clean) throw new Error('a concept needs a name');
  const found = findConcept(catalogue, clean);
  if (found) return found;
  const concept = {
    id: freshId('c_', clean, new Set(catalogue.concepts.map(item => item.id))),
    name: clean,
    definition: String(definition || '').trim().slice(0, 300),
    parent: parent && conceptById(catalogue, parent) ? parent : null,
    aliases: [...new Set(aliases.map(alias => String(alias).trim()).filter(alias => alias && normalizeName(alias) !== normalizeName(clean)))].slice(0, 10),
    category,
    alsoUsedIn: [],
    seen: [],
    learned: null,
    by,
    createdAt: at,
  };
  catalogue.concepts.push(concept);
  return concept;
}

const addAlias = (concept, name) => {
  const clean = String(name || '').trim();
  if (!clean || normalizeName(clean) === normalizeName(concept.name)) return;
  concept.aliases = concept.aliases || [];
  if (!concept.aliases.some(alias => normalizeName(alias) === normalizeName(clean))) concept.aliases.push(clean);
};

/**
 * Folds an outline's concepts in. Each proposal is `{ id, name, definition, parent,
 * aliases, match }`; an id the catalogue has wins, then a name or alias match, then a
 * new concept. Returns the catalogue id for each proposal, in order, plus what happened.
 */
export function applyProposals(catalogue, proposals, category, at = new Date().toISOString()) {
  const ids = [];
  const report = [];
  const pendingParents = [];
  for (const proposal of proposals) {
    let concept = proposal.id ? conceptById(catalogue, proposal.id) : null;
    let how = concept ? 'existing' : null;
    if (!concept) {
      concept = findConcept(catalogue, proposal.name);
      if (concept) how = 'name';
    }
    if (concept) {
      addAlias(concept, proposal.name);
      for (const alias of proposal.aliases || []) addAlias(concept, alias);
      if (concept.category !== category && !(concept.alsoUsedIn || []).includes(category)) concept.alsoUsedIn = [...(concept.alsoUsedIn || []), category];
    } else {
      concept = addConcept(catalogue, { name: proposal.name, definition: proposal.definition, aliases: proposal.aliases || [], category, by: 'build', at });
      how = 'new';
      if (proposal.parent) pendingParents.push({ concept, parent: proposal.parent });
    }
    ids.push(concept.id);
    report.push({ id: concept.id, name: concept.name, how, reason: String(proposal.reason || '').slice(0, 200) });
  }
  // Parents may name concepts this same outline created.
  for (const { concept, parent } of pendingParents) {
    const found = conceptById(catalogue, parent) || findConcept(catalogue, parent);
    if (found && found.id !== concept.id && !isAncestor(catalogue, concept.id, found.id)) concept.parent = found.id;
  }
  return { ids, report };
}

/** Whether `ancestorId` is above `id` (guards against parent loops). */
export function isAncestor(catalogue, ancestorId, id) {
  const seen = new Set();
  let current = conceptById(catalogue, id);
  while (current && current.parent && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parent === ancestorId) return true;
    current = conceptById(catalogue, current.parent);
  }
  return false;
}

/** Notes that a page teaching these concepts was opened. */
export function markSeen(catalogue, ids, where) {
  for (const id of ids) {
    const concept = conceptById(catalogue, id);
    if (!concept) continue;
    concept.seen = concept.seen || [];
    if (!concept.seen.some(entry => entry.course === where.course && entry.page === where.page)) concept.seen.push(where);
  }
}

/** Only ever called from the person's own click. */
export function setLearned(catalogue, id, learned, where) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  concept.learned = learned ? { course: where?.course || null, page: where?.page || null, at: where?.at || new Date().toISOString() } : null;
  return concept;
}

export function renameConcept(catalogue, id, name) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  const clean = String(name || '').trim().slice(0, 100);
  if (!clean) throw new Error('a concept needs a name');
  const clash = findConcept(catalogue, clean);
  if (clash && clash.id !== id) throw new Error(`${clash.name} already has that name: merge them instead`);
  addAlias(concept, concept.name);
  concept.name = clean;
  concept.aliases = (concept.aliases || []).filter(alias => normalizeName(alias) !== normalizeName(clean));
  return concept;
}

export function setDefinition(catalogue, id, definition) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  concept.definition = String(definition || '').trim().slice(0, 300);
  return concept;
}

/** Puts a concept under another one (`null`: top level). A loop is refused. */
export function setParent(catalogue, id, parentId) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  if (!parentId) {
    concept.parent = null;
    return concept;
  }
  if (parentId === id) throw new Error('a concept cannot sit under itself');
  if (!conceptById(catalogue, parentId)) throw new Error('no such concept to put it under');
  if (isAncestor(catalogue, id, parentId)) throw new Error('that one already sits under this concept');
  concept.parent = parentId;
  return concept;
}

export function moveConcept(catalogue, id, category) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  if (!catalogue.categories.some(item => item.id === category)) throw new Error('no such category');
  concept.alsoUsedIn = (concept.alsoUsedIn || []).filter(other => other !== category);
  if (concept.category !== category) concept.alsoUsedIn.push(concept.category);
  concept.category = category;
  return concept;
}

/** Removes a concept; its children move up to its parent. Pages keep the stale id and ignore it. */
export function removeConcept(catalogue, id) {
  const concept = conceptById(catalogue, id);
  if (!concept) throw new Error('no such concept');
  for (const child of catalogue.concepts) if (child.parent === id) child.parent = concept.parent;
  catalogue.concepts = catalogue.concepts.filter(item => item.id !== id);
}

/** `drop` becomes part of `keep`: its names, where it was seen, and the earlier Learned. */
export function mergeConcepts(catalogue, keepId, dropId) {
  if (keepId === dropId) throw new Error('pick two different concepts');
  const keep = conceptById(catalogue, keepId);
  const drop = conceptById(catalogue, dropId);
  if (!keep || !drop) throw new Error('no such concept');
  addAlias(keep, drop.name);
  for (const alias of drop.aliases || []) addAlias(keep, alias);
  for (const entry of drop.seen || []) markSeen(catalogue, [keepId], entry);
  if (drop.learned && (!keep.learned || drop.learned.at < keep.learned.at)) keep.learned = drop.learned;
  if (!keep.definition) keep.definition = drop.definition;
  for (const other of [drop.category, ...(drop.alsoUsedIn || [])]) {
    if (other && other !== keep.category && !(keep.alsoUsedIn || []).includes(other)) keep.alsoUsedIn = [...(keep.alsoUsedIn || []), other];
  }
  if (keep.parent === dropId) keep.parent = drop.parent === keepId ? null : drop.parent;
  for (const child of catalogue.concepts) if (child.parent === dropId && child.id !== keepId) child.parent = keepId;
  catalogue.concepts = catalogue.concepts.filter(item => item.id !== dropId);
  return keep;
}

/** The catalogue as short lines for a prompt: `id | name | parent | aliases | category`. */
export function compactCatalogue(catalogue) {
  const categoryName = id => catalogue.categories.find(category => category.id === id)?.name || id;
  return catalogue.concepts
    .map(concept => [concept.id, concept.name, concept.parent || '-', (concept.aliases || []).join('; ') || '-', categoryName(concept.category)].join(' | '))
    .join('\n');
}
