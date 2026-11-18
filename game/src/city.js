// Vice Fortuna: the city generator and the spatial queries everything else runs on.
//
// The city is a 56 x 56 grid of 96 px cells (5376 x 5376 world px). Road lines run along cell
// boundaries; every 7th line is a wide avenue, the rest are narrow side streets. The rectangles
// between consecutive lines are blocks; the part of a block left inside its sidewalks holds a few
// buildings. The southern band is beach and then water, with no buildings at all.
//
// Nothing here draws. The renderer reads the lists straight out of the city object, and the
// simulation asks blocked()/onRoad()/isSidewalk()/nearestRoadPoint() where it may go.
// Everything is derived from the seed through ./rng.js, so a seed always yields the same city.
import { createRng } from './rng.js';

// ---------------------------------------------------------------------------------------------
// Geometry constants: keep these in step with the contract at the top of the spec.
// ---------------------------------------------------------------------------------------------
export const CELL = 96; // one grid cell, in world pixels
export const GRID = 56; // GRID x GRID cells
export const SIZE = CELL * GRID; // 5376
export const AVENUE_EVERY = 7; // road line indices 0, 7, 14 ... are avenues
export const AVENUE_W = 96; // carriageway width of an avenue
export const STREET_W = 36; // carriageway width of a side street (one lane each way)
export const SIDEWALK = 14; // pavement strip on each side of a carriageway
// 4800: the south band from here down is beach and then open water, out of bounds on foot.
export const WATER_Y = SIZE - 6 * CELL; // 4800: the water starts here
export const BEACH_Y = WATER_Y - 3 * CELL; // 4512: sand from here to the water

// Road centre lines, one per boundary between cells, plus the outer edge of the map.
// Line i sits at i * CELL, so a cell k is spanned by lines k and k + 1.
const LINES = GRID + 1;

// Building style tables. Tints are pastel/off-white in the Miami palette; roofs are the same hue
// a shade darker so the extruded slab reads against the walls.
const WALL_TINTS = [
  '#f7e7d3', '#f2d5bd', '#e9c6b0', '#f5dfc2', '#dfe6da',
  '#e7d8ea', '#d7e4ea', '#f9efd8', '#efd9cf', '#e3e8e2',
  '#fbe6d0', '#d9d3e6', '#f0e2c8',
];
const ROOF_TINTS = [
  '#d8c1a6', '#cfb096', '#c4a08a', '#d6bf9c', '#bfc9ba',
  '#c6b4cc', '#b6c8d0', '#dccaa9', '#cfb4a8', '#c3cabf',
  '#e0c8a7', '#bcb3cc', '#d2c0a0',
];
const GLASS = 'rgba(40, 58, 74, 0.55)'; // shared so windows read as glass at any zoom

// Billboards: invented brands only. Width/height are the poster rectangle.
const BRANDS = [
  { brand: 'Solva Cola', colour: '#d8352a', bg: '#f7efe0' },
  { brand: 'Vice Motors', colour: '#1d5e8c', bg: '#e8f0f4' },
  { brand: 'Kestrel Air', colour: '#c98a1b', bg: '#20303c' },
  { brand: 'Palma Rum', colour: '#2f7d4f', bg: '#fbf3d9' },
  { brand: 'Fortuna Bank', colour: '#454a57', bg: '#dfe4ea' },
  { brand: 'Neon Tan Lines', colour: '#b03a8c', bg: '#fbeae7' },
  { brand: 'Coral Reef Rum', colour: '#e0703a', bg: '#fff4e2' },
  { brand: 'Marisol Radio 98', colour: '#7a3fbf', bg: '#efe6fb' },
  { brand: 'Golden Gull Hotel', colour: '#b9971f', bg: '#2a2f3a' },
  { brand: 'Tidewater Insurance', colour: '#1f7a86', bg: '#e3f2f3' },
];

// ---------------------------------------------------------------------------------------------
// Small maths helpers (no allocation in the query path beyond the single returned object).
// ---------------------------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Index of the road line nearest to a coordinate: line i lives at i * CELL.
function lineIndex(v) {
  return clamp(Math.round(v / CELL), 0, GRID);
}

// Whether a coordinate lies within `reach(i)` of any road line. A point 41 px east of an avenue
// is nearer the next side street than the avenue itself, so a single nearest-line test would miss
// the carriageway it actually stands on; check a couple of lines either side as well.
function nearLine(v, reach) {
  const i = lineIndex(v);
  for (let d = -2; d <= 2; d += 1) {
    const index = i + d;
    if (index < 0 || index > GRID) continue;
    if (Math.abs(v - index * CELL) <= reach(index)) return true;
  }
  return false;
}

function isAvenueIndex(index) {
  return index % AVENUE_EVERY === 0;
}

// Carriageway half width for a line index (avenues are wider than side streets).
function halfRoad(index) {
  return (isAvenueIndex(index) ? AVENUE_W : STREET_W) * 0.5;
}

// ---------------------------------------------------------------------------------------------
// Builders: each one fills a separate list on the city object.
// ---------------------------------------------------------------------------------------------

// Road lines: every cell boundary, with the avenue flags kept in plain sets.
function buildRoads() {
  const roadsX = new Array(LINES);
  const roadsY = new Array(LINES);
  const avenuesX = new Set();
  const avenuesY = new Set();
  for (let index = 0; index < LINES; index += 1) {
    const centre = index * CELL;
    roadsX[index] = centre;
    roadsY[index] = centre;
    if (isAvenueIndex(index)) {
      avenuesX.add(centre);
      avenuesY.add(centre);
    }
  }
  return { roadsX, roadsY, avenuesX, avenuesY };
}

// Block rectangles: one per cell-square between two consecutive road lines, minus the sidewalks
// and half the carriageway on every side. With a 36 px side street a mid-block cell yields a
// ~32 px lot and an avenue-adjacent cell a 4 px sliver (which is dropped and reads as plaza), so
// buildings sit inside {roads + sidewalk} and never spill onto a pavement.
// Blocks sit between road lines: each rectangle fills one cell of the grid between streets.
function buildBlocks() {
  const blocks = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const left = col * CELL;
      const top = row * CELL;
      if (top + CELL > BEACH_Y) continue; // sand and sea: no blocks out here
      const inX = halfRoad(col) + SIDEWALK;
      const outX = halfRoad(col + 1) + SIDEWALK;
      const inY = halfRoad(row) + SIDEWALK;
      const outY = halfRoad(row + 1) + SIDEWALK;
      const x = left + inX;
      const y = top + inY;
      const w = CELL - inX - outX;
      const h = CELL - inY - outY;
      if (w > 20 && h > 20) blocks.push({ x, y, w, h, col, row });
    }
  }
  return blocks;
}

// Subdivide one block into 1..4 lots and drop a building on each lot that survives the dice.
// Lots are small (32 px between side streets), so streets split a big block up its longer axis
// and every lot keeps a 2 px gap from its neighbour and its block edge.
function populateBlock(block, rng, buildings) {
  const { x, y, w, h } = block;
  const margin = 2;
  const innerX = x + margin;
  const innerY = y + margin;
  const innerW = w - margin * 2;
  const innerH = h - margin * 2;
  if (innerW < 14 || innerH < 14) return;

  // Split the lot at most once along each axis, giving a 1x1, 2x1, 1x2 or 2x2 lot grid.
  const cols = innerW > 60 && rng.next() < 0.6 ? 2 : 1;
  const rows = innerH > 60 && rng.next() < 0.6 ? 2 : 1;
  const colGap = cols === 2 ? 3 : 0;
  const rowGap = rows === 2 ? 3 : 0;
  const lotW = (innerW - colGap) / cols;
  const lotH = (innerH - rowGap) / rows;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (rng.next() < 0.12) continue; // a gap: car park, plaza, back lot
      // Shrink the lot by a random shave so the skyline is not a perfect grid of boxes.
      const shaveX = rng.range(0, Math.min(5, lotW * 0.15));
      const shaveY = rng.range(0, Math.min(5, lotH * 0.15));
      const bx = innerX + c * (lotW + colGap) + shaveX * 0.5;
      const by = innerY + r * (lotH + rowGap) + shaveY * 0.5;
      const bw = lotW - shaveX;
      const bh = lotH - shaveY;
      if (bw < 12 || bh < 12) continue;

      const tintIndex = rng.int(0, WALL_TINTS.length - 1);
      // Towers hug the map centre; the beach fringe stays low-rise.
      const downtown = 1 - Math.min(1, Math.hypot(bx - SIZE / 2, by - SIZE / 2) / (SIZE * 0.55));
      const floors = clamp(Math.round(rng.range(1, 3 + downtown * 22)), 1, 24);
      const winCols = clamp(Math.round(bw / 9), 2, 10);
      const winRows = clamp(Math.round(floors * 0.8), 1, 18);

      buildings.push({
        x: bx,
        y: by,
        w: bw,
        h: bh,
        floors,
        tint: WALL_TINTS[tintIndex],
        roofTint: ROOF_TINTS[tintIndex],
        windows: { cols: winCols, rows: winRows, colour: GLASS },
      });
    }
  }
}

// Palms: a double row along the beach road, plus a scattering on a few inland blocks.
function buildPalms(blocks, rng) {
  const palms = [];
  const beachRoadY = WATER_Y - CELL; // the last road line before the sand
  for (let x = CELL * 0.5; x < SIZE; x += CELL * 0.5) {
    if (rng.next() < 0.28) continue;
    palms.push({ x: x + rng.range(-8, 8), y: beachRoadY - rng.range(26, 40), scale: rng.range(0.8, 1.25) });
    if (rng.next() < 0.6) {
      palms.push({ x: x + rng.range(-8, 8), y: beachRoadY + rng.range(30, 44), scale: rng.range(0.75, 1.1) });
    }
  }
  // Inland: a handful of palms per chosen block, tucked into the corners.
  for (const block of blocks) {
    if (rng.next() > 0.12) continue;
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i += 1) {
      palms.push({
        x: block.x + rng.range(4, Math.max(5, block.w - 4)),
        y: block.y + rng.range(4, Math.max(5, block.h - 4)),
        scale: rng.range(0.7, 1.05),
      });
    }
  }
  return palms;
}

// Lamps: one on each corner of every avenue intersection, set just off the carriageway. Corner
// lamps on the map border are dropped (they would sit outside the world).
function buildLamps(roadsX, roadsY, avenuesX, avenuesY) {
  const lamps = [];
  const off = SIDEWALK * 0.5;
  const push = (x, y) => {
    if (x < 2 || y < 2 || x > SIZE - 2 || y > SIZE - 2) return;
    lamps.push({ x, y });
  };
  for (const x of roadsX) {
    if (!avenuesX.has(x)) continue;
    for (const y of roadsY) {
      if (!avenuesY.has(y)) continue;
      const hx = halfRoad(Math.round(x / CELL)) + off;
      const hy = halfRoad(Math.round(y / CELL)) + off;
      push(x - hx, y - hy);
      push(x + hx, y - hy);
      push(x - hx, y + hy);
      push(x + hx, y + hy);
    }
  }
  return lamps;
}

// Billboards: 6..10 posters mounted on the walls of buildings that face an avenue.
function buildBillboards(buildings, roadsX, roadsY, avenuesX, avenuesY, rng) {
  const candidates = [];
  for (const b of buildings) {
    // A building fronts an avenue if its left/right edge is near a vertical avenue, or its top/
    // bottom edge near a horizontal one.
    const nearVertical = [...avenuesX].some((ax) => Math.abs(ax - b.x) < 40 || Math.abs(ax - (b.x + b.w)) < 40);
    const nearHorizontal = [...avenuesY].some((ay) => Math.abs(ay - b.y) < 40 || Math.abs(ay - (b.y + b.h)) < 40);
    if (nearVertical || nearHorizontal) candidates.push({ b, vertical: nearVertical });
  }
  // Fall back to any building tall enough if the avenue frontage is thin.
  const pool = candidates.length ? candidates : buildings.filter((b) => b.floors >= 2).map((b) => ({ b, vertical: true }));
  const count = clamp(rng.int(6, 10), 6, Math.min(10, pool.length));
  const billboards = [];
  const used = new Set();
  // Deal brands without replacement first so one city does not repeat a brand across posters.
  const deck = BRANDS.slice();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const swap = deck[i];
    deck[i] = deck[j];
    deck[j] = swap;
  }
  let guard = 0;
  while (billboards.length < count && guard < 400) {
    guard += 1;
    const entry = rng.pick(pool);
    if (used.has(entry.b)) continue;
    used.add(entry.b);
    const { b, vertical } = entry;
    const ad = deck[billboards.length % deck.length];
    const long = clamp(Math.min(vertical ? b.h : b.w, 70), 48, 70);
    const short = 26;
    const w = vertical ? short : long;
    const h = vertical ? long : short;
    // Mount just outside the wall, centred along the face, so the renderer can lift it.
    let x;
    let y;
    if (vertical) {
      x = b.x < SIZE / 2 ? b.x - w - 2 : b.x + b.w + 2;
      y = b.y + clamp(b.h * 0.5 - h * 0.5, 0, Math.max(0, b.h - h));
    } else {
      x = b.x + clamp(b.w * 0.5 - w * 0.5, 0, Math.max(0, b.w - w));
      y = b.y < SIZE / 2 ? b.y - h - 2 : b.y + b.h + 2;
    }
    billboards.push({ x, y, w, h, brand: ad.brand, colour: ad.colour, bg: ad.bg });
  }
  return billboards;
}

// Parked cars: pulled up along the kerb of a selection of blocks, aligned with the street.
// Only one car per block face, so nothing stacks on the same spot.
const CAR_COLOURS = ['#b8332c', '#2c6fa8', '#d5a02c', '#e8e3d6', '#3a4b3f', '#7c4a8f', '#c46a2a', '#22262b'];
const CAR_KINDS = ['sedan', 'sedan', 'coupe', 'wagon', 'van'];

function buildParked(blocks, rng) {
  const parked = [];
  for (const block of blocks) {
    if (rng.next() > 0.3) continue;
    const westSide = rng.next() < 0.5;
    const colour = rng.pick(CAR_COLOURS);
    const kind = rng.pick(CAR_KINDS);
    if (westSide) {
      // West kerb: nose north, sitting in the side street just outside the block.
      parked.push({
        x: block.x - 12,
        y: block.y + rng.range(18, Math.max(19, block.h - 18)),
        angle: -Math.PI / 2,
        colour,
        kind,
      });
    } else {
      // North kerb: nose east.
      parked.push({
        x: block.x + rng.range(18, Math.max(19, block.w - 18)),
        y: block.y - 12,
        angle: 0,
        colour,
        kind,
      });
    }
  }
  return parked;
}

// ---------------------------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------------------------
export function buildCity(seed = 1) {
  const rng = createRng(seed);
  const { roadsX, roadsY, avenuesX, avenuesY } = buildRoads();
  const blocks = buildBlocks();

  const buildings = [];
  for (const block of blocks) populateBlock(block, rng, buildings);

  // Second pass: the odd mega-tower, capped so nothing pokes through the sky weirdly.
  for (const b of buildings) {
    if (b.floors >= 12 && rng.next() < 0.08) b.floors = clamp(b.floors + rng.int(2, 6), 1, 24);
  }

  const palms = buildPalms(blocks, rng);
  const lamps = buildLamps(roadsX, roadsY, avenuesX, avenuesY);
  const billboards = buildBillboards(buildings, roadsX, roadsY, avenuesX, avenuesY, rng);
  const parked = buildParked(blocks, rng);

  // Strip the generator-only fields (col/row) from blocks so the shape matches the contract.
  const cleanBlocks = blocks.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));

  return {
    size: SIZE,
    seed,
    cells: GRID,
    cell: CELL,
    roadsX,
    roadsY,
    avenuesX,
    avenuesY,
    buildings,
    blocks: cleanBlocks,
    water: { y: WATER_Y },
    beach: { y: BEACH_Y },
    palms,
    lamps,
    billboards,
    parked,
    marks: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Spatial queries used by the simulation
// ---------------------------------------------------------------------------------------------

// True if a disc of `radius` at (x, y) touches a building or the sea. Buildings are tested
// against the disc-expanded rectangle, which is exact enough for walking and driving.
export function blocked(city, x, y, radius = 0) {
  if (y + radius >= city.water.y) return true; // in the sea
  if (x < radius || y < radius || x > city.size - radius || y > city.size - radius) return true;
  for (let i = 0; i < city.buildings.length; i += 1) {
    const b = city.buildings[i];
    if (x + radius > b.x && x - radius < b.x + b.w && y + radius > b.y && y - radius < b.y + b.h) return true;
  }
  return false;
}

// True if (x, y) lies on a carriageway (avenue or side street), including intersections.
export function onRoad(city, x, y) {
  return nearLine(x, halfRoad) || nearLine(y, halfRoad);
}

// Nearest point on a carriageway: the nearest lane centre. Roads carry two lanes either way, so
// the nearest road point is the projection onto the closest road line, nudged toward the right-
// hand lane of the direction of travel (keep right).
export function nearestRoadPoint(city, x, y) {
  const ix = lineIndex(x);
  const iy = lineIndex(y);
  const dx = Math.abs(x - city.roadsX[ix]);
  const dy = Math.abs(y - city.roadsY[iy]);
  if (dx <= dy) {
    // Vertical road: hold x, slide to the nearer lane beside the nearest intersection.
    const hw = halfRoad(ix);
    const lane = y < city.roadsY[iy] ? -hw * 0.35 : hw * 0.35;
    return {
      x: clamp(x, city.roadsX[ix] - hw, city.roadsX[ix] + hw),
      y: clamp(city.roadsY[iy] + lane, 0, city.size),
    };
  }
  const hw = halfRoad(iy);
  const lane = x < city.roadsX[ix] ? hw * 0.35 : -hw * 0.35;
  return {
    x: clamp(city.roadsX[ix] + lane, 0, city.size),
    y: clamp(y, city.roadsY[iy] - hw, city.roadsY[iy] + hw),
  };
}

// True if (x, y) is on a pavement: inside a road's sidewalk strip but past its carriageway, and
// not out in the sand.
export function isSidewalk(city, x, y) {
  if (y >= city.beach.y) return false;
  if (onRoad(city, x, y)) return false;
  return nearLine(x, (i) => halfRoad(i) + SIDEWALK) || nearLine(y, (i) => halfRoad(i) + SIDEWALK);
}
