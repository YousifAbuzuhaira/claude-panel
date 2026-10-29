// A page's (or a chat reply's) blocks as DOM. Shapes: the top of learn/markdown.mjs.
//   { t: 'h', level, inlines } | { t: 'p', inlines } | { t: 'code', lang, text }
//   | { t: 'ul' | 'ol', start, items: [{ depth, ordered, inlines }] } | { t: 'quote', inlines }
//   | { t: 'hr' } | { t: 'table', rows: [[inlines]] }   (the first row is the header)
// Inlines: { s, b?, i?, code?, link?, time?, added?, sec? }. Unknown block types are skipped.
import { GLYPH, h, isHttp, toast } from './core.js';

const ADDED_TIP = 'Claude added this: it is not in the sources';

export function renderInlines(inlines) {
  const out = [];
  for (const item of inlines || []) {
    if (!item || typeof item.s !== 'string') continue;
    let node;
    if (item.added) {
      node = h('span.added', { title: ADDED_TIP }, item.s);
    } else if (item.code) {
      node = h('code', null, item.s);
    } else {
      node = document.createTextNode(item.time ? `${GLYPH.play} ${item.s}` : item.s);
    }
    if (item.b) node = h('strong', null, node);
    if (item.i) node = h('em', null, node);
    if (item.sec && !item.link) node = h('span.sec', { title: 'A part of the source page' }, node);
    if (item.link && isHttp(item.link)) {
      node = h(`a${item.time ? '.time' : ''}${item.sec ? '.sec' : ''}`, { href: item.link, target: '_blank', rel: 'noopener noreferrer', title: item.time ? 'Watch from this moment' : item.link }, node);
    }
    out.push(node);
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

export function renderBlocks(blocks) {
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
