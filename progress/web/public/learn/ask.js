// Ask: the Advisor's chats, as many as you keep. The list on the left (advisor.list, the one
// used last on top); a new chat's id is made here, so its key (advisor:<id>) never changes
// mid-reply; a chat is saved with its first question.
import { chatBusy, chatEmpty, chatPanel, doneListeners, fillInput, forgetChat, isAdvisorKey, openChat, submit } from './chat.js';
import { GLYPH, act, armed, call, chip, formatDate, h, toast } from './core.js';

const SUGGESTIONS = [
  'What should I learn next?',
  'What am I missing for the stack I work in?',
  'Plan my next month of learning',
  'What would make me a stronger senior engineer?',
];

let panel = null;
let list = null;
let current = null; // the chat in front
let saved = []; // advisor.list

const newId = () => `a${Date.now().toString(16)}${Math.random().toString(36).slice(2, 6)}`;
const keyOf = id => `advisor:${id}`;
const isSaved = id => saved.some(chat => chat.id === id);

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return formatDate(iso);
}

function row(id, title, at, isSavedChat) {
  const remove = isSavedChat ? h('button.chat-remove', { type: 'button', title: 'Delete this chat (click twice)', 'aria-label': 'Delete this chat' }, GLYPH.close || '✕') : null;
  const item = h(`li.chat-item${id === current ? '.on' : ''}`, { title },
    h('button.chat-pick', { type: 'button' }, h('span.chat-name', null, title), at ? h('span.chat-when', null, when(at)) : null),
    remove);
  item.querySelector('.chat-pick').addEventListener('click', () => select(id));
  remove?.addEventListener('click', async event => {
    event.stopPropagation();
    if (!armed(`advisor-remove:${id}`, remove, 'delete?')) return;
    if ((await act('advisor.remove', { chatId: id })) === undefined) return;
    forgetChat(keyOf(id));
    saved = saved.filter(chat => chat.id !== id);
    if (current === id) {
      current = saved[0]?.id || newId();
      show();
    }
    drawList();
    toast('Chat deleted');
  });
  return item;
}

function drawList() {
  if (!list) return;
  const rows = [];
  if (!isSaved(current)) rows.push(row(current, 'New chat', null, false));
  for (const chat of saved) rows.push(row(chat.id, chat.title || 'Untitled chat', chat.updatedAt, true));
  list.replaceChildren(...rows);
}

async function refresh() {
  try {
    saved = (await call('advisor.list')) || [];
  } catch {
    return;
  }
  drawList();
}

function show() {
  panel.wanted = keyOf(current);
  openChat(panel, keyOf(current), { advisor: true, chatId: current }, { saved: isSaved(current) });
}

function select(id) {
  if (id === current) return;
  current = id;
  drawList();
  show();
}

function startNew() {
  // The chat in front is new and still empty: it is the new chat.
  if (!isSaved(current) && !chatBusy(keyOf(current)) && chatEmpty(keyOf(current))) {
    panel.input.focus();
    return;
  }
  current = newId();
  drawList();
  show();
  panel.input.focus();
}

export function buildAskView(host) {
  panel = chatPanel({
    title: null,
    placeholder: 'Ask what to learn, or how to go about it (Enter sends)',
    newLabel: null,
    fields: () => ({ advisor: true, chatId: current }),
    // A new chat is saved with its first question: it joins the list now.
    onSent: () => { if (!isSaved(current)) refresh(); },
  });
  panel.head.prepend(h('h2.ask-title', null, 'What should I learn next?'));
  const suggestions = h('div.chips.suggestions', null, SUGGESTIONS.map(text => chip(text, false, () => {
    fillInput(panel, text);
    submit(panel);
  })));
  panel.head.after(suggestions);
  const newChat = h('button.action', { type: 'button', title: 'Start a new chat; the others stay in this list' }, '+ New chat');
  newChat.addEventListener('click', startNew);
  list = h('ul.chat-list');
  const side = h('aside.ask-chats', null, h('div.ask-chats-head', null, h('span.ui-caption', null, 'Chats'), newChat), list);
  host.append(h('div.ask-view', null, side, panel.root));
  doneListeners.add(key => { if (isAdvisorKey(key)) refresh(); });
}

export async function openAdvisor() {
  if (!panel) return;
  await refresh();
  if (!current) current = saved[0]?.id || newId();
  drawList();
  show();
}
