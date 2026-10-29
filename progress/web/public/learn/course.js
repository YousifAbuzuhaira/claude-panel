// Course: contents (left), the page (middle), its chat (right), and the overlap screen.
import { token } from '../shared/api.js';
import { renderBlocks } from './blocks.js';
import { chatHooks, chatPanel, fillInput, forgetChat, pageKey, redrawIdle, showChat } from './chat.js';
import { GLYPH, S, act, action, armed, call, formatClock, formatDate, h, inlineEdit, isHttp, nav, savePrefs, short, toast } from './core.js';

const C = {
  renamingPage: null,
  rewritingPage: null,
  addingPage: false,
  overlapShown: false,
  overlapData: null,
  overlapPicks: new Set(),
  lastCourseAt: 0,
  scrollSaved: -1,
  scrollTimer: null,
  pendingScroll: null,
  shownStatus: '',
  openSeq: 0,
};

let ui = null;
let chat = null;

export function buildCourseView(host) {
  const courseTitle = h('h2.course-name');
  const courseMeta = h('div.course-meta');
  const overlapLink = action('What I already know', () => openOverlap(true), 'blue');
  const hideLink = action('hide contents', () => setContentsShown(false), 'faint');
  const pageList = h('ol.page-list');
  const contents = h('aside.contents', { 'aria-label': 'Contents' }, courseTitle, courseMeta, h('div.contents-tools', null, overlapLink, hideLink), pageList);

  const pageCount = h('span.page-count');
  const showLink = action('show contents', () => setContentsShown(true), 'faint');
  const pageTitle = h('h1.page-title');
  const sourceLine = h('div.source-line');
  const conceptChips = h('div.chips.concept-chips');
  const body = h('div.page-body.prose');
  const checks = h('div.checks');
  const prev = action(`${GLYPH.left} Previous`, () => stepPage(-1), 'dim');
  const next = action(`Next ${GLYPH.right}`, () => stepPage(1), 'accent');
  const skip = action('Skip this page', toggleSkip, 'faint');
  const pageNav = h('nav.page-nav', null, prev, skip, next);
  const article = h('article.page', null, h('div.page-head', null, pageCount, showLink), pageTitle, sourceLine, conceptChips, body, checks, pageNav);
  const overlap = h('section.overlap', { hidden: true });
  const pageScroll = h('div.page-scroll', null, article, overlap);
  pageScroll.addEventListener('scroll', onScroll, { passive: true });

  chat = chatPanel({
    title: 'Ask about this page',
    placeholder: 'Ask anything, or answer a check question (Enter sends)',
    newLabel: 'new thread',
    fields: () => (S.pageData?.page ? { courseId: S.courseId, n: S.pageN } : null),
  });
  const chatColumn = h('aside.chat-column', { 'aria-label': 'Chat' }, chat.root);
  const grid = h('div.course-grid', null, contents, h('main.page-column', null, pageScroll), chatColumn);
  host.append(grid);
  ui = { grid, contents, courseTitle, courseMeta, pageList, pageCount, showLink, pageTitle, sourceLine, conceptChips, body, checks, prev, next, skip, article, overlap, pageScroll };
  setContentsShown(S.showContents, false);

  chatHooks.learn = setConceptLearned;
  window.addEventListener('pagehide', () => saveProgress(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(true); });
}

function setContentsShown(shown, save = true) {
  S.showContents = shown;
  ui.grid.classList.toggle('no-contents', !shown);
  ui.showLink.hidden = shown;
  if (save) savePrefs();
}

const pages = () => S.courseData?.course.pages || [];
const positionOf = n => pages().findIndex(page => page.n === n) + 1;
const skippedSet = () => new Set(S.courseData?.course.skipped || []);

// --- Opening a course and a page -----------------------------------------------------------

/** The page asked for; else the current one in the same course; else the saved one; else the first not skipped. */
export async function openCourse(id, page) {
  if (!id) {
    nav.showView('library');
    return;
  }
  const same = S.courseData?.course.id === id;
  if (!same) {
    saveProgress();
    S.pageData = null;
    S.pageN = 0;
    C.renamingPage = null;
    C.rewritingPage = null;
    C.addingPage = false;
    showOverlap(false);
  }
  S.courseId = id;
  savePrefs();
  C.lastCourseAt = Date.now();
  let result;
  try {
    result = await call('course.get', { id });
  } catch (error) {
    toast(String(error.message || error), 'error');
    S.courseId = null;
    S.courseData = null;
    savePrefs();
    nav.showView('library');
    return;
  }
  if (S.courseId !== id) return;
  S.courseData = result;
  showContents();
  const course = result.course;
  let target = 0;
  if (page) target = Number(page);
  else if (same && S.pageN > 0) target = S.pageN;
  else if (course.progress?.page) target = Number(course.progress.page);
  if (!course.pages.some(item => item.n === target)) {
    const skipped = new Set(course.skipped || []);
    target = (course.pages.find(item => !skipped.has(item.n)) || course.pages[0])?.n || 0;
  }
  if (target && (!same || S.pageN !== target || !S.pageData)) await openPage(target);
  else if (S.pageData) showPageHeader();
  if (course.overlap && !course.overlap.seen) openOverlap(false);
}

export async function openPage(n) {
  if (!S.courseData) return;
  saveProgress();
  const courseId = S.courseId;
  S.pageN = n;
  C.scrollSaved = -1;
  const seq = ++C.openSeq;
  showContents();
  showOverlap(false);
  let result;
  try {
    result = await call('page.get', { courseId, n });
  } catch (error) {
    toast(String(error.message || error), 'error');
    return;
  }
  // An answer for a page no longer in front is dropped.
  if (seq !== C.openSeq || S.courseId !== courseId || S.pageN !== n) return;
  S.pageData = result;
  const course = S.courseData.course;
  if (result.page && !(course.read || []).includes(n)) course.read = [...(course.read || []), n];
  if (result.skipped) course.skipped = result.skipped;
  showPage();
  showContents();
}

export function stepPage(delta) {
  if (!S.courseData) return;
  const list = pages();
  const skipped = skippedSet();
  let index = positionOf(S.pageN) - 1 + delta;
  while (index >= 0 && index < list.length && skipped.has(list[index].n)) index += delta;
  if (index < 0 || index >= list.length) {
    if (delta > 0) toast('That was the last page.');
    return;
  }
  openPage(list[index].n);
}

async function toggleSkip() {
  const n = S.pageN;
  const skip = !skippedSet().has(n);
  const result = await act('page.skip', { courseId: S.courseId, n, skip });
  if (!result) return;
  S.courseData.course.skipped = result;
  showContents();
  showPageHeader();
  if (result.includes(S.pageN)) stepPage(1);
}

// --- Contents --------------------------------------------------------------------------------

function showContents() {
  if (!S.courseData || !ui) return;
  const course = S.courseData.course;
  const read = new Set(course.read || []);
  const skipped = new Set(course.skipped || []);
  const concepts = Object.values(S.courseData.concepts || {});
  const learned = concepts.filter(concept => concept.state === 'learned').length;
  ui.courseTitle.textContent = course.title;
  const meta = [`${course.pages.length} pages`, `${read.size} read`, `${learned}/${concepts.length} concepts learned`];
  if (course.status !== 'ready') meta.push(`being written: ${course.pages.filter(page => page.status === 'written').length}/${course.pages.length}`);
  ui.courseMeta.textContent = meta.join(`  ${GLYPH.dot}  `);

  const items = course.pages.map((page, index) => {
    const n = page.n;
    const written = page.status === 'written';
    const isSkipped = skipped.has(n);
    const isRead = read.has(n);
    const mark = !written ? GLYPH.pending : isSkipped ? GLYPH.skip : isRead ? GLYPH.full : GLYPH.empty;
    const tip = !written ? 'Not written yet' : isSkipped ? 'Skipped' : isRead ? 'Read' : 'Not read yet';
    const markClass = !written ? 'pending' : isSkipped ? 'skipped' : isRead ? 'read' : 'unread';
    const current = n === S.pageN;
    const title = C.renamingPage === n
      ? inlineEdit({
        value: page.title,
        placeholder: 'Page title',
        onSave: async text => {
          if (!text) return false;
          const result = await act('page.rename', { courseId: S.courseId, n, title: text });
          if (!result) return false;
          C.renamingPage = null;
          updatePages({ pages: result });
          return true;
        },
        onCancel: () => { C.renamingPage = null; showContents(); },
      })
      : h('span.page-name', null, `${index + 1}. ${page.title}`);
    const li = h(`li.page-item${current ? '.current' : ''}${isSkipped || !written ? '.muted' : ''}`, {
      onclick: () => { if (C.renamingPage !== n && C.rewritingPage !== n) openPage(n); },
    }, h('div.page-line', null, h(`span.mark.${markClass}`, { title: tip }, mark), title));
    // Rename, reorder, rewrite and remove: under the page you're on.
    if (current || C.rewritingPage === n || C.renamingPage === n) {
      const up = action(GLYPH.up, () => movePage(n, -1));
      up.title = 'Move up';
      const down = action(GLYPH.down, () => movePage(n, 1));
      down.title = 'Move down';
      li.append(h('div.page-actions', null,
        action('rename', () => { C.renamingPage = n; C.rewritingPage = null; showContents(); }),
        up, down,
        action('rewrite', () => { C.rewritingPage = n; C.renamingPage = null; showContents(); }),
        action('remove', event => removePage(n, event.currentTarget))));
    }
    if (C.rewritingPage === n) {
      li.append(inlineEdit({
        placeholder: 'What should change? (optional) Enter rewrites',
        multiline: true,
        onSave: async note => {
          const job = await act('page.rewrite', { courseId: S.courseId, n, note });
          if (!job) return false;
          C.rewritingPage = null;
          toast('Rewriting the page. It carries on if you close this page.');
          refreshCourse();
          return true;
        },
        onCancel: () => { C.rewritingPage = null; showContents(); },
      }));
    }
    return li;
  });
  // A page of your own: Claude plans it from the course's sources, after the current page.
  const add = C.addingPage
    ? h('li.page-add', null, inlineEdit({
      placeholder: 'What the new page is about (Enter adds it after this page)',
      multiline: true,
      onSave: async topic => {
        if (!topic) return false;
        const job = await act('page.add', { courseId: S.courseId, topic, after: S.pageN || null });
        if (!job) return false;
        C.addingPage = false;
        toast('Writing your page. It carries on if you close this page.');
        refreshCourse();
        return true;
      },
      onCancel: () => { C.addingPage = false; showContents(); },
    }))
    : h('li.page-add', null, action('+ Add a page', () => { C.addingPage = true; showContents(); }, 'blue'));
  ui.pageList.replaceChildren(...items, add);
}

function updatePages(course) {
  S.courseData.course = { ...S.courseData.course, ...course };
  showContents();
  if (S.pageData) showPageHeader();
}

async function movePage(n, delta) {
  const result = await act('page.move', { courseId: S.courseId, n, delta });
  if (result) updatePages({ pages: result });
}

async function removePage(n, el) {
  if (!armed(`page:${S.courseId}:${n}`, el)) return;
  const course = await act('page.remove', { courseId: S.courseId, n });
  if (!course) return;
  S.courseData.course = course;
  forgetChat(pageKey(S.courseId, n));
  toast('Page removed. Its concepts stay in your Learned list.');
  if (S.pageN === n) openPage(course.pages[0].n);
  else {
    showContents();
    showPageHeader();
  }
}

/** The course again (a rewrite or an added page started, or a build moved on). */
export async function refreshCourse() {
  const id = S.courseId;
  if (!id) return;
  C.lastCourseAt = Date.now();
  let result;
  try {
    result = await call('course.get', { id });
  } catch {
    return;
  }
  if (S.courseId !== id || result.course.id !== id) return;
  S.courseData = result;
  showContents();
  // The page on screen was waiting to be written, or rewritten: show the new one.
  const info = result.course.pages.find(page => page.n === S.pageN);
  const wasWaiting = (S.pageData && !S.pageData.page) || C.shownStatus === 'todo';
  if (info && info.status === 'written' && wasWaiting) openPage(S.pageN);
  else if (S.pageData) showPageHeader();
}

/** A status event: while a build writes this course, at most every 3 s, and once when it stops. */
export function courseStatus(build) {
  if (S.view !== 'course' || !build || build.courseId !== S.courseId) return;
  if (build.state === 'running' && Date.now() - C.lastCourseAt < 3000) return;
  refreshCourse();
}

// --- The page --------------------------------------------------------------------------------

function showPageHeader() {
  const total = pages().length;
  const position = positionOf(S.pageN);
  const info = pages().find(page => page.n === S.pageN);
  const rewriting = info && info.status !== 'written' && S.pageData?.page;
  ui.pageCount.textContent = position ? `Page ${position} of ${total}${rewriting ? `  ${GLYPH.dot}  being rewritten` : ''}` : '';
  ui.pageTitle.textContent = info ? info.title : '';
  ui.skip.textContent = skippedSet().has(S.pageN) ? 'Skipped: undo' : 'Skip this page';
  ui.prev.style.visibility = position > 1 ? 'visible' : 'hidden';
  ui.next.style.visibility = position && position < total ? 'visible' : 'hidden';
  C.shownStatus = info ? info.status : '';
}

function sourceLinks(page) {
  const source = page.source || {};
  const items = [{ url: source.url, title: source.title, kind: source.kind, from: source.fromSec, to: source.toSec }];
  for (const item of page.support || []) {
    if (item.url) items.push({ url: item.url, title: item.title, kind: /youtu\.?be/.test(item.url) ? 'youtube' : 'web', from: item.fromSec, to: item.toSec });
  }
  return items.filter(item => isHttp(item.url)).map(item => {
    const video = item.kind === 'youtube';
    const hasTime = video && item.from !== null && item.from !== undefined;
    const label = hasTime ? `${GLYPH.play} Watch ${formatClock(item.from)}–${formatClock(item.to)}` : video ? `${GLYPH.play} Watch` : `${GLYPH.link} Read`;
    let url = item.url;
    if (hasTime && Number(item.from) > 0) url += `${url.includes('?') ? '&' : '?'}t=${Math.floor(Number(item.from))}s`;
    return h('a.source', { href: url, target: '_blank', rel: 'noopener noreferrer', title: item.url }, `${label}: ${short(item.title || item.url, 70)}`);
  });
}

function conceptChip(concept) {
  const glyph = concept.state === 'learned' ? GLYPH.check : concept.state === 'seen' ? GLYPH.half : GLYPH.empty;
  const tip = `${concept.definition || ''}\n\n${concept.state === 'learned' ? 'Learned. Click to unmark.' : 'Click to mark it learned.'}`.trim();
  return h(`button.chip.concept.${concept.state}`, {
    type: 'button',
    title: tip,
    onclick: () => setConceptLearned(concept.id, concept.state !== 'learned'),
  }, `${glyph} ${concept.name}`);
}

function showChips() {
  ui.conceptChips.replaceChildren(...(S.pageData?.concepts || []).map(conceptChip));
}

/** The person's own click: the only way anything becomes Learned. */
async function setConceptLearned(id, learned) {
  const result = await act('concept.learn', { id, learned, courseId: S.courseId, n: S.pageN });
  if (!result) return;
  for (const concept of S.pageData?.concepts || []) if (concept.id === result.id) concept.state = result.state;
  if (S.courseData?.concepts?.[result.id]) S.courseData.concepts[result.id].state = result.state;
  const listed = (S.concepts?.concepts || []).find(concept => concept.id === result.id);
  if (listed) Object.assign(listed, result);
  showChips();
  showContents();
  redrawIdle(key => key.startsWith(`${S.courseId}:`));
  toast(result.state === 'learned' ? `Learned: ${result.name}` : `Not marked learned: ${result.name}`);
}

function showPage() {
  const result = S.pageData;
  showPageHeader();
  ui.sourceLine.replaceChildren();
  ui.conceptChips.replaceChildren();
  ui.checks.replaceChildren();
  const key = pageKey(S.courseId, S.pageN);
  if (!result.page) {
    ui.body.replaceChildren(h('p.dim.waiting', null, 'This page is still being written. The build carries on in the background; it shows here when it is done.'));
    showChat(chat, key, []);
    C.pendingScroll = 0;
    restoreScroll();
    return;
  }
  const page = result.page;
  ui.sourceLine.replaceChildren(...sourceLinks(page));
  showChips();
  ui.body.replaceChildren(...renderBlocks(page.blocks));
  const checks = page.checks || [];
  if (checks.length) {
    ui.checks.append(
      h('hr'),
      h('h2.checks-title', null, 'Check yourself'),
      h('p.dim.checks-hint', null, 'Answer in the chat. Claude says what you got right and what you missed; when you have it, you can mark it learned.'),
      h('ol.check-list', null, checks.map((check, index) => h('li', null,
        h('span', null, `${check.q} `),
        action(`answer ${GLYPH.right}`, () => fillInput(chat, `Check ${index + 1}: ${check.q}\nMy answer: `), 'blue')))));
  }
  showChat(chat, key, result.chat?.messages || []);
  const progress = result.progress;
  C.pendingScroll = progress && progress.page === S.pageN && progress.scroll > 0 ? Number(progress.scroll) : 0;
  restoreScroll();
}

// --- Reading position: restored once laid out, saved a second after scrolling stops -----------

function restoreScroll() {
  const ratio = C.pendingScroll || 0;
  let tries = 0;
  const attempt = () => {
    const scroller = ui.pageScroll;
    const room = scroller.scrollHeight - scroller.clientHeight;
    if (room > 0 || tries > 10) {
      scroller.scrollTop = ratio * Math.max(0, room);
      C.scrollSaved = ratio;
      C.pendingScroll = null;
      return;
    }
    tries++;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

function currentRatio() {
  const scroller = ui.pageScroll;
  const room = scroller.scrollHeight - scroller.clientHeight;
  return room > 0 ? scroller.scrollTop / room : 0;
}

function onScroll() {
  if (C.pendingScroll !== null && C.pendingScroll !== undefined) return;
  clearTimeout(C.scrollTimer);
  C.scrollTimer = setTimeout(() => saveProgress(), 1000);
}

/** `leaving`: the tab is going away, so the request must outlive it. */
export function saveProgress(leaving = false) {
  clearTimeout(C.scrollTimer);
  if (!ui || !S.courseId || !S.pageN || !S.pageData?.page || C.overlapShown) return;
  if (C.pendingScroll !== null && C.pendingScroll !== undefined) return;
  const ratio = Math.round(currentRatio() * 10000) / 10000;
  if (Math.abs(ratio - C.scrollSaved) < 0.01) return;
  C.scrollSaved = ratio;
  const request = { cmd: 'progress.set', courseId: S.courseId, n: S.pageN, scroll: ratio };
  if (leaving) {
    try {
      fetch('/api/rpc', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token }, body: JSON.stringify(request) });
    } catch {}
  } else {
    call('progress.set', request).catch(() => {});
  }
}

// --- The overlap screen ------------------------------------------------------------------------

export async function openOverlap(always) {
  const courseId = S.courseId;
  const data = await act('overlap.get', { courseId });
  if (!data || S.courseId !== courseId) return;
  const known = data.covered.length + data.partly.length + data.mentioned.length;
  if (!known && !always) {
    // Nothing you have met before: no screen, just remember it was checked.
    call('overlap.apply', { courseId, skip: [] }).catch(() => {});
    if (S.courseData?.course.overlap) S.courseData.course.overlap.seen = true;
    return;
  }
  C.overlapData = data;
  C.overlapPicks = new Set();
  renderOverlap();
  showOverlap(true);
}

/** Closing it never marks it seen; only *Start the course* does. */
export function showOverlap(shown) {
  if (!ui) return;
  saveProgress();
  C.overlapShown = shown;
  ui.overlap.hidden = !shown;
  ui.article.hidden = shown;
  if (shown) ui.pageScroll.scrollTop = 0;
}

export const overlapOpen = () => C.overlapShown;

function renderOverlap() {
  const data = C.overlapData;
  const titles = data.courseTitles || {};
  const courseTitle = id => titles[id] || 'an earlier course';
  const pagesText = list => {
    const positions = list.map(n => positionOf(n)).filter(Boolean);
    return positions.length === 1 ? `here: page ${positions[0]}` : `here: pages ${positions.join(', ')}`;
  };
  const line = (cls, name, detail) => h(`div.overlap-line.${cls}`, null, h('div.overlap-name', null, name), h('div.overlap-detail', null, detail));
  const out = [
    h('h1.page-title', null, 'Before you start'),
    h('p.dim', null, 'What this course covers that you have met before. Nothing is skipped unless you tick it.'),
  ];
  if (data.covered.length) {
    out.push(h('h3.label.green', null, `Already learned  ${data.covered.length}`));
    for (const item of data.covered) {
      const when = item.learned ? `learned ${formatDate(item.learned.at)}${item.learned.course ? ` in ${courseTitle(item.learned.course)}` : ''}` : 'learned';
      out.push(line('green', `${GLYPH.check} ${item.name}`, `${when}  ${GLYPH.dot}  ${pagesText(item.pages)}`));
    }
  }
  if (data.partly.length) {
    out.push(h('h3.label.blue', null, `Partly covered  ${data.partly.length}`));
    for (const item of data.partly) out.push(line('blue', `${GLYPH.half} ${item.name}`, `you have ${item.have.name}; this goes further  ${GLYPH.dot}  ${pagesText(item.pages)}`));
  }
  if (data.mentioned.length) {
    out.push(h('h3.label', null, `Read before, not marked learned  ${data.mentioned.length}`));
    for (const item of data.mentioned) {
      const where = [...new Set(item.seen.map(seen => courseTitle(seen.course)))].join(', ');
      out.push(line('dim', `${GLYPH.empty} ${item.name}`, `read in ${where}  ${GLYPH.dot}  ${pagesText(item.pages)}`));
    }
  }
  if (data.fresh.length) {
    out.push(h('h3.label.accent', null, `New to you  ${data.fresh.length}`));
    out.push(h('p.fresh', null, data.fresh.map(item => item.name).join(`  ${GLYPH.dot}  `)));
  }
  if (data.skippablePages.length) {
    out.push(h('h3.label', null, 'Pages you could skip (everything on them is learned)'));
    for (const n of data.skippablePages) {
      const page = pages().find(item => item.n === n);
      const ticked = C.overlapPicks.has(n);
      out.push(h(`button.skip-pick${ticked ? '.ticked' : ''}`, {
        type: 'button',
        onclick: () => {
          if (C.overlapPicks.has(n)) C.overlapPicks.delete(n);
          else C.overlapPicks.add(n);
          renderOverlap();
        },
      }, `${ticked ? GLYPH.ticked : GLYPH.box}  ${positionOf(n)}. ${page ? page.title : ''}`));
    }
  }
  out.push(h('div.overlap-buttons', null,
    h('button.button.primary', {
      type: 'button',
      onclick: async () => {
        const skip = [...C.overlapPicks];
        const result = await act('overlap.apply', { courseId: S.courseId, skip });
        if (!result) return;
        S.courseData.course.skipped = result;
        if (S.courseData.course.overlap) S.courseData.course.overlap.seen = true;
        showOverlap(false);
        showContents();
        showPageHeader();
        if (result.includes(S.pageN)) stepPage(1);
      },
    }, 'Start the course'),
    action('close', () => showOverlap(false), 'dim')));
  ui.overlap.replaceChildren(...out);
}

