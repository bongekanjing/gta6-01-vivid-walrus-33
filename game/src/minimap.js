// Vice Fortuna: the circular, north-up minimap in the bottom-left corner. The map is centred on
// the player, so only the arrow rotates; world +y is map +y and north stays put. One map pixel is
// 12 world pixels, so a 74 px radius shows a 1776 px window. The road layer never changes, so it
// is painted once into an offscreen canvas and blitted with a translation; only the marker, the
// police blips and the arrow are drawn per frame, inside the circle clip.

// Map scale: one map pixel covers WORLD_PER_MAP (12) world pixels in both axes.
const WORLD_PER_MAP = 12; // 1 map px = 12 world px
const MAP_RADIUS = 74; // the radius the HUD reserves for us
const ROAD_LAYER_MAX = 900; // cap on the offscreen layer's edge, so a big city is not a memory hog

// Palette: a paper map at dusk. Water is the only loud colour besides the blips.
const COLOURS = {
  water: '#1f6f8b',
  beach: '#e3d2a4',
  land: '#2a2b31',
  block: '#3b3c44',
  avenue: '#8d8a80',
  street: '#6d6b64',
  rim: '#0d0e11',
  rimInner: '#f2d99a',
};

// --- static layer: roads, blocks and sea, painted once per city ----------
let layer = null; // { canvas, scale, city }

// Avenue every 7th road line, 96 px wide; side streets are 36 px. Half width, in world px.
function halfRoad(index) {
  return (index % 7 === 0 ? 96 : 36) * 0.5;
}

// Paint the whole city at `scale` (world px -> layer px): land, beach, sea, blocks, then the
// streets twice so avenues sit over side streets and junctions stay clean.
function paintLayer(ctx, city, scale) {
  const layerSize = Math.ceil(city.size * scale);
  const sea = city.water.y * scale;
  const beachY = (city.beach ? city.beach.y : city.water.y) * scale;

  ctx.fillStyle = COLOURS.land;
  ctx.fillRect(0, 0, layerSize, layerSize);
  ctx.fillStyle = COLOURS.beach;
  ctx.fillRect(0, beachY, layerSize, sea - beachY);
  ctx.fillStyle = COLOURS.water;
  ctx.fillRect(0, sea, layerSize, layerSize - sea);

  ctx.fillStyle = COLOURS.block;
  for (let i = 0; i < city.blocks.length; i += 1) {
    const b = city.blocks[i];
    ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
  }

  // Each line gets a thin side-street stroke, then avenues a wider stroke on top.
  for (let i = 0; i < city.roadsX.length; i += 1) {
    const x = city.roadsX[i] * scale;
    const y = city.roadsY[i] * scale;
    const avenue = i % 7 === 0;
    for (let pass = avenue ? 0 : 1; pass < 2; pass += 1) {
      ctx.strokeStyle = pass ? COLOURS.avenue : COLOURS.street;
      ctx.lineWidth = Math.max(1, (pass ? halfRoad(i) * 2 : 36) * scale);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, sea);
      ctx.moveTo(0, y);
      ctx.lineTo(layerSize, y);
      ctx.stroke();
    }
  }
}

// Build (or reuse) the offscreen road layer. Painted a little coarser than the on-screen scale
// (ROAD_LAYER_MAX) and scaled back up when blitted.
function ensureLayer(city) {
  if (layer && layer.city === city) return layer;
  const scale = Math.min(1 / WORLD_PER_MAP, ROAD_LAYER_MAX / city.size);
  const edge = Math.ceil(city.size * scale);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(edge, edge)
    : Object.assign(document.createElement('canvas'), { width: edge, height: edge });
  paintLayer(canvas.getContext('2d'), city, scale);
  layer = { canvas, scale, city };
  return layer;
}

// --- blips ---------------------------------------------------------------

// Police: blue discs with a white pinprick, so they pop against the grey roads.
function drawPolice(ctx, police, px, py, s, cx, cy) {
  if (!police) return;
  for (let i = 0; i < police.length; i += 1) {
    const cop = police[i];
    const at = (cop.state === 'foot' && cop.officer) || cop.car || cop;
    if (typeof at.x !== 'number') continue;
    const x = cx + (at.x - px) * s;
    const y = cy + (at.y - py) * s;
    ctx.fillStyle = '#2f7ff5';
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dfeaff';
    ctx.beginPath();
    ctx.arc(x, y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Mission marker: a gold diamond on the live objective (missions.marker, else the current stage's
// x/y), pulled to a ring just inside the rim when it sits outside the window so the player still
// gets a bearing on it.
function drawMarker(ctx, state, px, py, s, radius, cx, cy) {
  const missions = state.missions;
  if (!missions || missions.done) return;
  const job = missions.list && missions.list[missions.index];
  const stage = job && job.stages && job.stages[missions.stage];
  const marker = missions.marker && typeof missions.marker.x === 'number' ? missions.marker
    : stage && typeof stage.x === 'number' ? stage : null;
  if (!marker) return;
  let mx = cx + (marker.x - px) * s;
  let my = cy + (marker.y - py) * s;
  const dist = Math.hypot(mx - cx, my - cy);
  const edge = radius - 8;
  if (dist > edge) {
    mx = cx + ((mx - cx) * edge) / dist;
    my = cy + ((my - cy) * edge) / dist;
  }
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#f0c34a';
  ctx.strokeStyle = '#4a3406';
  ctx.lineWidth = 1.2;
  ctx.fillRect(-5.5, -5.5, 11, 11);
  ctx.strokeRect(-5.5, -5.5, 11, 11);
  ctx.restore();
}

// White arrow along the player's facing, at the centre because the map centres on them. World
// angle 0 is +x and the art points up (-y), hence the quarter-turn.
function drawArrow(ctx, angle) {
  ctx.save();
  ctx.rotate(angle + Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, -7.5);
  ctx.lineTo(5.4, 6.2);
  ctx.lineTo(0, 3.2);
  ctx.lineTo(-5.4, 6.2);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.85)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();
}

// --- public entry point --------------------------------------------------
export function drawMinimap(ctx, state, cx, cy, radius = MAP_RADIUS) {
  if (!ctx || !state || !state.city || !state.player) return;
  const player = state.player;
  const s = 1 / WORLD_PER_MAP;
  const px = player.car ? player.car.x : player.x;
  const py = player.car ? player.car.y : player.y;
  const angle = (player.car ? player.car.angle : player.angle) || 0;
  const base = ensureLayer(state.city);

  ctx.save();

  // Disc: clip, fill the land under the roads, then blit the static layer centred on the player.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = COLOURS.land;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.save();
  ctx.translate(cx - px * s, cy - py * s);
  ctx.scale(s / base.scale, s / base.scale);
  ctx.drawImage(base.canvas, 0, 0);
  ctx.restore();

  // Blips in world-relative screen offsets; the player arrow last so nothing covers it.
  drawPolice(ctx, state.police, px, py, s, cx, cy);
  drawMarker(ctx, state, px, py, s, radius, cx, cy);
  ctx.translate(cx, cy);
  drawArrow(ctx, angle);

  // Rim: a dark ring with a thin gold inner line, matching the HUD's late-afternoon look.
  ctx.restore(); // drop the clip so the rim draws cleanly
  ctx.save();
  ctx.strokeStyle = COLOURS.rim;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha *= 0.55;
  ctx.strokeStyle = COLOURS.rimInner;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
