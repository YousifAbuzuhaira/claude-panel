// What the video stage knows, with no drawing: shared by the player and by the checks that test a
// script before it's recorded (learn/video-check.mjs). Every moment of a video is worked out from
// the time alone, so a jump lands on the right picture, whatever played before it.

export const STAGE = { w: 1120, h: 630, left: 40, right: 1080, top: 96, bottom: 500 };
const SAFE = { x: 30, y: 86, w: 1060, h: 424 };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const numberWidth = (o, size) => (Number(o.value ?? 0).toLocaleString('en-US').length + String(o.suffix || '').length) * size * 0.62 + 10;

/** About where an object sits, for the camera. Null for what only joins others. */
export function roughRect(o, assets) {
  if (o.shape === 'arrow') return null;
  if (o.shape === 'row') {
    const n = Math.max(1, (o.items || []).length);
    const cell = Math.max(44, Math.min(112, Math.floor(((o.w || 1000) - 10 * (n - 1)) / n)));
    const width = Math.min(o.w || 1000, n * cell + 10 * (n - 1));
    return { x: o.x + ((o.w || 1000) - width) / 2, y: o.y, w: width, h: cell * 1.05 };
  }
  if (o.shape === 'label') {
    const size = { s: 16, m: 22, l: 30, xl: 46 }[o.size || 'm'];
    const w = o.w || 300;
    const wide = String(o.text ?? '').length * size * 0.56;
    return { x: o.align === 'center' ? o.x + Math.max(0, w - wide) / 2 : o.x, y: o.y, w: Math.min(w, wide), h: Math.ceil(wide / w) * size * 1.3 };
  }
  if (o.shape === 'number') {
    const size = { m: 26, l: 40, xl: 60 }[o.size || 'l'];
    return { x: o.x, y: o.y, w: Math.min(o.w || 200, numberWidth(o, size)), h: size * 1.15 + (o.sub ? 24 : 0) };
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

/** The picture framed: everything shown inside the safe area, leaning a little to what changed. */
export function frameFor(state, before, assets) {
  const shown = [...state.values()].filter(o => o.visible);
  const rects = shown.map(o => roughRect(o, assets)).filter(Boolean);
  if (!rects.length) return { x: 560, y: 298, zoom: 1 };
  const box = boundsOf(rects);
  const zoom = clamp(Math.min((SAFE.w - 40) / Math.max(box.w, 1), (SAFE.h - 30) / Math.max(box.h, 1)), 1, 1.5);
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
  return { x, y, zoom };
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

/** A camera for each state. Small corrections are dropped: they would only make the picture twitch. */
export function buildCameras(scene, states, assets) {
  const cameras = states.map((state, index) => {
    const told = index > 0 && scene.cues[index - 1].camera;
    return told ? { x: 560, y: 298, zoom: 1, ...told } : frameFor(state, states[index - 1], assets);
  });
  for (let index = 1; index < cameras.length; index++) {
    const a = cameras[index - 1];
    const b = cameras[index];
    if (Math.abs(a.x - b.x) < 16 && Math.abs(a.y - b.y) < 12 && Math.abs(a.zoom - b.zoom) < 0.03) cameras[index] = a;
  }
  return cameras;
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
