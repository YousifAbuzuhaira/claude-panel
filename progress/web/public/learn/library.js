// Library: a new course, the builds, and the courses by category.
import { GLYPH, S, act, action, armed, categoryName, chip, formatDate, h, inlineEdit, isHttp, nav, onEnter, short, toast } from './core.js';

const L = {
  mode: 'pick',
  pickingJob: null,
  picks: new Set(),
  renamingCourse: null,
  editingSummary: null,
  movingCourse: null,
  renamingCategory: null,
  lastAt: 0,
};

let ui = null;

export function buildLibraryView(host) {
  const topic = h('input.input.grow', { type: 'text', placeholder: 'A topic to learn, or a YouTube video, playlist or docs link', 'aria-label': 'Topic or link' });
  const category = h('input.input.category', { type: 'text', placeholder: 'Category', 'aria-label': 'Category' });
  const pickChip = chip('Let me pick', true, () => setMode('pick'));
  pickChip.title = 'Research first, then you tick which videos and pages the course is built from';
  const autoChip = chip('Just build it', false, () => setMode('auto'));
  autoChip.title = 'Claude picks the sources and builds the course straight away';
  const build = h('button.button.primary', { type: 'button', onclick: submitNewCourse }, 'Build');
  const categoryChips = h('div.chips.category-chips');
  const search = h('input.input.search', { type: 'search', placeholder: 'Search your courses', 'aria-label': 'Search courses' });
  const jobs = h('section.jobs');
  const courses = h('section.courses');
  onEnter(topic, submitNewCourse);
  search.addEventListener('input', showCourses);

  host.append(h('div.library-view', null,
    h('section.card.new-course', null,
      h('h2.card-title', null, 'New course'),
      h('div.new-row', null, topic, category, h('div.modes', null, pickChip, autoChip), build),
      categoryChips),
    search,
    jobs,
    courses));
  ui = { topic, category, pickChip, autoChip, categoryChips, search, jobs, courses };
}

function setMode(mode) {
  L.mode = mode;
  ui.pickChip.classList.toggle('on', mode === 'pick');
  ui.autoChip.classList.toggle('on', mode === 'auto');
}

function submitNewCourse() {
  const topic = ui.topic.value.trim();
  if (!topic) {
    toast('Type a topic, or paste a link');
    return;
  }
  const category = ui.category.value.trim() || 'General';
  startBuild(topic, category, L.mode);
  ui.topic.value = '';
}

/** Also what a chat's *Build this* does (always in pick mode). */
export async function startBuild(topic, category, mode) {
  const fields = { category, mode };
  if (/^https?:\/\//i.test(topic)) fields.link = topic;
  else fields.topic = topic;
  const job = await act('build.start', fields);
  if (!job) return null;
  toast(`Building: ${job.topic}. It carries on if you close this page.`);
  refreshLibrary();
  return job;
}

export async function refreshLibrary() {
  L.lastAt = Date.now();
  const result = await act('library.get');
  if (!result) return;
  S.library = result;
  if (result.status) S.status = result.status;
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
  if (!L.pickingJob && new URLSearchParams(location.search).has('pick')) {
    const waiting = (S.library.jobs || []).find(job => job.state === 'waiting-picks');
    if (waiting) {
      L.pickingJob = waiting.id;
      L.picks = new Set((waiting.candidates || []).filter(candidate => candidate.recommended).map(candidate => candidate.id));
    }
  }
  showJobs();
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
    case 'running': add('Pause', jobAction('build.cancel', job.id), 'dim'); break;
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
      add('Dismiss', jobAction('build.dismiss', job.id), 'dim');
      break;
    default: break;
  }
  const row = h(`div.job.state-${job.state}`, null,
    h('div.job-top', null, h('span.job-title', null, job.topic || job.courseTitle || 'A build'), actions),
    h('div.job-message', null, job.message || job.state));
  if (job.state === 'failed' && job.error) row.append(h('div.job-error', null, short(job.error, 300)));
  if (job.total > 0 && job.state !== 'done') {
    const ratio = Math.max(0, Math.min(1, job.done / job.total));
    row.append(h('div.job-bar', null,
      h('div.bar', null, h('div.bar-fill', { style: { width: `${Math.round(ratio * 100)}%` } })),
      h('span.mono.dim', null, `${job.done}/${job.total} pages`)));
  }
  if (job.state === 'waiting-picks' && L.pickingJob === job.id) row.append(picker(job));
  return row;
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
  panel.append(h('button.button.primary', {
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
    const newCategory = h('input.input.small', { type: 'text', placeholder: 'New category', onclick: event => event.stopPropagation() });
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
