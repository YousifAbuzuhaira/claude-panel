// What the video stage knows, with no drawing: shared by the player and by the checks that test a
// script before it's recorded (learn/video-check.mjs). Every moment of a video is worked out from
// the time alone, so a jump lands on the right picture, whatever played before it.

export const STAGE = { w: 1120, h: 630, left: 40, right: 1080, top: 96, bottom: 500 };
const SAFE = { x: 30, y: 86, w: 1060, h: 424 };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const numberWidth = (o, size) => (Number(o.value ?? 0).toLocaleString('en-US').length + String(o.suffix || '').length) * size * 0.62 + 10;

// Monospace type is about this wide per character of its font size.
const MONO = 0.61;
const CELL_GAP = 10;

/** A row's cell size (its --cell) and each cell's drawn width: a cell grows with its text (white-space: pre). */
export function rowCells(o) {
  const items = o.items || [];
  const n = Math.max(1, items.length);
  const cell = Math.max(44, Math.min(112, Math.floor(((o.w || 1000) - CELL_GAP * (n - 1)) / n)));
  const sub = Math.max(13, cell * 0.16);
  const widths = items.map(item => Math.max(cell, String(item?.label ?? '').length * cell * 0.34 * MONO + 10, String(item?.sub ?? '').length * sub * MONO + 10));
  return { cell, widths: widths.length ? widths : [cell] };
}

/**
 * About where an object sits, as the stage draws it: for the camera and for the checks before a
 * script is recorded. Null for what only joins others.
 */
export function roughRect(o, assets) {
  if (o.shape === 'arrow') return null;
  if (o.shape === 'row') {
    // Cells wrap within the row's width (the stage's, with none given), each line centred in it.
    const { cell, widths } = rowCells(o);
    const room = o.w || STAGE.w;
    const lines = [];
    for (const width of widths) {
      const line = lines.at(-1);
      if (line && line.w + CELL_GAP + width <= room) line.w += CELL_GAP + width;
      else lines.push({ w: width });
    }
    const widest = Math.max(...lines.map(line => line.w));
    const box = o.w || (lines.length > 1 ? room : widest);
    return { x: o.x + (box - widest) / 2, y: o.y, w: widest, h: cell * 1.05 * lines.length + CELL_GAP * (lines.length - 1) };
  }
  if (o.shape === 'label') {
    // Without a width a label is one line, as wide as its text.
    const size = { s: 16, m: 22, l: 30, xl: 46 }[o.size || 'm'];
    const wide = String(o.text ?? '').length * size * (o.mono ? MONO : 0.56);
    const room = o.w || STAGE.w;
    const w = Math.min(room, wide);
    return { x: o.align === 'center' && o.w ? o.x + (o.w - w) / 2 : o.x, y: o.y, w, h: Math.max(1, Math.ceil(wide / room)) * size * 1.3 };
  }
  if (o.shape === 'number') {
    const size = { m: 26, l: 40, xl: 60 }[o.size || 'l'];
    const w = Math.min(o.w || Infinity, numberWidth(o, size));
    return { x: o.align === 'center' && o.w ? o.x + (o.w - w) / 2 : o.x, y: o.y, w, h: size * 1.15 + (o.sub ? 24 : 0) };
  }
  if (o.shape === 'table') return { x: o.x, y: o.y, w: o.w, h: 50 * (assets.table[o.asset]?.length || 1) };
  if (o.shape === 'dot') return { x: o.x, y: o.y, w: o.w || 12, h: o.w || 12 };
  return { x: o.x, y: o.y, w: o.w || 0, h: o.h || 0 };
}

function boundsOf(rects) {
  const left = Math.min(...rects.map(r => r.x));
  const top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.w));
  const bottom = Math.max(...rects.map(r => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// The camera may pull back this far to keep everything in frame; past it, the picture is too small.
const LEAST_ZOOM = 0.85;

/**
 * A camera that crops nothing: zoomed out (to LEAST_ZOOM at most) until `rects` fit the safe area,
 * then moved just enough to bring them all in. A camera that already fits comes back unchanged.
 */
export function fitCamera(cam, rects) {
  if (!rects.length) return cam;
  const box = boundsOf(rects);
  const zoom = clamp(Math.min(cam.zoom, SAFE.w / Math.max(box.w, 1), SAFE.h / Math.max(box.h, 1)), LEAST_ZOOM, cam.zoom);
  // On screen a point p sits at (p - cam) * zoom + the centre: keep the box's edges inside SAFE.
  const keep = (at, low, high, centre, safeLow, safeHigh) => {
    const most = low + (centre - safeLow) / zoom;
    const least = high - (safeHigh - centre) / zoom;
    return least > most ? (low + high) / 2 : clamp(at, least, most);
  };
  const x = keep(cam.x, box.x, box.x + box.w, 560, SAFE.x, SAFE.x + SAFE.w);
  const y = keep(cam.y, box.y, box.y + box.h, 298, SAFE.y, SAFE.y + SAFE.h);
  return x === cam.x && y === cam.y && zoom === cam.zoom ? cam : { x, y, zoom };
}

/** The picture framed: everything shown inside the safe area, leaning a little to what changed. */
export function frameFor(state, before, assets) {
  const shown = [...state.values()].filter(o => o.visible);
  const rects = shown.map(o => roughRect(o, assets)).filter(Boolean);
  if (!rects.length) return { x: 560, y: 298, zoom: 1 };
  const box = boundsOf(rects);
  const zoom = clamp(Math.min((SAFE.w - 40) / Math.max(box.w, 1), (SAFE.h - 30) / Math.max(box.h, 1)), LEAST_ZOOM, 1.5);
  let x = box.x + box.w / 2;
  let y = box.y + box.h / 2;
  if (zoom === 1 && box.w < SAFE.w && box.h < SAFE.h) {
    x = (x + 560) / 2 + (x - 560) * 0.5;
    y = (y + 298) / 2 + (y - 298) * 0.5;
  }
  const moved = shown.filter(o => {
    const was = before?.get(o.id);
    return !was || !was.visible || JSON.stringify(was) !== JSON.stringify(o);
  }).map(o => roughRect(o, assets)).filter(Boolean);
  if (moved.length && moved.length < rects.length) {
    const focus = boundsOf(moved);
    const leanX = x + (focus.x + focus.w / 2 - x) * 0.16;
    const leanY = y + (focus.y + focus.h / 2 - y) * 0.16;
    const fitsX = (box.x - leanX) * zoom + 560 >= SAFE.x && (box.x + box.w - leanX) * zoom + 560 <= SAFE.x + SAFE.w;
    const fitsY = (box.y - leanY) * zoom + 298 >= SAFE.y && (box.y + box.h - leanY) * zoom + 298 <= SAFE.y + SAFE.h;
    if (fitsX) x = leanX;
    if (fitsY) y = leanY;
  }
  return fitCamera({ x, y, zoom }, rects);
}

/** One state of all a scene's objects per cue: scene.states[0] is before the first cue. */
export function buildStates(scene) {
  const first = new Map((scene.objects || []).map(o => [o.id, { ...o, visible: Boolean(o.show) }]));
  const states = [first];
  let previous = first;
  for (const cue of scene.cues || []) {
    const next = new Map([...previous].map(([id, o]) => [id, { ...o }]));
    for (const id of cue.show || []) if (next.has(id)) next.get(id).visible = true;
    for (const id of cue.hide || []) if (next.has(id)) next.get(id).visible = false;
    for (const [id, change] of Object.entries(cue.set || {})) if (next.has(id)) Object.assign(next.get(id), change);
    states.push(next);
    previous = next;
  }
  return states;
}

/**
 * A camera for each state, framing what is shown. A camera a script asks for (`cue.camera`, in
 * scripts before 0.18) is not followed: it cropped what was on stage. Small corrections are
 * dropped: they would only make the picture twitch.
 */
export function buildCameras(scene, states, assets) {
  const cameras = states.map((state, index) => frameFor(state, states[index - 1], assets));
  for (let index = 1; index < cameras.length; index++) {
    const a = cameras[index - 1];
    const b = cameras[index];
    if (Math.abs(a.x - b.x) < 16 && Math.abs(a.y - b.y) < 12 && Math.abs(a.zoom - b.zoom) < 0.03) cameras[index] = a;
  }
  return cameras;
}

/** Outline boxes with something shown inside them (its centre within): their name goes on their top edge. */
export function containers(state, assets) {
  const shown = [...state.values()].filter(o => o.visible && o.shape !== 'arrow');
  const held = new Set();
  for (const outer of shown) {
    if (outer.shape !== 'box' || outer.style !== 'outline') continue;
    const r = roughRect(outer, assets);
    for (const o of shown) {
      if (o === outer) continue;
      const q = roughRect(o, assets);
      const [cx, cy] = [q.x + q.w / 2, q.y + q.h / 2];
      if (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h) { held.add(outer.id); break; }
    }
  }
  return held;
}

/** Where a container's name sits on its top edge (15 px mono, 12 in from its left). */
export const legendRect = o => ({ x: o.x + 12, y: o.y - 10, w: String(o.text ?? '').length * 15 * MONO + 12, h: 20 });

/** Code without the indentation all its lines share (tabs as 4 spaces); its lines stay where they were. */
export function dedent(text) {
  const lines = String(text ?? '').replace(/\t/g, '    ').split('\n');
  const lead = line => /^ */.exec(line)[0].length;
  const common = Math.min(...lines.filter(line => line.trim()).map(lead));
  return Number.isFinite(common) && common > 0 ? lines.map(line => line.slice(Math.min(common, lead(line)))).join('\n') : lines.join('\n');
}

// --- Arrows ------------------------------------------------------------------------------

/** Where a line from a box's centre towards (tx, ty) leaves it, 8 past its edge. */
export function edgePoint(r, tx, ty) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy;
  const k = 1 / Math.max(Math.abs(dx) / (r.w / 2 + 8), Math.abs(dy) / (r.h / 2 + 8), 1e-6);
  return [cx + dx * k, cy + dy * k];
}

/** An arrow's two ends [x1, y1, x2, y2]: edge to edge between the objects it joins, else its own points. */
export function wireEnds(o, rectById) {
  const a = o.from && rectById(o.from), b = o.to && rectById(o.to);
  if (a && b) return [...edgePoint(a, b.x + b.w / 2, b.y + b.h / 2), ...edgePoint(b, a.x + a.w / 2, a.y + a.h / 2)];
  const ends = [o.x, o.y, o.x2, o.y2];
  return ends.every(Number.isFinite) ? ends : null;
}

/** An arrow's text (14 px mono, centred on x, its baseline at y) as a box. */
export function labelBox(text, x, y) {
  const w = String(text ?? '').length * 14 * MONO + 6;
  return { x: x - w / 2, y: y - 13, w, h: 18 };
}

const SPOT_ALONG = [0.5, 0.35, 0.65, 0.2, 0.8];

/** The point an arrow's text is drawn at, for a spot `{ t, side }` along the line between `ends`. */
export function labelPoint(ends, text, spot) {
  const [x1, y1, x2, y2] = ends;
  const px = x1 + (x2 - x1) * spot.t, py = y1 + (y2 - y1) * spot.t;
  const half = String(text ?? '').length * 14 * MONO / 2 + 3;
  if (spot.side === 'below') return [px, py + 22];
  if (spot.side === 'right') return [px + half + 8, py + 5];
  if (spot.side === 'left') return [px - half - 8, py + 5];
  return [px, py - 10];
}

const overlaps = (p, q, room = 0) => Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > room && Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > room;

const covered = (p, rects) => rects.reduce((sum, q) => sum + Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y)), 0);

/**
 * Where an arrow's text goes: the first spot along its line (the middle first) where it covers no
 * object, above or below a level line, beside a steep one. `free` is false when no spot is clear:
 * it then sits where it covers least.
 */
export function labelSpot(ends, text, rects) {
  const [x1, y1, x2, y2] = ends;
  const sides = Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? ['above', 'below'] : ['right', 'left'];
  let best = null;
  for (const t of SPOT_ALONG) {
    for (const side of sides) {
      const spot = { t, side };
      const box = labelBox(text, ...labelPoint(ends, text, spot));
      if (!rects.some(r => overlaps(box, r, 1))) return { ...spot, free: true };
      const cover = covered(box, rects);
      if (!best || cover < best.cover) best = { ...spot, cover };
    }
  }
  return { t: best.t, side: best.side, free: false };
}

/** Whether the segment from (x1, y1) to (x2, y2) passes through a rect. */
export function crosses([x1, y1, x2, y2], r) {
  // Liang-Barsky: clip the segment against the rect; anything left means it passes through.
  let low = 0, high = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - r.x], [dx, r.x + r.w - x1], [-dy, y1 - r.y], [dy, r.y + r.h - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const k = q / p;
    if (p < 0) low = Math.max(low, k); else high = Math.min(high, k);
    if (low > high) return false;
  }
  return true;
}

/** The scene playing at a time. */
export function sceneAt(scenes, t) {
  let found = 0;
  for (let index = 0; index < scenes.length; index++) {
    if (scenes[index].start <= t) found = index;
    else break;
  }
  return found;
}
