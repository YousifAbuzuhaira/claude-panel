// What keeps a page legible however see-through its window is. shared/look.js makes the
// background see-through (in a native window); the text, lines and accents stay solid, but over
// a backdrop of the opposite lightness solid text can still sink into what shows through. So
// look.js marks the page from every palette it applies (pages need not call this themselves):
//   --bg-solid             the background without its see-through, always (Sudoku's grid lines are
//                          mixed toward it, so they stay solid; the halo below is made of it)
//   html[data-see-through] while the background is clearer than SEE_THROUGH_BELOW: theme.css then
//                          gives the text a halo of --bg-solid to stand on, whatever is behind it
//                          (pages turn it off where it doesn't belong: a board, a primary button)
// At the usual see-through (95%) and in a plain browser (always solid) nothing changes.
//
// No imports, so the node tests can load it.

/** Clearer than this, the text gets its halo: the same point as the WPF windows
    ($UI_HALO_BELOW in widget/Chrome.ps1). */
export const SEE_THROUGH_BELOW = 0.85;

/** '#AARRGGBB' (a palette role) to {solid: '#rrggbb', alpha: 0..1}; null if malformed. */
export function splitArgb(argb) {
  if (typeof argb !== 'string' || !/^#[0-9A-Fa-f]{8}$/.test(argb)) return null;
  return { solid: `#${argb.slice(3).toLowerCase()}`, alpha: parseInt(argb.slice(1, 3), 16) / 255 };
}

/**
 * How a palette (shared/theme.js derivePalette's, '#AARRGGBB' roles) marks the page:
 * {bgSolid, seeThrough}. A palette without a readable cardFill marks nothing.
 */
export function seeThroughOf(palette) {
  const card = splitArgb(palette && palette.cardFill);
  if (!card) return { bgSolid: null, seeThrough: false };
  return { bgSolid: card.solid, seeThrough: card.alpha < SEE_THROUGH_BELOW - 1e-9 };
}

/** Marks `root` (default: <html>) for the palette now on it. Returns what it set. */
export function markSeeThrough(palette, root) {
  const target = root || (globalThis.document && globalThis.document.documentElement);
  const mark = seeThroughOf(palette);
  if (!target || !mark.bgSolid) return mark;
  target.style.setProperty('--bg-solid', mark.bgSolid);
  if (mark.seeThrough) target.dataset.seeThrough = '';
  else delete target.dataset.seeThrough;
  return mark;
}
