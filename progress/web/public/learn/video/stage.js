// The picture: objects made, moved and removed to match a state from model.mjs. It only ever
// sets text through textContent, so nothing in a script can become markup.
import { containers, dedent, labelPoint, labelSpot, roughRect, wireEnds } from './model.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = k => 1 - Math.pow(1 - k, 3);
const TONE = { ink: 'var(--ink)', dim: 'var(--dim)', accent: 'var(--accent)', green: 'var(--green)', red: 'var(--red)', gold: 'var(--gold)', blue: 'var(--blue)' };
let objectsLayer;
let wires;
let assets;

export function initStage(parts) {
  ({ objects: objectsLayer, wires, assets } = parts);
}

const live = new Map();
const KEYS = ['x', 'y', 'w', 'h', 'a', 's', 'v', 'p'];
const SVG = 'http://www.w3.org/2000/svg';
function svg(name, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs || {})) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}
function div(cls, text) { const node = document.createElement('div'); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
const targetOf = o => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0, a: o.fade ? 0.38 : 1, s: o.scale ?? 1, v: Number(o.value) || 0, p: 1 });

function makeElement(o) {
  if (o.shape === 'arrow') {
    const group = svg('g', { class: `wire${o.flow ? ' flow' : ''}` });
    group.append(svg('path'), svg('polygon'));
    if (o.text) { const label = svg('text'); label.textContent = o.text; group.append(label); }
    wires.append(group);
    return group;
  }
  const el = div(`ob ${o.shape === 'number' ? 'num' : o.shape}`);
  if (o.shape === 'box') el.append(document.createElement('b'), document.createElement('span'));
  if (o.shape === 'number') el.append(document.createElement('b'), document.createElement('span'));
  objectsLayer.append(el);
  return el;
}

function makeItem(o, instant) {
  const el = makeElement(o);
  const to = targetOf(o);
  const item = { id: o.id, shape: o.shape, el, o: {}, cur: { ...to }, from: { ...to }, to, t0: performance.now(), dur: 520, retiring: false };
  if (!instant) {
    const start = { ...to, a: 0, y: to.y + 12 };
    if (o.shape === 'bar') { const tall = to.h > to.w; start.w = tall ? to.w : 0; start.h = tall ? 0 : to.h; start.y = tall ? to.y + to.h : to.y; }
    if (o.shape === 'arrow') { start.p = 0; start.y = to.y; }
    const parent = o.spawnAt && live.get(o.spawnAt);
    if (parent) { const r = rectOf(parent); start.x = r.x + r.w / 2 - (to.w || 0) / 2; start.y = r.y + r.h / 2 - (to.h || 0) / 2; start.a = 0.2; item.dur = 720; }
    item.cur = { ...start };
    item.from = { ...start };
  }
  live.set(o.id, item);
  return item;
}

function changed(a, b) { return JSON.stringify(a) !== JSON.stringify(b); }

function refresh(item, o, instant) {
  const was = item.o;
  const { el } = item;
  if (was.tone !== o.tone) { const color = TONE[o.tone]; if (item.shape === 'arrow') el.style.setProperty('--tone', color || 'var(--dim)'); else el.style.setProperty('--tone', color || 'var(--ink)'); }
  if (item.shape === 'box') {
    const text = String(o.text ?? '');
    if (was.text !== o.text || was.w !== o.w || was.h !== o.h) {
      el.children[0].textContent = text;
      el.children[0].style.fontSize = `${clamp(Math.min(o.h * (o.sub ? 0.34 : 0.42), (o.w - 30) / Math.max(1, text.length * 0.62)), 14, 46)}px`;
    }
    if (was.sub !== o.sub) el.children[1].textContent = o.sub || '';
    el.children[1].hidden = !o.sub;
    el.classList.toggle('fill', o.style === 'fill');
    el.classList.toggle('outline', o.style === 'outline');
    el.classList.toggle('tinted', !!o.tone && o.tone !== 'ink');
  }
  if (item.shape === 'label') {
    if (was.text !== o.text) el.textContent = String(o.text ?? '');
    el.className = `ob label ${o.size || 'm'}${o.mono ? ' mono' : ''}${o.align === 'center' ? ' center' : ''}`;
  }
  if (item.shape === 'number') {
    el.className = `ob num ${o.size || 'l'}`;
    el.style.textAlign = o.align === 'center' ? 'center' : '';
    if (was.sub !== o.sub) el.children[1].textContent = o.sub || '';
  }
  if (item.shape === 'row' && (changed(was.items, o.items) || changed(was.mark, o.mark))) drawRow(item, o, !instant);
  if (item.shape === 'code') drawCode(item, o);
  if (item.shape === 'table') drawTable(item, o);
  if (item.shape === 'diagram') drawDiagram(item, o);
  item.o = o;
}

function retarget(item, o, instant) {
  const to = targetOf(o);
  if (o.shape === 'arrow') { to.x = 0; to.y = 0; to.w = 0; to.h = 0; }
  if (instant) { item.cur = { ...to }; item.from = { ...to }; item.to = to; item.t0 = 0; return; }
  if (KEYS.every(key => item.to[key] === to[key]) && !item.retiring) return;
  item.from = { ...item.cur };
  item.to = to;
  item.t0 = performance.now();
  item.dur = to.v !== item.from.v ? 900 : item.dur === 720 ? 720 : 520;
}

function retire(item, instant) {
  if (instant) { remove(item); return; }
  if (item.retiring) return;
  item.retiring = true;
  item.from = { ...item.cur };
  item.to = { ...item.cur, a: 0 };
  item.t0 = performance.now();
  item.dur = 260;
}
function remove(item) { item.el.remove(); live.delete(item.id); }

function rectOf(item) {
  const { cur, el } = item;
  if (item.shape === 'arrow') return { x: 0, y: 0, w: 0, h: 0 };
  return { x: cur.x, y: cur.y, w: cur.w || el.offsetWidth, h: cur.h || el.offsetHeight };
}

const liveRect = id => { const item = live.get(id); return item ? rectOf(item) : null; };

function drawWire(item) {
  const o = item.o;
  const ends = wireEnds(o, liveRect);
  if (!ends) { item.el.style.opacity = 0; return; }
  const [x1, y1, x2, y2] = ends;
  const p = item.cur.p;
  const ex = x1 + (x2 - x1) * p, ey = y1 + (y2 - y1) * p;
  const len = Math.hypot(ex - x1, ey - y1) || 1, ux = (ex - x1) / len, uy = (ey - y1) / len;
  const bx = ex - ux * 10, by = ey - uy * 10;
  const [path, head, text] = item.el.children;
  path.setAttribute('d', `M${x1},${y1} L${bx},${by}`);
  head.setAttribute('points', `${ex},${ey} ${bx - uy * 6},${by + ux * 6} ${bx + uy * 6},${by - ux * 6}`);
  // The text sits where applyState found it clear of everything, along the line as it is now.
  if (text) { const [lx, ly] = labelPoint(ends, o.text, item.spot || { t: 0.5, side: 'above' }); text.setAttribute('x', lx); text.setAttribute('y', ly); }
  item.el.style.opacity = item.cur.a;
}

function paint(item) {
  const { el, cur, shape } = item;
  if (shape === 'arrow') { drawWire(item); return; }
  el.style.transform = `translate(${cur.x}px, ${cur.y}px)${cur.s !== 1 ? ` scale(${cur.s})` : ''}`;
  el.style.opacity = cur.a;
  if (cur.w) el.style.width = `${cur.w}px`;
  if (shape !== 'row' && shape !== 'table' && shape !== 'label' && shape !== 'number' && cur.h) el.style.height = `${cur.h}px`;
  if (shape === 'dot') el.style.height = `${cur.w}px`;
  if (shape === 'number') {
    const whole = Number.isInteger(item.to.v);
    const value = whole ? Math.round(cur.v).toLocaleString('en-US') : cur.v.toFixed(1);
    el.children[0].textContent = `${value}${item.o.suffix || ''}`;
  }
}

// --- Widgets ---------------------------------------------------------------------------
const cellKey = cell => `${cell.label}|${cell.sub || ''}`;
function cellNode(cell) {
  const node = div('cell');
  const label = document.createElement('b'); label.textContent = cell.label;
  const sub = document.createElement('span'); sub.textContent = cell.sub || '';
  node.append(label, sub);
  node.dataset.key = cellKey(cell);
  return node;
}
function shared(a, b) {
  const size = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) size[i][j] = a[i] === b[j] ? size[i + 1][j + 1] + 1 : Math.max(size[i + 1][j], size[i][j + 1]);
  const kept = new Map();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { kept.set(j, i); i += 1; j += 1; } else if (size[i + 1][j] >= size[i][j + 1]) i += 1; else j += 1;
  }
  return kept;
}
function drawRow(item, o, slide) {
  const box = item.el;
  const row = o.items || [];
  const n = Math.max(1, row.length);
  const old = [...box.children].filter(node => !node.classList.contains('ghost'));
  const first = new Map(old.map(node => [node, [node.offsetLeft, node.offsetTop]]));
  const kept = shared(old.map(node => node.dataset.key), row.map(cellKey));
  const stays = new Set([...kept.values()].map(i => old[i]));
  const nodes = row.map((cell, k) => (kept.has(k) ? old[kept.get(k)] : cellNode(cell)));
  box.style.setProperty('--cell', `${Math.max(44, Math.min(112, Math.floor(((o.w || 1000) - 10 * (n - 1)) / n)))}px`);
  box.replaceChildren(...nodes);
  const mark = new Set(o.mark || []);
  nodes.forEach((node, k) => { node.classList.toggle('mark', mark.has(k)); node.classList.toggle('fresh', slide && old.length > 0 && !stays.has(node)); });
  if (!slide) return;
  for (const node of old) {
    if (stays.has(node)) continue;
    const [left, top] = first.get(node);
    node.classList.remove('mark');
    node.classList.add('ghost');
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    box.append(node);
    setTimeout(() => node.remove(), 340);
  }
  for (const node of nodes) {
    const was = first.get(node);
    if (!was) continue;
    const dx = was[0] - node.offsetLeft, dy = was[1] - node.offsetTop;
    if (dx || dy) node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
}
function drawCode(item, o) {
  const code = assets.code[o.asset] || { text: '' };
  let pre = item.el.firstElementChild;
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'code';
    // Without the indentation its lines share in the file: the code starts at the left edge.
    const lines = dedent(code.text).split('\n');
    const widest = Math.max(...lines.map(line => line.length));
    pre.style.fontSize = `${clamp(Math.min(((o.w || 600) - 36) / (widest * 0.61), ((o.h || 380) - 30) / (lines.length * 1.45)), 11, 21)}px`;
    lines.forEach(line => { const span = document.createElement('span'); span.textContent = line || ' '; pre.append(span); });
    item.el.append(pre);
  }
  const [from, to] = o.lines || [];
  pre.classList.toggle('lit', from !== undefined);
  [...pre.children].forEach((line, k) => {
    line.classList.toggle('lit', from !== undefined && k >= from && k <= (to ?? from));
    // A masked line: hidden until the learner picks it (the player then draws the state without it).
    line.classList.toggle('masked', o.mask === k);
  });
}
function drawTable(item, o) {
  const rows = assets.table[o.asset] || [[]];
  let table = item.el.querySelector('table');
  if (!table) {
    table = document.createElement('table');
    const head = table.createTHead().insertRow();
    rows[0].forEach(cell => { const th = document.createElement('th'); th.textContent = cell; head.append(th); });
    const body = table.createTBody();
    rows.slice(1).forEach(row => { const tr = body.insertRow(); row.forEach(cell => { tr.insertCell().textContent = cell; }); });
    item.el.append(table);
  }
  const shown = new Set(o.rows || []), now = new Set(o.now || []);
  [...table.tBodies[0].rows].forEach((tr, k) => { tr.classList.toggle('on', shown.has(k)); tr.classList.toggle('now', now.has(k)); });
}
function textLines(lines, cx, cy, line, cls) {
  const text = svg('text', { class: cls, 'text-anchor': 'middle' });
  const top = cy - (lines.length * line) / 2;
  lines.forEach((value, k) => text.append(svg('tspan', { x: cx, y: top + line * (k + 0.5), 'dominant-baseline': 'central' }, document.createTextNode(String(value)))));
  return text;
}
function nodeShape(node) {
  const { x, y, w, h } = node;
  if (node.shape === 'decision') { const k = h / 2; return svg('polygon', { points: `${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}`, class: 'd-node d-decision' }); }
  if (node.shape === 'circle') return svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, class: 'd-node' });
  const rx = node.shape === 'stadium' ? h / 2 : node.shape === 'round' ? 10 : 4;
  return svg('rect', { x, y, width: w, height: h, rx, class: 'd-node' });
}
function nodeAt(nodes, [x, y]) {
  let best = 0, bestGap = Infinity;
  nodes.forEach((node, k) => {
    const gap = Math.hypot(Math.max(node.x - x, 0, x - node.x - node.w), Math.max(node.y - y, 0, y - node.y - node.h));
    if (gap < bestGap) { bestGap = gap; best = k; }
  });
  return best;
}
function drawDiagram(item, o) {
  const block = assets.diagram[o.asset];
  if (!block) return;
  let box = item.el.firstElementChild;
  if (!box) {
    box = div('diagram-box');
    const root = svg('svg', { viewBox: `0 0 ${block.w} ${block.h}`, class: 'diagram-svg', width: block.w, height: block.h });
    root.style.setProperty('--d-font', `${block.font}px`);
    root.style.setProperty('--d-small', `${block.small}px`);
    for (const edge of block.edges) {
      const pts = edge.pts;
      const [x1, y1] = pts.at(-1), [x0, y0] = pts.at(-2);
      const size = 8, len = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      const bx = x1 - ux * size, by = y1 - uy * size;
      const group = svg('g', { class: 'reveal', 'data-from': nodeAt(block.nodes, pts[0]), 'data-to': nodeAt(block.nodes, pts.at(-1)) });
      group.append(svg('polyline', { points: [...pts.slice(0, -1), [bx, by]].map(p => p.join(',')).join(' '), class: `d-edge${edge.dash ? ' dash' : ''}` }));
      group.append(svg('polygon', { points: `${x1},${y1} ${bx - uy * size / 2},${by + ux * size / 2} ${bx + uy * size / 2},${by - ux * size / 2}`, class: 'd-head' }));
      if (edge.label) {
        const lw = Math.max(...edge.label.lines.map(line => line.length)) * block.small * 0.61 + 8;
        group.append(svg('rect', { x: edge.label.x - lw / 2, y: edge.label.y - 9, width: lw, height: 18, rx: 3, class: 'd-patch' }), textLines(edge.label.lines, edge.label.x, edge.label.y, block.smallLine, 'd-small'));
      }
      root.append(group);
    }
    block.nodes.forEach((node, k) => {
      root.append(svg('g', { class: 'reveal node', 'data-node': k }, nodeShape(node), textLines(node.lines, node.x + node.w / 2, node.y + node.h / 2, node.small ? block.smallLine : block.line, node.small ? 'd-small d-ink' : 'd-text')));
    });
    box.append(root);
    item.el.append(box);
  }
  const was = new Set(item.o.nodes || []);
  const shown = new Set(o.nodes || []);
  const added = [...shown].filter(k => !was.has(k));
  const now = new Set(added.length ? added : []);
  box.querySelectorAll('.node').forEach(group => { const k = Number(group.dataset.node); group.classList.toggle('on', shown.has(k)); group.classList.toggle('now', now.has(k)); });
  box.querySelectorAll('[data-from]').forEach(group => group.classList.toggle('on', shown.has(Number(group.dataset.from)) && shown.has(Number(group.dataset.to))));
  // A big diagram follows what is new, and shows whole when nothing is.
  const W = o.w || 1000, H = o.h || 400;
  const whole = Math.min(W / block.w, H / block.h);
  const focus = [...now].map(k => block.nodes[k]).filter(Boolean);
  let k = Math.min(whole, 2), cx = block.w / 2, cy = block.h / 2;
  if (whole < 1.5 && focus.length) {
    const left = Math.min(...focus.map(n => n.x)), right = Math.max(...focus.map(n => n.x + n.w));
    const top = Math.min(...focus.map(n => n.y)), bottom = Math.max(...focus.map(n => n.y + n.h));
    k = Math.max(whole, Math.min(1.8, (W * 0.8) / (right - left), (H * 0.62) / (bottom - top)));
    cx = (left + right) / 2; cy = (top + bottom) / 2;
  }
  const place = (centre, size, room) => (size * k <= room ? (room - size * k) / 2 : Math.min(0, Math.max(room - size * k, room / 2 - centre * k)));
  box.firstElementChild.style.transform = `translate(${place(cx, block.w, W)}px, ${place(cy, block.h, H)}px) scale(${k})`;
}

export function applyState(state, instant) {
  for (const [id, o] of state) {
    if (!o.visible) continue;
    let item = live.get(id);
    if (item && item.shape !== o.shape) { remove(item); item = null; }
    if (!item) item = makeItem(o, instant);
    item.retiring = false;
    refresh(item, o, instant);
    retarget(item, o, instant);
  }
  for (const item of [...live.values()]) {
    const o = state.get(item.id);
    if (!o || !o.visible) retire(item, instant);
  }
  placeLabels(state);
  // A container shows its name on its top edge, where what's inside can't cover it.
  const held = containers(state, assets);
  for (const item of live.values()) if (item.shape === 'box') item.el.classList.toggle('holds', held.has(item.id));
}

/** Each arrow's text, at the first spot along its line that covers nothing, picked from where things are going. */
function placeLabels(state) {
  const rectOf = id => { const o = state.get(id); return o?.visible ? roughRect(o, assets) : null; };
  const rects = [...state.values()].filter(o => o.visible && o.shape !== 'arrow').map(o => roughRect(o, assets));
  for (const o of state.values()) {
    const item = o.visible && o.shape === 'arrow' && o.text ? live.get(o.id) : null;
    const ends = item && wireEnds(o, rectOf);
    if (ends) item.spot = labelSpot(ends, o.text, rects);
  }
}

/** One frame of every object's move towards its target. */
export function stepObjects(now) {
  for (const item of [...live.values()]) {
    const k = item.t0 ? clamp((now - item.t0) / item.dur, 0, 1) : 1;
    const e = ease(k);
    for (const key of KEYS) item.cur[key] = item.from[key] + (item.to[key] - item.from[key]) * e;
    if (item.retiring && k >= 1) {
      remove(item);
      continue;
    }
    paint(item);
  }
}
