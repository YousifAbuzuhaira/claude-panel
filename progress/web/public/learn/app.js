// Learn in the browser: the shell (tabs, build chip, toast, banner, keys) and the events.
// Every action is one helper command through /api/rpc; the page never touches files.
import { onEvents, openWindow, withToken } from '../shared/api.js';
import { isNative, watchAppearance } from '../shared/look.js';
import { buildAskView, openAdvisor } from './ask.js';
import { chatEvent, forgetChats } from './chat.js';
import { GLYPH, MAX_SCALE, MIN_SCALE, S, VIEW_NAMES, banner, call, loadPrefs, nav, savePrefs, short, toast } from './core.js';
import { buildCourseView, courseStatus, openCourse, openOverlap, overlapOpen, saveProgress, showOverlap, stepPage } from './course.js';
import { buildLearnedView, leaveLearnedModes, refreshLearned, resetLearned } from './learned.js';
import { buildLibraryView, libraryDue, refreshLibrary, resetLibraryModes } from './library.js';
import { buildReviewView, refreshReview } from './review.js';
import { appearanceChanged, buildSettingsView, leaveSettings, refreshSettings, settingsStatus } from './settings.js';

const hosts = Object.fromEntries(VIEW_NAMES.map(name => [name, document.getElementById(`view-${name}`)]));
const tabs = Object.fromEntries(VIEW_NAMES.map(name => [name, document.querySelector(`[data-tab="${name}"]`)]));
const buildChip = document.getElementById('build-chip');

function showView(name) {
  if (name === 'course' && !S.courseId) name = 'library';
  if (S.view === 'course' && name !== 'course') saveProgress();
  if (S.view === 'settings' && name !== 'settings') leaveSettings();
  S.view = name;
  for (const key of VIEW_NAMES) {
    hosts[key].hidden = key !== name;
    tabs[key].classList.toggle('on', key === name);
    tabs[key].setAttribute('aria-selected', String(key === name));
  }
  tabs.course.hidden = !S.courseId;
  savePrefs();
  switch (name) {
    case 'library': refreshLibrary(); break;
    case 'course': openCourse(S.courseId, null); break;
    case 'review': refreshReview(); break;
    case 'learned': refreshLearned(); break;
    case 'ask': openAdvisor(); break;
    case 'settings': refreshSettings(); break;
    default: break;
  }
}

/** Opening a course from anywhere: the Course tab, then the page. */
function openCourseView(id, page) {
  // Already showing this course: nothing to do (at start the saved view says 'course' before it is shown).
  if (S.view === 'course' && S.courseId === id && !page && !hosts.course.hidden) return;
  if (S.view === 'settings') leaveSettings();
  S.courseId = id;
  S.view = 'course';
  for (const key of VIEW_NAMES) {
    hosts[key].hidden = key !== 'course';
    tabs[key].classList.toggle('on', key === 'course');
    tabs[key].setAttribute('aria-selected', String(key === 'course'));
  }
  tabs.course.hidden = false;
  savePrefs();
  openCourse(id, page);
}

function setTextScale(scale) {
  S.textScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(scale * 100) / 100));
  document.documentElement.style.setProperty('--scale', String(S.textScale));
  toast(`Text size ${Math.round(S.textScale * 100)}%`);
  savePrefs();
}

function showReviewCount() {
  tabs.review.textContent = S.reviewDue ? `Review ${S.reviewDue}` : 'Review';
}

Object.assign(nav, { showView, openCourse: openCourseView, refreshLibrary, refreshLearned, showReviewCount, setTextScale });

function updateBuildChip() {
  const build = S.status?.build;
  buildChip.className = 'build-chip';
  if (!build) {
    buildChip.hidden = true;
    return;
  }
  let text = '';
  switch (build.state) {
    case 'running': text = `${GLYPH.half} ${short(build.topic, 28)}${build.total > 0 ? ` ${build.done}/${build.total}` : ''}`; buildChip.classList.add('running'); break;
    case 'waiting-picks': text = `${GLYPH.empty} Pick sources: ${short(build.topic, 24)}`; buildChip.classList.add('waiting'); break;
    case 'failed': text = `${GLYPH.empty} Build stopped: ${short(build.topic, 24)}`; buildChip.classList.add('failed'); break;
    case 'done': text = `${GLYPH.check} ${short(build.message, 36)}`; buildChip.classList.add('done'); break;
    default: break;
  }
  buildChip.textContent = text;
  buildChip.title = build.message || '';
  buildChip.hidden = !text;
}

/** Another library: drop everything cached and close the Course tab. */
function onLibraryChanged() {
  S.library = null;
  S.concepts = null;
  S.courseId = null;
  S.courseData = null;
  S.pageData = null;
  S.pageN = 0;
  forgetChats();
  resetLibraryModes();
  resetLearned();
  showOverlap(false);
  tabs.course.hidden = true;
  savePrefs();
}

async function hello() {
  try {
    const result = await call('hello');
    S.helperReady = true;
    S.settings = result.settings;
    S.status = result.status;
    banner('');
    updateBuildChip();
    if ((result.resumed || []).length) toast('Carrying on with a build that was interrupted');
    return true;
  } catch (error) {
    banner(`Learn's helper can't run: ${error.message || error}`);
    return false;
  }
}

function onEvent(event) {
  switch (event.event) {
    case 'ready':
      // The helper (re)started: say hello again.
      if (S.helperReady) hello();
      break;
    case 'status':
      S.status = event.status;
      updateBuildChip();
      if (S.view === 'library' && libraryDue()) refreshLibrary();
      if (S.view === 'settings') settingsStatus();
      courseStatus(event.status?.build);
      break;
    case 'chat.delta':
    case 'chat.tool':
    case 'chat.done':
    case 'chat.error':
      chatEvent(event);
      break;
    case 'fatal':
      banner(`Learn's helper stopped: ${event.error || 'no reason given'}`);
      break;
    default: break;
  }
}

// --- Keys ------------------------------------------------------------------------------------

const typing = target => target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

document.addEventListener('keydown', event => {
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    setTextScale(S.textScale + 0.1);
    return;
  }
  if (ctrl && (event.key === '-' || event.key === '_')) {
    event.preventDefault();
    setTextScale(S.textScale - 0.1);
    return;
  }
  if (event.ctrlKey && !event.metaKey && /^[1-6]$/.test(event.key)) {
    event.preventDefault();
    showView(VIEW_NAMES[Number(event.key) - 1]);
    return;
  }
  if (event.key === 'Escape') {
    if (overlapOpen()) showOverlap(false);
    leaveLearnedModes();
    return;
  }
  if (S.view === 'course' && !typing(event.target) && !ctrl && !event.altKey) {
    if (event.key === 'ArrowRight') { event.preventDefault(); stepPage(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepPage(-1); }
  }
});

// --- Start -----------------------------------------------------------------------------------

await loadPrefs();
document.documentElement.style.setProperty('--scale', String(S.textScale));
buildLibraryView(hosts.library);
buildReviewView(hosts.review);
buildCourseView(hosts.course);
buildLearnedView(hosts.learned);
buildAskView(hosts.ask);
buildSettingsView(hosts.settings, { onLibraryChanged });
for (const name of VIEW_NAMES) tabs[name].addEventListener('click', () => showView(name));
buildChip.addEventListener('click', () => showView('library'));

// The header's marks: the colour scheme lives at the top of Settings; the games hub is a link
// (with the token), or in the macOS window app a window of its own, as /games opens it.
document.getElementById('look-mark').addEventListener('click', () => {
  showView('settings');
  hosts.settings.scrollTop = 0;
});
const gamesMark = document.getElementById('games-mark');
gamesMark.href = withToken('../games/');
gamesMark.addEventListener('click', async event => {
  if (!isNative() || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  if (!(await openWindow('games'))) location.href = gamesMark.href;
});

// The first paint came from /look.css; from here the page follows every change, from any window.
watchAppearance('learn', appearanceChanged);

const events = onEvents(onEvent);
let lost = false;
events.addEventListener('error', () => {
  if (events.readyState !== EventSource.OPEN) {
    lost = true;
    banner("Lost the connection to Learn's server. Trying again...");
  }
});
events.addEventListener('open', () => {
  if (!lost) return;
  lost = false;
  hello().then(ok => { if (ok) showView(S.view); });
});

/** A view asked for by a link (`open learn --view ...`): a view name, or 'course'/'overlap' with a course. */
function showAsked(view, courseId, page = null) {
  if (courseId) S.courseId = courseId;
  if ((view === 'course' || view === 'overlap') && S.courseId) {
    openCourseView(S.courseId, page);
    if (view === 'overlap') setTimeout(() => openOverlap(true), 400);
  } else {
    showView(VIEW_NAMES.includes(view) ? view : S.view);
  }
}

// A view to open straight away, for snapshots and links: ?view=<name>[&course=<id>&page=<n>],
// or ?view=overlap to open the course's overlap screen. Once shown, the query leaves the
// address, so a reload (Cmd+R in the window app) opens where the person is, not the old link:
// the prefs remember the view and the course.
const params = new URLSearchParams(location.search);
if (await hello()) {
  showAsked(params.get('view'), params.get('course'), Number(params.get('page')) || null);
  if (location.search) history.replaceState(null, '', location.pathname);
} else {
  for (const key of VIEW_NAMES) hosts[key].hidden = key !== 'library';
}
