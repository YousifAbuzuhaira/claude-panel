// The pure parts of Learn's helper: Markdown, the catalogue, the overlap, captions and
// pages, Claude's stream, settings, diagrams, documents, chats. node --test learn/tests/
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addConcept, applyProposals, emptyCatalogue, ensureCategory, findConcept, mergeConcepts, moveConcept, normalizeName,
  removeCategory, renameConcept, setDefinition, setLearned, setParent, stateOf, markSeen,
} from '../catalogue.mjs';
import { claudeArgs, readStreamLine } from '../claude.mjs';
import { readMarkers } from '../chat.mjs';
import { cleanLabel, diagramBlock, parseFlow, parseSequence, wrapLabel } from '../diagram.mjs';
import { chatTitle, condenseChat, listClaudeChats, maskSecrets, projectSlug } from '../chats.mjs';
import { cutLongSections, docxToSections, documentType, pageIsJunk, pagesForClaude, pdfSections, readZip, uniqueHeadings } from '../documents.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { askNumbers, cleanAsks, picksCovering, uncovered } from '../coverage.mjs';
import { markdownToBlocks, parseInline } from '../markdown.mjs';
import { DAILY_CAP, LADDER, answerInReview, answerOnPage, dropCourse, dueToday, emptyReview, flagItem, itemKey, nextDue, parseKey, recallDays, swapConcept } from '../review.mjs';
import { markTerms, pageGlossary } from '../terms.mjs';
import { applyReader, checkBlock, checkId, closingFor, givesItselfAway, isTerm, mergeAids, mergeTerms, pageMap, placeChecks, quoteState, shuffled, spanOf, tidyAids } from '../teach.mjs';
import { MAX_DISPUTES, disputeBlock, holdBack, placeDisputes, tidyDisputes } from '../verify.mjs';
import { overlapReport } from '../overlap.mjs';
import { normalizeSettings, toWslPath } from '../settings.mjs';
import { chunkLines, condenseTranscript, formatTime, htmlToSections, isPlaylist, parseJson3, parseTime, textToSections, transcriptText, youTubeId } from '../sources.mjs';

describe('what you asked for', () => {
  test('a build line keeps a long request whole', () => {
    const topic = 'everything you named '.repeat(20).trim();
    assert.equal(readMarkers(`[[build: ${topic} | AI]]`).builds[0].topic, topic);
  });
  test('asks are trimmed, once each, and only real numbers count', () => {
    assert.deepEqual(cleanAsks(['  Docker ', 'docker', '', null, 'Kubernetes\n basics']), ['Docker', 'Kubernetes basics']);
    assert.deepEqual(cleanAsks('nope'), []);
    assert.deepEqual(askNumbers([0, '1', 1, 7, -1, 'x'], 3), [0, 1]);
  });
  test('an ask with no source or page is named', () => {
    assert.deepEqual(uncovered(['a', 'b', 'c'], [{ covers: [0] }, { covers: [2] }, {}]), ['b']);
    assert.deepEqual(uncovered([], [{ covers: [] }]), []);
  });
  test('picks grow until every ask has a source, when one exists', () => {
    const candidates = [{ id: 's1', covers: [0] }, { id: 's2', covers: [1] }, { id: 's3', covers: [1, 2] }];
    assert.deepEqual(picksCovering(candidates, ['a', 'b', 'c'], ['s1']), ['s1', 's2', 's3']);
    assert.deepEqual(picksCovering(candidates, ['a', 'b', 'c', 'nothing has this'], ['s1', 's3']), ['s1', 's3']);
  });
});

describe('words explained where they are used', () => {
  const glossary = [
    { term: 'logit', names: ['logit', 'raw score'], def: 'A score before softmax.' },
    { term: 'SFT', names: ['SFT'], def: 'Supervised fine-tuning.' },
  ];
  test('a word is marked at its first use in each section, plural included', () => {
    const { blocks, used } = markTerms(markdownToBlocks('## One\nLogits and more logits.\n\n## Two\nA raw score.'), glossary);
    const marked = blocks.flatMap(block => block.inlines || []).filter(item => item.term !== undefined);
    assert.deepEqual(marked.map(item => item.s), ['Logits', 'raw score']);
    assert.deepEqual(used.map(item => item.term), ['logit']);
  });
  test('code, links, headings and whole other words are left alone; short names keep their case', () => {
    const { blocks } = markTerms(markdownToBlocks('## logit\n\`logit\` and [logit](https://x.y) and catalogit, sft and SFT.'), glossary);
    const marked = blocks.flatMap(block => block.inlines || []).filter(item => item.term !== undefined);
    assert.deepEqual(marked.map(item => item.s), ['SFT']);
  });
  test('callouts, lists and tables are marked; check blocks are not touched', () => {
    const page = markdownToBlocks('> [!key] Title\n> A logit here.\n\n- SFT here');
    const { blocks } = markTerms([...page, { t: 'check', id: 'q1' }], glossary);
    assert.ok(blocks[0].blocks[0].inlines.some(item => item.term !== undefined));
    assert.ok(blocks[1].items[0].inlines.some(item => item.term !== undefined));
    assert.deepEqual(blocks[2], { t: 'check', id: 'q1' });
  });
  test('the page wins, then the course, then concepts; what you have learned is not explained', () => {
    const page = { terms: [{ term: 'Token', aka: [], def: 'page' }] };
    const concepts = [{ name: 'Token', aliases: [], definition: 'concept' }, { name: 'Softmax', aliases: [], definition: 'c', learned: { at: 'x' } }, { name: 'Attention', aliases: ['self-attention'], definition: 'c' }];
    const list = pageGlossary(page, [{ term: 'token', aka: [], def: 'course' }, { term: 'Softmax', aka: [], def: 'course' }, { term: 'Beam', aka: [], def: 'course' }], concepts);
    assert.deepEqual(list.map(item => [item.term, item.def]), [['Token', 'page'], ['Beam', 'course'], ['Attention', 'c']]);
  });
  test('nothing to mark leaves the blocks as they are', () => {
    const blocks = markdownToBlocks('Text.');
    assert.equal(markTerms(blocks, []).blocks, blocks);
  });
});

describe('review', () => {
  const day = 86_400_000;
  const start = new Date(2026, 10, 4, 10).getTime();
  const key = itemKey('course', 3, 'q1');
  test('keys come apart again', () => {
    assert.deepEqual(parseKey(key), { courseId: 'course', n: 3, id: 'q1' });
  });
  test('right answers climb the ladder; a wrong one comes back tomorrow', () => {
    const state = emptyReview();
    let at = start;
    answerOnPage(state, key, { right: true, choice: 1, concepts: ['c_a'] }, at);
    for (const gap of LADDER.slice(0, -1)) {
      assert.equal(state.items[key].due, at + gap * day);
      at += gap * day;
      assert.deepEqual(dueToday(state, at).due, [key]);
      answerInReview(state, key, true, at);
    }
    assert.equal(state.items[key].due, at + 60 * day);
    answerInReview(state, key, false, at);
    assert.equal(state.items[key].due, at + day);
    assert.equal(state.items[key].box, 0);
  });
  test('only the first answer on a page counts; a guess never comes back', () => {
    const state = emptyReview();
    answerOnPage(state, key, { right: false, choice: 0 }, start);
    answerOnPage(state, key, { right: true, choice: 2 }, start);
    assert.equal(state.items[key].choice, 0);
    answerOnPage(state, 'c/1/q2', { right: true, choice: 0, guess: true }, start);
    assert.deepEqual(dueToday(state, start + day).due, [key]);
  });
  test('the day has a cap; what is over it waits, and nothing is shown as a debt', () => {
    const state = emptyReview();
    for (let i = 0; i < DAILY_CAP + 3; i++) answerOnPage(state, `c/1/q${i}`, { right: true, choice: 0 }, start + i);
    const later = start + day;
    const first = dueToday(state, later);
    assert.equal(first.due.length, DAILY_CAP);
    assert.equal(first.waiting, 3);
    assert.equal(first.due[0], 'c/1/q0', 'oldest first');
    for (const item of first.due) answerInReview(state, item, true, later);
    assert.deepEqual(dueToday(state, later).due, []);
    assert.equal(dueToday(state, later + day).due.length, 3);
  });
  test('a question marked wrong is gone', () => {
    const state = emptyReview();
    answerOnPage(state, key, { right: true, choice: 0 }, start);
    flagItem(state, key);
    assert.deepEqual(dueToday(state, start + day).due, []);
    assert.equal(nextDue(state, start), null);
  });
  test('recall is the longest gap a right answer crossed', () => {
    const state = emptyReview();
    answerOnPage(state, key, { right: true, choice: 0, concepts: ['c_a'] }, start);
    assert.deepEqual(recallDays(state), {});
    answerInReview(state, key, true, start + 7 * day);
    assert.deepEqual(recallDays(state), { c_a: 7 });
    swapConcept(state, 'c_a', 'c_b');
    assert.deepEqual(recallDays(state), { c_b: 7 });
    dropCourse(state, 'course');
    assert.deepEqual(state.items, {});
  });
});

describe('questions must come from the page', () => {
  const markdown = '## Why it loops\nGreedy always takes the top token [sec: Greedy]. So a repeated phrase feeds itself and never stops. (added) It also misses better paths.\n\n## Recap\nDone.';
  const options = [{ text: 'It takes the top token', right: true, why: 'Yes.' }, { text: 'It samples', right: false, why: 'No.' }, { text: 'It trains', right: false, why: 'No.' }];
  const context = { markdown, conceptIds: ['c_a', 'c_b'], headings: ['Why it loops', 'Recap'] };

  test('a quote is found through punctuation and cites; a marked sentence counts as added', () => {
    const map = pageMap(markdown);
    assert.equal(quoteState('Greedy always takes the top token', map), 'sourced');
    assert.equal(quoteState('greedy ALWAYS takes, the top token.', map), 'sourced');
    assert.equal(quoteState('So a repeated phrase feeds itself', map), 'added');
    assert.equal(quoteState('a phrase the page never says at all', map), 'missing');
    assert.equal(quoteState('too short', map), 'missing');
  });
  test('a term is a word or a phrase, not a mark, a command or a value', () => {
    for (const word of ['logit', 'top-p', 'SFT', '+noall +answer', 'Host header']) assert.equal(isTerm(word), true, word);
    for (const word of ['[1:05]', '(added)', '[sec: Intro]', '-s -o /dev/null -w "%{http_code}\\n"', '0x7ffd5c3a1e40 + 24', '', 'x'.repeat(41)]) assert.equal(isTerm(word), false, word);
  });
  test('a much longer right option gives itself away', () => {
    assert.equal(givesItselfAway([{ text: 'a'.repeat(90), right: true }, { text: 'b'.repeat(30) }, { text: 'c'.repeat(32) }]), true);
    assert.equal(givesItselfAway(options), false);
  });
  test('tidying keeps what passes and says why the rest failed', () => {
    const aids = tidyAids({
      terms: [{ term: 'Greedy', aka: [], def: 'Takes the top.', key: true }, { term: 'greedy', aka: [], def: 'Again.' }, { term: '', def: 'x' }],
      quick: [
        { q: 'Good?', options, quote: 'Greedy always takes the top token', section: 'why it loops', concepts: ['c_a', 'c_x'] },
        { q: 'Added?', options, quote: 'So a repeated phrase feeds itself', section: 'Why it loops', concepts: [] },
        { q: 'Two options?', options: options.slice(0, 2), quote: 'Greedy always takes the top token' },
        { q: 'Two right?', options: options.map(option => ({ ...option, right: true })), quote: 'Greedy always takes the top token' },
      ],
      closing: [
        { q: 'Explain.', points: ['p'], answer: 'a', quote: 'Greedy always takes the top token', section: 'Nope', concepts: ['c_a'] },
        { q: 'Which concept?', points: [], answer: 'a', quote: 'Greedy always takes the top token', concepts: ['c_x'] },
      ],
    }, context);
    assert.deepEqual(aids.terms.map(item => item.term), ['Greedy']);
    assert.equal(aids.quick.length, 1);
    assert.equal(aids.quick[0].section, 'Why it loops', 'the heading as the page writes it');
    assert.deepEqual(aids.quick[0].concepts, ['c_a']);
    assert.equal(aids.closing[0].section, null);
    assert.deepEqual(aids.failed.map(item => item.q), ['Added?', 'Two options?', 'Two right?', 'Which concept?']);
  });
  test('the blind reader must reach the same answer', () => {
    const aids = tidyAids({
      terms: [{ term: 'Greedy', aka: ['greedy search'], def: 'd' }],
      quick: [
        { q: 'One?', options, quote: 'Greedy always takes the top token', concepts: [] },
        { q: 'Two?', options, quote: 'Greedy always takes the top token', concepts: [] },
        { q: 'Three?', options, quote: 'Greedy always takes the top token', concepts: [] },
      ],
      closing: [{ q: 'Open?', points: [], answer: 'a', quote: 'Greedy always takes the top token', concepts: ['c_a'] }],
    }, context, () => 0.5);
    const right = check => check.options.findIndex(option => option.right);
    const wrong = check => check.options.findIndex(option => !option.right);
    const [one, two, three] = aids.quick;
    const judged = applyReader(aids, {
      answers: [{ id: one.id, choice: right(one) }, { id: two.id, choice: wrong(two) }, { id: three.id, choice: null }],
      closing: [{ id: aids.closing[0].id, answerable: false }],
      unknown: ['logits', 'Greedy Search'],
      missing: ['beam search'],
    }, context.conceptIds);
    assert.deepEqual(judged.quick.map(check => check.q), ['One?']);
    assert.equal(judged.closing.length, 0);
    assert.equal(judged.failed.length, 3);
    assert.deepEqual(judged.unknown, ['logits'], 'a word the glossary explains is not unknown');
    assert.deepEqual(judged.missing, ['beam search']);
    assert.deepEqual(judged.untested, ['c_a', 'c_b']);
  });
  test('two rounds keep what passed in either, once each', () => {
    const first = { terms: [{ term: 'a', aka: [] }], quick: [{ id: 'q1' }], closing: [], unknown: [] };
    const second = { terms: [{ term: 'b', aka: [] }], quick: [{ id: 'q1' }, { id: 'q2' }], closing: [{ id: 'q3' }], unknown: ['a', 'c'] };
    const merged = mergeAids(first, second);
    assert.deepEqual(merged.quick.map(item => item.id), ['q1', 'q2']);
    assert.equal(merged.terms.length, 2);
    assert.deepEqual(merged.unknown, ['c']);
  });
  test('a concept no question tests gets a plain one, so the lock never strands it', () => {
    const check = closingFor({ id: 'c_a', name: 'Top-p', definition: 'd' });
    assert.ok(check.q.includes('Top-p'));
    assert.deepEqual(check.concepts, ['c_a']);
    assert.equal(check.plain, true);
  });
  test('checks sit at the end of their section; a guess before the first heading; no section before the recap', () => {
    const blocks = markdownToBlocks('Intro.\n\n## One\nA.\n\n### Deeper\nB.\n\n## Two\nC.\n\n## Recap\nD.');
    const check = (id, extra = {}) => ({ t: 'check', id, ...extra });
    const placed = placeChecks(blocks, [
      { block: check('in-one'), section: 'One' },
      { block: check('nowhere'), section: null },
      { block: check('guess', { guess: 1 }), section: null },
    ]);
    assert.deepEqual(placed.map(block => block.id || block.t), ['p', 'guess', 'h', 'p', 'h', 'p', 'in-one', 'h', 'p', 'nowhere', 'h', 'p']);
  });
  test('a check block keeps its order, marks and inlines', () => {
    const block = checkBlock({ id: 'q1', q: 'Which \`flag\`?', options: [{ text: 'a', right: false, why: 'no' }, { text: 'b', right: true, why: 'yes' }, { text: 'c', right: false, why: 'no' }], concepts: ['c_a'] });
    assert.equal(block.t, 'check');
    assert.ok(block.q.some(item => item.code));
    assert.deepEqual(block.options.map(option => Boolean(option.right)), [false, true, false]);
  });
  test('ids follow the words; shuffling keeps every item', () => {
    assert.equal(checkId('Why  does it loop?'), checkId('why does it loop'));
    assert.deepEqual(shuffled([1, 2, 3], () => 0).sort(), [1, 2, 3]);
  });
  test('a course keeps one definition of a word, and a rewritten page replaces its own', () => {
    let list = mergeTerms([], [{ term: 'Token', aka: [], def: 'one' }], 1);
    list = mergeTerms(list, [{ term: 'token', aka: [], def: 'two' }, { term: 'Logit', aka: [], def: 'l' }], 2);
    assert.deepEqual(list.map(item => item.def), ['one', 'l']);
    list = mergeTerms(list, [{ term: 'Token', aka: [], def: 'three' }], 1);
    assert.deepEqual(list.map(item => item.def).sort(), ['l', 'three']);
  });
});

describe('markdown', () => {
  test('a callout holds blocks, keeps its kind and title; a plain quote stays a quote', () => {
    const blocks = markdownToBlocks('> [!example] Two beams\n> Step one.\n>\n> \`\`\`bash\n> ls\n> \`\`\`\n\n> just a quote');
    assert.equal(blocks[0].t, 'callout');
    assert.equal(blocks[0].kind, 'example');
    assert.equal(blocks[0].title[0].s, 'Two beams');
    assert.deepEqual(blocks[0].blocks.map(block => block.t), ['p', 'code']);
    assert.equal(blocks[1].t, 'quote');
  });
  test('headings, paragraphs, fenced code with its language, quotes, rules, tables', () => {
    const blocks = markdownToBlocks('## Why\nText **bold** and `code`.\n\n```bash\ndocker ps\n```\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.deepEqual(blocks.map(block => block.t), ['h', 'p', 'code', 'quote', 'hr', 'table']);
    assert.equal(blocks[0].level, 2);
    assert.deepEqual(blocks[2], { t: 'code', lang: 'bash', text: 'docker ps' });
    assert.equal(blocks[5].rows.length, 2);
  });

  test('a timestamp links into the video at that second; a named one into that video', () => {
    const inlines = parseInline('at [12:34] and [s4 1:05]', { videoId: 'MAIN', videos: { s4: 'FOUR' } });
    const links = inlines.filter(item => item.time).map(item => item.link);
    assert.deepEqual(links, ['https://www.youtube.com/watch?v=MAIN&t=754s', 'https://www.youtube.com/watch?v=FOUR&t=65s']);
  });

  test('a section cite links to the page; (added) is marked; bare urls link', () => {
    const inlines = parseInline('see [sec: Syntax] (added) https://kubernetes.io/docs.', { sectionLinks: { Syntax: 'https://d/x#syntax' } });
    assert.ok(inlines.some(item => item.sec && item.link === 'https://d/x#syntax'));
    assert.ok(inlines.some(item => item.added));
    assert.ok(inlines.some(item => item.link === 'https://kubernetes.io/docs'));
  });

  test('nested bullets stay inside a numbered list, across blank lines, numbering kept', () => {
    const [list, after] = markdownToBlocks('1. One\n   - why\n\n2. Two\n\n- x');
    assert.equal(list.t, 'ol');
    assert.deepEqual(list.items.map(item => [item.depth, item.ordered]), [[0, true], [1, false], [0, true]]);
    assert.equal(after.t, 'ul');
  });
});

describe('catalogue', () => {
  const fresh = () => {
    const catalogue = emptyCatalogue();
    const devops = ensureCategory(catalogue, 'DevOps');
    return { catalogue, devops };
  };

  test('names match loosely: case, punctuation and a plural do not make a new concept', () => {
    const { catalogue, devops } = fresh();
    addConcept(catalogue, { name: 'Docker volumes', category: devops.id });
    assert.equal(normalizeName('Docker-Volume'), normalizeName('docker volumes'));
    assert.ok(findConcept(catalogue, 'docker volume'));
    assert.equal(addConcept(catalogue, { name: 'DOCKER VOLUMES', category: devops.id }), findConcept(catalogue, 'Docker volumes'));
    assert.equal(catalogue.concepts.length, 1);
  });

  test('ids are stable and never collide', () => {
    const { catalogue, devops } = fresh();
    const one = addConcept(catalogue, { name: 'CI basics', category: devops.id });
    catalogue.concepts.push({ ...one, id: 'c_ci_basics_x', name: 'Other' });
    const two = addConcept(catalogue, { name: 'CI: basics!', category: devops.id, aliases: [] });
    assert.equal(two, one);
    const three = addConcept(catalogue, { name: 'ci basics two', category: devops.id });
    assert.notEqual(three.id, one.id);
  });

  test('an outline reuses an id, then a name, then makes a concept; parents may name a new one', () => {
    const { catalogue, devops } = fresh();
    const volumes = addConcept(catalogue, { name: 'Docker volumes', category: devops.id });
    const { ids, report } = applyProposals(catalogue, [
      { id: volumes.id, name: 'Named volumes' },
      { id: null, name: 'docker volumes' },
      { id: null, name: 'Compose', definition: 'd' },
      { id: null, name: 'Compose watch', parent: 'Compose' },
    ], devops.id);
    assert.equal(ids[0], volumes.id);
    assert.equal(ids[1], volumes.id);
    assert.deepEqual(report.map(item => item.how), ['existing', 'name', 'new', 'new']);
    assert.ok(volumes.aliases.includes('Named volumes'));
    assert.equal(catalogue.concepts.find(concept => concept.id === ids[3]).parent, ids[2]);
  });

  test('Learned only comes from setLearned; opening a page only makes it Seen', () => {
    const { catalogue, devops } = fresh();
    const concept = addConcept(catalogue, { name: 'Rollbacks', category: devops.id });
    markSeen(catalogue, [concept.id], { course: 'c1', page: 2, at: 't' });
    markSeen(catalogue, [concept.id], { course: 'c1', page: 2, at: 't2' });
    assert.equal(stateOf(concept), 'seen');
    assert.equal(concept.seen.length, 1);
    setLearned(catalogue, concept.id, true, { course: 'c1', page: 2, at: 't3' });
    assert.equal(stateOf(concept), 'learned');
    setLearned(catalogue, concept.id, false);
    assert.equal(stateOf(concept), 'seen');
  });

  test('a merge keeps both names, the earlier Learned, and re-parents children', () => {
    const { catalogue, devops } = fresh();
    const keep = addConcept(catalogue, { name: 'Continuous integration', category: devops.id });
    const drop = addConcept(catalogue, { name: 'CI basics', category: devops.id });
    const child = addConcept(catalogue, { name: 'CI caching', parent: drop.id, category: devops.id });
    setLearned(catalogue, drop.id, true, { course: 'c', page: 1, at: '2026-01-01' });
    mergeConcepts(catalogue, keep.id, drop.id);
    assert.ok(keep.aliases.includes('CI basics'));
    assert.equal(keep.learned.at, '2026-01-01');
    assert.equal(child.parent, keep.id);
    assert.equal(catalogue.concepts.length, 2);
  });

  test('rename refuses a clash; move and category removal carry concepts along', () => {
    const { catalogue, devops } = fresh();
    const backend = ensureCategory(catalogue, 'Backend');
    const a = addConcept(catalogue, { name: 'Indexes', category: devops.id });
    addConcept(catalogue, { name: 'Locks', category: devops.id });
    assert.throws(() => renameConcept(catalogue, a.id, 'locks'));
    moveConcept(catalogue, a.id, backend.id);
    assert.equal(a.category, backend.id);
    removeCategory(catalogue, devops.id, backend.id);
    assert.ok(catalogue.concepts.every(concept => concept.category === backend.id));
  });
});

describe('editing concepts', () => {
  test('a nest under itself, or under its own child, is refused; top level clears the parent', () => {
    const catalogue = emptyCatalogue();
    const cat = ensureCategory(catalogue, 'DevOps').id;
    const volumes = addConcept(catalogue, { name: 'Docker volumes', category: cat });
    const drivers = addConcept(catalogue, { name: 'Volume drivers', parent: volumes.id, category: cat });
    const nfs = addConcept(catalogue, { name: 'NFS volumes', parent: drivers.id, category: cat });
    assert.throws(() => setParent(catalogue, volumes.id, volumes.id), /under itself/);
    assert.throws(() => setParent(catalogue, volumes.id, nfs.id), /already sits under/);
    assert.throws(() => setParent(catalogue, volumes.id, 'c_nothing'), /no such concept/);
    setParent(catalogue, nfs.id, volumes.id);
    assert.equal(nfs.parent, volumes.id);
    setParent(catalogue, nfs.id, null);
    assert.equal(nfs.parent, null);
  });

  test('a definition is trimmed and capped', () => {
    const catalogue = emptyCatalogue();
    const concept = addConcept(catalogue, { name: 'Indexes', category: ensureCategory(catalogue, 'Databases').id });
    setDefinition(catalogue, concept.id, `  ${'x'.repeat(400)}  `);
    assert.equal(concept.definition.length, 300);
  });
});

describe('overlap', () => {
  test('Learned is covered with where; a Learned parent makes it partly; Seen elsewhere is only mentioned', () => {
    const catalogue = emptyCatalogue();
    const cat = ensureCategory(catalogue, 'DevOps').id;
    const ci = addConcept(catalogue, { name: 'CI basics', category: cat });
    const blueGreen = addConcept(catalogue, { name: 'Blue-green deployments', parent: ci.id, category: cat });
    const canary = addConcept(catalogue, { name: 'Canary releases', category: cat });
    const fresh = addConcept(catalogue, { name: 'Feature flags', category: cat });
    setLearned(catalogue, ci.id, true, { course: 'old', page: 3, at: 't' });
    markSeen(catalogue, [canary.id], { course: 'old', page: 5, at: 't' });
    markSeen(catalogue, [fresh.id], { course: 'new', page: 4, at: 't' });
    const report = overlapReport(catalogue, [
      { n: 1, concepts: [ci.id] },
      { n: 2, concepts: [blueGreen.id, canary.id] },
      { n: 3, concepts: [fresh.id] },
    ], 'new');
    assert.deepEqual(report.covered.map(item => item.id), [ci.id]);
    assert.equal(report.covered[0].learned.course, 'old');
    assert.deepEqual(report.partly.map(item => [item.id, item.have.id]), [[blueGreen.id, ci.id]]);
    assert.deepEqual(report.mentioned.map(item => item.id), [canary.id]);
    assert.deepEqual(report.fresh.map(item => item.id), [fresh.id]);
    assert.deepEqual(report.skippablePages, [1]);
  });
});

describe('sources', () => {
  test('json3 captions: lines with times, auto-caption repeats folded, music dropped', () => {
    const lines = parseJson3({ events: [
      { tStartMs: 1000, segs: [{ utf8: 'so in this' }] },
      { tStartMs: 1500, segs: [{ utf8: 'so in this video' }] },
      { tStartMs: 3000, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 4000, segs: [{ utf8: 'we learn\nvolumes' }] },
      { tStartMs: 5000 },
    ] });
    assert.deepEqual(lines, [{ t: 1, text: 'so in this video' }, { t: 4, text: 'we learn volumes' }]);
  });

  test('chunks, slices and a condensed sample that fits', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ t: i * 10, text: `line ${i}` }));
    const chunks = chunkLines(lines, 30);
    assert.equal(chunks[0].t, 0);
    assert.ok(chunks[1].t >= 30);
    const slice = transcriptText(chunks, 600, 900);
    assert.ok(slice.startsWith('[10:00]'));
    assert.ok(!slice.includes('[15:00]'));
    assert.ok(condenseTranscript(chunks, 500).length <= 500);
  });

  test('times and YouTube links', () => {
    assert.equal(formatTime(3723), '1:02:03');
    assert.equal(formatTime(65), '1:05');
    assert.equal(parseTime('1:02:03'), 3723);
    assert.ok(Number.isNaN(parseTime('soon')));
    assert.equal(youTubeId('https://youtu.be/p2PH_YPCsis?t=3'), 'p2PH_YPCsis');
    assert.equal(isPlaylist('https://www.youtube.com/playlist?list=PL123'), true);
    assert.equal(isPlaylist('https://www.youtube.com/watch?v=p2PH_YPCsis&list=PL123'), false);
  });

  test('a page becomes sections with anchors; code keeps its fence; chrome is dropped', () => {
    const page = htmlToSections('<html><title>Vols</title><nav>menu</nav><main><h1>Volumes</h1><p>Intro &amp; more</p><h2 id="syntax">Syntax</h2><pre><code>docker run -v a:/b</code></pre></main></html>');
    assert.equal(page.title, 'Vols');
    const syntax = page.sections.find(section => section.heading === 'Syntax');
    assert.equal(syntax.anchor, 'syntax');
    assert.ok(syntax.text.includes('```\ndocker run -v a:/b\n```'));
    assert.ok(!JSON.stringify(page).includes('menu'));
  });
});

describe('claude', () => {
  test('the flags keep a clean room: tools named twice, prompt not swallowed, resume over system prompt', () => {
    const args = claudeArgs({ model: 'sonnet', tools: ['WebSearch', 'WebFetch'], schema: { type: 'object' } });
    assert.ok(args.includes('--safe-mode') && args.includes('--restricted') && args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
    assert.ok(args.includes('--no-session-persistence'));
    const none = claudeArgs({ model: 'sonnet', tools: [] });
    assert.equal(none[none.indexOf('--tools') + 1], '');
    assert.ok(!none.includes('--allowedTools'));
    const resumed = claudeArgs({ model: 'sonnet', resume: 'abc', systemFile: '/x.md', persist: true });
    assert.ok(resumed.includes('--resume') && !resumed.includes('--append-system-prompt-file'));
  });

  test('stream lines: text deltas, the session, tool uses, the result, and junk ignored', () => {
    assert.deepEqual(readStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}'), { delta: 'hi' });
    assert.deepEqual(readStreamLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}'), { sessionId: 's1', model: 'm' });
    assert.deepEqual(readStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch","input":{"query":"q"}}]}}').tools[0].name, 'WebSearch');
    const done = readStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"a":1},"session_id":"s1"}');
    assert.deepEqual(done.result.structured, { a: 1 });
    assert.equal(readStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true}').result.isError, true);
    assert.equal(readStreamLine('not json'), null);
  });

  test('a reply\'s [[...]] lines come out as buttons, only for the page\'s concepts', () => {
    const read = readMarkers('Right.\n[[mark-learned: c_a, c_zzz]]\n[[build: Swarm networking | DevOps]]', ['c_a']);
    assert.equal(read.text, 'Right.');
    assert.deepEqual(read.offers, ['c_a']);
    assert.deepEqual(read.builds, [{ topic: 'Swarm networking', category: 'DevOps' }]);
  });
});

describe('settings', () => {
  test('Windows and UNC paths become WSL paths; bad values fall back', () => {
    assert.equal(toWslPath('C:\\Users\\me\\OneDrive\\Learn\\'), '/mnt/c/Users/me/OneDrive/Learn');
    assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\learn'), '/home/me/learn');
    const settings = normalizeSettings({ library: 'relative/path', models: { build: 'gpt-9', chat: 'opus' }, workFolders: ['/a', '/a', 'rel', 7] });
    assert.ok(settings.library.startsWith('/'));
    assert.equal(settings.models.build, 'sonnet');
    assert.equal(settings.models.chat, 'opus');
    assert.deepEqual(settings.workFolders, ['/a']);
  });
});

describe('diagrams', () => {
  const overlaps = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

  test('flowchart: shapes, labels, chains and & groups', () => {
    const flow = parseFlow('flowchart LR\n  A[Browser] -->|HTTPS| B(API)\n  B --> C{Cached?} -- yes --> D[(Postgres)]\n  B & C -.-> E([Queue]):::hot\n  %% a comment\n  classDef hot fill:#f00');
    assert.equal(flow.dir, 'LR');
    assert.deepEqual([...flow.nodes.values()].map(node => [node.id, node.shape, node.label]), [
      ['A', 'rect', 'Browser'], ['B', 'round', 'API'], ['C', 'decision', 'Cached?'], ['D', 'db', 'Postgres'], ['E', 'stadium', 'Queue'],
    ]);
    assert.deepEqual(flow.edges.map(edge => `${edge.from}>${edge.to}:${edge.label}:${edge.dash}`), ['A>B:HTTPS:0', 'B>C::0', 'C>D:yes:0', 'B>E::1', 'C>E::1']);
  });

  test('flowchart: graph, semicolons, thick and open edges, a node named before it is shaped', () => {
    const flow = parseFlow('graph TD; a --> b; b ==> c; c --- a; b[Shaped later]');
    assert.equal(flow.dir, 'TD');
    assert.equal(flow.nodes.get('b').label, 'Shaped later');
    assert.deepEqual(flow.edges.map(edge => [edge.thick, edge.head]), [[0, 1], [1, 1], [0, 0]]);
  });

  test('a laid-out flowchart has no overlapping boxes and sits inside its size, cycles included', () => {
    const block = diagramBlock('flowchart TD\nA[Start] --> B[Load] --> C{OK?}\nC -- no --> B\nC -- yes --> D[Done]\nA --> D\nB --> E[Log] --> D');
    assert.equal(block.t, 'diagram');
    assert.equal(block.kind, 'flow');
    assert.equal(block.nodes.length, 5);
    for (let i = 0; i < block.nodes.length; i++) for (let j = i + 1; j < block.nodes.length; j++) assert.ok(!overlaps(block.nodes[i], block.nodes[j]), `${block.nodes[i].lines} / ${block.nodes[j].lines}`);
    for (const node of block.nodes) assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= block.w && node.y + node.h <= block.h);
    for (const edge of block.edges) assert.ok(edge.pts.length >= 2);
    // The back edge (no) still points at B: its last point touches B's box.
    const b = block.nodes[1];
    const back = block.edges.find(edge => edge.label && edge.label.lines[0] === 'no');
    const [x, y] = back.pts.at(-1);
    assert.ok(x >= b.x - 1 && x <= b.x + b.w + 1 && y >= b.y - 1 && y <= b.y + b.h + 1);
  });

  test('top-down ranks run downwards, left-right ranks run across, bottom-up is mirrored', () => {
    const down = diagramBlock('flowchart TD\nA --> B');
    assert.ok(down.nodes[1].y > down.nodes[0].y);
    const across = diagramBlock('flowchart LR\nA --> B');
    assert.ok(across.nodes[1].x > across.nodes[0].x);
    const up = diagramBlock('flowchart BT\nA --> B');
    assert.ok(up.nodes[1].y < up.nodes[0].y);
  });

  test('sequence: participants, replies, self messages, notes and frames', () => {
    const sequence = parseSequence('sequenceDiagram\nautonumber\nparticipant P as Panel\nP->>W: run\nW-->>P: link\nloop until done\nP->>P: poll\nend\nNote over P,W: on Windows\nalt good\nP-xW: open\nelse bad\nP->>P: log\nend');
    assert.deepEqual([...sequence.parts.values()].map(part => part.label), ['Panel', 'W']);
    assert.deepEqual(sequence.events.map(event => event.t), ['msg', 'msg', 'open', 'msg', 'close', 'note', 'open', 'msg', 'split', 'msg', 'close']);
    assert.equal(sequence.events[0].text, '1. run');
    assert.equal(sequence.events[1].dash, 1);
    assert.equal(sequence.events[7].head, 2);
    const block = diagramBlock('sequenceDiagram\nparticipant P as Panel\nP->>W: run\nloop until it answers\nP->>P: poll the exit\nend');
    assert.equal(block.kind, 'sequence');
    assert.equal(block.frames.length, 1);
    // The frame holds its label and the self message's text.
    const frame = block.frames[0];
    const self = block.edges.find(edge => edge.label && edge.label.lines[0] === 'poll the exit');
    assert.ok(frame.x + frame.w >= self.label.x);
    assert.equal(block.edges.filter(edge => edge.life).length, 2);
  });

  test('what it cannot read stays code', () => {
    assert.equal(diagramBlock('pie title Pets\n "Dogs" : 386'), null);
    assert.equal(diagramBlock('flowchart TD\nA'), null); // one box is not a diagram
    const blocks = markdownToBlocks('```mermaid\ngantt\n```\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```js\nflowchart\n```');
    assert.deepEqual(blocks.map(block => block.t), ['code', 'diagram', 'code']);
    assert.equal(blocks[0].lang, 'mermaid');
    assert.match(blocks[1].source, /A-->B/);
  });

  test('labels: quotes, <br>, tags and entities out; wrapped to width', () => {
    assert.equal(cleanLabel('"Load <b>balancer</b><br/>(L7)"'), 'Load balancer\n(L7)');
    assert.equal(cleanLabel('a #quot;b#quot; &amp; c'), 'a "b" & c');
    assert.deepEqual(wrapLabel('one two three four five six', 9), ['one two', 'three', 'four five', 'six']);
    assert.deepEqual(wrapLabel('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  });
});

/** A zip made here, as a .docx is: each entry deflated, with its directory at the end. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('documents', () => {
  const W = body => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
  const para = (text, style = null, list = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  test('the types Learn reads, by extension', () => {
    assert.deepEqual(['a.PDF', 'b.docx', 'c.md', 'd.txt', 'e.htm', 'f.doc', 'g'].map(documentType), ['PDF', 'Word', 'Markdown', 'Text', 'HTML', null, null]);
  });

  test('a zip is read entry by entry', () => {
    const zip = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'world'.repeat(100) }));
    assert.equal(zip.get('a.txt')().toString(), 'hello');
    assert.equal(zip.get('dir/b.txt')().toString().length, 500);
    assert.throws(() => readZip(Buffer.from('not a zip at all, sorry')), /not a zip/);
  });

  test('Word: the title, headings by style (named or by outline level), lists, tables and entities', () => {
    const styles = '<w:styles><w:style w:styleId="Kop1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Mine"><w:name w:val="Mine"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>';
    const body = para('Runbook', 'Title') + para('For the on-call engineer.') + para('Before you start', 'Kop1') + para('Check the lag &amp; alerts', null, true)
      + '<w:tbl><w:tr><w:tc>' + para('Step') + '</w:tc><w:tc>' + para('Command') + '</w:tc></w:tr><w:tr><w:tc>' + para('Promote') + '</w:tc><w:tc>' + para('select pg_promote();') + '</w:tc></w:tr></w:tbl>'
      + para('After', 'Mine') + para('Rebuild the old primary.');
    const read = docxToSections(makeZip({ 'word/document.xml': W(body), 'word/styles.xml': styles }));
    assert.equal(read.title, 'Runbook');
    assert.deepEqual(read.sections.map(section => [section.heading, section.level]), [['Introduction', 1], ['Before you start', 1], ['After', 2]]);
    assert.equal(read.sections[1].text, '- Check the lag & alerts\n| Step | Command |\n| Promote | select pg_promote(); |');
    assert.throws(() => docxToSections(makeZip({ 'other.xml': '<x/>' })), /not a Word document/);
  });

  test('PDF: sections by the top two levels of bookmarks, the page in each heading', () => {
    const pages = ['Cover', 'Intro text '.repeat(40), 'WAL text '.repeat(40), 'More WAL '.repeat(40), 'Failover text '.repeat(40)];
    const outline = [{ title: 'Write-ahead log', page: 2, level: 0 }, { title: 'Deep detail', page: 3, level: 2 }, { title: 'Failover', page: 4, level: 1 }, { title: 'Intro', page: 1, level: 0 }];
    const sections = pdfSections(pages, outline);
    assert.deepEqual(sections.map(section => section.heading), ['Intro (p. 2)', 'Write-ahead log (pp. 3-4)', 'Failover (p. 5)'], 'a short front matter (the cover) is left out; level 2 is inside its parent');
    assert.ok(sections[1].text.includes('More WAL'));
  });

  test('PDF without bookmarks: three pages at a time; a long part cut at page ends', () => {
    const pages = Array.from({ length: 7 }, (_, i) => `Page ${i + 1} `.repeat(30));
    assert.deepEqual(pdfSections(pages).map(section => section.heading), ['Pages 1-3', 'Pages 4-6', 'Page 7']);
    const big = Array.from({ length: 4 }, () => 'word '.repeat(2400)); // 12,000 characters a page
    const cut = pdfSections(big, [{ title: 'All', page: 0, level: 0 }, { title: 'Rest', page: 3, level: 0 }]);
    assert.deepEqual(cut.map(section => section.heading), ['All (pp. 1-2)', 'All (p. 3)', 'Rest (p. 4)']);
  });

  test('a page with no usable text goes to Claude only when such pages are a real share', () => {
    assert.equal(pageIsJunk(''), true);
    assert.equal(pageIsJunk('%%%% ### $$$ 1234 5678 !!!! '.repeat(8)), true, 'symbols, no words');
    assert.equal(pageIsJunk('A standby connects with a replication slot and receives the WAL as it is written by the primary.'), false);
    const good = 'A standby connects with a replication slot and receives the WAL as it is written by the primary.';
    assert.deepEqual(pagesForClaude([good, '', good, good, good, good, good, good, good, good, good, good, good, good, good, good, good, good, good, good]), [], 'one empty page in twenty: a figure or a blank');
    assert.deepEqual(pagesForClaude([good, '', '', good, '', good]), [1, 2, 4]);
  });

  test('headings made unique; long sections cut into parts at paragraph ends', () => {
    assert.deepEqual(uniqueHeadings([{ heading: 'Setup', text: 'a' }, { heading: 'setup', text: 'b' }, { heading: '', text: 'c' }]).map(section => section.heading), ['Setup', 'setup (2)', 'Section']);
    const long = [{ heading: 'Notes', level: 1, text: ['one '.repeat(200), 'two '.repeat(200), 'three '.repeat(200)].join('\n\n') }];
    const parts = cutLongSections(long, 1000);
    assert.ok(parts.length >= 3);
    assert.match(parts[0].heading, /^Notes \(part 1\)$/);
    assert.ok(parts.every(part => part.text.length <= 1000));
    assert.deepEqual(cutLongSections([{ heading: 'Introduction', text: 'x '.repeat(800) }], 1000).map(part => part.heading), ['Part 1', 'Part 2']);
  });

  test('Markdown: a # inside a code fence is not a heading', () => {
    const read = textToSections('# Title\nintro\n```bash\n# a comment\nls\n```\n## Next\nmore', 'x');
    assert.deepEqual(read.sections.map(section => section.heading), ['Title', 'Next']);
    assert.match(read.sections[0].text, /# a comment/);
  });
});

describe('chats', () => {
  const line = value => JSON.stringify(value);
  const records = [
    { type: 'user', cwd: '/home/me/app', timestamp: '2026-11-03T10:00:00Z', message: { content: 'Why does the browser link do nothing?' } },
    { type: 'user', isMeta: true, message: { content: '<system-reminder>hidden</system-reminder>' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the opener.' }, { type: 'tool_use', name: 'Bash', input: { command: 'cat log.txt' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/app/a.ps1', old_string: 'Start-Process', new_string: 'Process.Start' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'opener exited 0 with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx1234' }] } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: 'Summary: the opener died with wsl.exe.' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'a subagent at work' }] } },
    { type: 'custom-title', customTitle: 'browser-link' },
  ];

  test('a chat shrunk to text: turns, tool lines, edits, cut results, the compaction, secrets masked', () => {
    const text = condenseChat(records.map(line).join('\n'), { title: 'browser-link' });
    assert.match(text, /^CHAT: browser-link/);
    assert.match(text, /\[#1 2026-11-03 10:00\] LEARNER: Why does the browser link do nothing\?/);
    assert.match(text, /tool Bash: cat log.txt/);
    assert.match(text, /tool Edit: \/app\/a.ps1\n  was: Start-Process\n  now: Process.Start/);
    assert.match(text, /result: opener exited 0 with GITHUB_TOKEN=<hidden>/);
    assert.match(text, /compacted here/);
    assert.match(text, /\[summary written at the compaction\]/);
    assert.ok(!text.includes('system-reminder'));
    assert.ok(!text.includes('subagent at work'));
    assert.ok(!text.includes('ghp_'));
  });

  test("a chat's title: its own, else Claude's, else its first words", () => {
    assert.equal(chatTitle(records), 'browser-link');
    assert.equal(chatTitle([{ type: 'ai-title', aiTitle: 'Fix the opener' }, records[0]]), 'Fix the opener');
    assert.equal(chatTitle([records[1], records[0]]), 'Why does the browser link do nothing?');
  });

  test('secrets: keys, tokens, JWTs, passwords in URLs, NAME=value and JSON', () => {
    const masked = maskSecrets([
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
      'postgres://app:s3cretpw@db:5432/x', 'DB_PASSWORD=hunter2hunter2', 'export API_KEY="abcdef123456"', '{"client_secret": "zzzzzzzz"}',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    ].join('\n'));
    for (const secret of ['abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'SflKxwRJSMeKKF2QT4', 's3cretpw', 'hunter2hunter2', 'abcdef123456', 'zzzzzzzz', 'MIIE']) assert.ok(!masked.includes(secret), secret);
    assert.match(masked, /postgres:\/\/app:<hidden>@db/);
    assert.match(masked, /DB_PASSWORD=<hidden>/);
    assert.equal(maskSecrets('a commit 3f2a9c1 and a path /home/me/app'), 'a commit 3f2a9c1 and a path /home/me/app', 'ordinary text is left alone');
  });

  test("the chats are listed newest first, Learn's own and empty ones left out", () => {
    const dir = mkdtempSync(join(tmpdir(), 'learn-chats-'));
    try {
      const write = (project, id, items, at) => {
        mkdirSync(join(dir, project), { recursive: true });
        const file = join(dir, project, `${id}.jsonl`);
        writeFileSync(file, `${items.map(line).join('\n')}\n${' '.repeat(2100)}`);
        return file;
      };
      write('-home-me-app', '11111111-1111-4111-8111-111111111111', records);
      write(projectSlug('/home/me/.claude/learn'), '22222222-2222-4222-8222-222222222222', records);
      write('-home-me-app', '33333333-3333-4333-8333-333333333333', [records[1]]);
      write('-home-me-app', 'not-a-session', records);
      const chats = listClaudeChats({ dir, exclude: ['/home/me/.claude/learn'] });
      assert.deepEqual(chats.map(chat => chat.id), ['11111111-1111-4111-8111-111111111111']);
      assert.equal(chats[0].title, 'browser-link');
      assert.equal(chats[0].project, 'app');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fact-check', () => {
  const markdown = [
    '# Beam search',
    '',
    'Beam search always finds an output at least as likely as greedy search does [sec: Beam search].',
    '',
    'Greedy search takes the single most likely token at every step of the way.',
  ].join('\n');
  const flag = { quote: 'Beam search always finds an output at least as likely as greedy search does', problem: 'It can prune the greedy path.', correction: 'It usually does, with no guarantee.', evidence: 'https://example.org/beam', checks: [] };

  test('a flag stays when its quote is on the page and its evidence is elsewhere', () => {
    const { disputes, rejected } = tidyDisputes({ disputes: [flag] }, { markdown, sourceUrls: ['https://other.org/a'] });
    assert.equal(disputes.length, 1);
    assert.deepEqual(rejected, []);
  });

  test('a flag goes when its quote is not on the page', () => {
    const { disputes, rejected } = tidyDisputes({ disputes: [{ ...flag, quote: 'A claim this page never makes anywhere at all' }] }, { markdown });
    assert.equal(disputes.length, 0);
    assert.match(rejected[0].reason, /not on the page/);
  });

  test('a page\'s own source is no evidence, however it is written', () => {
    const { disputes, rejected } = tidyDisputes({ disputes: [{ ...flag, evidence: 'https://www.example.org/beam/#top' }] }, { markdown, sourceUrls: ['http://example.org/beam'] });
    assert.equal(disputes.length, 0);
    assert.match(rejected[0].reason, /own sources/);
  });

  test('a flag needs a real link, a problem and a correction', () => {
    const flags = [{ ...flag, evidence: 'not a link' }, { ...flag, evidence: 'javascript:alert(1)' }, { ...flag, correction: '' }];
    assert.equal(tidyDisputes({ disputes: flags }, { markdown }).disputes.length, 0);
  });

  test('the same claim is flagged once, and only known questions are named', () => {
    const { disputes } = tidyDisputes({ disputes: [{ ...flag, checks: ['q1', 'made-up'] }, flag] }, { markdown, checkIds: ['q1'] });
    assert.equal(disputes.length, 1);
    assert.deepEqual(disputes[0].checks, ['q1']);
  });

  test('flags stop at the most a page can carry', () => {
    const many = Array.from({ length: MAX_DISPUTES + 3 }, (_, index) => ({ ...flag, quote: `Claim number ${index} is written out here in five words or more` }));
    const page = many.map(item => item.quote).join('. ');
    assert.equal(tidyDisputes({ disputes: many }, { markdown: page }).disputes.length, MAX_DISPUTES);
  });

  test('a question quoting a disputed passage is held back, and others stay', () => {
    const quick = [
      { id: 'q1', q: 'Does beam beat greedy?', quote: 'always finds an output at least as likely' },
      { id: 'q2', q: 'What does greedy take?', quote: 'takes the single most likely token' },
    ];
    const closing = [{ id: 'c1', q: 'Explain beam search', quote: 'Beam search always finds an output' }];
    const held = holdBack({ quick, closing }, [{ ...flag, checks: [] }], markdown);
    assert.deepEqual(held.quick.map(check => check.id), ['q2']);
    assert.deepEqual(held.closing, []);
    assert.equal(held.heldBack.length, 2);
  });

  test('a question the check names is held back whatever it quotes', () => {
    const quick = [{ id: 'q2', q: 'What does greedy take?', quote: 'takes the single most likely token' }];
    assert.deepEqual(holdBack({ quick, closing: [] }, [{ ...flag, checks: ['q2'] }], markdown).quick, []);
  });

  test('no flags change nothing', () => {
    const aids = { quick: [{ id: 'q1', q: 'a', quote: 'b' }], closing: [] };
    assert.equal(holdBack(aids, [], markdown).quick.length, 1);
  });

  test('the box sits right under the passage', () => {
    const blocks = markdownToBlocks(markdown);
    const placed = placeDisputes(blocks, [flag]);
    const at = placed.findIndex(block => block.kind === 'disputed');
    assert.equal(placed.length, blocks.length + 1);
    assert.equal(placed[at - 1].t, 'p');
    assert.match(placed[at - 1].inlines.map(item => item.s).join(''), /always finds/);
  });

  test('a box is never lost: a quote that is nowhere still lands on the page', () => {
    const placed = placeDisputes(markdownToBlocks(markdown), [{ ...flag, quote: 'nothing like this is anywhere on it' }]);
    assert.equal(placed.at(-1).kind, 'disputed');
  });

  test('the box carries the problem, the correction and a link', () => {
    const box = disputeBlock(flag);
    assert.equal(box.kind, 'disputed');
    const inlines = box.blocks[0].inlines;
    assert.match(inlines.map(item => item.s).join(''), /prune the greedy path.*no guarantee/);
    assert.equal(inlines.find(item => item.link)?.link, 'https://example.org/beam');
  });

  test('a span is where a quote sits, and null when it is not on the page', () => {
    const map = pageMap('One two three four five six seven.');
    assert.deepEqual(spanOf('three four five six seven', map), { start: 2, end: 7 });
    assert.equal(spanOf('eight nine ten eleven twelve', map), null);
  });
});
