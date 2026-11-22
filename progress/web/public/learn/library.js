// Library: a new course, the builds, every explainer (/explain), and the courses by category.
import { openWindow, upload, withToken } from '../shared/api.js';
import { isNative } from '../shared/look.js';
import { GLYPH, S, act, action, armed, categoryName, chip, formatDate, h, inlineEdit, isHttp, nav, onEnter, short, toast, videoBar } from './core.js';

const L = {
  mode: 'auto',
  source: 'topic', // what a new course is built from: topic, document or chat
  audience: 'team', // a course from a chat: for a teammate, or for you who were in it
  document: null, // the File picked for one
  pickingJob: null,
  picks: new Set(),
  renamingCourse: null,
  editingSummary: null,
  movingCourse: null,
  renamingCategory: null,
  lastAt: 0,
};

// Read as the page loads: app.js clears the address's query once the asked view is shown.
const ASKED_PICK = new URLSearchParams(location.search).has('pick');

let ui = null;

const DOCUMENT_TYPES = ['.pdf', '.docx', '.md', '.markdown', '.txt', '.text', '.html', '.htm'];
const DOCUMENT_HINT = 'Choose a PDF, Word, Markdown, text or HTML file, or drop one here';
const SOURCES = [
  { key: 'topic', text: 'A topic or link', tip: 'Claude researches the topic (or reads the video, playlist or page you paste) and finds the sources' },
  { key: 'document', text: 'A document', tip: 'A PDF, Word, Markdown, text or HTML file on this computer: the course is built from it' },
  { key: 'chat', text: 'A Claude chat', tip: 'Something you did in one of your Claude Code chats: Learn reads that chat and teaches it' },
];
const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function buildLibraryView(host) {
  const topic = h('input.ui-input.grow', { type: 'text', placeholder: 'A topic to learn, or a YouTube video, playlist or docs link', 'aria-label': 'Topic or link' });
  const category = h('input.ui-input.category', { type: 'text', placeholder: 'Category', 'aria-label': 'Category' });
  const autoChip = chip('Just build it', true, () => setMode('auto'));
  autoChip.title = 'Claude picks sources that cover everything you named, and builds the course straight away';
  const pickChip = chip('Let me pick', false, () => setMode('pick'));
  pickChip.title = 'Research first, then you tick which videos and pages the course is built from';
  const build = h('button.ui-btn.primary', { type: 'button', onclick: submitNewCourse }, 'Build');
  const categoryChips = h('div.chips.category-chips');
  const search = h('input.ui-input.search', { type: 'search', placeholder: 'Search your courses and explainers', 'aria-label': 'Search courses and explainers' });
  const jobs = h('section.jobs');
  const explainers = h('section.explainers');
  const courses = h('section.courses');
  onEnter(topic, submitNewCourse);
  search.addEventListener('input', () => { showExplainers(); showCourses(); });

  // A document in place of the topic: a box that picks one; a file dropped on the Library too.
  const fileInput = h('input', { type: 'file', accept: DOCUMENT_TYPES.join(','), hidden: true, 'aria-hidden': 'true' });
  const docName = h('span.doc-name', null, DOCUMENT_HINT);
  const docClear = h('button.doc-clear', { type: 'button', title: 'Choose another', hidden: true }, GLYPH.close);
  const docBox = h('div.doc-box.grow', { role: 'button', tabindex: '0', title: 'A PDF, Word (.docx), Markdown, text or HTML file, up to 64 MB', hidden: true },
    docName, docClear, h('span.doc-choose', null, 'Choose\u2026'));
  docBox.addEventListener('click', event => { if (event.target !== docClear) fileInput.click(); });
  docBox.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  docClear.addEventListener('click', event => { event.stopPropagation(); setDocument(null); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setDocument(fileInput.files[0]); fileInput.value = ''; });

  // A Claude chat in place of the topic: which chat, and what to cover.
  const chatSelect = h('select.ui-input.chat-select', { 'aria-label': 'The chat' }, h('option', { value: '' }, 'Pick a chat\u2026'));
  const chatFocus = h('input.ui-input.grow', { type: 'text', placeholder: 'What should the course cover? (e.g. how we fixed the browser link)', 'aria-label': 'What the course covers' });
  const chatBox = h('div.chat-source.grow', { hidden: true }, chatSelect, chatFocus);
  onEnter(chatFocus, submitNewCourse);
  chatSelect.addEventListener('change', () => { if (chatSelect.value) chatFocus.focus(); });

  const modes = h('div.modes', null, autoChip, pickChip);
  // Who a course from a chat is for: a teammate gets the background, you get it shorter.
  const teamChip = chip('For a teammate', true, () => setAudience('team'));
  teamChip.title = 'Explains the project and the background, for someone who wasn\'t in the chat';
  const selfChip = chip('I was in this chat', false, () => setAudience('self'));
  selfChip.title = 'Leaves out the background you lived through; keeps every fact, decision and step';
  const audience = h('div.modes', { hidden: true }, teamChip, selfChip);
  const sourceChips = {};
  const fromRow = h('div.from-row', null, h('span.from-label', null, 'From'));
  for (const item of SOURCES) {
    const c = chip(item.text, item.key === L.source, () => setSource(item.key));
    c.title = item.tip;
    sourceChips[item.key] = c;
    fromRow.append(c);
  }
  const view = h('div.library-view', null,
    h('section.card.new-course', null,
      h('div.new-head', null, h('h2.card-title', null, 'New course'), fromRow),
      h('div.new-row', null, topic, docBox, chatBox, category, modes, audience, build, fileInput),
      categoryChips),
    search,
    jobs,
    explainers,
    courses);
  view.addEventListener('dragover', event => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      view.classList.add('dropping');
    }
  });
  view.addEventListener('dragleave', event => { if (!view.contains(event.relatedTarget)) view.classList.remove('dropping'); });
  view.addEventListener('drop', event => {
    view.classList.remove('dropping');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    setDocument(file);
  });
  host.append(view);
  ui = { topic, category, pickChip, autoChip, categoryChips, search, jobs, explainers, courses, docBox, docName, docClear, modes, sourceChips, chatBox, chatSelect, chatFocus, audience, teamChip, selfChip };
}

function setAudience(audience) {
  L.audience = audience;
  ui.teamChip.classList.toggle('on', audience === 'team');
  ui.selfChip.classList.toggle('on', audience === 'self');
}

function setSource(source) {
  L.source = source;
  for (const [key, el] of Object.entries(ui.sourceChips)) el.classList.toggle('on', key === source);
  ui.topic.hidden = source !== 'topic';
  ui.docBox.hidden = source !== 'document';
  ui.chatBox.hidden = source !== 'chat';
  // Picking sources is for a researched topic; a document or a chat is its own source.
  ui.modes.hidden = source !== 'topic';
  ui.audience.hidden = source !== 'chat';
  if (source === 'topic') ui.topic.focus();
  if (source === 'chat') loadChats();
}

let chatsLoaded = false;
async function loadChats() {
  if (chatsLoaded) return;
  chatsLoaded = true;
  const chats = await act('claudeChats.list');
  if (!chats) {
    chatsLoaded = false;
    return;
  }
  ui.chatSelect.replaceChildren(
    h('option', { value: '' }, chats.length ? 'Pick a chat\u2026' : 'No Claude Code chats found'),
    ...chats.map(chat => h('option', { value: chat.id, title: chat.cwd || '' }, [chat.title, chat.project, formatDate(chat.at)].filter(Boolean).join('  \u00b7  '))));
  ui.chatSelect.focus();
}

async function submitChat(category) {
  const chat = ui.chatSelect.value;
  if (!chat) {
    toast('Pick the chat the course is about');
    ui.chatSelect.focus();
    return;
  }
  const focus = ui.chatFocus.value.trim();
  if (!focus) {
    toast('Say what the course should cover');
    ui.chatFocus.focus();
    return;
  }
  const title = ui.chatSelect.selectedOptions[0]?.textContent.split('  \u00b7  ')[0] || 'your chat';
  const job = await act('build.start', { chat, focus, category, audience: L.audience });
  if (!job) return;
  ui.chatFocus.value = '';
  toast(`Reading ${title} for ${focus}. It carries on if you close this page.`);
  refreshLibrary();
}

function setDocument(file) {
  if (file) {
    const ext = (/\.[^.]+$/.exec(file.name) || [''])[0].toLowerCase();
    if (!DOCUMENT_TYPES.includes(ext)) {
      toast('Learn reads PDF, Word (.docx), Markdown, text and HTML files', 'error');
      return;
    }
    if (file.size > 64 * 1024 * 1024) {
      toast('That file is over 64 MB', 'error');
      return;
    }
  }
  L.document = file;
  ui.docName.textContent = file ? `${file.name} \u00b7 ${sizeText(file.size)}` : DOCUMENT_HINT;
  ui.docBox.classList.toggle('chosen', Boolean(file));
  ui.docClear.hidden = !file;
  if (file) setSource('document');
}

async function submitDocument(category) {
  const file = L.document;
  if (!file) {
    ui.docBox.click();
    return;
  }
  setDocument(null);
  toast(`Sending ${file.name}\u2026`);
  let sent;
  try {
    sent = await upload(file);
  } catch (error) {
    toast(String(error.message || error), 'error');
    return;
  }
  const job = await act('build.start', { category, file: sent.path, name: sent.name });
  if (!job) return;
  toast(`Reading ${sent.name}. The course builds from it, and carries on if you close this page.`);
  refreshLibrary();
}

function setMode(mode) {
  L.mode = mode;
  ui.pickChip.classList.toggle('on', mode === 'pick');
  ui.autoChip.classList.toggle('on', mode === 'auto');
}

function submitNewCourse() {
  const category = ui.category.value.trim() || 'General';
  if (L.source === 'document') {
    submitDocument(category);
    return;
  }
  if (L.source === 'chat') {
    submitChat(category);
    return;
  }
  const topic = ui.topic.value.trim();
  if (!topic) {
    toast('Type a topic, or paste a link');
    return;
  }
  startBuild(topic, category, L.mode);
  ui.topic.value = '';
}

/** Also what a chat's *Build this* does (straight away: you asked for it). */
export async function startBuild(topic, category, mode) {
  const fields = { category, mode };
  if (/^https?:\/\//i.test(topic)) fields.link = topic;
  else fields.topic = topic;
  const job = await act('build.start', fields);
  if (!job) return null;
  toast(`Building: ${short(job.topic, 80)}. It carries on if you close this page.`);
  refreshLibrary();
  return job;
}

export async function refreshLibrary() {
  L.lastAt = Date.now();
  const result = await act('library.get');
  if (!result) return;
  S.library = result;
  if (result.status) S.status = result.status;
  S.reviewDue = result.reviewDue || 0;
  nav.showReviewCount();
  showLibrary();
}

export const libraryDue = () => Date.now() - L.lastAt > 2000;

function showLibrary() {
  if (!ui || !S.library) return;
  ui.categoryChips.replaceChildren(...S.library.categories.map(category => {
    const item = chip(category.name, false, () => { ui.category.value = category.name; ui.topic.focus(); });
    item.title = 'Put the new course in this category';
    return item;
  }));
  // A snapshot (?pick) shows the source picker open, when a build is waiting for one.
  if (!L.pickingJob && ASKED_PICK) {
    const waiting = (S.library.jobs || []).find(job => job.state === 'waiting-picks');
    if (waiting) {
      L.pickingJob = waiting.id;
      L.picks = new Set((waiting.candidates || []).filter(candidate => candidate.recommended).map(candidate => candidate.id));
    }
  }
  showJobs();
  showExplainers();
  showCourses();
}

// --- Builds ----------------------------------------------------------------------------------

function showJobs() {
  const jobs = S.library?.jobs || [];
  ui.jobs.replaceChildren(...(jobs.length ? [h('h3.label', null, 'Builds'), ...jobs.map(jobRow)] : []));
}

const jobAction = (cmd, jobId) => async () => {
  if ((await act(cmd, { jobId })) !== undefined) refreshLibrary();
};

function jobRow(job) {
  const actions = h('div.row-actions');
  const add = (text, fn, cls) => actions.append(action(text, fn, cls));
  switch (job.state) {
    case 'running':
      if (job.kind === 'explain' && job.explain) add('Open clips', () => openExplainer(job.explain), 'accent');
      add('Pause', jobAction('build.cancel', job.id), 'dim');
      break;
    case 'waiting-picks':
      add(L.pickingJob === job.id ? 'Hide sources' : 'Pick sources', () => togglePicker(job), 'gold');
      add('Dismiss', jobAction('build.dismiss', job.id), 'dim');
      break;
    case 'paused':
    case 'failed':
      add('Carry on', jobAction('build.resume', job.id), 'accent');
      add('Dismiss', jobAction('build.dismiss', job.id), 'dim');
      break;
    case 'done':
      if (job.courseId) add('Open course', () => nav.openCourse(job.courseId, null), 'green');
      if (job.kind === 'explain' && job.explain) add('Open clips', () => openExplainer(job.explain), 'green');
      add('Dismiss', jobAction('build.dismiss', job.id), 'dim');
      break;
    default: break;
  }
  const row = h(`div.job.state-${job.state}`, null,
    h('div.job-top', null, h('span.job-title', { title: job.topic || '' }, short(job.courseTitle || job.topic || 'A build', 120)), actions),
    h('div.job-message', null, job.message || job.state));
  if (job.state === 'failed' && job.error) row.append(h('div.job-error', null, short(job.error, 300)));
  const making = job.kind === 'video' && job.state === 'running' ? (S.status?.build?.id === job.id ? S.status.build : job).working?.[0] : null;
  if (making) row.append(videoBar(making));
  else if (job.total > 0 && job.state !== 'done') {
    const ratio = Math.max(0, Math.min(1, job.done / job.total));
    row.append(h('div.job-bar', null,
      h('div.bar', null, h('div.bar-fill', { style: { width: `${Math.round(ratio * 100)}%` } })),
      h('span.mono.dim', null, `${job.done}/${job.total} ${{ video: 'videos', explain: 'clips' }[job.kind] || 'pages'}`)));
  }
  if (job.state === 'waiting-picks' && L.pickingJob === job.id) row.append(picker(job));
  return row;
}

// --- Explainers (/explain) --------------------------------------------------------------------

const EXPLAINER_STATES = { making: ['accent', 'Being made'], ready: ['green', 'Ready'], waiting: ['faint', 'Waiting: opening it carries on'] };

/** Every explainer, newest first: the way back to clips /explain made, whenever they were made. */
function showExplainers() {
  if (!ui || !S.library) return;
  const query = ui.search.value.trim().toLowerCase();
  const shown = (S.library.explainers || []).filter(item => !query || String(item.title).toLowerCase().includes(query));
  ui.explainers.replaceChildren(...(shown.length ? [h('h3.label', null, 'Explainers'), ...shown.map(explainerRow)] : []));
}

function explainerRow(item) {
  const [tone, text] = EXPLAINER_STATES[item.state] || EXPLAINER_STATES.waiting;
  const open = () => openExplainer(item.id, item.at);
  return h('article.course-row.explainer-row', {
    tabindex: '0',
    onclick: open,
    onkeydown: event => { if (event.key === 'Enter' && event.target === event.currentTarget) open(); },
  },
  h('div.course-top', null, h('span.course-title', null, item.title), h('span.counts.mono', null, `${item.ready}/${item.clips} clips`)),
  h('div.course-foot', null, h(`span.${tone}`, null, text), item.createdAt ? h('span.faint', null, `Made ${formatDate(item.createdAt)}`) : null, fileLink(item)));
}

/**
 * The explainer as one file you can pass on: where it is, once made (written again with each clip),
 * or a quiet way to make it for one made before files were.
 */
function fileLink(item) {
  if (item.file) return h('span.faint.mono', { title: item.file }, `File: ${item.file.replace(/^\/(?:home|Users)\/[^/]+/, '~')}`);
  if (!item.ready) return null;
  return action('Save as a file', async () => {
    const done = await act('explain.export', { id: item.id });
    if (!done) return;
    toast(`Saved: ${done.file}`);
    refreshLibrary();
  });
}

/** The player on an explainer, at the clip you were on: its own window where there is one. */
async function openExplainer(id, at = null) {
  const clip = Number.isInteger(at) && at > 1 ? at : null;
  if (isNative() && await openWindow('learn/video', { explain: id, ...(clip ? { clip } : {}) })) return;
  window.open(withToken(`video/?explain=${encodeURIComponent(id)}${clip ? `&clip=${clip}` : ''}`), 'learn-video', 'popup,width=1180,height=760');
}

function togglePicker(job) {
  if (L.pickingJob === job.id) {
    L.pickingJob = null;
  } else {
    L.pickingJob = job.id;
    L.picks = new Set((job.candidates || []).filter(candidate => candidate.recommended).map(candidate => candidate.id));
  }
  showJobs();
}

function picker(job) {
  const panel = h('div.picker');
  if (job.summary) panel.append(h('p.dim', null, job.summary));
  const asks = job.asks || [];
  const gaps = asks.filter((ask, number) => !(job.candidates || []).some(candidate => L.picks.has(candidate.id) && (candidate.covers || []).includes(number)));
  if (asks.length) panel.append(h(`p.pick-cover${gaps.length ? '.gap' : ''}`, null, gaps.length ? `Not covered by what's ticked: ${gaps.join(', ')}` : `Covers everything you named: ${asks.join(', ')}`));
  // The recommended ones first, already ticked.
  const candidates = [...(job.candidates || [])].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  for (const candidate of candidates) {
    const ticked = L.picks.has(candidate.id);
    const kind = candidate.kind === 'youtube' ? `${GLYPH.play} video` : `${GLYPH.link} page`;
    const meta = [kind, candidate.channel, candidate.lengthMin ? `${candidate.lengthMin} min` : '', candidate.level].filter(Boolean).join(`  ${GLYPH.dot}  `);
    const open = !isHttp(candidate.url) ? null : h('a.open-link', { href: candidate.url, target: '_blank', rel: 'noopener noreferrer', onclick: event => event.stopPropagation() }, `open ${GLYPH.link}`);
    panel.append(h(`div.candidate${ticked ? '.ticked' : ''}`, {
      role: 'checkbox',
      'aria-checked': String(ticked),
      tabindex: '0',
      onclick: () => {
        if (L.picks.has(candidate.id)) L.picks.delete(candidate.id);
        else L.picks.add(candidate.id);
        showJobs();
      },
      onkeydown: event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.currentTarget.click(); } },
    },
    h('span.tick', null, ticked ? GLYPH.ticked : GLYPH.box),
    h('div.candidate-text', null,
      h('div.candidate-title', null, candidate.title),
      h('div.meta', null, meta),
      candidate.why ? h('div.why', null, candidate.why) : null),
    open));
  }
  const count = L.picks.size;
  panel.append(h('div.pick-all', null, action('Use all', () => {
    L.picks = new Set((job.candidates || []).map(candidate => candidate.id));
    showJobs();
  }, 'blue')));
  panel.append(h('button.ui-btn.primary', {
    type: 'button',
    onclick: async () => {
      if (!L.picks.size) {
        toast('Tick at least one source');
        return;
      }
      if ((await act('build.pick', { jobId: job.id, picks: [...L.picks] })) === undefined) return;
      L.pickingJob = null;
      toast('Building from your picks');
      refreshLibrary();
    },
  }, count === 1 ? 'Build from 1 source' : `Build from ${count} sources`));
  return panel;
}

// --- Courses ---------------------------------------------------------------------------------

/** A category's heading with rename and remove (shown on hover). */
export function categoryHeader(id, text, categories, reload, onLabelClick = null) {
  if (L.renamingCategory === id) {
    return h('div.category-head', null, inlineEdit({
      value: categoryName(id),
      placeholder: 'Category name',
      onSave: async name => {
        if (!name) return false;
        if ((await act('category.rename', { id, name })) === undefined) return false;
        L.renamingCategory = null;
        nav.refreshLibrary();
        nav.refreshLearned();
        return true;
      },
      onCancel: () => { L.renamingCategory = null; reload(); },
      cls: 'narrow',
    }));
  }
  const label = h(`h3.category-label${onLabelClick ? '.clickable' : ''}`, onLabelClick ? { onclick: onLabelClick } : null, text);
  return h('div.category-head', null, label, h('div.hover-actions', null,
    action('rename', () => { L.renamingCategory = id; reload(); }),
    action('remove', event => removeCategory(id, categories, event.currentTarget))));
}

async function removeCategory(id, categories, el) {
  const others = (categories || []).filter(category => category.id !== id);
  if (!others.length) {
    toast('This is your only category');
    return;
  }
  if (!armed(`category:${id}`, el)) return;
  const target = others.find(category => category.name === 'General') || others[0];
  if ((await act('category.remove', { id, moveTo: target.id })) === undefined) return;
  toast(`Removed. Its courses and concepts moved to ${target.name}.`);
  nav.refreshLibrary();
  nav.refreshLearned();
}

function showCourses() {
  if (!ui || !S.library) return;
  const all = S.library.courses || [];
  if (!all.length) {
    ui.courses.replaceChildren(h('p.empty', null, "No courses yet. Type a topic above, for example 'Kubernetes deployments' or 'Postgres indexes', and Claude researches free videos and docs and writes you a course you read page by page, with a chat beside each page."));
    return;
  }
  const query = ui.search.value.trim().toLowerCase();
  const shown = all.filter(course => !query || String(course.title).toLowerCase().includes(query) || String(course.topic || '').toLowerCase().includes(query));
  const order = S.library.categories.map(category => category.id);
  for (const course of shown) if (!order.includes(course.category)) order.push(course.category);
  const out = [];
  for (const categoryId of order) {
    const inCategory = shown.filter(course => course.category === categoryId);
    if (!inCategory.length) continue;
    out.push(categoryHeader(categoryId, [categoryName(categoryId), h('span.count', null, String(inCategory.length))], S.library.categories, showCourses));
    for (const course of inCategory) out.push(courseRow(course));
  }
  if (!shown.length) out.push(h('p.empty', null, 'No course matches.'));
  ui.courses.replaceChildren(...out);
}

function courseRow(course) {
  const id = course.id;
  const editing = L.renamingCourse === id || L.editingSummary === id;
  const counts = h('span.counts.mono', null, `${course.read}/${course.pages} read  ${GLYPH.dot}  ${course.learned}/${course.concepts} learned`);
  const title = L.renamingCourse === id
    ? inlineEdit({
      value: course.title,
      placeholder: 'Course name',
      onSave: async text => {
        if (!text) return false;
        if ((await act('course.update', { id, title: text })) === undefined) return false;
        L.renamingCourse = null;
        refreshLibrary();
        return true;
      },
      onCancel: () => { L.renamingCourse = null; showCourses(); },
    })
    : h('span.course-title', null, course.title);
  const row = h(`article.course-row${editing ? '.editing' : ''}`, {
    tabindex: editing ? null : '0',
    onclick: () => { if (!editing) nav.openCourse(id, null); },
    onkeydown: event => { if (event.key === 'Enter' && event.target === event.currentTarget) nav.openCourse(id, null); },
  }, h('div.course-top', null, title, counts));

  if (L.editingSummary === id) {
    row.append(inlineEdit({
      value: course.summary,
      placeholder: 'What the course is about (Enter saves, Shift+Enter for a new line)',
      multiline: true,
      onSave: async text => {
        if ((await act('course.update', { id, summary: text })) === undefined) return false;
        L.editingSummary = null;
        refreshLibrary();
        return true;
      },
      onCancel: () => { L.editingSummary = null; showCourses(); },
    }));
  } else if (course.summary) {
    row.append(h('p.course-summary', null, short(course.summary, 240)));
  }

  const foot = h('div.course-foot');
  if (course.status !== 'ready') foot.append(h('span.gold', null, `Being written: ${course.written} of ${course.pages} pages so far`));
  if (course.lastOpened) foot.append(h('span.faint', null, `Opened ${formatDate(course.lastOpened)}`));
  foot.append(
    action('move', () => { L.movingCourse = L.movingCourse === id ? null : id; showCourses(); }),
    action('rename', () => { L.renamingCourse = id; L.editingSummary = null; showCourses(); }),
    action('edit summary', () => { L.editingSummary = id; L.renamingCourse = null; showCourses(); }),
    action('remove', event => removeCourse(id, event.currentTarget)),
  );
  row.append(foot);

  if (L.movingCourse === id) {
    const newCategory = h('input.ui-input.small', { type: 'text', placeholder: 'New category', onclick: event => event.stopPropagation() });
    onEnter(newCategory, async () => {
      const name = newCategory.value.trim();
      if (!name) return;
      const made = await act('category.add', { name });
      if (!made) return;
      if ((await act('course.setCategory', { id, category: made.id })) === undefined) return;
      L.movingCourse = null;
      refreshLibrary();
    });
    row.append(h('div.chips.move-chips', null,
      h('span.faint', null, 'Move to'),
      S.library.categories.map(category => chip(category.name, category.id === course.category, async () => {
        if ((await act('course.setCategory', { id, category: category.id })) === undefined) return;
        L.movingCourse = null;
        refreshLibrary();
      })),
      newCategory));
  }
  return row;
}

async function removeCourse(id, el) {
  if (!armed(`course:${id}`, el)) return;
  const result = await act('course.remove', { id });
  if (!result) return;
  if (S.courseId === id) {
    S.courseId = null;
    S.courseData = null;
    S.pageData = null;
    S.pageN = 0;
  }
  const count = Number(result.removedConcepts) || 0;
  toast(count === 1 ? 'Course removed, with the 1 concept only it taught.' : `Course removed, with the ${count} concepts only it taught.`);
  S.concepts = null;
  nav.showView('library');
}

/** Esc and a new library forget the half-done edits. */
export function resetLibraryModes() {
  L.pickingJob = null;
  L.renamingCourse = null;
  L.editingSummary = null;
  L.movingCourse = null;
  L.renamingCategory = null;
}
