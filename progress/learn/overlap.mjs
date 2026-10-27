// What a new course holds against what the person already has. Pure: no Claude here.
//   covered   Learned (by the person's own tick), with where and when; these can be skipped
//   partly    new here, but a broader concept above it is Learned ("you have CI basics")
//   mentioned opened in another course, never marked Learned: noted, never offered as a skip
//   fresh     the rest
import { conceptById, stateOf } from './catalogue.mjs';

function learnedAncestor(catalogue, concept) {
  const seen = new Set();
  let current = concept.parent ? conceptById(catalogue, concept.parent) : null;
  while (current && !seen.has(current.id)) {
    if (current.learned) return current;
    seen.add(current.id);
    current = current.parent ? conceptById(catalogue, current.parent) : null;
  }
  return null;
}

/** `pages` are `[{ n, title, concepts: [ids] }]`; `courseId` keeps this course's own opens out. */
export function overlapReport(catalogue, pages, courseId) {
  const pagesOf = new Map();
  for (const page of pages) {
    for (const id of page.concepts || []) {
      if (!pagesOf.has(id)) pagesOf.set(id, []);
      pagesOf.get(id).push(page.n);
    }
  }
  const covered = [];
  const partly = [];
  const mentioned = [];
  const fresh = [];
  for (const [id, onPages] of pagesOf) {
    const concept = conceptById(catalogue, id);
    if (!concept) continue;
    const entry = { id, name: concept.name, pages: onPages };
    if (stateOf(concept) === 'learned') {
      covered.push({ ...entry, learned: concept.learned });
      continue;
    }
    const elsewhere = (concept.seen || []).filter(where => where.course !== courseId);
    const above = learnedAncestor(catalogue, concept);
    if (above) partly.push({ ...entry, have: { id: above.id, name: above.name } });
    else if (elsewhere.length) mentioned.push({ ...entry, seen: elsewhere });
    else fresh.push(entry);
  }
  const isCovered = id => covered.some(item => item.id === id);
  const skippablePages = pages.filter(page => (page.concepts || []).length > 0 && page.concepts.every(id => !conceptById(catalogue, id) || isCovered(id)) && page.concepts.some(isCovered)).map(page => page.n);
  return { covered, partly, mentioned, fresh, skippablePages };
}
