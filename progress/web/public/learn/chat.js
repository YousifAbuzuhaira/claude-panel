// The chats: one conversation per key ("<courseId>:<n>" for a page, "advisor" for Ask).
// Each key keeps its own DOM, so a reply keeps streaming while you look elsewhere.
import { renderBlocks } from './blocks.js';
import { GLYPH, S, act, call, h, nav, toast } from './core.js';
import { startBuild } from './library.js';

const chats = new Map(); // key -> { el, messages, busy, live, tool, liveSection }
const panels = new Set();

export const pageKey = (courseId, n) => `${courseId}:${n}`;

function stateOf(key) {
  if (!chats.has(key)) chats.set(key, { el: h('div.chat-log'), messages: [], busy: false, live: null, tool: null, liveSection: null });
  return chats.get(key);
}

export function forgetChats(keep = () => false) {
  for (const [key, state] of chats) if (!state.busy && !keep(key)) chats.delete(key);
}

export const forgetChat = key => { if (!chats.get(key)?.busy) chats.delete(key); };

// --- Concept names and states for the Mark learned buttons ------------------------------------

function conceptInfo(id) {
  const fromPage = (S.pageData?.concepts || []).find(concept => concept.id === id);
  if (fromPage) return fromPage;
  if (S.courseData?.concepts?.[id]) return S.courseData.concepts[id];
  return (S.concepts?.concepts || []).find(concept => concept.id === id) || null;
}

const conceptName = id => conceptInfo(id)?.name || id;
const allLearned = ids => ids.every(id => conceptInfo(id)?.state === 'learned');

/** Set by course.js: marks a concept learned and refreshes the page's chips. */
export const chatHooks = { learn: async (id, learned) => act('concept.learn', { id, learned }) };

function offerButton(ids) {
  const names = ids.map(conceptName).join(', ');
  if (allLearned(ids)) return h('button.chat-button.done', { type: 'button', disabled: true }, `${GLYPH.check} Learned: ${names}`);
  const button = h('button.chat-button.learn', {
    type: 'button',
    onclick: async () => {
      button.disabled = true;
      // The person's own click: the only way anything becomes Learned.
      for (const id of ids) await chatHooks.learn(id, true);
      button.textContent = `${GLYPH.check} Learned`;
      button.classList.add('done');
    },
  }, `Mark learned: ${names}`);
  return button;
}

function buildButton(build) {
  let started = false;
  const button = h('button.chat-button.build', {
    type: 'button',
    onclick: async () => {
      if (started) {
        nav.showView('library');
        return;
      }
      button.disabled = true;
      const job = await startBuild(build.topic, build.category || 'General', 'pick');
      button.disabled = false;
      if (!job) return;
      started = true;
      button.textContent = `Building: ${build.topic}. Open the Library to pick its sources.`;
      button.classList.add('done');
    },
  }, `Build this: ${build.topic}  (${build.category || 'General'})`);
  return button;
}

function messageSection(message) {
  if (message.role === 'user') {
    return h('section.msg.user', null, h('div.who', null, 'You'), h('div.msg-text', null, String(message.text || '')));
  }
  const body = message.blocks ? renderBlocks(message.blocks) : [h('p', null, String(message.text || ''))];
  const buttons = [];
  if ((message.offers || []).length) buttons.push(offerButton(message.offers));
  for (const build of message.builds || []) if (build && build.topic) buttons.push(buildButton(build));
  return h('section.msg.claude', null, h('div.who', null, 'Claude'), h('div.msg-body.prose', null, body), buttons.length ? h('div.msg-buttons', null, buttons) : null);
}

function emptyNote(key) {
  return h('p.chat-empty', null, key === 'advisor'
    ? 'Ask what to learn next. Claude looks at what you have learned and read, and at the work folders you set in Settings, to suggest what would help you most.'
    : 'Ask about anything on this page, or answer one of its check questions. Claude knows the page and its sources.');
}

function redraw(key) {
  const state = stateOf(key);
  state.el.replaceChildren(...(state.messages.length ? state.messages.map(messageSection) : [emptyNote(key)]));
}

// --- A chat panel: the log, the box and the Send/Stop button ----------------------------------

/**
 * `fields()` gives the target ({ courseId, n } or { advisor: true }), or null when nothing
 * can be sent (no written page). `newLabel` names the clear link.
 */
export function chatPanel({ title, placeholder, newLabel, fields }) {
  const log = h('div.chat-scroll');
  const input = h('textarea.input.chat-input', { placeholder, rows: 3, 'aria-label': 'Message' });
  const send = h('button.button.primary.send', { type: 'button' }, 'Send');
  const clear = h('button.action.dim', { type: 'button' }, newLabel);
  const head = h('div.chat-head', null, title ? h('h3.chat-title', null, title) : null, clear);
  const root = h('div.chat-panel', null, head, log, h('div.chat-compose', null, input, send));
  const panel = { root, input, send, log, key: null, fields, head };
  panels.add(panel);

  send.addEventListener('click', () => submit(panel));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(panel);
    }
  });
  clear.addEventListener('click', async () => {
    if (!panel.key) return;
    const state = stateOf(panel.key);
    if (state.busy) {
      toast('Wait for the answer, or stop it first');
      return;
    }
    const target = fields();
    if (!target) return;
    if ((await act('chat.clear', target)) === undefined) return;
    state.messages = [];
    redraw(panel.key);
  });
  return panel;
}

/** Shows `key`'s conversation in the panel; `messages` replace it unless a reply is coming. */
export function showChat(panel, key, messages) {
  const state = stateOf(key);
  if (!state.busy) {
    state.messages = [...(messages || [])];
    redraw(key);
  }
  panel.key = key;
  panel.log.replaceChildren(state.el);
  updateSend(panel);
  toEnd(panel);
}

/** Opening a chat that isn't part of a page: chat.get. */
export async function openChat(panel, key, target) {
  const state = stateOf(key);
  if (state.busy) {
    showChat(panel, key, state.messages);
    return;
  }
  try {
    const chat = await call('chat.get', target);
    showChat(panel, key, chat.messages);
  } catch (error) {
    showChat(panel, key, []);
    toast(String(error.message || error), 'error');
  }
}

export function fillInput(panel, text) {
  panel.input.value = text;
  panel.input.focus();
  panel.input.setSelectionRange(text.length, text.length);
}

function updateSend(panel) {
  const busy = panel.key && chats.get(panel.key)?.busy;
  panel.send.textContent = busy ? 'Stop' : 'Send';
  panel.send.classList.toggle('primary', !busy);
  panel.send.classList.toggle('stop', Boolean(busy));
}

function updatePanelsFor(key) {
  for (const panel of panels) if (panel.key === key) updateSend(panel);
}

function toEnd(panel) {
  requestAnimationFrame(() => { panel.log.scrollTop = panel.log.scrollHeight; });
}

function toEndFor(key) {
  for (const panel of panels) {
    if (panel.key !== key) continue;
    const log = panel.log;
    // Follow the reply only if the reader is already near the bottom.
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) toEnd(panel);
  }
}

export async function submit(panel) {
  const key = panel.key;
  if (!key) return;
  const state = stateOf(key);
  if (state.busy) {
    act('chat.stop', { key });
    return;
  }
  const target = panel.fields();
  if (!target) {
    toast('Open a written page first');
    return;
  }
  const text = panel.input.value.trim();
  if (!text) return;
  if (!state.messages.length) state.el.replaceChildren();
  const user = { role: 'user', text };
  state.messages.push(user);
  state.el.append(messageSection(user));
  const tool = h('span.tool', null, 'thinking');
  const live = h('div.msg-text.live-text');
  const liveSection = h('section.msg.claude.live', null, h('div.who', null, 'Claude', tool), live);
  state.el.append(liveSection);
  Object.assign(state, { busy: true, live, tool, liveSection });
  panel.input.value = '';
  updatePanelsFor(key);
  toEnd(panel);
  try {
    await call('chat.send', { ...target, text });
  } catch (error) {
    failed(key, String(error.message || error));
  }
}

// --- Stream events: only for keys this page knows -----------------------------------------------

export function chatEvent(event) {
  const state = chats.get(event.key);
  if (!state) return;
  switch (event.event) {
    case 'chat.delta':
      if (!state.live) return;
      state.live.textContent += event.text || '';
      if (state.tool) state.tool.textContent = '';
      toEndFor(event.key);
      break;
    case 'chat.tool':
      if (state.tool) state.tool.textContent = event.text || '';
      break;
    case 'chat.done': {
      state.liveSection?.remove();
      Object.assign(state, { busy: false, live: null, tool: null, liveSection: null });
      if (event.message) {
        state.messages.push(event.message);
        state.el.append(messageSection(event.message));
      }
      updatePanelsFor(event.key);
      toEndFor(event.key);
      break;
    }
    case 'chat.error':
      failed(event.key, event.error || 'Something went wrong');
      break;
    default: break;
  }
}

function failed(key, text) {
  const state = chats.get(key);
  if (!state) return;
  if (state.live) {
    state.live.append(h(`div.chat-error${text === 'Stopped' ? '.stopped' : ''}`, null, text));
  } else {
    state.el.append(h(`div.chat-error${text === 'Stopped' ? '.stopped' : ''}`, null, text));
  }
  if (state.tool) state.tool.textContent = '';
  state.liveSection?.classList.remove('live');
  Object.assign(state, { busy: false, live: null, tool: null, liveSection: null });
  updatePanelsFor(key);
}

/** After a concept changes, Mark learned buttons in idle chats redraw from the new states. */
export function redrawIdle(keyMatch) {
  for (const [key, state] of chats) if (!state.busy && keyMatch(key)) redraw(key);
}
