// Seeded PRNG helpers (mulberry32). Same seed -> same sequence, so scenes are repeatable.
// Note: game/src/random.js already exposes createRandom(seed); this module wraps it with
// the next/range/int/pick helpers used by newer game code.

function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a generator object bound to one seed (mulberry32: a 32-bit state stepping by 0x6d2b79f5).
// Deterministic per seed: the same seed always yields the same sequence.
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next, // float in [0, 1)
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)), // inclusive both ends
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

// Module-level default generator so callers can use the bare helpers.
const defaultRng = createRng(1);

export const next = () => defaultRng.next();
export const range = (min, max) => defaultRng.range(min, max);
export const int = (min, max) => defaultRng.int(min, max);
export const pick = (list) => defaultRng.pick(list);

// Reseed the default generator in place (call order stays stable for callers).
export function seed(value) {
  const fresh = createRng(value);
  Object.assign(defaultRng, fresh);
}
