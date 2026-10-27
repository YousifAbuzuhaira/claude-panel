// The pure parts of Learn's helper: Markdown, the catalogue, the overlap, captions and
// pages, Claude's stream, settings. node --test learn/tests/
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addConcept, applyProposals, emptyCatalogue, ensureCategory, findConcept, mergeConcepts, moveConcept, normalizeName,
  removeCategory, renameConcept, setDefinition, setLearned, setParent, stateOf, markSeen,
} from '../catalogue.mjs';
import { claudeArgs, readStreamLine } from '../claude.mjs';
import { readMarkers } from '../chat.mjs';
import { markdownToBlocks, parseInline } from '../markdown.mjs';
import { overlapReport } from '../overlap.mjs';
import { normalizeSettings, toWslPath } from '../settings.mjs';
import { chunkLines, condenseTranscript, formatTime, htmlToSections, isPlaylist, parseJson3, parseTime, transcriptText, youTubeId } from '../sources.mjs';

describe('markdown', () => {
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
