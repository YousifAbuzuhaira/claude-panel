// Learned: every concept, by category, as a tree by parent. Add what you know, tidy, edit.
import { GLYPH, S, act, action, armed, categoryName, chip, formatDate, h, inlineEdit, onEnter, short, toast } from './core.js';
import { categoryHeader } from './library.js';

const M = {
  filter: 'all',
  category: '', // the category id added concepts go to
  renamingConcept: null,
  editingDefinition: null,
  movingConcept: null,
  mergeFrom: null,
  nestFrom: null,
  tidy: null,
};

let ui = null;

export function buildLearnedView(host) {
  const addBox = h('input.input.grow', { type: 'text', placeholder: 'Add something you already know, e.g. "Git rebase" (Claude files it)', 'aria-label': 'Add a concept' });
  const addButton = h('button.button.green', { type: 'button', onclick: addKnown }, 'Add as learned');
  onEnter(addBox, addKnown);
  const filters = h('div.chips.filters');
  const tidyLink = action('Tidy concepts', startTidy, 'blue');
  tidyLink.title = 'Claude looks for concepts that are the same idea under two names, and suggests merges';
  const newCategory = h('input.input.small', { type: 'text', placeholder: 'New category', 'aria-label': 'New category' });
  onEnter(newCategory, async () => {
    const name = newCategory.value.trim();
    if (!name) return;
    const made = await act('category.add', { name });
    if (!made) return;
    newCategory.value = '';
    toast(`Category: ${made.name}`);
    refreshLearned();
  });
  const search = h('input.input.search', { type: 'search', placeholder: 'Search concepts', 'aria-label': 'Search concepts' });
  search.addEventListener('input', showLearned);
  const tidyPanel = h('div.tidy');
  const note = h('div.mode-note');
  const list = h('div.concept-list');
  host.append(h('div.learned-view', null,
    h('div.add-row', null, addBox, addButton),
    h('div.learned-tools', null, filters, tidyLink, newCategory),
    search, tidyPanel, note, list));
  ui = { addBox, filters, search, tidyPanel, note, list };
  showFilters();
}

function showFilters() {
  const options = [['all', 'All'], ['learned', `${GLYPH.check} Learned`], ['seen', `${GLYPH.half} Read`], ['new', `${GLYPH.empty} New`]];
  ui.filters.replaceChildren(...options.map(([key, label]) => chip(label, M.filter === key, () => { M.filter = key; showFilters(); showLearned(); })));
}

export async function refreshLearned() {
  const result = await act('concept.list');
  if (!result) return;
  S.concepts = result;
  showLearned();
}

async function addKnown() {
  const text = ui.addBox.value.trim();
  if (!text) return;
  ui.addBox.value = '';
  toast(`Filing: ${text}`);
  // The category here is an id, not a name.
  const concept = await act('concept.add', { text, category: M.category || '' });
  if (!concept) return;
  toast(`Learned: ${concept.name}`);
  refreshLearned();
}

async function startTidy() {
  ui.tidyPanel.replaceChildren(h('p.dim', null, 'Claude is reading your concepts for duplicates...'));
  const result = await act('concept.tidy');
  if (!result) {
    ui.tidyPanel.replaceChildren();
    return;
  }
  M.tidy = result;
  showTidy();
}

function showTidy() {
  if (!M.tidy) {
    ui.tidyPanel.replaceChildren();
    return;
  }
  if (!M.tidy.length) {
    ui.tidyPanel.replaceChildren(h('p.green', null, 'No duplicates found.'));
    return;
  }
  ui.tidyPanel.replaceChildren(h('h3.label.blue', null, 'Same idea, two names?'), ...M.tidy.map(merge => h('div.tidy-row', null,
    h('span', null, `'${merge.dropName}' into '${merge.keepName}'${merge.reason ? `: ${merge.reason}` : ''}`),
    h('span.row-actions', null,
      action('merge', async () => {
        if (!(await act('concept.merge', { keep: merge.keep, drop: merge.drop }))) return;
        M.tidy = M.tidy.filter(other => other.drop !== merge.drop && other.keep !== merge.drop);
        showTidy();
        refreshLearned();
      }, 'accent'),
      // Only hides it.
      action('not the same', () => { M.tidy = M.tidy.filter(other => other !== merge); showTidy(); }, 'faint')))));
}

const nameOf = id => (S.concepts?.concepts || []).find(concept => concept.id === id)?.name || id;
const courseTitle = id => (id ? S.concepts?.courseTitles?.[id] || 'a removed course' : 'a course');
const glyphOf = state => (state === 'learned' ? GLYPH.check : state === 'seen' ? GLYPH.half : GLYPH.empty);

export function showLearned() {
  if (!ui) return;
  const data = S.concepts;
  ui.note.textContent = M.mergeFrom
    ? `Merging '${nameOf(M.mergeFrom)}': click 'into' on the concept to keep. Esc cancels.`
    : M.nestFrom ? `Nesting '${nameOf(M.nestFrom)}': click 'under' on its new parent, or 'top level' on its own row. Esc cancels.` : '';
  ui.note.hidden = !ui.note.textContent;
  if (!data) {
    ui.list.replaceChildren();
    return;
  }
  const all = data.concepts || [];
  if (!all.length) {
    ui.list.replaceChildren(h('p.empty', null, 'No concepts yet. Each course adds the concepts it teaches here; you mark them learned on the page. You can also add what you already know above.'));
    return;
  }
  const query = ui.search.value.trim().toLowerCase();
  const matches = new Set(all.filter(concept => {
    const okState = M.filter === 'all' || concept.state === M.filter;
    const okText = !query || concept.name.toLowerCase().includes(query) || (concept.aliases || []).join(' ').toLowerCase().includes(query);
    return okState && okText;
  }).map(concept => concept.id));
  const categories = [...data.categories];
  for (const concept of all) {
    if (!categories.some(category => category.id === concept.category)) categories.push({ id: concept.category, name: concept.category || 'Other' });
  }
  const out = [];
  for (const category of categories) {
    const inCategory = all.filter(concept => concept.category === category.id);
    const shown = inCategory.filter(concept => matches.has(concept.id));
    if (!shown.length && (query || M.filter !== 'all')) continue;
    const learned = inCategory.filter(concept => concept.state === 'learned').length;
    const target = M.category === category.id;
    const head = categoryHeader(category.id, [category.name, h('span.count', null, `${learned} learned of ${inCategory.length}`), target ? h('span.target-note', null, 'adds go here') : null], data.categories, showLearned, () => {
      M.category = M.category === category.id ? '' : category.id;
      showLearned();
    });
    head.title = 'Click the name: concepts you add go into this category';
    if (target) head.classList.add('target');
    out.push(head);
    // A tree: each concept under its parent when the parent is in the same category.
    const ids = new Set(inCategory.map(concept => concept.id));
    const byName = (a, b) => a.name.localeCompare(b.name);
    const walk = (concept, depth, seen) => {
      if (depth > 6 || seen.has(concept.id)) return;
      seen.add(concept.id);
      if (matches.has(concept.id)) out.push(conceptRow(concept, depth));
      for (const child of inCategory.filter(other => other.parent === concept.id).sort(byName)) walk(child, depth + 1, seen);
    };
    const seen = new Set();
    for (const root of inCategory.filter(concept => !concept.parent || !ids.has(concept.parent)).sort(byName)) walk(root, 0, seen);
  }
  ui.list.replaceChildren(...out);
}

function conceptRow(concept, depth) {
  const id = concept.id;
  const state = concept.state;
  const glyph = h(`button.state-glyph.${state}`, {
    type: 'button',
    title: state === 'learned' ? 'Learned: click to unmark' : 'Click to mark learned',
    onclick: async () => {
      // No courseId: a tick from the Learned list.
      if (await act('concept.learn', { id, learned: state !== 'learned' })) refreshLearned();
    },
  }, glyphOf(state));

  let where = '';
  if (concept.learned) {
    where = `learned ${formatDate(concept.learned.at)}`;
    if (concept.learned.course) where += ` ${GLYPH.dot} ${short(courseTitle(concept.learned.course), 30)}`;
  } else if ((concept.seen || []).length) {
    const courses = [...new Set(concept.seen.map(seen => seen.course))];
    where = courses.length === 1 ? `read in ${short(courseTitle(courses[0]), 30)}` : `read in ${courses.length} courses`;
  }

  const keys = M.mergeFrom && M.mergeFrom !== id ? ['into']
    : M.nestFrom && M.nestFrom !== id ? ['under']
      : M.nestFrom === id ? ['top level', 'cancel']
        : ['rename', 'edit', 'nest', 'move', 'merge'];
  const isTarget = ['into', 'under', 'top level'].includes(keys[0]);
  const editing = M.renamingConcept === id || M.movingConcept === id || M.editingDefinition === id;
  const tools = h(`span.concept-tools${isTarget || editing ? '.shown' : ''}`, null,
    keys.map(key => action(key, event => conceptAction(key, id, event.currentTarget), isTarget && key !== 'cancel' ? 'accent' : 'faint')));
  const actions = h('div.concept-actions', null, where ? h('span.where', null, where) : null, tools,
    isTarget ? null : (() => {
      // Always there, so removing never depends on finding the hover actions.
      const remove = action(GLYPH.close, event => conceptAction('remove', id, event.currentTarget), 'faint.remove');
      remove.title = 'Remove this concept';
      return remove;
    })());

  const text = h('div.concept-text');
  if (M.renamingConcept === id) {
    text.append(inlineEdit({
      value: concept.name,
      placeholder: 'Name',
      onSave: async name => {
        if (!name) return false;
        if (!(await act('concept.update', { id, name }))) return false;
        M.renamingConcept = null;
        refreshLearned();
        return true;
      },
      onCancel: () => { M.renamingConcept = null; showLearned(); },
    }));
  } else {
    text.append(h(`div.concept-name${state === 'new' ? '.dim' : ''}`, null, concept.name));
  }
  if (M.editingDefinition === id) {
    text.append(inlineEdit({
      value: concept.definition || '',
      placeholder: 'What it is, in one line',
      multiline: true,
      onSave: async definition => {
        if (!(await act('concept.update', { id, definition }))) return false;
        M.editingDefinition = null;
        refreshLearned();
        return true;
      },
      onCancel: () => { M.editingDefinition = null; showLearned(); },
    }));
  } else if (concept.definition) {
    text.append(h('div.concept-definition', null, concept.definition));
  }
  if ((concept.alsoUsedIn || []).length) text.append(h('div.faint.small', null, `also used in ${concept.alsoUsedIn.map(categoryName).join(', ')}`));
  if (M.movingConcept === id) {
    text.append(h('div.chips.move-chips', null, h('span.faint', null, 'Move to'), (S.concepts.categories || []).map(category => chip(category.name, category.id === concept.category, async () => {
      if (!(await act('concept.move', { id, category: category.id }))) return;
      M.movingConcept = null;
      refreshLearned();
    }))));
  }
  return h(`div.concept-row${isTarget ? '.picking' : ''}`, {
    style: { paddingLeft: `${8 + depth * 22}px` },
    title: (concept.aliases || []).length ? `Also called: ${concept.aliases.join(', ')}` : null,
  }, glyph, text, actions);
}

async function conceptAction(key, id, el) {
  switch (key) {
    case 'rename': Object.assign(M, { renamingConcept: id, movingConcept: null, editingDefinition: null }); showLearned(); break;
    case 'edit': Object.assign(M, { editingDefinition: id, renamingConcept: null, movingConcept: null }); showLearned(); break;
    case 'nest': Object.assign(M, { nestFrom: id, mergeFrom: null }); showLearned(); break;
    case 'cancel': M.nestFrom = null; showLearned(); break;
    case 'under':
    case 'top level': {
      const child = M.nestFrom;
      M.nestFrom = null;
      const result = await act('concept.update', { id: child, parent: key === 'under' ? id : null });
      if (result) refreshLearned();
      else showLearned();
      break;
    }
    case 'move': Object.assign(M, { movingConcept: M.movingConcept === id ? null : id, renamingConcept: null }); showLearned(); break;
    case 'merge': Object.assign(M, { mergeFrom: id, nestFrom: null }); showLearned(); break;
    case 'into': {
      const drop = M.mergeFrom;
      M.mergeFrom = null;
      const kept = await act('concept.merge', { keep: id, drop });
      if (kept) toast(`Merged into ${kept.name}`);
      refreshLearned();
      break;
    }
    case 'remove': {
      if (!armed(`concept:${id}`, el, 'remove?')) return;
      const name = nameOf(id);
      if ((await act('concept.remove', { id })) === undefined) return;
      toast(`Removed: ${name}`);
      refreshLearned();
      break;
    }
    default: break;
  }
}

/** Esc leaves the modes. True when there was one to leave. */
export function leaveLearnedModes() {
  const had = M.renamingConcept || M.movingConcept || M.mergeFrom || M.nestFrom || M.editingDefinition;
  Object.assign(M, { renamingConcept: null, movingConcept: null, mergeFrom: null, nestFrom: null, editingDefinition: null });
  if (had) showLearned();
  return Boolean(had);
}

export function resetLearned() {
  leaveLearnedModes();
  M.tidy = null;
  M.category = '';
  if (ui) ui.tidyPanel.replaceChildren();
}
