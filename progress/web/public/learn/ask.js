// Ask: the Advisor chat, with suggestions.
import { chatPanel, fillInput, openChat, submit } from './chat.js';
import { chip, h } from './core.js';

const SUGGESTIONS = [
  'What should I learn next?',
  'What am I missing for the stack I work in?',
  'Plan my next month of learning',
  'What would make me a stronger senior engineer?',
];

let panel = null;

export function buildAskView(host) {
  panel = chatPanel({
    title: null,
    placeholder: 'Ask what to learn, or how to go about it (Enter sends)',
    newLabel: 'new conversation',
    fields: () => ({ advisor: true }),
  });
  panel.head.prepend(h('h2.ask-title', null, 'What should I learn next?'));
  const suggestions = h('div.chips.suggestions', null, SUGGESTIONS.map(text => chip(text, false, () => {
    fillInput(panel, text);
    submit(panel);
  })));
  panel.head.after(suggestions);
  host.append(h('div.ask-view', null, panel.root));
}

export function openAdvisor() {
  if (panel) openChat(panel, 'advisor', { advisor: true });
}
