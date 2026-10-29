// Learn in the browser: the shell (tabs, build chip, toast, banner, keys) and the events.
// Every action is one helper command through /api/rpc; the page never touches files.
import { onEvents } from '../shared/api.js';
import { buildAskView, openAdvisor } from './ask.js';
import { chatEvent, forgetChats } from './chat.js';
import { GLYPH, MAX_SCALE, MIN_SCALE, S, VIEW_NAMES, banner, call, loadPrefs, nav, savePrefs, short, toast } from './core.js';
import { buildCourseView, courseStatus, openCourse, openOverlap, overlapOpen, saveProgress, showOverlap, stepPage } from './course.js';
import { buildLearnedView, leaveLearnedModes, refreshLearned, resetLearned } from './learned.js';
import { buildLibraryView, libraryDue, refreshLibrary, resetLibraryModes } from './library.js';
import { buildSettingsView, refreshSettings, showSettings } from './settings.js';

const hosts = Object.fromEntries(VIEW_NAMES.map(name => [name, document.getElementById(`view-${name}`)]));
const tabs = Object.fromEntries(VIEW_NAMES.map(name => [name, document.querySelector(`[data-tab="${name}"]`)]));
const buildChip = document.getElementById('build-chip');

function showView(name) {
  if (name === 'course' && !S.courseId) name = 'library';
  if (S.view === 'course' && name !== 'course') saveProgress();
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
    case 'learned': refreshLearned(); break;
    case 'ask': openAdvisor(); break;
    case 'settings': refreshSettings(); break;
    default: break;
  }
}

/** Opening a course from anywhere: the Course tab, then the page. */
function openCourseView(id, page) {
  if (S.view === 'course' && S.courseId === id && !page) return;
  S.courseId = id;
  S.view = 'course';
  for (const key of VIEW_NAMES) {
    hosts[key].hidden = key !== 'course';
    tabs[key].classList.toggle('on', key === 'course');
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

Object.assign(nav, { showView, openCourse: openCourseView, refreshLibrary, refreshLearned, setTextScale });

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
      if (S.view === 'settings') showSettings();
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
  if (event.ctrlKey && !event.metaKey && /^[1-5]$/.test(event.key)) {
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

loadPrefs();
document.documentElement.style.setProperty('--scale', String(S.textScale));
buildLibraryView(hosts.library);
buildCourseView(hosts.course);
buildLearnedView(hosts.learned);
buildAskView(hosts.ask);
buildSettingsView(hosts.settings, { onLibraryChanged });
for (const name of VIEW_NAMES) tabs[name].addEventListener('click', () => showView(name));
buildChip.addEventListener('click', () => showView('library'));

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

// A view to open straight away, for snapshots and links: ?view=<name>[&course=<id>&page=<n>],
// or ?view=overlap to open the course's overlap screen.
const params = new URLSearchParams(location.search);
const asked = params.get('view');
if (params.get('course')) S.courseId = params.get('course');
if (await hello()) {
  if ((asked === 'course' || asked === 'overlap') && S.courseId) {
    openCourseView(S.courseId, Number(params.get('page')) || null);
    if (asked === 'overlap') setTimeout(() => openOverlap(true), 400);
  } else {
    showView(VIEW_NAMES.includes(asked) ? asked : S.view);
  }
} else {
  for (const key of VIEW_NAMES) hosts[key].hidden = key !== 'library';
}
