// A page's (or a chat reply's) blocks as DOM. Shapes: the top of learn/markdown.mjs.
//   { t: 'h', level, inlines } | { t: 'p', inlines } | { t: 'code', lang, text }
//   | { t: 'ul' | 'ol', start, items: [{ depth, ordered, inlines }] } | { t: 'quote', inlines }
//   | { t: 'hr' } | { t: 'table', rows: [[inlines]] }   (the first row is the header)
//   | { t: 'diagram', ... }   (laid out by learn/diagram.mjs, drawn by ./diagram.js)
//   | { t: 'callout', kind, title, blocks } | { t: 'check', ... }   (drawn by ./checks.js)
// Inlines: { s, b?, i?, code?, link?, time?, added?, sec?, term? }. Unknown block types are skipped.
import { GLYPH, h, isHttp, toast } from './core.js';
import { renderDiagram } from './diagram.js';

const ADDED_TIP = 'Claude added this: it is not in the sources';
const SECTION_MARK = '\u00a7';
const CALLOUTS = { example: 'Example', key: 'Key idea', warning: 'Watch out', analogy: 'Analogy', disputed: 'Disputed' };

// What the page being drawn adds: its `glossary`, and `check` to draw a quick check.
let active = null;

// One small box that follows the word under the pointer, drawn outside every scrolling column.
let tip = null;
function showTip(word, entry) {
  if (!tip) {
    tip = h('div.term-tip', { role: 'tooltip' });
    document.body.append(tip);
  }
  tip.replaceChildren(h('strong', null, entry.term), h('div', null, entry.def));
  tip.hidden = false;
  const box = word.getBoundingClientRect();
  const left = Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8));
  const below = box.bottom + 6 + tip.offsetHeight < window.innerHeight;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? box.bottom + 6 : box.top - tip.offsetHeight - 6}px`;
}
const hideTip = () => { if (tip) tip.hidden = true; };

function termWord(node, entry) {
  const word = h('span.term', { tabindex: '0', 'aria-label': `${entry.term}: ${entry.def}` }, node);
  word.addEventListener('mouseenter', () => showTip(word, entry));
  word.addEventListener('focus', () => showTip(word, entry));
  word.addEventListener('mouseleave', hideTip);
  word.addEventListener('blur', hideTip);
  return word;
}

export function renderInlines(inlines) {
  const out = [];
  for (const item of inlines || []) {
    if (!item || typeof item.s !== 'string') continue;
    let node;
    if (item.added) {
      node = h('sup.added', { title: ADDED_TIP }, '+');
    } else if (item.sec) {
      node = document.createTextNode(SECTION_MARK);
    } else if (item.code) {
      node = h('code', null, item.s);
    } else {
      node = document.createTextNode(item.time ? `${GLYPH.play} ${item.s}` : item.s);
    }
    if (item.b) node = h('strong', null, node);
    if (item.i) node = h('em', null, node);
    if (item.sec && !item.link) node = h('sup.sec', { title: `From the source: ${item.s}` }, node);
    if (item.link && isHttp(item.link)) {
      const title = item.time ? 'Watch from this moment' : item.sec ? `From the source: ${item.s}` : item.link;
      node = h(`a${item.time ? '.time' : ''}${item.sec ? '.sec' : ''}`, { href: item.link, target: '_blank', rel: 'noopener noreferrer', title }, item.sec ? h('sup', null, node) : node);
    }
    const entry = item.term !== undefined ? active?.glossary?.[item.term] : null;
    out.push(entry ? termWord(node, entry) : node);
  }
  return out;
}

function renderList(block) {
  const ordered = block.t === 'ol';
  const root = h(ordered ? 'ol' : 'ul');
  if (ordered && block.start && block.start !== 1) root.start = block.start;
  // A stack of open lists by depth; an item deeper than the last opens a list inside it.
  const stack = [{ list: root, depth: 0 }];
  for (const item of block.items || []) {
    const depth = Math.max(0, Math.min(3, Number(item.depth) || 0));
    while (stack.length > 1 && stack.at(-1).depth > depth) stack.pop();
    let top = stack.at(-1);
    if (depth > top.depth) {
      const parentItem = top.list.lastElementChild || top.list.appendChild(h('li.bare'));
      const nested = h(item.ordered ? 'ol' : 'ul');
      parentItem.append(nested);
      stack.push({ list: nested, depth });
      top = stack.at(-1);
    }
    top.list.append(h('li', null, renderInlines(item.inlines)));
  }
  return root;
}

function renderCode(block) {
  const copy = h('button.copy', {
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(block.text || '');
        copy.textContent = 'copied';
      } catch {
        toast('Could not copy', 'error');
      }
      setTimeout(() => { copy.textContent = 'copy'; }, 1500);
    },
  }, 'copy');
  return h('div.code', null,
    h('div.code-head', null, h('span.lang', null, block.lang || ''), copy),
    h('pre', null, h('code', null, block.text || '')));
}

function renderTable(block) {
  const rows = block.rows || [];
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return h('div.table-wrap', null, h('table', null,
    h('thead', null, h('tr', null, head.map(cell => h('th', null, renderInlines(cell))))),
    h('tbody', null, body.map(row => h('tr', null, row.map(cell => h('td', null, renderInlines(cell))))))));
}

function renderCallout(block) {
  const kind = CALLOUTS[block.kind] ? block.kind : 'key';
  return h(`aside.callout.${kind}`, null,
    h('div.callout-head', null, h('span.callout-kind', null, CALLOUTS[kind]), (block.title || []).length ? h('span.callout-title', null, renderInlines(block.title)) : null),
    h('div.callout-body', null, renderBlocks(block.blocks)));
}

/** `context`: what a page adds to its blocks (see `active`). Blocks inside a callout inherit it. */
export function renderBlocks(blocks, context = null) {
  const outer = active;
  if (context) active = context;
  try {
    return blockNodes(blocks);
  } finally {
    active = outer;
  }
}

function blockNodes(blocks) {
  const out = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    switch (block.t) {
      case 'h': {
        const level = Math.max(2, Math.min(5, (Number(block.level) || 1) + 1));
        out.push(h(`h${level}`, null, renderInlines(block.inlines)));
        break;
      }
      case 'p': out.push(h('p', null, renderInlines(block.inlines))); break;
      case 'code': out.push(renderCode(block)); break;
      case 'ul':
      case 'ol': out.push(renderList(block)); break;
      case 'quote': out.push(h('blockquote', null, renderInlines(block.inlines))); break;
      case 'hr': out.push(h('hr')); break;
      case 'diagram': out.push(renderDiagram(block)); break;
      case 'callout': out.push(renderCallout(block)); break;
      case 'check': if (active?.check) out.push(active.check(block)); break;
      case 'table': {
        const table = renderTable(block);
        if (table) out.push(table);
        break;
      }
      default: break; // unknown: skipped
    }
  }
  return out;
}
