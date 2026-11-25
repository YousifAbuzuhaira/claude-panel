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
import { chatTitle, condenseChat, listClaudeChats, maskSecrets, projectSlug, projectsDir } from '../chats.mjs';
import { maskCode } from '../secrets.mjs';
import { cutLongSections, docxToSections, documentType, mergeSections, pageIsJunk, pagesForClaude, pdfSections, readZip, uniqueHeadings } from '../documents.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { askNumbers, cleanAsks, picksCovering, uncovered } from '../coverage.mjs';
import { markdownToBlocks, parseInline, patchSections, splitSections } from '../markdown.mjs';
import { DAILY_CAP, LADDER, answerInReview, answerOnPage, dropCourse, dueToday, emptyReview, flagItem, itemKey, nextDue, parseKey, recallDays, swapConcept } from '../review.mjs';
import { markTerms, pageGlossary } from '../terms.mjs';
import { applyReader, checkBlock, checkId, closingFor, givesItselfAway, isTerm, mergeAids, mergeTerms, pageMap, placeChecks, quoteState, shuffled, spanOf, tidyAids } from '../teach.mjs';
import { MAX_DISPUTES, disputeBlock, holdBack, placeDisputes, sourceDisputes, tidyDisputes, tidySourceCheck } from '../verify.mjs';
import { voicePlatform } from '../voice.mjs';
import { applyPlan, checkPlan, maskable, planRequest, planSchema } from '../video-plan.mjs';
import { writeScript } from '../video-script.mjs';
import { anchorFile, checkExplainer, clipCounts, clipPage, clipPlan, explainInfo, explainPaths, explainProblems, listExplainers, looksSecret, nextClip, quotesInChat, readAnchors, saveExplainer, wantedClips } from '../explain.mjs';
import { codeNeeds, estimate, faultsBySection, firstTaught, flattenPage, hearing, isOldPage, keptOnScreen, layoutNotes, longClips, mendSection, mergeTiny, plainScenes, settleMasks, settleScenes, simulate, spokenBudget, spokenWords, stopsOf, testOpener, testSection, tidyPronounce, videoQuiz, videoStamp, withBlockRead } from '../video-check.mjs';
import { buildCameras, buildStates, containers, crosses, dedent, edgePoint, fitCamera, frameFor, labelPoint, labelSpot, legendRect, roughRect, sceneAt, wireEnds } from '../../web/public/learn/video/model.mjs';
import { wheelFits } from '../../tools/voice-lock.mjs';
import { overlapReport } from '../overlap.mjs';
import { claudeBinary, isAbsoluteLocal, normalizeSettings, toLocalPath, toWslPath } from '../settings.mjs';
import { chunkLines, condenseTranscript, formatTime, htmlToSections, isPlaylist, outlineExcerpt, parseJson3, parseTime, textToSections, transcriptText, youTubeId } from '../sources.mjs';
import { countWords, isOver, keepTighter, learnedFor, ownerMap, pageBudget, plannedPages, proseWords } from '../shape.mjs';

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

  test('effort is passed only when asked for', () => {
    const args = claudeArgs({ model: 'opus', effort: 'low', tools: [] });
    assert.equal(args[args.indexOf('--effort') + 1], 'low');
    assert.ok(!claudeArgs({ model: 'opus', tools: [] }).includes('--effort'));
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

  test('questions in videos are off unless turned on, and only true turns them on', () => {
    assert.equal(normalizeSettings({}).videoQuestions, false);
    assert.equal(normalizeSettings({ videoQuestions: 'yes' }).videoQuestions, false);
    assert.equal(normalizeSettings({ videoQuestions: true }).videoQuestions, true);
  });

  test('on Windows itself a Windows path stays one, so a settings change never moves the library', () => {
    assert.equal(toLocalPath('C:\\Users\\me\\Learn\\', 'win32'), 'C:\\Users\\me\\Learn');
    assert.equal(toLocalPath('C:\\', 'win32'), 'C:\\');
    assert.equal(toLocalPath('C:\\Users\\me\\Learn', 'linux'), '/mnt/c/Users/me/Learn');
    assert.ok(isAbsoluteLocal('C:\\a', 'win32'));
    assert.ok(isAbsoluteLocal('D:/a', 'win32'));
    assert.ok(isAbsoluteLocal('\\\\server\\share\\x', 'win32'));
    assert.ok(!isAbsoluteLocal('/mnt/c/a', 'win32'));
    assert.ok(!isAbsoluteLocal('C:\\a', 'linux'));
    const settings = normalizeSettings({ library: 'C:\\Users\\me\\.claude\\learn', workFolders: ['D:\\code', 'rel'], claudePath: 'C:\\bin\\claude.exe' }, 'win32');
    assert.equal(settings.library, 'C:\\Users\\me\\.claude\\learn');
    assert.deepEqual(settings.workFolders, ['D:\\code']);
    assert.equal(settings.claudePath, 'C:\\bin\\claude.exe');
    // Read back and saved again (any settings.set): still the same folder.
    assert.equal(normalizeSettings(settings, 'win32').library, settings.library);
  });

  test('claude is found as claude.exe on Windows, through npm\'s claude.cmd too', () => {
    const files = new Set(['C:\\nvm\\claude.cmd', 'C:\\nvm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe']);
    const exists = path => files.has(path);
    const settings = { claudePath: null };
    assert.equal(claudeBinary(settings, { platform: 'win32', path: 'C:\\Windows;C:\\nvm', exists, home: 'C:\\Users\\me' }), 'C:\\nvm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    files.add('C:\\Users\\me\\.local\\bin\\claude.exe');
    assert.equal(claudeBinary(settings, { platform: 'win32', path: 'C:\\Windows', exists, home: 'C:\\Users\\me' }), 'C:\\Users\\me\\.local\\bin\\claude.exe');
    // A Mac's Homebrew claude, when PATH (a bare launch) doesn't have it.
    assert.equal(claudeBinary(settings, { platform: 'darwin', path: '/usr/bin', exists: path => path === '/opt/homebrew/bin/claude', home: '/Users/me' }), '/opt/homebrew/bin/claude');
    assert.equal(claudeBinary(settings, { platform: 'linux', path: '/a:/b', exists: path => path === '/b/claude', home: '/home/me' }), '/b/claude');
  });

  test('videos have their own model, Opus unless a good one is chosen', () => {
    assert.equal(normalizeSettings({}).models.video, 'opus');
    assert.equal(normalizeSettings({ models: { video: 'sonnet' } }).models.video, 'sonnet');
    assert.equal(normalizeSettings({ models: { video: 'gpt-9' } }).models.video, 'opus');
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
    const more = maskSecrets(['{ "DB_PASSWORD": "hunter2hunter2" }', "API_KEY='correct horse battery'", 'curl -H "Authorization: Bearer abcd1234efgh"', 'Authorization: Bearer abcdefghijklmnopqrstuvwx'].join('\n'));
    for (const secret of ['hunter2hunter2', 'correct horse', 'abcd1234efgh', 'abcdefghijklmnop']) assert.ok(!more.includes(secret), secret);
    assert.equal(maskSecrets('Bearer authentication is used'), 'Bearer authentication is used', 'a word is not a credential');
  });

  test('a source file: plain code after a secret name is shown', () => {
    const code = [
      'function mint(user) {}',
      'const token = mint(request.user);',
      'export function hashToken(token: string): Promise<string> {',
      'type Login = { accessToken: string; password: string; author: Person };',
      'const limits = { maxTokens: 128000, authTimeout: 600000 };',
      '<OrgTab authFetch={authFetch} />',
      'import { useAuth } from "@keops-ai/auth";',
      "throw new AuthError('Invalid token for this user');",
      "app.get('/me', { onRequest: [app.keopsAuthenticate, requirePermission('users:read')] });",
      'headers.set("authorization", `Bearer ${token}`);',
      "createHmac('sha256', secretKey).digest('base64url');",
      'const TOKEN_RE = /^[A-Za-z0-9]{16,}$/;',
      "export const AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED';",
    ].join('\n');
    assert.equal(maskCode(code, '.ts'), code);
    const python = 'import os\ndef mint(user: User) -> str:\n    token = os.environ["X"] or mint(user)\n    self.token = token';
    assert.equal(maskCode(python, '.py'), python);
  });

  test('a source file: a secret written into it is hidden, wherever it is, whether or not it has digits', () => {
    const make = value => [
      `const token: string = "${value}";`, `const o = { "DB_PASSWORD": '${value}' };`, `'x-api-key': "${value}",`, `env["API_TOKEN"] = "${value}";`, `headers.set("Authorization", "${value}");`,
      `const s = process.env.SECRET || "${value}";`, `if (password === "${value}") return;`, 'const password = `' + value + '`;', 'const t = `password=' + value + '`;', 'const x = `\nDB_PASSWORD=' + value + '\n`;',
      `// password: ${value}`, ` * token=${value}`, `const c = "Server=x;Password=${value};";`, `const u = "postgres://app:${value}@db/x";`, `var apiKey = @"${value}";`, `password := "${value}"`, `let token = String::from("${value}");`,
    ];
    for (const value of ['hunter2hunter2', 'letmeinplease', 'kZbQxWvTrPnMlKjHgFdSaQwE']) {
      for (const line of make(value)) {
        const masked = maskCode(line, '.ts');
        assert.ok(!masked.includes(value), masked);
        assert.equal(masked.split('\n').length, line.split('\n').length);
      }
      for (const line of [`API_KEY: str = "${value}"`, `os.environ.get("API_KEY", "${value}")`, `# token: ${value}`, `client(password="${value}")`]) assert.ok(!maskCode(line, '.py').includes(value), line);
      for (const ext of ['.yml', '.sh', '.json', '']) assert.ok(!maskCode(`password: ${value}`, ext).includes(value), ext);
    }
    assert.match(maskCode('const PASSWORD = 12345678;', '.ts'), /<hidden>/);
  });

  test('a private key is hidden line for line, so an excerpt that starts inside it shows none of it', () => {
    const text = 'a\nkey: |\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB\nabcDEF\n-----END RSA PRIVATE KEY-----\nz';
    for (const ext of ['.yml', '.ts']) {
      const masked = maskCode(text, ext).split('\n');
      assert.equal(masked.length, 7);
      assert.equal(masked[6], 'z');
      assert.doesNotMatch(masked.slice(3, 6).join(''), /MIIE|abcDEF/);
    }
  });

  test('a long unbroken line is hidden quickly', () => {
    const start = Date.now();
    maskCode(`x="${'token_'.repeat(20_000)}"`, '.js');
    maskCode(`${'a'.repeat(400_000)} token`, '.js');
    assert.ok(Date.now() - start < 2_000);
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

describe('where the voice runs', () => {
  test('Linux, WSL, Windows and Apple Silicon on macOS 14 have a build', () => {
    assert.match(voicePlatform('linux', 'x64', '6.6.0').target, /x86_64-unknown-linux/);
    assert.match(voicePlatform('win32', 'x64', '10.0.19045').target, /x86_64-pc-windows-msvc/);
    assert.equal(voicePlatform('win32', 'x64', '10.0.19045').zip, true);
    assert.match(voicePlatform('linux', 'arm64', '6.6.0').target, /aarch64-unknown-linux/);
    assert.match(voicePlatform('darwin', 'arm64', '23.1.0').target, /aarch64-apple-darwin/);
  });

  test('an Intel Mac or an old macOS is told why', () => {
    assert.match(voicePlatform('darwin', 'x64', '23.1.0').reason, /Apple Silicon/);
    assert.match(voicePlatform('darwin', 'arm64', '22.6.0').reason, /macOS 14/);
    assert.match(voicePlatform('win32', 'arm64', '10').reason, /no build/);
  });
});

describe('the voice lock', () => {
  test('keeps wheels Python 3.12 can use on Linux and Apple Silicon', () => {
    for (const name of ['numpy-2.5.4-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl', 'attrs-26.1.0-py3-none-any.whl', 'x-1-cp39-abi3-macosx_11_0_arm64.whl', 'onnxruntime-1.31.1-cp312-cp312-macosx_14_0_arm64.whl']) assert.equal(wheelFits(name), true, name);
  });

  test('the Windows lock keeps 64-bit Windows wheels, and none for Linux or a Mac', () => {
    for (const name of ['x-1-cp312-cp312-win_amd64.whl', 'attrs-26.1.0-py3-none-any.whl', 'espeakng_loader-0.2.4-py3-none-win_amd64.whl', 'protobuf-7.36.2-cp310-abi3-win_amd64.whl']) assert.equal(wheelFits(name, { windows: true }), true, name);
    for (const name of ['x-1-cp312-cp312-win32.whl', 'x-1-cp312-cp312-manylinux_2_28_x86_64.whl', 'x-1-cp312-cp312-macosx_11_0_arm64.whl', 'x-1-cp313-cp313-win_amd64.whl']) assert.equal(wheelFits(name, { windows: true }), false, name);
  });

  test('leaves out other Pythons and platforms', () => {
    for (const name of ['numpy-2.5.4-cp313-cp313-manylinux_2_28_x86_64.whl', 'x-1-cp312-cp312-win_amd64.whl', 'x-1-cp312-cp312-macosx_10_12_x86_64.whl', 'x-1-cp313-abi3-macosx_11_0_arm64.whl']) assert.equal(wheelFits(name), false, name);
  });
});

describe('a page as a video', () => {
  const longCode = Array.from({ length: 40 }, (_, k) => `line_${k} = ${'x'.repeat(k === 3 ? 200 : 10)}`).join('\n');
  const page = {
    title: 'Beam search',
    markdown: 'text',
    stats: {},
    blocks: [
      ...markdownToBlocks([
        'Before any heading [12:34] there is a sentence (added). And a second one.',
        '',
        '## Greedy',
        '',
        'Greedy takes the top token at each step of the way.',
        '',
        '- First point here.',
        '- Second point here.',
        '',
        '```python',
        longCode,
        '```',
        '',
        '| a | b |',
        '|---|---|',
        ...Array.from({ length: 9 }, (_, k) => `| ${k} | v${k} |`),
        '',
        '## Greedy',
        '',
        'The same heading comes up again in this page.',
      ].join('\n')),
      { t: 'check', id: 'q1', q: parseInline('What does greedy take?'), concepts: [], options: [{ inlines: parseInline('The top token'), why: parseInline('It keeps the best.'), right: 1 }, { inlines: parseInline('All tokens'), why: parseInline('No.') }] },
    ],
  };

  test('source marks are left out of what is said', () => {
    const { blocks } = flattenPage(page);
    assert.equal(blocks[0].text, 'Before any heading there is a sentence. And a second one.');
  });

  test('every block is numbered in order, and a repeated heading stays its own section', () => {
    const { blocks, sections } = flattenPage(page);
    assert.deepEqual(blocks.map(block => block.n), blocks.map((_, k) => k));
    assert.deepEqual(sections, ['Introduction', 'Greedy', 'Greedy (2)']);
  });

  test('a question stays after the block before it', () => {
    const { quiz, blocks } = flattenPage(page);
    assert.equal(quiz[0].after, blocks.length - 1);
    assert.equal(quiz[0].section, 'Greedy (2)');
    assert.equal(quiz[0].options[0].right, true);
  });

  test('a disputed box is a block to cover, marked as a correction', () => {
    const { blocks } = flattenPage({ blocks: [{ t: 'callout', kind: 'disputed', title: [], blocks: markdownToBlocks('Not always true.') }] });
    assert.equal(blocks[0].callout, 'disputed');
  });

  test('a page without its first-pass stats is an old one', () => {
    assert.equal(isOldPage({ blocks: [] }), true);
    assert.equal(isOldPage(page), false);
  });

  test('a stamp changes with the words, the questions and the flags, and only those', () => {
    const stamp = videoStamp(page);
    assert.equal(videoStamp({ ...page, title: 'Renamed' }), stamp);
    assert.notEqual(videoStamp({ ...page, markdown: 'other' }), stamp);
    assert.notEqual(videoStamp({ ...page, blocks: page.blocks.slice(0, -1) }), stamp);
    assert.notEqual(videoStamp({ ...page, disputes: [{ quote: 'a' }] }), stamp);
  });

  test('the plain fallback covers every block of a section and asks its questions', () => {
    const material = flattenPage(page);
    for (const section of material.sections) {
      const scenes = plainScenes(section, material);
      const covered = new Set(scenes.flatMap(scene => scene.covers));
      for (const block of material.blocks.filter(item => item.section === section)) assert.ok(covered.has(block.n), `block ${block.n}`);
    }
    assert.equal(plainScenes('Greedy (2)', material).filter(scene => scene.check === 'q1').length, 1);
  });

  test('the plain fallback passes the checks it stands in for', () => {
    const material = flattenPage(page);
    for (const section of material.sections) {
      for (const scene of plainScenes(section, material).filter(item => !item.check)) {
        const problems = [];
        simulate(scene, scene.title, material.assets, problems);
        assert.deepEqual(problems, []);
      }
    }
  });

  test('long code and tables are paged so each page stays readable', () => {
    const material = flattenPage(page);
    const scenes = plainScenes('Greedy', material);
    const code = scenes.filter(scene => scene.objects[0]?.shape === 'code');
    const tables = scenes.filter(scene => scene.objects[0]?.shape === 'table');
    assert.ok(code.length >= 3);
    assert.equal(tables.length, 2);
    assert.ok(code.every(scene => scene.beats[0].hold > 0));
  });

  test('a section is told what it left out', () => {
    const material = flattenPage(page);
    const problems = testSection('Greedy', { scenes: [] }, material);
    assert.ok(problems.some(problem => /is not covered/.test(problem)));
  });

  test('a question must appear exactly once', () => {
    const material = flattenPage(page);
    const asked = { title: 'Quick check', covers: [], quote: null, check: 'q1', objects: [], beats: [] };
    assert.ok(testSection('Greedy (2)', { scenes: [asked, asked] }, material).some(problem => /appears 2 times/.test(problem)));
  });

  test('a scene is played through: off stage, an unknown object, a word not said', () => {
    const scene = {
      objects: [{ id: 'a', shape: 'box', x: 1000, y: 200, w: 200, h: 100, text: 'hi' }],
      beats: [{ say: 'Here it comes.', do: [{ on: 'gone', show: ['a', 'b'] }] }],
    };
    const problems = [];
    simulate(scene, 'S', { code: [], table: [], diagram: [] }, problems);
    assert.ok(problems.some(problem => /leaves the stage/.test(problem)));
    assert.ok(problems.some(problem => /unknown object b/.test(problem)));
    assert.ok(problems.some(problem => /"on" word "gone"/.test(problem)));
  });

  test('a cue word is one word as the recorder hears it: numbers with commas, hyphens, a final stop', () => {
    const scene = {
      objects: [{ id: 'a', shape: 'box', x: 100, y: 200, w: 200, h: 100, text: 'hi' }],
      beats: [{ say: 'GPT-3 has 1,000 non-linear steps.', do: [{ on: 'GPT-3', show: ['a'] }, { on: '1,000', set: { a: { fade: true } } }, { on: 'non-linear', set: { a: { fade: false } } }, { on: 'steps', set: { a: { fade: true } } }] }],
    };
    const problems = [];
    simulate(scene, 'S', { code: [], table: [], diagram: [] }, problems);
    assert.ok(!problems.some(problem => /"on" word/.test(problem)));
  });

  test('an object never shown is caught', () => {
    const problems = [];
    simulate({ objects: [{ id: 'a', shape: 'box', x: 100, y: 200, w: 200, h: 100 }], beats: [{ say: 'Hello.', do: [] }] }, 'S', { code: [], table: [], diagram: [] }, problems);
    assert.ok(problems.some(problem => /never shown/.test(problem)));
  });

  test('two objects on top of each other are caught, but a label in a box is fine', () => {
    const scene = extra => ({ objects: [{ id: 'a', shape: 'box', x: 100, y: 200, w: 300, h: 200, show: true }, { show: true, ...extra }], beats: [] });
    const run = extra => {
      const problems = [];
      simulate(scene(extra), 'S', { code: [], table: [], diagram: [] }, problems);
      return problems;
    };
    assert.ok(run({ id: 'b', shape: 'box', x: 200, y: 250, w: 300, h: 100 }).some(problem => /overlaps/.test(problem)));
    assert.deepEqual(run({ id: 'b', shape: 'label', x: 120, y: 220, w: 200, text: 'in' }), []);
  });

  test('faults go to the section they belong to, and never to a rebuilt one', () => {
    const material = flattenPage(page);
    const faults = faultsBySection({ ...material, claims: { added: [{ said: 'x', why: 'y', section: 'Greedy' }], dropped: [{ fact: 'z', block: 0 }] }, reading: { answers: [{ id: 'q1', choice: 0 }] } }, new Set(['Introduction']));
    assert.deepEqual([...faults.keys()], ['Greedy']);
  });

  test('a claim with no known section is sent to all of them', () => {
    const material = flattenPage({ ...page, blocks: page.blocks.slice(0, -1) });
    const faults = faultsBySection({ ...material, claims: { added: [{ said: 'x', why: 'y', section: 'Nowhere' }], dropped: [] }, reading: {} });
    assert.equal(faults.size, material.sections.length);
  });

  test('a question the watcher got wrong is a fault', () => {
    const material = flattenPage(page);
    const wrong = material.quiz[0].options.findIndex(option => !option.right);
    const faults = faultsBySection({ ...material, claims: {}, reading: { answers: [{ id: 'q1', choice: wrong }] } });
    assert.match(faults.get('Greedy (2)')[0], /could not answer/);
  });

  test('a block the scenes dropped is read out right after what came before it', () => {
    const material = flattenPage(page);
    const block = material.blocks[1];
    const scenes = [{ title: 'Before', covers: [0] }, { title: 'After', covers: [5] }];
    const read = withBlockRead(scenes, block);
    assert.deepEqual(read.map(scene => scene.title), ['Before', 'Before', 'After']);
    assert.deepEqual(read[1].covers, [block.n]);
    assert.equal(scenes.length, 2);
  });

  test('a pronunciation stays only for a word really said', () => {
    const scenes = [{ beats: [{ say: 'Token 1917 here.' }] }];
    assert.deepEqual(tidyPronounce([{ written: '1917', spoken: 'nineteen' }, { written: '2000', spoken: 'x' }, { written: 'Token', spoken: 'Token' }], scenes), [{ written: '1917', spoken: 'nineteen' }]);
  });

  test('what a watcher hears carries the section heading', () => {
    const material = flattenPage(page);
    const scenes = plainScenes('Introduction', material).map(scene => ({ ...scene, section: 'Introduction' }));
    assert.match(hearing(scenes, material.assets), /## \[Introduction\]/);
  });

  describe('settling scenes', () => {
    const assets = { code: [], table: [], diagram: [{ nodes: [] }] };
    const box = (id, y, h = 100) => ({ id, shape: 'box', x: 100, y, w: 200, h, show: true });
    const sceneOf = (objects, beats = [{ say: 'Go.', do: [] }]) => ({ title: 'T', objects, beats });

    test('an object a little off the stage moves back, all its positions together', () => {
      const set = { on: null, set: { a: { y: 430 } } };
      const { scenes: [scene] } = settleScenes({ scenes: [sceneOf([box('a', 300)], [{ say: 'Go.', do: [set] }])] }, assets);
      assert.ok(scene.objects[0].y < 300);
      assert.equal(300 - scene.objects[0].y, 430 - scene.beats[0].do[0].set.a.y);
    });

    test('an object far off the stage is left for Claude', () => {
      const { scenes: [scene] } = settleScenes({ scenes: [sceneOf([box('a', 700)])] }, assets);
      assert.equal(scene.objects[0].y, 700);
    });

    test('an object too big for the stage is not moved', () => {
      const wide = { id: 'a', shape: 'box', x: 20, y: 200, w: 1100, h: 100, show: true };
      assert.equal(settleScenes({ scenes: [sceneOf([wide])] }, assets).scenes[0].objects[0].x, 20);
    });

    test('an asset written as a block heading writes it becomes its number', () => {
      const { scenes: [scene] } = settleScenes({ scenes: [sceneOf([{ id: 'd', shape: 'diagram', x: 100, y: 120, w: 400, h: 300, asset: 'diagram 0', show: true }])] }, assets);
      assert.equal(scene.objects[0].asset, 0);
    });

    test('the answer it was given is left alone', () => {
      const given = { scenes: [sceneOf([box('a', 430)])], pronounce: [] };
      const settled = settleScenes(given, assets);
      assert.equal(given.scenes[0].objects[0].y, 430);
      assert.deepEqual(settled.pronounce, []);
    });
  });

  test('an estimate grows with the words', () => {
    assert.ok(estimate(2000).minutes > estimate(1000).minutes);
    assert.ok(estimate(1673).minutes > 9 && estimate(1673).minutes < 12, 'the measured page made a 9.5 min video');
    assert.equal(estimate(2529).totalMinutes, estimate(2529).scriptMinutes + estimate(2529).recordingMinutes);
  });
});

describe('the stage', () => {
  const assets = { code: [], table: [], diagram: [] };
  const scene = {
    objects: [{ id: 'a', shape: 'box', x: 100, y: 200, w: 200, h: 100 }, { id: 'b', shape: 'box', x: 400, y: 200, w: 200, h: 100 }],
    cues: [{ show: ['a'] }, { show: ['b'], set: { a: { fade: true } } }, { hide: ['a'] }],
  };

  test('there is one state per cue, and each is complete on its own', () => {
    const states = buildStates(scene);
    assert.equal(states.length, 4);
    assert.equal(states[0].get('a').visible, false);
    assert.equal(states[2].get('a').fade, true);
    assert.equal(states[3].get('a').visible, false);
    assert.equal(states[3].get('b').visible, true);
  });

  test('a state never changes an earlier one', () => {
    const states = buildStates(scene);
    assert.equal(states[1].get('a').fade, undefined);
  });

  test('there is a camera for every state', () => {
    const states = buildStates(scene);
    const cameras = buildCameras(scene, states, assets);
    assert.equal(cameras.length, states.length);
    assert.ok(cameras.every(camera => camera.zoom >= 0.85 && camera.zoom <= 1.5));
  });

  test('a camera a script asks for is not followed: it cropped what was shown, so the picture frames itself', () => {
    const told = { ...scene, cues: [{ show: ['a'], camera: { x: 300, y: 250, zoom: 2 } }] };
    const states = buildStates(told);
    const plain = { ...scene, cues: [{ show: ['a'] }] };
    assert.deepEqual(buildCameras(told, states, assets)[1], buildCameras(plain, buildStates(plain), assets)[1]);
    assert.ok(buildCameras(told, states, assets)[1].zoom <= 1.5);
  });

  test('the scene at a time is the last one started', () => {
    const scenes = [{ start: 0 }, { start: 10 }, { start: 20 }];
    assert.equal(sceneAt(scenes, 0), 0);
    assert.equal(sceneAt(scenes, 15), 1);
    assert.equal(sceneAt(scenes, 99), 2);
  });
});

describe('pages say what the source says', () => {
  test('"(added; why)" is an added mark like "(added)": not spoken, not quotable', () => {
    for (const mark of ['(added)', '(added; illustrative values)', '(added: my example)', '(added, toy numbers)']) {
      const inlines = parseInline(`A toy deploy fails once in a hundred ${mark} and that is all.`);
      assert.ok(inlines.some(item => item.added), mark);
      assert.ok(!inlines.some(item => !item.added && item.s.includes('added')), mark);
    }
    const map = pageMap('Real fact from the chat is here. A toy deploy fails once in a hundred. (added; illustrative values) Another sourced fact sits here too.');
    assert.equal(quoteState('A toy deploy fails once in a hundred', map), 'added');
    assert.equal(quoteState('Another sourced fact sits here too', map), 'sourced');
    const page = { title: 'P', markdown: 'x', stats: {}, blocks: markdownToBlocks('Said aloud here (added; illustrative values) and the rest.') };
    assert.equal(flattenPage(page).blocks[0].text, 'Said aloud here and the rest.');
  });

  test('a closing question can rest only on what the source says', () => {
    const markdown = '## One\nThe cache keeps entries for two seconds [sec: Cache]. Assume a toy hit rate of ninety percent here. (added; illustrative)';
    const aids = tidyAids({
      terms: [],
      quick: [],
      closing: [
        { q: 'Sourced?', points: [], answer: 'a', quote: 'The cache keeps entries for two seconds', concepts: ['c_a'] },
        { q: 'Added?', points: [], answer: 'a', quote: 'Assume a toy hit rate of ninety percent', concepts: ['c_a'] },
      ],
    }, { markdown, conceptIds: ['c_a'], headings: ['One'] });
    assert.deepEqual(aids.closing.map(item => item.q), ['Sourced?']);
    assert.deepEqual(aids.failed.map(item => item.q), ['Added?']);
  });

  test('sections split at ## headings, never inside a code fence', () => {
    const parts = splitSections('Opening.\n\n## One\n\nA.\n\n```bash\n## not a heading\n```\n\n### Sub\n\n## Two\nB.');
    assert.deepEqual(parts.map(part => part.heading), ['', 'One', 'Two']);
  });

  test('a patch replaces, removes and adds sections; everything else stays word for word', () => {
    const page = 'Why it matters.\n\n## One\n\nFirst [sec: A].\n\n## Two\n\nSecond.\n\n## Recap\n\n- x\n';
    assert.equal(
      patchSections(page, [{ heading: 'Two', after: null, markdown: '## Two\n\nSecond, fixed.' }]),
      'Why it matters.\n\n## One\n\nFirst [sec: A].\n\n## Two\n\nSecond, fixed.\n\n## Recap\n\n- x\n',
    );
    assert.equal(patchSections(page, [{ heading: 'One', after: null, markdown: '' }]), 'Why it matters.\n\n## Two\n\nSecond.\n\n## Recap\n\n- x\n');
    assert.equal(patchSections(page, [{ heading: 'New', after: 'One', markdown: 'Text without its heading.' }]), 'Why it matters.\n\n## One\n\nFirst [sec: A].\n\n## New\n\nText without its heading.\n\n## Two\n\nSecond.\n\n## Recap\n\n- x\n');
    assert.match(patchSections(page, [{ heading: 'Late', after: 'nowhere', markdown: '## Late\n\nL.' }]), /## Two\n\nSecond\.\n\n## Late\n\nL\.\n\n## Recap/, 'an unknown "after" goes before the Recap');
    assert.match(patchSections(page, [{ heading: '', after: null, markdown: 'A new opening.' }]), /^A new opening\.\n\n## One/);
    assert.equal(patchSections(page, []), page);
    assert.equal(patchSections(page, [{ heading: 'Nope', after: null, markdown: '' }]), page, 'removing what is not there changes nothing');
  });

  test('a brief fix replaces its section; a new heading is added at the end', () => {
    const sections = [{ heading: 'The plan', level: 1, text: 'Phases 1 to 3.' }, { heading: 'Risks', level: 1, text: 'None.' }];
    const merged = mergeSections(sections, [{ heading: '## the plan', text: 'Phases 0 to 8, each named.' }, { heading: 'Who does the work', text: 'You write and review.' }, { heading: '', text: 'x' }]);
    assert.deepEqual(merged.map(section => [section.heading, section.text]), [['The plan', 'Phases 0 to 8, each named.'], ['Risks', 'None.'], ['Who does the work', 'You write and review.']]);
    assert.equal(sections[0].text, 'Phases 1 to 3.', 'the input is not changed');
  });

  test('the source check keeps what it can act on', () => {
    const markdown = 'The layout re-runs on every tab click, the page says here. A toy example uses five hundred users. (added) The cache TTL is two seconds in the code.';
    const found = tidySourceCheck({
      wrong: [
        { quote: 'The layout re-runs on every tab click', kind: 'contradicts', problem: 'Soft switches skip it.', correction: 'Only a first load runs it.' },
        { quote: 'The layout re-runs on every tab click', kind: 'contradicts', problem: 'Again.', correction: 'x' },
        { quote: 'A toy example uses five hundred users', kind: 'unsupported', problem: 'Not in the chat.', correction: 'Mark it.' },
        { quote: 'a sentence that is nowhere on the page', kind: 'contradicts', problem: 'p', correction: 'c' },
        { quote: 'The cache TTL is two seconds', kind: 'odd', problem: 'Never said.', correction: 'Remove it.' },
      ],
      dropped: [{ fact: 'Decision 2: you write and review.', where: 'Plan' }, { fact: '  ', where: 'x' }],
    }, markdown);
    assert.deepEqual(found.wrong.map(item => [item.kind, item.problem]), [['contradicts', 'Soft switches skip it.'], ['unsupported', 'Never said.']]);
    assert.deepEqual(found.dropped, [{ fact: 'Decision 2: you write and review.', where: 'Plan' }]);
    assert.deepEqual(sourceDisputes(found.wrong).map(item => [item.quote, item.evidence, item.source]), [['The layout re-runs on every tab click', null, true]]);
  });

  test('a box from the source check has no link', () => {
    const block = disputeBlock({ quote: 'q', problem: 'Soft switches skip it.', correction: 'Only a first load runs it.', evidence: null });
    const text = JSON.stringify(block.blocks);
    assert.ok(!text.includes('Evidence'));
    assert.ok(text.includes('the course'));
    assert.ok(JSON.stringify(disputeBlock({ quote: 'q', problem: 'p', correction: 'c', evidence: 'https://example.com/x' }).blocks).includes('https://example.com/x'));
  });

  test('a scratch build can read chats from a folder of copies', () => {
    const before = process.env.LEARN_CHATS_DIR;
    try {
      process.env.LEARN_CHATS_DIR = '/tmp/scratch-chats';
      assert.equal(projectsDir(), '/tmp/scratch-chats');
      delete process.env.LEARN_CHATS_DIR;
      assert.match(projectsDir(), /projects$/);
    } finally {
      if (before === undefined) delete process.env.LEARN_CHATS_DIR;
      else process.env.LEARN_CHATS_DIR = before;
    }
  });
});

describe('the shape of a page', () => {
  test('a page may run to about what its material needs, never past the clamps', () => {
    assert.equal(pageBudget({ kind: 'chat', mainWords: 226 }), 900);
    assert.equal(pageBudget({ kind: 'chat', mainWords: 500 }), 1600);
    assert.equal(pageBudget({ kind: 'chat', mainWords: 5000 }), 2400, 'at most 2,400');
    assert.equal(pageBudget({ kind: 'youtube', mainWords: 0 }), 600, 'at least 600');
    assert.equal(pageBudget({ kind: 'web', mainWords: 1000, supportWords: 1000 }), 1600);
    assert.equal(pageBudget({ kind: 'youtube', mainWords: 2000 }), 1900);
    assert.equal(pageBudget({ kind: 'chat', mainWords: 500, audience: 'self' }), 1350, 'shorter for the one who was there');
    assert.equal(pageBudget({ kind: 'unknown', mainWords: 1000 }), 1300);
  });

  test('prose words leave out code, diagrams, cites, marks and table rules', () => {
    const markdown = [
      '## Why it is slow',
      'The layout waits on two calls [sec: Chain]. A toy page waits once (added; illustrative).',
      '',
      '```ts',
      'const x = await getSession();',
      '```',
      '',
      '> [!example] A short trace',
      '> One hop then [1:05] another.',
      '> ```bash',
      '> curl -s https://x',
      '> ```',
      '',
      '| hop | ms |',
      '|---|---|',
      '| proxy | 40 |',
    ].join('\n');
    assert.equal(proseWords(markdown), countWords('Why it is slow The layout waits on two calls. A toy page waits once. A short trace One hop then another. hop ms proxy 40'));
  });

  test('over means 15% over and 150 words over; no budget is never over', () => {
    assert.equal(isOver(1200, 1000), true);
    assert.equal(isOver(1100, 1000), false, 'a tenth over is fine');
    assert.equal(isOver(1000, 700), true);
    assert.equal(isOver(700, 600), false, '15% over but under 150 words over');
    assert.equal(isOver(9000, null), false);
  });

  test('tightening is kept only if the check finds no more wrong or missing', () => {
    const before = { wrong: [{}], dropped: [{}] };
    assert.equal(keepTighter(before, { wrong: [{}], dropped: [{}] }), true);
    assert.equal(keepTighter(before, { wrong: [], dropped: [] }), true);
    assert.equal(keepTighter(before, { wrong: [{}], dropped: [{}, {}] }), false);
    assert.equal(keepTighter(before, { wrong: [{}, {}], dropped: [] }), false);
    assert.equal(keepTighter({ ...before, missing: [], unclear: [] }, { ...before, missing: ['a subtopic'], unclear: [] }), false, 'a subtopic the reader now misses');
    assert.equal(keepTighter({ ...before, unclear: ['why'] }, { ...before, unclear: [] }), true);
  });

  test('the planner is told about how many pages its material fills', () => {
    assert.equal(plannedPages([{ kind: 'chat', sections: [{ text: 'word '.repeat(4500) }] }]), 10);
    assert.equal(plannedPages([{ kind: 'youtube', chunks: [{ text: 'word '.repeat(14000) }] }, { kind: 'web', sections: [{ text: 'word '.repeat(2000) }] }]), 12);
    assert.equal(plannedPages([{ kind: 'doc', sections: [{ text: 'tiny' }] }]), 3, 'at least 3');
    assert.equal(plannedPages([{ kind: 'chat', sections: [{ text: 'word '.repeat(90000) }] }]), 40, 'at most 40');
  });

  test('each term belongs to the first page that teaches it; the others refer back or forward', () => {
    const owners = ownerMap([{ teaches: ['JWT', 'Prefetch'] }, { teaches: ['jwt', 'Permission cache'] }, {}, { teaches: ['Held session'] }]);
    assert.deepEqual(owners[0].mine, ['JWT', 'Prefetch']);
    assert.deepEqual(owners[1].mine, ['Permission cache'], 'JWT is page 1\'s');
    assert.deepEqual(owners[1].earlier, [{ term: 'JWT', page: 1 }, { term: 'Prefetch', page: 1 }]);
    assert.deepEqual(owners[1].later, [{ term: 'Held session', page: 4 }]);
    assert.deepEqual(owners[2].mine, [], 'an older page with no teaches owns nothing');
    assert.equal(owners[2].earlier.length, 3);
  });

  test('what you have learned is passed on only from the course\'s own category', () => {
    const catalogue = emptyCatalogue();
    const ai = ensureCategory(catalogue, 'AI');
    const concept = addConcept(catalogue, { name: 'Gradient descent', definition: 'd', category: ai.id });
    setLearned(catalogue, concept.id, true);
    assert.deepEqual(learnedFor(catalogue, 'AI'), ['Gradient descent']);
    assert.deepEqual(learnedFor(catalogue, 'DevOps'), [], 'a category with no match gets nothing, not the whole catalogue');
    assert.deepEqual(learnedFor(catalogue, null), []);
  });

  test('a planner reads whole sections with their words when they fit, else their starts', () => {
    const sections = [{ heading: 'The plan', text: 'Phase 0 relaxes the rule. '.repeat(10) }, { heading: 'Risks', text: 'Tokens live 14 minutes.' }];
    const whole = outlineExcerpt(sections, 10_000);
    assert.ok(whole.includes('[sec: The plan] (50 words)'));
    assert.ok(whole.includes('Tokens live 14 minutes.'));
    const cut = outlineExcerpt([{ heading: 'Long', text: 'word '.repeat(5000) }], 1000);
    assert.ok(cut.length <= 1000);
    assert.ok(cut.startsWith('[sec: Long] (5000 words) '));
  });
});

describe('a video retells a page once', () => {
  const check = (id, guess = false) => ({ t: 'check', id, guess, q: parseInline(`Question ${id}?`), concepts: [], options: [{ inlines: parseInline('Right'), why: parseInline('Yes.'), right: 1 }, { inlines: parseInline('Wrong'), why: parseInline('No.') }] });
  const page = {
    title: 'Volumes',
    markdown: 'x',
    stats: {},
    terms: [{ term: 'volume', aka: ['volumes'], def: 'Storage that outlives a container.' }, { term: 'bind mount', aka: [], def: 'A host folder.' }],
    blocks: [
      ...markdownToBlocks('Why your data vanishes when a container goes.\n\n## Volumes\n\nVolumes keep your data safe when a container is removed.\n\nA second paragraph explains named volumes in more depth.'),
      check('q1', true), check('q2'), check('q3'),
      ...markdownToBlocks('## Bind mounts\n\nA bind mount maps a host folder into the container, unlike volumes.'),
      check('q4'), check('q5'),
      ...markdownToBlocks('## Recap\n\n- Volumes keep data.\n- Bind mounts map folders.'),
      check('q6'),
    ],
  };

  test('the recap is left out; its blocks and its section are not in the video', () => {
    const { blocks, sections } = flattenPage(page);
    assert.ok(!sections.includes('Recap'));
    assert.ok(!blocks.some(block => /Volumes keep data\./.test(block.text)));
  });

  test("the video asks the guess and each section's last quick check; watching must still answer all of them", () => {
    const { quiz, allQuiz } = flattenPage(page);
    assert.deepEqual(allQuiz.map(q => q.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    assert.deepEqual(quiz.map(q => q.id), ['q1', 'q3', 'q6'], 'at most two stops a clip: its guess and its last question');
    assert.deepEqual(videoQuiz(allQuiz.slice(0, 2)).map(q => q.id), ['q1', 'q2']);
    assert.equal(allQuiz.find(q => q.id === 'q6').section, 'Bind mounts', "a question under the recap stays with the section before it");
  });

  test('a word is explained in the first section that uses it', () => {
    const { blocks } = flattenPage(page);
    const taught = firstTaught(page.terms, blocks);
    assert.equal(taught.get('volume'), 'Volumes');
    assert.equal(taught.get('bind mount'), 'Bind mounts');
  });

  test('a section is budgeted at its prose once, plus a little for code, tables and diagrams', () => {
    const { blocks } = flattenPage(page);
    const mine = blocks.filter(block => block.section === 'Volumes');
    assert.equal(spokenBudget(mine), mine.reduce((total, block) => total + block.text.split(/\s+/).length, 0));
    assert.equal(spokenBudget([{ t: 'code', text: 'a\nb' }, { t: 'p', text: 'two words' }]), 62);
    assert.equal(spokenWords([{ check: 'q1', beats: [{ say: 'not counted here' }] }, { beats: [{ say: 'one two' }, { say: 'three' }] }]), 3);
  });

  test('length never fails a section: a long but correct one passes', () => {
    const material = flattenPage(page);
    const scenes = plainScenes('Volumes', material).map(scene => (scene.check ? scene : { ...scene, beats: [...scene.beats, ...scene.beats, ...scene.beats] }));
    assert.deepEqual(testSection('Volumes', { scenes }, material), []);
  });

  test('a section whose repairs ran out keeps its good scenes and reads out only what a failing one taught', () => {
    const material = flattenPage(page);
    const [first, second] = material.blocks.filter(block => block.section === 'Volumes');
    const good = { title: 'Kept', covers: [first.n], quote: 'Volumes keep your data safe when a container is removed', check: null, objects: [{ id: 'a', shape: 'box', x: 120, y: 200, w: 320, h: 130, text: 'Volumes' }], beats: [{ say: 'Volumes keep your data.', do: [{ on: 'Volumes', show: ['a'] }] }] };
    const bad = { title: 'Broken', covers: [second.n], quote: 'a sentence the page never says anywhere', check: null, objects: [], beats: [{ say: 'Named ones.', do: [] }] };
    const mended = mendSection('Volumes', { scenes: [good, bad], pronounce: [] }, material);
    assert.equal(mended.scenes.filter(scene => !scene.check)[0].title, 'Kept');
    assert.ok(mended.scenes.some(scene => scene.plain && scene.covers.includes(second.n)), 'the failing scene\'s block is read out');
    assert.deepEqual(mended.scenes.filter(scene => scene.check).map(scene => scene.check), material.quiz.filter(q => q.section === 'Volumes').map(q => q.id));
    assert.deepEqual(testSection('Volumes', mended, material), []);
    assert.equal(mendSection('Volumes', { scenes: [bad] }, material), null, 'no good scene: the whole section is rebuilt');
  });
});

describe('a video as clips', () => {
  const many = (word, n) => `${Array.from({ length: n }, (_, k) => `${word}${k}`).join(' ')}.`;
  const check = (id, guess = false) => ({ t: 'check', id, guess, q: parseInline(`Question ${id}?`), concepts: [], options: [{ inlines: parseInline('Right'), why: parseInline('Yes.'), right: 1 }, { inlines: parseInline('Wrong'), why: parseInline('No.') }] });
  const page = {
    title: 'Clips',
    markdown: 'x',
    stats: {},
    terms: [],
    blocks: [
      ...markdownToBlocks(`A short opening line.\n\n## Long one\n\n${many('alpha', 90)}\n\n## Another long one\n\n${many('beta', 80)}`),
      check('q1', true), check('q2'), check('q3'),
      ...markdownToBlocks('## Tail\n\nJust a few words here.'),
      check('q4'),
    ],
  };

  test('a section too small to stand alone joins the next, or the one before when it is last; questions go with it', () => {
    const material = mergeTiny(flattenPage(page));
    assert.deepEqual(material.sections, ['Long one', 'Another long one']);
    assert.equal(material.blocks.find(block => /opening line/.test(block.text)).section, 'Long one');
    assert.equal(material.blocks.find(block => /few words/.test(block.text)).section, 'Another long one');
    assert.equal(material.allQuiz.find(q => q.id === 'q4').section, 'Another long one');
    assert.deepEqual(material.quiz.map(q => q.id), ['q1', 'q4'], "the questions are picked again for the clips: the guess and the clip's last one");
    for (const section of material.sections) assert.deepEqual(testSection(section, { scenes: plainScenes(section, material) }, material), [], `${section} is made and tested as one clip`);
  });

  test('nothing is split, and one section stays one clip however small', () => {
    const one = mergeTiny(flattenPage({ ...page, blocks: markdownToBlocks('Only a line.') }));
    assert.deepEqual(one.sections, ['Introduction']);
    const scenes = [{ section: 'A', beats: [{ say: many('w', 440) }] }, { section: 'B', beats: [{ say: 'short' }] }];
    assert.deepEqual(longClips(['A', 'B'], scenes), ['A'], 'a clip over about 3 minutes is noted, not cut');
  });

  const box = (id, text, x = 100) => ({ id, shape: 'box', x, y: 200, w: 260, h: 120, text });
  const told = ({ hide = true } = {}) => ({
    title: 'Gateway',
    objects: [box('gw', 'App gateway'), box('c', 'checks', 420)],
    beats: [
      { say: 'The app gateway forwards checks.', do: [{ on: 'gateway', show: ['gw', 'c'] }] },
      { say: 'Then it steps aside.', do: [{ on: 'aside', ...(hide ? { hide: ['gw', 'c'] } : { set: { gw: { fade: true }, c: { fade: true } } }) }] },
      { say: 'Later the app gateway answers, and checks pass.', do: [] },
    ],
  });

  test('a sentence naming something the clip hid is flagged; an ordinary word is not, and a faded thing is fine', () => {
    const problems = keptOnScreen([told()]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /app gateway/);
    assert.deepEqual(keptOnScreen([told({ hide: false })]), []);
  });

  test('a new scene carries something over, unless it shows code, a table or a diagram; a question clears the stage anyway', () => {
    const fresh = { title: 'Fresh', objects: [box('x', 'Other thing')], beats: [{ say: 'Something else.', do: [{ on: null, show: ['x'] }] }] };
    const carried = { ...fresh, objects: [box('gw', 'App gateway'), box('x', 'Other thing', 420)], beats: [{ say: 'Something else.', do: [{ on: null, show: ['gw', 'x'] }] }] };
    const code = { ...fresh, objects: [{ id: 'k', shape: 'code', x: 40, y: 100, w: 540, h: 396, asset: 0 }], beats: [{ say: 'The code.', do: [{ on: null, show: ['k'] }] }] };
    const question = { title: 'Quick check', covers: [], quote: null, check: 'q1', objects: [], beats: [{ say: '', do: [] }] };
    const keep = told({ hide: false });
    assert.match(keptOnScreen([keep, fresh]).join(), /starts with none of the last scene's objects/);
    assert.deepEqual(keptOnScreen([keep, carried]), []);
    assert.deepEqual(keptOnScreen([keep, code]), []);
    assert.deepEqual(keptOnScreen([keep, question, fresh]), []);
  });

  test("what is kept on screen never fails a section: it's polish for Claude, not a reason to read a section out", () => {
    const material = mergeTiny(flattenPage(page));
    const [block] = material.blocks.filter(item => item.section === 'Long one');
    const scene = { ...told(), covers: material.blocks.filter(item => item.section === 'Long one').map(item => item.n), quote: block.text.split(' ').slice(0, 6).join(' '), check: null };
    assert.equal(keptOnScreen([scene]).length, 1);
    assert.ok(!testSection('Long one', { scenes: [scene] }, material).some(problem => /off screen/.test(problem)));
  });
});

describe("a video's plan: the map, each clip's guess, the failures it opens on", () => {
  const many = (word, n) => `${Array.from({ length: n }, (_, k) => `${word}${k}`).join(' ')}.`;
  const pageCheck = (id, guess = false) => ({ t: 'check', id, guess, q: parseInline(`Question ${id}?`), concepts: [], options: [{ inlines: parseInline('Right'), why: parseInline('Yes.'), right: 1 }, { inlines: parseInline('Wrong'), why: parseInline('No.') }] });
  const page = {
    title: 'Requests',
    markdown: 'x',
    stats: {},
    terms: [],
    blocks: [
      ...markdownToBlocks(`## Browser\n\nThe browser sends the request to the edge first. ${many('alpha', 80)}\n\n## Edge\n\nThe edge forwards the request to the api server. ${many('beta', 80)}`),
      pageCheck('p1'),
      ...markdownToBlocks(`## Api\n\nThe api reads the record and answers in one hop. ${many('gamma', 80)}`),
    ],
  };
  const material = mergeTiny(flattenPage(page));
  const guess = (quote, right = 0) => ({ q: 'Where does the request go first?', options: ['The edge', 'The api', 'The database'].map((text, k) => ({ text, why: `Because ${k}.`, right: k === right })), quote });
  const good = () => ({
    shape: 'flow',
    boxes: [{ id: 'b', label: 'Browser', parent: null }, { id: 'e', label: 'Edge', parent: null }, { id: 'a', label: 'Api server', parent: null }],
    clips: [
      { clip: 'Browser', box: 'b', handoff: null, handoffQuote: null, guess: guess('The browser sends the request to the edge first'), trap: [] },
      { clip: 'Edge', box: 'e', handoff: 'the request', handoffQuote: 'sends the request to the edge', guess: guess('The edge forwards the request to the api server', 1), trap: [] },
      { clip: 'Api', box: 'a', handoff: 'the request', handoffQuote: 'forwards the request to the api server', guess: guess('The api reads the record and answers', 2), trap: [] },
    ],
    splits: [],
  });

  test('a plan that holds stands whole', () => {
    const { problems, plan } = checkPlan(good(), material);
    assert.deepEqual(problems, []);
    assert.equal(plan.shape, 'flow');
    assert.deepEqual(plan.clips.map(entry => entry.box), ['b', 'e', 'a']);
    assert.equal(plan.clips[1].handoff, 'the request');
    assert.ok(plan.clips.every(entry => entry.guess));
  });

  test('a map that breaks the rules goes, and the rest of the plan stays', () => {
    const wide = good();
    wide.boxes.push(...['w', 'x'].map(id => ({ id, label: id.toUpperCase(), parent: null })));
    const { problems, plan } = checkPlan(wide, material);
    assert.match(problems.join(), /5 top boxes/);
    assert.equal(plan.shape, 'none');
    assert.deepEqual(plan.boxes, []);
    assert.ok(plan.clips.every(entry => entry.box === null && entry.handoff === null));
    assert.ok(plan.clips.every(entry => entry.guess), "the guesses don't depend on the map");
    const deep = good();
    deep.boxes.push({ id: 'c', label: 'Child', parent: 'a' }, { id: 'g', label: 'Grandchild', parent: 'c' });
    assert.match(checkPlan(deep, material).problems.join(), /third level/);
    const wordy = good();
    wordy.boxes[0].label = 'The browser that the user has open';
    assert.match(checkPlan(wordy, material).problems.join(), /1 to 3 words/);
  });

  test("a guess needs 3 options, one right, and a quote from its own clip; one that fails leaves that clip ungated", () => {
    const bad = good();
    bad.clips[0].guess.options.pop();
    bad.clips[2].guess.quote = 'The browser sends the request to the edge first';
    const { problems, plan } = checkPlan(bad, material);
    assert.match(problems.join(), /exactly 3 options and one right/);
    assert.match(problems.join(), /Clip "Api": the guess's quote is not word for word from this clip's blocks/);
    assert.equal(plan.clips[0].guess, null);
    assert.ok(plan.clips[1].guess);
    assert.equal(plan.clips[2].guess, null);
  });

  test('a clip with a guess of its own needs none; a handoff needs its quote; a trap stays inside its clip', () => {
    const withGuess = mergeTiny(flattenPage({ ...page, blocks: [...page.blocks.slice(0, 2), pageCheck('g1', true), ...page.blocks.slice(2)] }));
    const plan = good();
    plan.clips[0].guess = null;
    plan.clips[1].handoffQuote = 'words nowhere on the page at all';
    plan.clips[2].trap = [0, 999];
    const checked = checkPlan(plan, withGuess);
    const browserBlocks = withGuess.blocks.filter(block => block.section === 'Browser').map(block => block.n);
    assert.ok(!checked.problems.some(problem => /Clip "Browser" needs a guess/.test(problem)));
    assert.match(checked.problems.join(), /the handoff's quote/);
    assert.equal(checked.plan.clips[1].handoff, null);
    assert.ok(checked.plan.clips[2].trap.every(n => !browserBlocks.includes(n)));
  });

  test('fewer than 3 clips: no map', () => {
    const two = mergeTiny(flattenPage({ ...page, blocks: page.blocks.slice(0, 4) }));
    const plan = good();
    plan.clips = plan.clips.filter(entry => two.sections.includes(entry.clip));
    const checked = checkPlan(plan, two);
    assert.equal(checked.plan.shape, 'none');
  });

  test("each clip's guess joins the quiz as the video's own, asked first in its clip, and watching must answer it", () => {
    const { material: planned, map } = applyPlan(page, material, checkPlan(good(), material).plan);
    const own = planned.allQuiz.filter(q => q.videoOnly);
    assert.equal(own.length, 3);
    assert.ok(own.every(q => q.guess && /^v[0-9a-f]{10}$/.test(q.id)));
    for (const section of planned.sections) assert.equal(planned.quiz.find(q => q.section === section)?.videoOnly, true, `${section} opens on its own guess`);
    assert.ok(planned.quiz.some(q => q.id === 'p1'), "the page's own quick check is still asked");
    assert.deepEqual(map.clips.map(entry => entry.box), ['b', 'e', 'a']);
    for (const section of planned.sections) assert.deepEqual(testSection(section, { scenes: plainScenes(section, planned) }, planned), []);
    const missed = faultsBySection({ claims: {}, reading: { answers: [] }, blocks: planned.blocks, quiz: planned.allQuiz, sections: planned.sections });
    assert.ok([...missed.values()].flat().some(text => /Where does the request go first/.test(text)), 'a clip must teach the answer to its own guess');
  });

  test('a long clip may be split where its second idea starts; a short one never is', () => {
    const long = mergeTiny(flattenPage({ ...page, blocks: markdownToBlocks(`## One\n\n${many('a', 250)}\n\n${many('b', 250)}\n\n## Two\n\n${many('c', 90)}\n\n## Three\n\n${many('d', 90)}`) }));
    const second = long.blocks.find(block => block.section === 'One' && /^b0/.test(block.text)).n;
    const plan = { shape: 'none', boxes: [], clips: long.sections.map(clip => ({ clip, box: null, handoff: null, handoffQuote: null, guess: null, trap: [] })), splits: [{ clip: 'One', at: second, title: 'One, part two' }, { clip: 'Two', at: second, title: 'Nope' }] };
    const checked = checkPlan(plan, long);
    assert.deepEqual(checked.plan.splits.map(split => split.title), ['One, part two']);
    const { material: split } = applyPlan(page, long, checked.plan);
    assert.deepEqual(split.sections, ['One', 'One, part two', 'Two', 'Three']);
    assert.equal(split.blocks.find(block => block.n === second).section, 'One, part two');
  });

  test('an opener says 15 to 60 words, in 2 to 5 beats, with no code, table or diagram', () => {
    const quote = 'The browser sends the request to the edge first';
    const box = { id: 'x', shape: 'box', x: 100, y: 200, w: 300, h: 120, text: 'Edge', show: true };
    const opener = beats => ({ title: 'Straight to the api', covers: [], quote, check: null, objects: [box], beats });
    const say = text => ({ say: text, do: [{ on: null, set: { x: { fade: false } } }] });
    const fine = opener([say('Say the browser went straight to the api, skipping the edge entirely.'), say('Then nothing would stand between the user and the server at all.')]);
    assert.deepEqual(testOpener(fine, 'Opener', material.assets, material.pageText), []);
    assert.match(testOpener(opener([say('Too short.'), say('Really.')]), 'Opener', material.assets, material.pageText).join(), /say 15 to 60/);
    assert.match(testOpener({ ...fine, objects: [{ id: 'k', shape: 'code', x: 40, y: 100, w: 540, h: 396, asset: 0, show: true }] }, 'Opener', { code: [{ text: 'x' }], table: [], diagram: [] }, material.pageText).join(), /no code, table or diagram/);
  });
});

describe('a video without questions', () => {
  const many = (word, n) => `${Array.from({ length: n }, (_, k) => `${word}${k}`).join(' ')}.`;
  const pageCheck = id => ({ t: 'check', id, guess: false, q: parseInline(`Question ${id}?`), concepts: [], options: [{ inlines: parseInline('Right'), why: parseInline('Yes.'), right: 1 }, { inlines: parseInline('Wrong'), why: parseInline('No.') }] });
  const page = {
    title: 'Requests',
    markdown: 'x',
    stats: {},
    terms: [],
    blocks: [
      ...markdownToBlocks(`## Browser\n\nThe browser sends the request to the edge first. ${many('alpha', 80)}\n\n## Edge\n\nThe edge forwards the request to the api server. ${many('beta', 80)}`),
      pageCheck('p1'),
      ...markdownToBlocks(`## Api\n\nThe api reads the record and answers in one hop. ${many('gamma', 80)}`),
    ],
  };
  const material = mergeTiny(flattenPage(page));
  const guess = quote => ({ q: 'Where does the request go first?', options: ['The edge', 'The api', 'The database'].map((text, k) => ({ text, why: `Because ${k}.`, right: k === 0 })), quote });
  const fullPlan = () => ({
    shape: 'flow',
    boxes: [{ id: 'b', label: 'Browser', parent: null }, { id: 'e', label: 'Edge', parent: null }, { id: 'a', label: 'Api server', parent: null }],
    clips: [
      { clip: 'Browser', box: 'b', handoff: null, handoffQuote: null, guess: guess('The browser sends the request to the edge first'), trap: [], mask: false, patternOf: null, patternQuote: null },
      { clip: 'Edge', box: 'e', handoff: null, handoffQuote: null, guess: guess('The edge forwards the request to the api server'), trap: [], mask: false, patternOf: null, patternQuote: null },
      { clip: 'Api', box: 'a', handoff: null, handoffQuote: null, guess: null, trap: [], mask: false, patternOf: null, patternQuote: null },
    ],
    splits: [],
    groups: [{ box: 'b', q: 'Q?', options: [], needs: [], quotes: [] }],
  });

  test('the plan is asked for no guess, masked line, pattern or group question, and none is a problem', () => {
    const prompt = planRequest(page, material, null, false);
    assert.doesNotMatch(prompt, /GUESS QUESTION|"mask"|"groups"|HAS A GUESS ALREADY|\(CODE\)/);
    assert.match(planRequest(page, material), /GUESS QUESTION/);
    const schema = planSchema(false);
    assert.ok(!('groups' in schema.properties));
    assert.ok(!schema.required.includes('groups'));
    assert.deepEqual(Object.keys(schema.properties.clips.items.properties).sort(), ['box', 'clip', 'handoff', 'handoffQuote', 'trap']);
    const { problems, plan } = checkPlan(fullPlan(), material, { questions: false });
    assert.ok(!problems.some(problem => /guess|group/i.test(problem)), problems.join('\n'));
    assert.ok(plan.clips.every(entry => entry.guess === null && entry.mask === false && entry.patternOf === null));
    assert.deepEqual(plan.groups, []);
    assert.equal(plan.shape, 'flow');
    // With questions on, the clip with no guess is still a problem.
    assert.ok(checkPlan(fullPlan(), material).problems.some(problem => /"Api" needs a guess question/.test(problem)));
  });

  const scriptWith = async questions => {
    const prompts = [];
    const ask = async (prompt, schema) => {
      prompts.push({ prompt, schema });
      if (schema.properties.shape) return fullPlan();
      if (schema.properties.openers) return { openers: [], pronounce: [] };
      if (schema.properties.scenes) return { scenes: [], pronounce: [] };
      if (schema.properties.answers) return { answers: [], closing: [], unknown: [], missing: [] };
      return { added: [], dropped: [] };
    };
    return { script: await writeScript({ page, ask, questions }), prompts };
  };

  test('off: nothing that stops the video is written, asked for or kept, though the watcher still has the page\'s questions', async () => {
    const { script, prompts } = await scriptWith(false);
    assert.equal(script.withQuestions, false);
    assert.deepEqual(script.quiz, []);
    assert.deepEqual(script.openers, {});
    assert.ok(!script.scenes.some(scene => scene.check || scene.masks?.length));
    assert.ok(!prompts.some(({ schema }) => schema.properties.openers), 'no opener was asked for');
    assert.ok(!prompts.some(({ prompt }) => /^QUIZ:|^QUESTIONS\./m.test(prompt)), 'no section was told about questions');
  });

  test('on: the guesses and the page\'s own question are in the video', async () => {
    const { script, prompts } = await scriptWith(true);
    assert.equal(script.withQuestions, true);
    assert.ok(script.quiz.some(q => q.guess));
    assert.ok(script.quiz.some(q => q.id === 'p1'));
    assert.ok(prompts.some(({ schema }) => schema.properties.openers));
    assert.ok(prompts.some(({ prompt }) => /^QUIZ:/m.test(prompt)));
  });
});

describe('a masked line, group questions and repeated patterns', () => {
  const many = (word, n) => `${Array.from({ length: n }, (_, k) => `${word}${k}`).join(' ')}.`;
  const code = ['function forward(request) {', '  const token = mint(request.user);', '  request.headers.auth = token;', '  return send(request);', '}'].join('\n');
  const pageCheck = (id, guess = false) => ({ t: 'check', id, guess, q: parseInline(`Question ${id}?`), concepts: [], options: [{ inlines: parseInline('Right'), why: parseInline('Yes.'), right: 1 }, { inlines: parseInline('Wrong'), why: parseInline('No.') }] });
  const page = {
    title: 'Gateway',
    markdown: 'x',
    stats: {},
    terms: [],
    blocks: [
      ...markdownToBlocks(`## Shell\n\nThe shell shows every app as a tab. ${many('alpha', 80)}\n\n## Gateway\n\nThe gateway mints a token for each request it forwards. ${many('beta', 80)}\n\n\`\`\`js\n${code}\n\`\`\``),
      pageCheck('end1'),
      ...markdownToBlocks(`## Backend\n\nThe backend checks the token before it answers. ${many('gamma', 80)}`),
      pageCheck('end2'),
    ],
  };
  const material = mergeTiny(flattenPage(page));
  const question = (quote, right = 0) => ({ q: 'What happens?', options: ['One', 'Two', 'Three'].map((text, k) => ({ text, why: `Because ${k}.`, right: k === right })), quote });
  const plan = () => ({
    shape: 'flow',
    boxes: [{ id: 'front', label: 'Front', parent: null }, { id: 'back', label: 'Back', parent: null }],
    clips: [
      { clip: 'Shell', box: 'front', handoff: null, handoffQuote: null, guess: question('The shell shows every app as a tab'), trap: [], mask: true, patternOf: null, patternQuote: null },
      { clip: 'Gateway', box: 'front', handoff: null, handoffQuote: null, guess: question('The gateway mints a token for each request'), trap: [], mask: true, patternOf: null, patternQuote: null },
      { clip: 'Backend', box: 'back', handoff: 'a token', handoffQuote: 'mints a token for each request', guess: question('The backend checks the token before it answers'), trap: [], mask: false, patternOf: 'Gateway', patternQuote: 'The backend checks the token before it answers' },
    ],
    splits: [],
    groups: [{ box: 'front', q: 'What do the shell and the gateway share?', options: ['A', 'B', 'C'].map((text, k) => ({ text, why: 'w', right: !k })), needs: ['Shell', 'Gateway'], quotes: [{ clip: 'Shell', quote: 'The shell shows every app as a tab' }, { clip: 'Gateway', quote: 'The gateway mints a token for each request' }] }],
  });

  test('only a clip with code worth asking about may mask a line; a group question closes its box, so that clip has none', () => {
    assert.ok(maskable(material, 'Gateway'));
    assert.ok(!maskable(material, 'Shell'));
    const { problems, plan: checked } = checkPlan(plan(), material);
    assert.deepEqual(problems, []);
    assert.deepEqual(checked.clips.map(entry => entry.mask), [false, false, false], 'Shell has no code; Gateway closes the group; Backend has no code');
    assert.equal(checked.clips[2].patternOf, 'Gateway');
    assert.equal(checked.groups.length, 1);
    assert.equal(checked.groups[0].last, 'Gateway');
  });

  test("a group question needs two of its own box's clips, a quote from each, and one right answer", () => {
    const bad = plan();
    bad.groups[0].needs = ['Shell', 'Backend'];
    assert.match(checkPlan(bad, material).problems.join(), /must name two or three of its own clips/);
    const unquoted = plan();
    unquoted.groups[0].quotes.pop();
    assert.match(checkPlan(unquoted, material).problems.join(), /no quote word for word from clip "Gateway"/);
    const later = plan();
    later.clips[0].patternOf = 'Backend';
    assert.match(checkPlan(later, material).problems.join(), /must name an earlier clip/);
  });

  test("the group question is its box's last clip's end question; a clip with a mask asks no end question; watching answers both", () => {
    const noGroup = plan();
    noGroup.groups = [];
    const masked = applyPlan(page, material, checkPlan(noGroup, material).plan).material;
    assert.ok(masked.masks.has('Gateway'));
    assert.ok(!masked.quiz.some(q => q.id === 'end1'), 'the mask is the second stop');
    assert.ok(masked.allQuiz.some(q => q.id === 'end1'), 'still answered by watching');
    const grouped = applyPlan(page, material, checkPlan(plan(), material).plan).material;
    const end = grouped.quiz.filter(q => q.section === 'Gateway' && !q.guess);
    assert.equal(end.length, 1);
    assert.deepEqual(end[0].group, ['Shell', 'Gateway']);
    assert.equal(grouped.patterns.Backend, 'Gateway');
  });

  const codeScene = (beatDo, extra = {}) => ({ title: 'The code', covers: [], quote: null, check: null, objects: [{ id: 'k', shape: 'code', x: 40, y: 100, w: 540, h: 396, asset: 0 }], beats: [{ say: 'Here it is.', do: [{ on: null, show: ['k'] }] }, { say: 'So what must line 2 do?', do: [beatDo] }], ...extra });
  const opening = { title: 'First', covers: [], quote: null, check: null, objects: [], beats: [{ say: 'First.', do: [] }] };
  const allowed = { ...material, masks: new Set(['Gateway']) };
  const mask = choices => ({ on: 'line', mask: { id: 'k', line: 2, choices } });

  test('a mask becomes the hidden line and the pick, with the real line as the answer', () => {
    const { result, notes } = settleMasks({ scenes: [opening, codeScene(mask(['  request.body = token;', '  request.headers.auth = request.user;']))] }, allowed, 'Gateway');
    assert.deepEqual(notes, []);
    const scene = result.scenes[1];
    assert.equal(scene.masks.length, 1);
    assert.equal(scene.masks[0].answer, 'request.headers.auth = token;');
    assert.equal(scene.masks[0].beat, 1);
    assert.deepEqual(scene.beats[1].do[0].set.k, { mask: 2 });
    assert.equal(stopsOf(result.scenes), 1);
  });

  test("a mask that doesn't hold is taken out and told to Claude: never in another clip, the first scene, or with a real line as a wrong choice", () => {
    const good = ['  request.body = token;', '  request.headers.auth = request.user;'];
    const out = (scenes, section = 'Gateway') => settleMasks({ scenes }, allowed, section);
    assert.match(out([opening, codeScene(mask(good))], 'Shell').notes.join(), /has no masked line/);
    assert.match(out([codeScene(mask(good))]).notes.join(), /not in its first scene/);
    assert.match(out([opening, codeScene(mask(['  return send(request);', good[1]]))]).notes.join(), /real line of the page's code/);
    assert.match(out([opening, codeScene(mask([good[0]]))]).notes.join(), /exactly 2 wrong versions/);
    assert.match(out([opening, codeScene(mask(['x', good[1]]))]).notes.join(), /about its length/);
    const removed = out([opening, codeScene(mask(['x', good[1]]))]).result.scenes[1];
    assert.ok(!removed.masks && !removed.beats[1].do[0].mask, 'nothing of it is left to play');
    assert.match(out([opening]).notes.join(), /hide the one line/, 'a clip given a mask is reminded when it has none');
  });

  test('a clip stops twice at most', () => {
    const q = id => ({ title: 'Quick check', covers: [], quote: null, check: id, objects: [], beats: [{ say: '', do: [] }] });
    assert.equal(stopsOf([q('a'), { masks: [{}] }, q('b')]), 3);
    assert.ok(testSection('Gateway', { scenes: [q('a'), { masks: [{}], title: 'x', covers: [], beats: [] }, q('b')] }, material).some(problem => /stops 3 times/.test(problem)));
    const twoGuesses = videoQuiz([{ id: 'g1', guess: true, section: 'A' }, { id: 'g2', guess: true, section: 'A' }, { id: 'e', guess: false, section: 'A' }]);
    assert.deepEqual(twoGuesses.map(item => item.id), ['g1', 'e'], 'one guess a clip, however many the page has');
  });
});

describe('an explainer: your session plans clips about code, Learn checks and makes them', () => {
  const guess = (quote, right = 0) => ({ q: 'What happens?', options: ['One', 'Two', 'Three'].map((text, k) => ({ text, why: `Because ${k}.`, right: k === right })), quote });
  const plan = () => ({
    title: 'Tokens',
    shape: 'parts',
    boxes: [{ id: 'a', label: 'Minting', parent: null }, { id: 'b', label: 'Checking', parent: null }],
    clips: [
      { title: 'Minting', box: 'a', level: 1, facts: [{ text: 'The gateway mints a token for each request.', basis: 'code' }], anchors: [{ file: 'gw.js', from: 1, to: 4, expect: 'mint(request.user)' }], guess: guess('mints a token for each request') },
      { title: 'Checking', box: 'b', level: 2, facts: [{ text: 'We decided the backend checks every token.', basis: 'session', quote: 'the backend checks every token' }], anchors: [], guess: guess('the backend checks every token', 1) },
      { title: 'Edges', box: 'b', level: 3, facts: [{ text: 'An expired token is refused.', basis: 'code' }], anchors: [], guess: guess('An expired token is refused', 2), failure: [0] },
    ],
  });

  test("a plan's shape is checked before anything is read: clip 1 is the mental model, session facts carry a quote, guesses have 3 options", () => {
    assert.deepEqual(explainProblems(plan()), []);
    const bad = plan();
    bad.clips[0].level = 2;
    bad.clips[1].facts[0].quote = 'too short';
    bad.clips[2].guess.options.pop();
    bad.clips[2].failure = [4];
    bad.clips.push({ ...plan().clips[0], title: 'Minting' });
    const problems = explainProblems(bad).join('\n');
    assert.match(problems, /Clip 1 is the mental model/);
    assert.match(problems, /needs a quote of 4 words or more/);
    assert.match(problems, /3 options with a why each/);
    assert.match(problems, /"failure" lists fact numbers/);
    assert.match(problems, /its own title/);
    const long = plan();
    long.clips[0].anchors[0].to = 200;
    assert.match(explainProblems(long).join(), /over 60 lines/);
  });

  test('code is read from disk inside the folder or under home: a file outside both, lines past its end, or lines without "expect" are refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'explain-'));
    mkdirSync(join(root, 'work'));
    writeFileSync(join(root, 'work', 'gw.js'), 'function forward(request) {\n  const token = mint(request.user);\n  return send(request, token);\n}\n');
    writeFileSync(join(root, 'secret.txt'), 'outside');
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    mkdirSync(home);
    assert.equal(anchorFile(cwd, '../secret.txt', { home }).error, 'outside');
    assert.equal(anchorFile(cwd, 'gw.js', { home }).shown, 'gw.js');
    const read = readAnchors(plan(), cwd, { home });
    assert.deepEqual(read.problems, []);
    assert.match(read.clips[0].anchors[0].code, /const token = mint/);
    const moved = plan();
    moved.clips[0].anchors.push({ file: 'gw.js', from: 1, to: 9, expect: 'x' }, { file: 'gw.js', from: 1, to: 2, expect: 'send(' }, { file: '../secret.txt', from: 1, to: 1, expect: 'outside' }, { file: 'nope.js', from: 1, to: 1, expect: 'x' });
    const problems = readAnchors(moved, cwd, { home }).problems.join('\n');
    assert.match(problems, /the file has 5 lines/);
    assert.match(problems, /"send\(" is not in those lines/);
    assert.match(problems, /not a file in this project or under your home folder/);
    assert.match(problems, /nope\.js:1-1: no such file/);
    rmSync(root, { recursive: true, force: true });
  });

  test('a file anywhere under home is read and shown as ~/...; files that look like secrets never are, even through a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'explain-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    for (const dir of [cwd, join(home, 'lib'), join(home, '.ssh')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, 'lib', 'util.js'), 'export const retry = n => n + 1;\nconst API_KEY = "sk-abcdef1234567890";\n');
    for (const name of ['.env', '.env.example', 'id_ed25519', '.ssh/config']) writeFileSync(join(home, name), 'x');
    symlinkSync(join(home, '.ssh', 'config'), join(cwd, 'harmless.txt'));
    assert.deepEqual(anchorFile(cwd, join(home, 'lib', 'util.js'), { home }).shown, '~/lib/util.js');
    assert.equal(anchorFile(cwd, '~/lib/util.js', { home }).shown, '~/lib/util.js');
    for (const file of ['~/.env', '~/id_ed25519', '~/.ssh/config', 'harmless.txt']) assert.equal(anchorFile(cwd, file, { home }).error, 'secret', file);
    assert.ok(anchorFile(cwd, '~/.env.example', { home }).real);
    assert.equal(anchorFile(cwd, '/etc/hostname', { home }).error, 'outside');
    for (const path of ['a/.aws/credentials', 'key.pem', 'secrets.yaml', '.npmrc', 'x/.config/gh/hosts.yml']) assert.ok(looksSecret(path), path);
    for (const path of ['src/credentials.ts', 'keys.ts', 'gw.js', '.env.sample']) assert.ok(!looksSecret(path), path);
    const read = readAnchors({ clips: [{ anchors: [{ file: '~/lib/util.js', from: 1, to: 2, expect: 'retry' }, { file: '~/.env', from: 1, to: 1, expect: 'x' }] }] }, cwd, { home });
    assert.match(read.problems.join('\n'), /Learn doesn't read files that look like secrets/);
    assert.equal(read.clips[0].anchors[0].file, '~/lib/util.js');
    assert.doesNotMatch(read.clips[0].anchors[0].code, /sk-abcdef1234567890/);
    rmSync(root, { recursive: true, force: true });
  });

  test('the depth you picked in the chat comes with the plan: 1, 2 or 3, or left out for the player to ask', () => {
    assert.deepEqual(explainProblems({ ...plan(), depth: 2 }), []);
    assert.deepEqual(explainProblems({ ...plan(), depth: null }), []);
    assert.match(explainProblems({ ...plan(), depth: 4 }).join(), /"depth" is 1, 2 or 3/);
    assert.match(explainProblems({ ...plan(), depth: '2' }).join(), /"depth" is 1, 2 or 3/);
  });

  test('a checked plan keeps its depth, so the player never asks; without one it is null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'explain-'));
    writeFileSync(join(root, 'gw.js'), 'function forward(request) {\n  const token = mint(request.user);\n  return send(request, token);\n}\n');
    const one = { ...plan(), shape: 'none', boxes: [], clips: [plan().clips[0]] };
    const io = { askStructured: async () => ({ wrong: [] }) };
    const withDepth = await checkExplainer({ plan: { ...one, depth: 2 }, sessionId: 's', cwd: root, io });
    assert.equal(withDepth.explainer.depth, 2);
    const without = await checkExplainer({ plan: one, sessionId: 's', cwd: root, io });
    assert.equal(without.explainer.depth, null);
    rmSync(root, { recursive: true, force: true });
  });

  test('a fact with code in it goes back: ticks, a call or an arrow; a plain name or a value is fine', () => {
    const saying = text => { const one = plan(); one.clips[0].facts[0].text = text; return explainProblems(one).join(); };
    for (const text of ['The gateway calls `mint` first.', 'It runs mint() for each request.', 'It maps user => token.']) assert.match(saying(text), /has code in it: say in plain words/);
    for (const text of ['The gateway mints a token (once) for each request.', 'Set WIKI_API_KEY before you start, or type /clips wiki.', 'It waits 2 seconds, then tries again.']) assert.doesNotMatch(saying(text), /has code/);
  });

  test("the code is read for the check alone: the check sees it, and neither the clip's page nor the saved plan has it", async () => {
    const root = mkdtempSync(join(tmpdir(), 'explain-'));
    writeFileSync(join(root, 'gw.js'), 'function forward(request) {\n  const token = mint(request.user);\n  return send(request, token);\n}\n');
    let prompt = '';
    const io = { askStructured: async asked => { prompt = asked.prompt; return { wrong: [] }; } };
    const { explainer: checked } = await checkExplainer({ plan: { ...plan(), shape: 'none', boxes: [], clips: [plan().clips[0]] }, sessionId: 's', cwd: root, io });
    assert.match(prompt, /mint\(request\.user\)/);
    assert.deepEqual(checked.clips[0].anchors, [{ file: 'gw.js', from: 1, to: 4 }]);
    assert.doesNotMatch(JSON.stringify(checked), /mint\(request/);
    assert.doesNotMatch(clipPage(checked, 1).markdown, /```|mint\(/);
    rmSync(root, { recursive: true, force: true });
  });

  test("a guess's answer is stated in the clip's facts: words only its code has are not enough", async () => {
    const root = mkdtempSync(join(tmpdir(), 'explain-'));
    writeFileSync(join(root, 'gw.js'), 'function forward(request) {\n  const token = mint(request.user);\n  return send(request, token);\n}\n');
    const one = { ...plan(), shape: 'none', boxes: [], clips: [plan().clips[0]] };
    one.clips[0].guess.quote = 'const token = mint request user';
    const io = { askStructured: async () => assert.fail('checked though its guess is not in its facts') };
    assert.match((await checkExplainer({ plan: one, sessionId: 's', cwd: root, io })).problems.join(), /quote is not word for word from its facts/);
    rmSync(root, { recursive: true, force: true });
  });

  test("a session fact's quote must be in what the chat said or a tool returned, never in a tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chats-'));
    const id = '11111111-2222-3333-4444-555555555555';
    mkdirSync(join(dir, 'project'));
    const lines = [
      { type: 'user', message: { content: 'I think the backend checks every token, right?' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo "a sentence typed into a command"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'test failed: token expired at 10:02' }] } },
    ];
    writeFileSync(join(dir, 'project', `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'));
    const found = await quotesInChat(id, ['the backend checks every token', 'a sentence typed into a command', 'token expired at 10:02'], { dir });
    assert.deepEqual([...found].sort(), ['the backend checks every token', 'token expired at 10:02']);
    rmSync(dir, { recursive: true, force: true });
  });

  const explainer = () => ({ id: 'x202611181332459e', title: 'Tokens', map: { shape: 'none', boxes: [], clips: [] }, depth: null, at: 1, clips: plan().clips.map(clip => ({ ...clip, failure: clip.failure || [] })) });

  test('a clip is a page of one section: its facts and no code; its plan has its guess and its failures, and no masked line', () => {
    const page = clipPage(explainer(), 1);
    const material = flattenPage(page);
    assert.deepEqual(material.sections, ['Minting']);
    assert.deepEqual(material.blocks.map(block => block.t), ['p']);
    assert.deepEqual(material.assets.code, []);
    const made = clipPlan(explainer(), 3);
    assert.equal(made.shape, 'none');
    assert.deepEqual(made.clips[0].trap, [0]);
    assert.equal(made.clips[0].mask, false);
    const checked = checkPlan(clipPlan(explainer(), 1), material);
    assert.ok(checked.plan.clips[0].guess, "the guess's quote is on the clip's page");
  });

  test('clips are made in order: clip 1 before you pick a depth, then every clip of the depth picked, the one you watch first', () => {
    const lib = { root: mkdtempSync(join(tmpdir(), 'lib-')) };
    const one = { ...explainer(), clips: [...explainer().clips, ...explainer().clips.map((clip, k) => ({ ...clip, title: `More ${k}`, level: 2 }))] };
    assert.deepEqual(nextClip(lib, one), { n: 1 });
    const made = n => { mkdirSync(join(explainPaths(lib, one.id).dir, 'clips'), { recursive: true }); writeFileSync(`${explainPaths(lib, one.id).clip(n)}.json`, '{}'); };
    made(1);
    assert.deepEqual(nextClip(lib, one), { wait: true }, 'no depth picked yet');
    assert.deepEqual(nextClip(lib, { ...one, depth: 2 }), { n: 2 });
    made(2);
    assert.deepEqual(nextClip(lib, { ...one, depth: 2 }), { n: 4 }, 'clip 3 is past depth 2');
    made(4);
    assert.deepEqual(nextClip(lib, { ...one, depth: 2 }), { n: 5 }, 'no limit ahead of the clip watched: nobody need be watching');
    assert.deepEqual(nextClip(lib, { ...one, depth: 2, at: 6 }), { n: 6 }, 'the clip being watched first');
    assert.deepEqual(nextClip(lib, { ...one, depth: 2, at: 6 }, new Set([6])), { n: 5 }, 'then the ones before it');
    const info = explainInfo(lib, { ...one, depth: 2 });
    assert.deepEqual(info.counts, [1, 5, 6]);
    assert.deepEqual(info.clips.slice(0, 4).map(clip => clip.state), ['ready', 'ready', 'left out', 'ready']);
    assert.deepEqual(clipCounts(lib, { ...one, depth: 2 }), { done: 3, total: 5 });
    made(5);
    made(6);
    assert.deepEqual(nextClip(lib, { ...one, depth: 2 }), { done: true }, 'clip 3 is never made at depth 2');
    assert.deepEqual(nextClip(lib, one), { wait: true }, 'with no depth, clip 3 waits for a pick');
    rmSync(lib.root, { recursive: true, force: true });
  });

  test('with the depth picked in the chat, every clip of it is made at once, never waiting for a pick', () => {
    const lib = { root: mkdtempSync(join(tmpdir(), 'lib-')) };
    const picked = { ...explainer(), depth: 3 };
    const made = n => { mkdirSync(join(explainPaths(lib, picked.id).dir, 'clips'), { recursive: true }); writeFileSync(`${explainPaths(lib, picked.id).clip(n)}.json`, '{}'); };
    made(1);
    assert.deepEqual(nextClip(lib, picked), { n: 2 });
    assert.equal(wantedClips({ ...explainer(), depth: 1 }), 1);
    assert.equal(wantedClips(explainer()), 3, 'before a pick, all of them');
    rmSync(lib.root, { recursive: true, force: true });
  });

  test("the Library lists every explainer, newest first: its clips in depth, how many are made, and what it's doing", () => {
    const lib = { root: mkdtempSync(join(tmpdir(), 'lib-')) };
    const older = saveExplainer(lib, { ...explainer(), id: 'x202611010000aaaa', title: 'Older', depth: 1, createdAt: '2026-11-01T00:00:00Z' });
    const newer = saveExplainer(lib, { ...explainer(), id: 'x202611200000bbbb', title: 'Newer', depth: 2, createdAt: '2026-11-20T00:00:00Z' });
    saveExplainer(lib, { ...explainer(), id: 'x202611150000cccc', title: 'Waiting', depth: null, createdAt: '2026-11-15T00:00:00Z' });
    mkdirSync(join(lib.root, 'explainers', 'junk'), { recursive: true });
    mkdirSync(join(explainPaths(lib, older.id).dir, 'clips'), { recursive: true });
    writeFileSync(`${explainPaths(lib, older.id).clip(1)}.json`, '{}');
    const listed = listExplainers(lib, [{ kind: 'explain', explain: newer.id, state: 'running' }]);
    assert.deepEqual(listed.map(item => item.title), ['Newer', 'Waiting', 'Older']);
    assert.deepEqual(listed.map(item => item.state), ['making', 'waiting', 'ready']);
    assert.deepEqual(listed.map(item => [item.ready, item.clips]), [[0, 2], [0, 3], [1, 1]]);
    assert.deepEqual(listExplainers({ root: join(lib.root, 'none') }), []);
    rmSync(lib.root, { recursive: true, force: true });
  });

  test("a section's request tells the writer the room its code needs, without the file's indentation, and offers no camera", async () => {
    const code = ['function forward(request) {', '  const token = mint(request.user);', '  return send(request, token);', '}'];
    const page = lines => { const markdown = `## Minting\n\nThe gateway mints a token for each request.\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\``; return { ...clipPage(explainer(), 1), markdown, blocks: markdownToBlocks(markdown) }; };
    const indented = code.map(line => `          ${line}`);
    const prompts = [];
    const ask = async (prompt, schema) => {
      prompts.push(prompt);
      if (schema.properties.scenes) return { scenes: [], pronounce: [] };
      if (schema.properties.answers) return { answers: [], closing: [], unknown: [], missing: [] };
      return { added: [], dropped: [] };
    };
    await writeScript({ page: page(indented), ask, plan: clipPlan(explainer(), 1), questions: false });
    const request = prompts.find(prompt => /THE STAGE/.test(prompt));
    const needs = codeNeeds(indented.join('\n'));
    assert.match(request, new RegExp(`needs at least ${needs.w} by ${needs.h} on stage`));
    assert.equal(needs.w, codeNeeds(code.join('\n')).w, 'indentation is not counted');
    assert.doesNotMatch(request, /w 540|"camera"/);
  });
});

describe('the picture: measured as drawn, framed without cropping, arrows and containers kept clear', () => {
  const assets = { code: [], table: [], diagram: [] };
  const sim = scene => { const problems = []; simulate(scene, 'S', assets, problems); return problems; };
  const shown = objects => ({ objects: objects.map(o => ({ show: true, ...o })), beats: [] });

  test('a row is as wide as its cells, which grow with their text, and wraps within its width', () => {
    // A one-cell row in a wide space is drawn where its cell is, not across its whole width.
    const one = roughRect({ shape: 'row', x: 820, y: 300, w: 240, items: [{ label: 'explain.md', sub: 'prompt file' }] });
    assert.ok(one.x + one.w > 1040, 'its long label widens the cell past the old guess');
    // The row that cut off "mcp": four cells under long subs, drawn far wider than the old 478.
    const src = roughRect({ shape: 'row', x: 60, y: 380, w: 1000, items: [{ label: 'builtin', sub: 'ships with Claude Code' }, { label: 'plugin', sub: 'markdown command' }, { label: 'user', sub: 'your own file' }, { label: 'mcp', sub: 'server prompt' }] });
    assert.ok(src.w > 700 && src.x < 200, JSON.stringify(src));
    const narrow = roughRect({ shape: 'row', x: 100, y: 100, w: 300, items: ['alpha', 'bravo', 'charlie', 'delta'].map(label => ({ label })) });
    const wide = roughRect({ shape: 'row', x: 100, y: 100, w: 1000, items: ['alpha', 'bravo', 'charlie', 'delta'].map(label => ({ label })) });
    assert.ok(narrow.h > wide.h, 'cells that do not fit wrap to a second line');
  });

  test('a label with no width is one line as long as its text; a centred number sits in the middle of its width', () => {
    const label = roughRect({ shape: 'label', x: 100, y: 100, text: 'x'.repeat(30), size: 'm' });
    assert.ok(label.w > 300 && label.h < 30, 'one line, wider than the old 300');
    const number = roughRect({ shape: 'number', x: 100, y: 100, w: 400, value: 7, align: 'center' });
    assert.ok(number.x > 250);
  });

  test('the camera crops nothing: it pulls back and moves until everything shown is inside the frame', () => {
    const inFrame = (cam, r) => (r.x - cam.x) * cam.zoom + 560 >= 29 && (r.x + r.w - cam.x) * cam.zoom + 560 <= 1091 && (r.y - cam.y) * cam.zoom + 298 >= 85 && (r.y + r.h - cam.y) * cam.zoom + 298 <= 511;
    const rects = [{ x: 60, y: 200, w: 640, h: 70 }, { x: 780, y: 200, w: 280, h: 290 }];
    const fitted = fitCamera({ x: 380, y: 160, zoom: 1.4 }, rects);
    assert.ok(rects.every(r => inFrame(fitted, r)), JSON.stringify(fitted));
    const fine = { x: 560, y: 298, zoom: 1 };
    assert.equal(fitCamera(fine, [{ x: 200, y: 200, w: 300, h: 100 }]), fine, 'a camera that fits is left alone');
    const state = new Map([['r', { id: 'r', shape: 'row', x: 800, y: 300, w: 280, visible: true, items: [{ label: 'register.tsx', sub: 'hooks' }] }], ['b', { id: 'b', shape: 'box', x: 60, y: 300, w: 200, h: 100, visible: true }]]);
    const cam = frameFor(state, null, assets);
    assert.ok([...state.values()].every(o => inFrame(cam, roughRect(o, assets))), JSON.stringify(cam));
  });

  test("an outline with something inside it is a container, its name on its top edge; an empty outline or a solid box isn't", () => {
    const state = new Map([
      ['c', { id: 'c', shape: 'box', style: 'outline', x: 100, y: 150, w: 500, h: 300, text: 'Code part', visible: true }],
      ['in', { id: 'in', shape: 'box', x: 150, y: 200, w: 200, h: 100, visible: true }],
      ['e', { id: 'e', shape: 'box', style: 'outline', x: 700, y: 150, w: 300, h: 100, visible: true }],
      ['s', { id: 's', shape: 'box', x: 700, y: 300, w: 300, h: 150, visible: true }],
    ]);
    assert.deepEqual([...containers(state, assets)], ['c']);
    assert.deepEqual(legendRect({ x: 100, y: 150, text: 'Code part' }).y, 140);
  });

  test("code is drawn without the indentation its lines share; blank lines don't count, tabs are four spaces, no line is lost", () => {
    assert.equal(dedent('    a\n      b\n\n    c'), 'a\n  b\n\nc');
    assert.equal(dedent('\ta\n\t\tb'), 'a\n    b');
    assert.equal(dedent('a\n  b'), 'a\n  b');
    assert.equal(dedent('  x\n  y\n  z').split('\n').length, 3);
  });

  test("an arrow runs edge to edge between what it joins, as before; its text moves along the line off what's there", () => {
    const a = { x: 100, y: 200, w: 200, h: 100 }, b = { x: 600, y: 200, w: 200, h: 100 };
    assert.deepEqual(wireEnds({ from: 'a', to: 'b' }, id => ({ a, b })[id]), [...edgePoint(a, 700, 250), ...edgePoint(b, 200, 250)]);
    assert.deepEqual(wireEnds({ x: 1, y: 2, x2: 3, y2: 4 }, () => null), [1, 2, 3, 4]);
    assert.equal(wireEnds({ from: 'a', to: 'gone' }, id => ({ a })[id]), null);
    const ends = wireEnds({ from: 'a', to: 'b' }, id => ({ a, b })[id]);
    assert.deepEqual(labelSpot(ends, 'sends', [a, b]), { t: 0.5, side: 'above', free: true });
    const blocker = { x: 420, y: 220, w: 60, h: 20 };
    const moved = labelSpot(ends, 'sends', [a, b, blocker]);
    assert.ok(moved.free && (moved.t !== 0.5 || moved.side !== 'above'));
    assert.equal(labelSpot(ends, 'x'.repeat(80), [a, b]).free, false, 'no spot fits text that long');
    assert.deepEqual(labelPoint(ends, 'sends', { t: 0.5, side: 'above' }), [(ends[0] + ends[2]) / 2, (ends[1] + ends[3]) / 2 - 10]);
    assert.ok(crosses([0, 0, 100, 100], { x: 40, y: 40, w: 20, h: 20 }));
    assert.ok(!crosses([0, 0, 100, 0], { x: 40, y: 40, w: 20, h: 20 }));
  });

  test("before recording: an arrow through a third object, text with no room, and a covered container name are polish, never failures", () => {
    const scene = shown([
      { id: 'a', shape: 'box', x: 60, y: 250, w: 160, h: 100, text: 'A' },
      { id: 'mid', shape: 'box', x: 480, y: 260, w: 120, h: 80, text: 'M' },
      { id: 'b', shape: 'box', x: 900, y: 250, w: 160, h: 100, text: 'B' },
      { id: 'go', shape: 'arrow', from: 'a', to: 'b', text: 'a label far too long to fit anywhere at all on this line here' },
    ]);
    const notes = layoutNotes([{ title: 'T', ...scene }], assets);
    assert.ok(notes.some(note => /arrow go passes through mid/.test(note)), notes.join('\n'));
    assert.ok(notes.some(note => /text of arrow go/.test(note)));
    assert.ok(!sim(scene).some(problem => /passes through|text of arrow/.test(problem)), 'not a failure');
    const ends = layoutNotes([{ title: 'T', ...shown([{ id: 'a', shape: 'box', x: 60, y: 250, w: 160, h: 100 }, { id: 'b', shape: 'box', x: 600, y: 250, w: 160, h: 100 }, { id: 'go', shape: 'arrow', from: 'a', to: 'b' }, { id: 'frame', shape: 'box', style: 'outline', x: 40, y: 230, w: 220, h: 140 }]) }], assets);
    assert.deepEqual(ends, [], 'its own ends and a container around an end are fine');
    const covered = layoutNotes([{ title: 'T', ...shown([{ id: 'c', shape: 'box', style: 'outline', x: 100, y: 150, w: 500, h: 300, text: 'Code part' }, { id: 'in', shape: 'box', x: 110, y: 145, w: 200, h: 100 }]) }], assets);
    assert.ok(covered.some(note => /in covers the name of c/.test(note)));
  });

  test('before recording: an outline half over something, a box over a faded one, or a sub wider than its box fail', () => {
    assert.ok(sim(shown([{ id: 'o', shape: 'box', style: 'outline', x: 100, y: 150, w: 300, h: 200 }, { id: 'b', shape: 'box', x: 350, y: 200, w: 200, h: 100 }])).some(problem => /o cuts across b/.test(problem)));
    assert.ok(!sim(shown([{ id: 'o', shape: 'box', style: 'outline', x: 100, y: 150, w: 500, h: 300 }, { id: 'b', shape: 'box', x: 150, y: 200, w: 200, h: 100 }])).some(problem => /cuts across/.test(problem)), 'all around it is fine');
    assert.ok(sim(shown([{ id: 'a', shape: 'box', x: 100, y: 200, w: 300, h: 150, fade: true }, { id: 'b', shape: 'box', x: 200, y: 250, w: 300, h: 100 }])).some(problem => /overlaps/.test(problem)));
    assert.ok(sim(shown([{ id: 'a', shape: 'box', x: 100, y: 200, w: 120, h: 100, text: 'A', sub: 'a small line far too long for it' }])).some(problem => /small text under box a/.test(problem)));
  });

  test('code is measured without its indentation: it fits at its stated size, fails at 540 by 396 naming the size, and too-wide code takes the full width', () => {
    // 72 characters once its 10 spaces are gone: wider than 540 at a readable size, well inside the stage.
    const lines = Array.from({ length: 6 }, (_, k) => `          const value${k} = compute(request.user, options.timeout, retries.limit, ${k});`);
    const code = { code: [{ text: lines.join('\n') }], table: [], diagram: [] };
    const needs = codeNeeds(lines.join('\n'));
    const run = (w, h, codeAssets = code) => { const problems = []; simulate(shown([{ id: 'k', shape: 'code', x: 40, y: 100, w, h, asset: 0 }]), 'S', codeAssets, problems); return problems; };
    assert.deepEqual(run(needs.w, needs.h), []);
    assert.match(run(540, 396).join(), new RegExp(`at least ${needs.w} by ${needs.h}`));
    const long = { code: [{ text: `x = ${'y'.repeat(140)};` }], table: [], diagram: [] };
    assert.ok(codeNeeds(long.code[0].text).wide);
    assert.deepEqual(run(1040, 100, long), []);
    assert.match(run(700, 100, long).join(), /wider than the stage/);
  });
});
