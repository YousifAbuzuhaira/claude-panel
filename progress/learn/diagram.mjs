// Diagrams in pages and chat replies: a small Mermaid subset (flowchart / graph, and
// sequenceDiagram), parsed and laid out here once, so each front end only draws boxes, text
// and lines from coordinates, in its own colour scheme. Lines it doesn't know (subgraph,
// classDef, style...) are skipped; when nothing usable is left the caller keeps the block as
// code, so the source still shows. Pure; tested in tests/pure.test.mjs.
//
// The block: { t:'diagram', kind:'flow'|'sequence', w, h, font, line, small, smallLine,
//   nodes: [{ x, y, w, h, shape, lines }]          x, y: top-left
//   edges: [{ pts:[[x,y]...], dash, thick, head, tail, life, label?: { x, y, lines } }]   label x, y: its centre
//   frames: [{ x, y, w, h, label, dividers:[{ y, label }] }], source }
// shape: rect | round | stadium | db | decision | circle | note. head: 0 none, 1 arrow, 2 cross.
// Every size assumes labels in a mono font at `font` px (`small` px on edges); a front end
// scales the whole thing by its own text size over `font`.

const FONT = 13;
const CHAR = FONT * 0.61; // a mono character's advance, a little generous (Cascadia 0.59, Menlo 0.6)
const LINE = 17;
const SMALL = 11.5;
const SMALL_CHAR = SMALL * 0.61;
const SMALL_LINE = 15;
const WRAP = 22; // characters per line in a box
const EDGE_WRAP = 26;
const MAX_NODES = 40;
const PAD_X = 12;
const PAD_Y = 7;
const NODE_GAP = 26;
const DUMMY_GAP = 12;
const RANK_GAP = 40;
const MARGIN = 6;

const round1 = value => Math.round(value * 10) / 10;

// --- Labels -------------------------------------------------------------------------------

/** A Mermaid label as plain text: quotes, <br>, tags, entities and Markdown marks taken out. */
export function cleanLabel(text) {
  let s = String(text ?? '').trim();
  if (/^".*"$/s.test(s)) s = s.slice(1, -1);
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/#quot;/g, '"')
    .replace(/#(\d+);/g, (whole, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\*\*|__|`/g, '')
    .replace(/\\n/g, '\n');
  return s.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 160);
}

/** Words wrapped to `width` characters; a word longer than that is cut. */
export function wrapLabel(text, width = WRAP) {
  const out = [];
  for (const paragraph of String(text || '').split('\n')) {
    let line = '';
    for (let word of paragraph.split(' ').filter(Boolean)) {
      while (word.length > width) {
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.length ? out.slice(0, 6) : [''];
}

const widthOf = (lines, char) => Math.max(...lines.map(line => line.length)) * char;

// --- Reading the source ------------------------------------------------------------------------

/** Statements: lines, and `;` outside brackets and quotes; comments dropped. */
function statements(source) {
  const out = [];
  for (const raw of String(source).replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/%%.*$/, '');
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && '[({'.includes(c)) depth++;
      else if (!quoted && '])}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (!quoted && !depth && c === ';') { out.push(line.slice(start, i)); start = i + 1; }
    }
    out.push(line.slice(start));
  }
  return out.map(line => line.trim()).filter(Boolean);
}

// The longest opener first, so `[(` is a database and not a box around `(`.
const SHAPES = [
  ['[(', ')]', 'db'], ['([', '])', 'stadium'], ['((', '))', 'circle'], ['[[', ']]', 'rect'],
  ['{{', '}}', 'decision'], ['[/', '/]', 'rect'], ['[/', '\\]', 'rect'], ['[\\', '\\]', 'rect'], ['[\\', '/]', 'rect'],
  ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'decision'], ['>', ']', 'rect'],
];
const NODE_ID = /\s*([A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)/y;
const CLASS_SUFFIX = /:::[\w-]+/y;
const AMP = /\s*&\s*/y;
const LABELLED_EDGE = /\s*(<)?(--|==|-\.)(?![-=.>])\s*([^|]+?)\s*(-{2,}>|-{3,}|={2,}>|={3,}|\.+->|\.+-)(?=[\s\w"]|$)/y;
const PLAIN_EDGE = /\s*(<)?(-{2,}|={2,}|-\.+-)(>|x|o)?(?:\s*\|([^|]*)\|)?/y;

function at(regex, text, index) {
  regex.lastIndex = index;
  return regex.exec(text);
}

function readNode(text, index) {
  const id = at(NODE_ID, text, index);
  if (!id) return null;
  let end = NODE_ID.lastIndex;
  let label = null;
  let shape = null;
  for (const [open, close, kind] of SHAPES) {
    if (!text.startsWith(open, end)) continue;
    let from = end + open.length;
    let stop;
    if (text[from] === '"') {
      const quote = text.indexOf('"', from + 1);
      stop = quote < 0 ? -1 : text.indexOf(close, quote + 1);
      if (stop >= 0 && text.slice(quote + 1, stop).trim()) stop = -1; // something between the quote and the closer
    } else {
      stop = text.indexOf(close, from);
    }
    if (stop < 0) continue;
    label = cleanLabel(text.slice(from, stop));
    shape = kind;
    end = stop + close.length;
    break;
  }
  const suffix = at(CLASS_SUFFIX, text, end);
  if (suffix) end = CLASS_SUFFIX.lastIndex;
  return { id: id[1], label, shape, end };
}

function readGroup(text, index) {
  const first = readNode(text, index);
  if (!first) return null;
  const nodes = [first];
  let end = first.end;
  for (;;) {
    if (!at(AMP, text, end)) break;
    const next = readNode(text, AMP.lastIndex);
    if (!next) break;
    nodes.push(next);
    end = next.end;
  }
  return { nodes, end };
}

function readEdge(text, index) {
  let m = at(LABELLED_EDGE, text, index);
  if (m) {
    const op = m[2] + m[4];
    return { tail: m[1] ? 1 : 0, dash: op.includes('.') ? 1 : 0, thick: op.includes('=') ? 1 : 0, head: m[4].endsWith('>') ? 1 : 0, label: cleanLabel(m[3]), end: LABELLED_EDGE.lastIndex };
  }
  m = at(PLAIN_EDGE, text, index);
  if (!m) return null;
  const op = m[2];
  return {
    tail: m[1] ? 1 : 0,
    dash: op.includes('.') ? 1 : 0,
    thick: op.includes('=') ? 1 : 0,
    head: m[3] === 'x' ? 2 : m[3] ? 1 : 0,
    label: m[4] ? cleanLabel(m[4]) : '',
    end: PLAIN_EDGE.lastIndex,
  };
}

const SKIP = /^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b/i;

/** A flowchart's boxes and edges, or null when it holds none. */
export function parseFlow(source) {
  const lines = statements(source);
  const header = /^(flowchart|graph)\b\s*(TD|TB|BT|LR|RL)?/i.exec(lines[0] || '');
  if (!header) return null;
  const dir = (header[2] || 'TD').toUpperCase().replace('TB', 'TD');
  const nodes = new Map();
  const edges = [];
  const register = node => {
    if (!nodes.has(node.id)) nodes.set(node.id, { id: node.id, label: node.id, shape: 'rect' });
    if (node.label !== null) Object.assign(nodes.get(node.id), { label: node.label || node.id, shape: node.shape });
    return node.id;
  };
  const rest = lines.slice(1);
  const firstLine = lines[0].slice(header[0].length).trim();
  if (firstLine) rest.unshift(firstLine);
  for (const line of rest) {
    if (SKIP.test(line)) continue;
    let group = readGroup(line, 0);
    if (!group) continue;
    group.nodes.forEach(register);
    for (;;) {
      const edge = readEdge(line, group.end);
      if (!edge) break;
      const next = readGroup(line, edge.end);
      if (!next) break;
      next.nodes.forEach(register);
      for (const from of group.nodes) for (const to of next.nodes) edges.push({ from: from.id, to: to.id, dash: edge.dash, thick: edge.thick, head: edge.head, tail: edge.tail, label: edge.label });
      group = next;
    }
  }
  if (nodes.size < 2 || nodes.size > MAX_NODES) return null;
  return { dir, nodes, edges };
}

/** A sequence diagram's participants and events, or null when it has no messages. */
export function parseSequence(source) {
  const lines = statements(source);
  if (!/^sequenceDiagram\b/i.test(lines[0] || '')) return null;
  const parts = new Map();
  const ensure = (id, label = null) => {
    const key = id.trim();
    if (!parts.has(key)) parts.set(key, { id: key, label: key });
    if (label) parts.get(key).label = label;
    return key;
  };
  const events = [];
  let numbered = false;
  let count = 0;
  for (const line of lines.slice(1)) {
    let m;
    if (/^autonumber\b/i.test(line)) { numbered = true; continue; }
    if (/^(activate|deactivate|title|accTitle|accDescr|box)\b/i.test(line)) continue;
    if ((m = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line))) { ensure(m[2], m[3] ? cleanLabel(m[3]) : null); continue; }
    if ((m = /^note\s+(left of|right of|over)\s+([^:,]+?)(?:\s*,\s*([^:]+?))?\s*:\s*(.*)$/i.exec(line))) {
      events.push({ t: 'note', where: m[1].toLowerCase(), a: ensure(m[2]), b: m[3] ? ensure(m[3]) : null, text: cleanLabel(m[4]) });
      continue;
    }
    if ((m = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/i.exec(line))) {
      const kind = m[1].toLowerCase();
      events.push({ t: 'open', text: kind === 'rect' ? '' : `${kind}${m[2] ? `: ${cleanLabel(m[2])}` : ''}` });
      continue;
    }
    if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(line))) { events.push({ t: 'split', text: m[2] ? cleanLabel(m[2]) : '' }); continue; }
    if (/^end$/i.test(line)) { events.push({ t: 'close' }); continue; }
    if ((m = /^([\w.]+)\s*(--?)(>>|>|x|\))\s*[+-]?\s*([\w.]+)\s*:\s*(.*)$/.exec(line))) {
      const text = cleanLabel(m[5]);
      events.push({ t: 'msg', a: ensure(m[1]), b: ensure(m[4]), dash: m[2] === '--' ? 1 : 0, head: m[3] === 'x' ? 2 : 1, text: numbered ? `${++count}. ${text}` : text });
    }
  }
  if (!events.some(event => event.t === 'msg') || parts.size > MAX_NODES) return null;
  return { parts, events };
}

// --- Flowchart layout --------------------------------------------------------------------------

function measureNode(node) {
  const lines = wrapLabel(node.label, WRAP);
  const tw = widthOf(lines, CHAR);
  const th = lines.length * LINE;
  let w = Math.max(56, tw + 2 * PAD_X);
  let h = th + 2 * PAD_Y;
  if (node.shape === 'db') h += 12;
  if (node.shape === 'stadium') w += h * 0.4;
  if (node.shape === 'decision') w = tw + 2 * PAD_X + h;
  if (node.shape === 'circle') w = h = Math.max(tw, th) + 2 * PAD_X;
  return { lines, w, h };
}

function layoutFlow({ dir, nodes, edges }) {
  const across = dir === 'LR' || dir === 'RL'; // ranks run left to right
  const real = [...nodes.values()].map((node, index) => {
    const size = measureNode(node);
    return { ...node, ...size, index, real: true, breadth: across ? size.h : size.w, depth: across ? size.w : size.h };
  });
  const byId = new Map(real.map(node => [node.id, node]));
  const links = edges.filter(edge => edge.from !== edge.to).map(edge => ({ ...edge, u: byId.get(edge.from), v: byId.get(edge.to) }));

  // Cycles broken by turning each back edge round for the layout (it is drawn the right way).
  const state = new Map();
  const outOf = new Map(real.map(node => [node, links.filter(link => link.u === node)]));
  const visit = node => {
    state.set(node, 1);
    for (const link of outOf.get(node)) {
      const seen = state.get(link.v) || 0;
      if (seen === 1) link.reversed = true;
      else if (!seen) visit(link.v);
    }
    state.set(node, 2);
  };
  for (const node of real) if (!state.get(node)) visit(node);
  for (const link of links) [link.a, link.b] = link.reversed ? [link.v, link.u] : [link.u, link.v];

  // Ranks: the longest path from a source; a source then moves down to just above its first target.
  const rank = new Map(real.map(node => [node, 0]));
  const waiting = new Map(real.map(node => [node, links.filter(link => link.b === node).length]));
  const queue = real.filter(node => !waiting.get(node));
  while (queue.length) {
    const node = queue.shift();
    for (const link of links.filter(item => item.a === node)) {
      rank.set(link.b, Math.max(rank.get(link.b), rank.get(node) + 1));
      waiting.set(link.b, waiting.get(link.b) - 1);
      if (!waiting.get(link.b)) queue.push(link.b);
    }
  }
  for (const node of real) {
    if (links.some(link => link.b === node)) continue;
    const targets = links.filter(link => link.a === node).map(link => rank.get(link.b));
    if (targets.length) rank.set(node, Math.max(rank.get(node), Math.min(...targets) - 1));
  }

  // Layers, with a stand-in at each rank a long edge passes.
  const depthOfRank = Math.max(...real.map(node => rank.get(node))) + 1;
  const layers = Array.from({ length: depthOfRank }, () => []);
  for (const node of real) { node.rank = rank.get(node); node.up = []; node.down = []; layers[node.rank].push(node); }
  for (const link of links) {
    const chain = [link.a];
    for (let r = link.a.rank + 1; r < link.b.rank; r++) {
      const stand = { real: false, rank: r, breadth: 2, depth: 0, index: link.a.index + 0.5, up: [], down: [] };
      layers[r].push(stand);
      chain.push(stand);
    }
    chain.push(link.b);
    for (let k = 0; k + 1 < chain.length; k++) { chain[k].down.push(chain[k + 1]); chain[k + 1].up.push(chain[k]); }
    link.chain = chain;
  }

  // Order inside each layer: by first appearance, then barycentre sweeps down and up.
  const placeIndex = () => layers.forEach(layer => layer.forEach((item, i) => { item.pos = i; }));
  layers.forEach(layer => layer.sort((p, q) => p.index - q.index));
  placeIndex();
  const mean = items => items.reduce((sum, item) => sum + item.pos, 0) / items.length;
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const layer of order) {
      const key = new Map(layer.map(item => {
        const near = down ? item.up : item.down;
        return [item, near.length ? mean(near) : item.pos];
      }));
      layer.sort((p, q) => key.get(p) - key.get(q) || p.pos - q.pos);
      layer.forEach((item, i) => { item.pos = i; });
    }
  }

  // Positions across each layer: packed, then pulled towards their neighbours a few times.
  const gap = (p, q) => (p.breadth + q.breadth) / 2 + (p.real && q.real ? NODE_GAP : DUMMY_GAP);
  for (const layer of layers) {
    let c = 0;
    layer.forEach((item, i) => { c += i ? gap(layer[i - 1], item) : item.breadth / 2; item.c = c; });
  }
  const settle = (layer, want) => {
    const forward = layer.map(item => want.get(item));
    for (let i = 1; i < layer.length; i++) forward[i] = Math.max(forward[i], forward[i - 1] + gap(layer[i - 1], layer[i]));
    const backward = layer.map(item => want.get(item));
    for (let i = layer.length - 2; i >= 0; i--) backward[i] = Math.min(backward[i], backward[i + 1] - gap(layer[i], layer[i + 1]));
    layer.forEach((item, i) => { item.c = (forward[i] + backward[i]) / 2; });
  };
  const centre = items => items.reduce((sum, item) => sum + item.c, 0) / items.length;
  for (let pass = 0; pass < 10; pass++) {
    const down = pass % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const layer of order) {
      const want = new Map(layer.map(item => {
        const near = down ? item.up : item.down;
        const both = [...item.up, ...item.down];
        return [item, near.length ? centre(near) : both.length ? centre(both) : item.c];
      }));
      settle(layer, want);
    }
  }

  // Positions along the ranks: each rank as deep as its deepest box; a gap wide enough for the labels in it.
  const rankDepth = layers.map(layer => Math.max(0, ...layer.filter(item => item.real).map(item => item.depth)));
  const labelIn = Array.from({ length: depthOfRank }, () => 0);
  for (const link of links) {
    if (!link.label) continue;
    link.labelLines = wrapLabel(link.label, EDGE_WRAP);
    const extent = across ? widthOf(link.labelLines, SMALL_CHAR) + 10 : link.labelLines.length * SMALL_LINE + 8;
    labelIn[link.a.rank] = Math.max(labelIn[link.a.rank], extent);
  }
  const rankStart = [];
  let d = 0;
  for (let r = 0; r < depthOfRank; r++) { rankStart[r] = d; d += rankDepth[r] + RANK_GAP + labelIn[r]; }
  for (const layer of layers) for (const item of layer) item.d = rankStart[item.rank] + rankDepth[item.rank] / 2;

  // Edges leave a box spread along its bottom (or right) side, in the order of where they go.
  const ports = new Map();
  const spread = (node, list, other) => {
    list.sort((p, q) => other(p).c - other(q).c);
    const room = node.shape === 'decision' || node.shape === 'circle' ? 0 : Math.min(16, (node.breadth * 0.7) / Math.max(1, list.length));
    list.forEach((link, i) => ports.set(`${list === node.outs ? 'o' : 'i'}:${links.indexOf(link)}`, (i - (list.length - 1) / 2) * room));
  };
  for (const node of real) {
    node.outs = links.filter(link => link.a === node);
    node.ins = links.filter(link => link.b === node);
    spread(node, node.outs, link => link.chain[1]);
    spread(node, node.ins, link => link.chain[link.chain.length - 2]);
  }
  const point = (c, depth) => (across ? [depth, c] : [c, depth]);
  for (const [k, link] of links.entries()) {
    const pts = [point(link.a.c + ports.get(`o:${k}`), link.a.d + link.a.depth / 2)];
    for (const stand of link.chain.slice(1, -1)) {
      pts.push(point(stand.c, rankStart[stand.rank]));
      if (rankDepth[stand.rank] > 0) pts.push(point(stand.c, rankStart[stand.rank] + rankDepth[stand.rank]));
    }
    pts.push(point(link.b.c + ports.get(`i:${k}`), link.b.d - link.b.depth / 2));
    if (link.labelLines) link.labelAt = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    link.pts = link.reversed ? pts.reverse() : pts;
  }

  const out = {
    nodes: real.map(node => {
      const [cx, cy] = point(node.c, node.d);
      return { x: cx - node.w / 2, y: cy - node.h / 2, w: node.w, h: node.h, shape: node.shape, lines: node.lines };
    }),
    edges: links.map(link => ({
      pts: link.pts,
      dash: link.dash,
      thick: link.thick,
      head: link.head,
      tail: link.tail,
      ...(link.labelLines ? { label: { x: link.labelAt[0], y: link.labelAt[1], lines: link.labelLines } } : {}),
    })),
    frames: [],
  };
  if (dir === 'BT' || dir === 'RL') mirror(out, dir === 'BT' ? 'y' : 'x');
  return out;
}

function mirror(drawing, axis) {
  const box = bounds(drawing);
  const flip = value => (axis === 'x' ? box.x0 + box.x1 - value : box.y0 + box.y1 - value);
  for (const node of drawing.nodes) {
    if (axis === 'x') node.x = flip(node.x + node.w); else node.y = flip(node.y + node.h);
  }
  for (const edge of drawing.edges) {
    edge.pts = edge.pts.map(([x, y]) => (axis === 'x' ? [flip(x), y] : [x, flip(y)]));
    if (edge.label) edge.label[axis] = flip(edge.label[axis]);
  }
}

// --- Sequence layout -------------------------------------------------------------------------------

const MSG_WRAP = 34;

function layoutSequence({ parts, events }) {
  const columns = [...parts.values()].map(part => {
    const lines = wrapLabel(part.label, 18);
    return { ...part, lines, w: Math.max(72, widthOf(lines, CHAR) + 2 * PAD_X), h: lines.length * LINE + 2 * PAD_Y };
  });
  const col = new Map(columns.map((column, i) => [column.id, i]));
  const headH = Math.max(...columns.map(column => column.h));
  for (const event of events) {
    if (event.t === 'msg' || event.t === 'note') {
      event.lines = wrapLabel(event.text, event.t === 'note' ? 28 : MSG_WRAP);
      event.tw = widthOf(event.lines, SMALL_CHAR);
    }
  }
  // Room between neighbouring lifelines for their boxes and the messages between them.
  const gaps = columns.slice(0, -1).map((column, i) => (column.w + columns[i + 1].w) / 2 + 28);
  for (const event of events) {
    if (event.t === 'msg') {
      const i = col.get(event.a);
      const j = col.get(event.b);
      if (i === j) {
        if (i < gaps.length) gaps[i] = Math.max(gaps[i], event.tw + 56);
      } else if (Math.abs(i - j) === 1) {
        gaps[Math.min(i, j)] = Math.max(gaps[Math.min(i, j)], event.tw + 28);
      }
    } else if (event.t === 'note' && event.where !== 'over') {
      const i = col.get(event.a);
      const k = event.where === 'right of' ? i : i - 1;
      if (k >= 0 && k < gaps.length) gaps[k] = Math.max(gaps[k], event.tw + 2 * PAD_X + 30);
    }
  }
  const xs = [columns[0].w / 2];
  for (let i = 0; i < gaps.length; i++) xs.push(xs[i] + gaps[i]);
  // A message across several lifelines widens the last gap it crosses when it needs to.
  for (const event of events) {
    if (event.t !== 'msg') continue;
    const [i, j] = [col.get(event.a), col.get(event.b)].sort((p, q) => p - q);
    const short = event.tw + 28 - (xs[j] - xs[i]);
    if (j - i > 1 && short > 0) for (let k = j; k < xs.length; k++) xs[k] += short;
  }

  const nodes = columns.map((column, i) => ({ x: xs[i] - column.w / 2, y: 0, w: column.w, h: headH, shape: 'rect', lines: column.lines }));
  const edges = [];
  const frames = [];
  const open = [];
  let y = headH + 14;
  // The open frames grow to hold the lifelines an event touches and how far its text reaches.
  const span = (event, left, right) => {
    const cols = [col.get(event.a), col.get(event.b ?? event.a)];
    for (const frame of open) {
      frame.lo = Math.min(frame.lo, ...cols);
      frame.hi = Math.max(frame.hi, ...cols);
      frame.left = Math.min(frame.left, left);
      frame.right = Math.max(frame.right, right);
    }
  };
  for (const event of events) {
    if (event.t === 'msg') {
      const i = col.get(event.a);
      const j = col.get(event.b);
      const labelH = event.lines.length * SMALL_LINE;
      if (i === j) span(event, xs[i], xs[i] + 44 + event.tw);
      else span(event, (xs[i] + xs[j]) / 2 - event.tw / 2, (xs[i] + xs[j]) / 2 + event.tw / 2);
      if (i === j) {
        y += 4;
        const x = xs[i];
        edges.push({ pts: [[x, y], [x + 36, y], [x + 36, y + 20], [x + 2, y + 20]], dash: event.dash, thick: 0, head: event.head, tail: 0, label: { x: x + 44 + event.tw / 2, y: y + 10, lines: event.lines, left: 1 } });
        y += 20 + 16;
      } else {
        y += labelH + 4;
        const dir = j > i ? 1 : -1;
        edges.push({ pts: [[xs[i], y], [xs[j] - dir * 2, y]], dash: event.dash, thick: 0, head: event.head, tail: 0, label: { x: (xs[i] + xs[j]) / 2, y: y - labelH / 2 - 3, lines: event.lines } });
        y += 16;
      }
    } else if (event.t === 'note') {
      const i = col.get(event.a);
      const j = event.b ? col.get(event.b) : i;
      const w = Math.max(event.tw + 2 * PAD_X, event.where === 'over' ? Math.abs(xs[j] - xs[i]) + 40 : 0);
      const h = event.lines.length * SMALL_LINE + 2 * PAD_Y - 2;
      const x = event.where === 'over' ? (xs[i] + xs[j]) / 2 - w / 2 : event.where === 'right of' ? xs[i] + 10 : xs[i] - 10 - w;
      span(event, x, x + w);
      nodes.push({ x, y, w, h, shape: 'note', lines: event.lines, small: 1 });
      y += h + 12;
    } else if (event.t === 'open') {
      const frame = { y, label: event.text, dividers: [], lo: Infinity, hi: -Infinity, left: Infinity, right: -Infinity, depth: open.length };
      open.push(frame);
      frames.push(frame);
      y += SMALL_LINE + 12;
    } else if (event.t === 'split' && open.length) {
      open.at(-1).dividers.push({ y: y - 4, label: event.text });
      y += SMALL_LINE + 8;
    } else if (event.t === 'close' && open.length) {
      open.pop().bottom = y - 4;
      y += 10;
    }
  }
  for (const frame of open) frame.bottom = y;
  const lifeEnd = y + 4;
  columns.forEach((column, i) => edges.unshift({ pts: [[xs[i], headH], [xs[i], lifeEnd]], dash: 1, thick: 0, head: 0, tail: 0, life: 1 }));
  const outFrames = frames.map(frame => {
    const lo = Number.isFinite(frame.lo) ? frame.lo : 0;
    const hi = Number.isFinite(frame.hi) ? frame.hi : columns.length - 1;
    const inset = frame.depth * 6;
    const x0 = Math.min(xs[lo] - columns[lo].w / 2, xs[lo] - 40, frame.left - 6) - 10 + inset;
    const labelW = Math.max(widthOf([frame.label || ''], SMALL_CHAR), ...frame.dividers.map(item => widthOf([item.label || ''], SMALL_CHAR))) + 20;
    const x1 = Math.max(xs[hi] + columns[hi].w / 2, xs[hi] + 40, frame.right + 6, x0 + labelW) + 10 - inset;
    return { x: x0, y: frame.y, w: x1 - x0, h: frame.bottom - frame.y, label: frame.label, dividers: frame.dividers };
  });
  return { nodes, edges, frames: outFrames };
}

// --- The block ------------------------------------------------------------------------------------

function bounds({ nodes, edges, frames }) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x0, y0, x1, y1) => { box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0); box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1); };
  for (const node of nodes) add(node.x, node.y, node.x + node.w, node.y + node.h);
  for (const frame of frames) add(frame.x, frame.y, frame.x + frame.w, frame.y + frame.h);
  for (const edge of edges) {
    for (const [x, y] of edge.pts) add(x, y, x, y);
    if (edge.label) {
      const w = widthOf(edge.label.lines, SMALL_CHAR) + 8;
      const h = edge.label.lines.length * SMALL_LINE + 4;
      add(edge.label.x - w / 2, edge.label.y - h / 2, edge.label.x + w / 2, edge.label.y + h / 2);
    }
  }
  return box;
}

function finish(kind, drawing, source) {
  const box = bounds(drawing);
  const dx = MARGIN - box.x0;
  const dy = MARGIN - box.y0;
  const at2 = ([x, y]) => [round1(x + dx), round1(y + dy)];
  return {
    t: 'diagram',
    kind,
    w: round1(box.x1 - box.x0 + 2 * MARGIN),
    h: round1(box.y1 - box.y0 + 2 * MARGIN),
    font: FONT,
    line: LINE,
    small: SMALL,
    smallLine: SMALL_LINE,
    nodes: drawing.nodes.map(node => ({ ...node, x: round1(node.x + dx), y: round1(node.y + dy), w: round1(node.w), h: round1(node.h) })),
    edges: drawing.edges.map(edge => ({ ...edge, pts: edge.pts.map(at2), ...(edge.label ? { label: { ...edge.label, x: round1(edge.label.x + dx), y: round1(edge.label.y + dy) } } : {}) })),
    frames: drawing.frames.map(frame => ({ ...frame, x: round1(frame.x + dx), y: round1(frame.y + dy), w: round1(frame.w), h: round1(frame.h), dividers: frame.dividers.map(item => ({ ...item, y: round1(item.y + dy) })) })),
    source: String(source).slice(0, 4000),
  };
}

/** A ```mermaid block's text as a laid-out diagram block, or null when it can't be read. */
export function diagramBlock(source) {
  try {
    const flow = parseFlow(source);
    if (flow) return finish('flow', layoutFlow(flow), source);
    const sequence = parseSequence(source);
    if (sequence) return finish('sequence', layoutSequence(sequence), source);
  } catch {
    // A diagram that breaks the layout shows as its source instead.
  }
  return null;
}
