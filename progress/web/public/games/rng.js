// Random numbers for the games: Math.random by default, or a seeded generator
// (mulberry32) so tests and snapshots can replay the same game.

/** A function returning floats in [0, 1), like Math.random. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [0, n). */
export const nextInt = (rng, n) => Math.floor(rng() * n);

/** Fisher-Yates, in place. */
export function shuffle(list, rng) {
  for (let k = list.length - 1; k > 0; k--) {
    const j = nextInt(rng, k + 1);
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
}

/** The seed from ?seed=N in the page's URL, or 0. */
export function seedFromUrl() {
  try {
    const seed = Number(new URLSearchParams(location.search).get('seed'));
    return Number.isInteger(seed) && seed > 0 ? seed : 0;
  } catch {
    return 0;
  }
}

export const rngFor = seed => (seed ? seeded(seed) : Math.random);
