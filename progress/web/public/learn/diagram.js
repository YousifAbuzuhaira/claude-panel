// A diagram block (learn/diagram.mjs lays it out) drawn as SVG: boxes, text and lines at the
// helper's coordinates, coloured by the scheme's CSS variables so a scheme change repaints it.
const SVG = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs || {})) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Lines of text centred on (cx, cy), `line` apart. */
function label(lines, cx, cy, line, cls, anchor = 'middle') {
  const text = el('text', { class: cls, 'text-anchor': anchor });
  const top = cy - (lines.length * line) / 2;
  lines.forEach((value, k) => text.append(el('tspan', { x: cx, y: top + line * (k + 0.5), 'dominant-baseline': 'central' }, document.createTextNode(String(value)))));
  return text;
}

function shape(node) {
  const x = num(node.x);
  const y = num(node.y);
  const w = num(node.w);
  const h = num(node.h);
  switch (node.shape) {
    case 'round': return el('rect', { x, y, width: w, height: h, rx: 10, class: 'd-node' });
    case 'stadium': return el('rect', { x, y, width: w, height: h, rx: h / 2, class: 'd-node' });
    case 'circle': return el('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, class: 'd-node' });
    case 'decision': {
      const k = h / 2;
      return el('polygon', { points: `${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}`, class: 'd-node d-decision' });
    }
    case 'db': {
      const r = 6;
      return el('g', null,
        el('path', { d: `M${x},${y + r} a${w / 2},${r} 0 0 1 ${w},0 v${h - 2 * r} a${w / 2},${r} 0 0 1 ${-w},0 Z`, class: 'd-node' }),
        el('path', { d: `M${x},${y + r} a${w / 2},${r} 0 0 0 ${w},0`, class: 'd-rim' }));
    }
    case 'note': return el('rect', { x, y, width: w, height: h, rx: 3, class: 'd-note' });
    default: return el('rect', { x, y, width: w, height: h, rx: 4, class: 'd-node' });
  }
}

/** The arrowhead at the end of `pts`, and the line's end pulled back to its base. */
function head(pts, kind, size) {
  const [x1, y1] = pts.at(-1);
  const [x0, y0] = pts.at(-2);
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / length;
  const uy = (y1 - y0) / length;
  if (kind === 2) {
    const s = size * 0.55;
    return { shape: el('path', { d: `M${x1 - s},${y1 - s} L${x1 + s},${y1 + s} M${x1 - s},${y1 + s} L${x1 + s},${y1 - s}`, class: 'd-cross' }), end: [x1, y1] };
  }
  const bx = x1 - ux * size;
  const by = y1 - uy * size;
  const half = size * 0.5;
  return {
    shape: el('polygon', { points: `${x1},${y1} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`, class: 'd-head' }),
    end: [bx + ux * 1, by + uy * 1],
  };
}

export function renderDiagram(block) {
  const w = num(block.w);
  const h = num(block.h);
  const font = num(block.font) || 13;
  const line = num(block.line) || 17;
  const small = num(block.small) || 11.5;
  const smallLine = num(block.smallLine) || 15;
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'diagram-svg', role: 'img', 'aria-label': 'Diagram' });
  svg.style.width = `calc(${w}px * var(--diagram-scale, 1))`;
  svg.style.setProperty('--d-font', `${font}px`);
  svg.style.setProperty('--d-small', `${small}px`);

  const frames = [];
  for (const frame of block.frames || []) {
    const x = num(frame.x);
    const y = num(frame.y);
    svg.append(el('rect', { x, y, width: num(frame.w), height: num(frame.h), rx: 4, class: 'd-frame' }));
    // A frame's labels sit on a patch of the background, so lifelines pass behind them.
    const tag = (text, ty) => {
      const tw = String(text).length * small * 0.61 + 6;
      frames.push(el('rect', { x: x + 3, y: ty + 1, width: tw, height: smallLine, rx: 2, class: 'd-patch' }), label([text], x + 6, ty + smallLine / 2 + 1, smallLine, 'd-small', 'start'));
    };
    if (frame.label) tag(frame.label, y);
    for (const divider of frame.dividers || []) {
      const dy = num(divider.y);
      svg.append(el('line', { x1: x, y1: dy, x2: x + num(frame.w), y2: dy, class: 'd-divider' }));
      if (divider.label) tag(divider.label, dy);
    }
  }

  const labels = [];
  for (const edge of block.edges || []) {
    let pts = (edge.pts || []).map(([x, y]) => [num(x), num(y)]);
    if (pts.length < 2) continue;
    const parts = [];
    const size = edge.thick ? 10 : 8;
    if (edge.head) {
      const end = head(pts, edge.head, size);
      if (edge.head === 1) pts = [...pts.slice(0, -1), end.end];
      parts.push(end.shape);
    }
    if (edge.tail) {
      const start = head([...pts].reverse(), 1, size);
      pts = [start.end, ...pts.slice(1)];
      parts.push(start.shape);
    }
    const cls = `d-edge${edge.dash ? ' dash' : ''}${edge.thick ? ' thick' : ''}${edge.life ? ' life' : ''}`;
    svg.append(el('polyline', { points: pts.map(p => p.join(',')).join(' '), class: cls }), ...parts);
    if (edge.label && Array.isArray(edge.label.lines)) labels.push(edge.label);
  }
  svg.append(...frames);
  // Edge labels last, on a patch of the background, so the lines pass behind them.
  for (const item of labels) {
    const lines = item.lines.map(String);
    const lw = Math.max(...lines.map(value => value.length)) * small * 0.61 + 8;
    const lh = lines.length * smallLine + 2;
    const x = num(item.x);
    svg.append(el('rect', { x: x - lw / 2, y: num(item.y) - lh / 2, width: lw, height: lh, rx: 3, class: 'd-patch' }));
    svg.append(label(lines, x, num(item.y), smallLine, 'd-small'));
  }

  for (const node of block.nodes || []) {
    const lines = (node.lines || []).map(String);
    svg.append(shape(node));
    svg.append(label(lines, num(node.x) + num(node.w) / 2, num(node.y) + num(node.h) / 2 + (node.shape === 'db' ? 3 : 0), node.small ? smallLine : line, node.small ? 'd-small d-ink' : 'd-text'));
  }

  const figure = document.createElement('figure');
  figure.className = 'diagram';
  figure.title = block.source || '';
  figure.append(svg);
  return figure;
}
