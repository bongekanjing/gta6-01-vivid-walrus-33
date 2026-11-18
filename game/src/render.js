// Vice Fortuna: the renderer. World state in, pixels out.
//
// 1280x720 logical playfield scaled to the window. All city layers are drawn through one camera
// transform; the camera follows the player (or their car), easing frame-rate independently and
// zooming 1.0 walking -> 0.78 at speed, clamped so no void shows past the map or the water.
//
// Hot loop allocates nothing: constants are module-level, and window patterns, dash strips,
// shaded hexes, per-building skins and billboard labels are cached on first use. Culling is a rect
// test against the view grown by CULL_MARGIN.
//
// Late afternoon: sun from the west, shadows east and south, peach glass, violet side walls, a warm
// wash over the frame and a soft vignette.
import { CELL, SIDEWALK, AVENUE_W, STREET_W, WATER_Y, BEACH_Y } from './city.js';

const VIEW_W = 1280;
const VIEW_H = 720;
const STEP = 1 / 60;
const CULL_MARGIN = 200;
const SHAKE_MAX = 14;
const FLOOR_H = 16; // world px of apparent height per floor
const ROOF_SLIDE = 0.18; // roof leans toward the city centre by height * this
const SHADOW_X = 0.34; // building shadow offset per height px: east and a little south
const SHADOW_Y = 0.24;
const DASH_LEN = 8; // world px per dash on/off pair
const WASH = 'rgba(255, 196, 120, 0.055)';

const C = {
  waterDeep: '#17496b', waterMid: '#2b7a9e', waterShallow: '#5fb3c4',
  foam: 'rgba(255, 248, 240, 0.75)', swell: 'rgba(240, 250, 252, 0.16)',
  sandWet: '#d7b98c', sand: '#efd6a6', dune: 'rgba(255, 246, 220, 0.35)',
  ground: '#6d6656', groundAlt: '#736b59',
  road: '#3b2f30', line: '#f4e9cf', lineDim: 'rgba(244, 233, 207, 0.65)',
  kerb: '#cdbfa6', walk: '#b9b3a4',
  sil: 'rgba(31, 32, 45, 0.30)', shadow: 'rgba(38, 30, 44, 0.34)', carShadow: 'rgba(30, 26, 34, 0.30)',
  glass: 'rgba(36, 50, 66, 0.62)', tyre: 'rgba(28, 26, 30, 0.32)', tyreOld: 'rgba(28, 26, 30, 0.14)',
  lampPost: '#4a4a50', lampGlow: 'rgba(255, 214, 140, 0.30)', lampCore: '#ffe6a8',
  palmTrunk: '#7a6247', palmDark: '#3f6b3a', palmMid: '#528a45', palmLight: '#6ba552',
  marker: '#f6c53c', markerPulse: 'rgba(255, 229, 140, 0.55)', bullet: '#ffe9a8',
  smoke: 'rgba(196, 192, 186, 0.55)', spark: '#ffcf7a', dust: 'rgba(214, 196, 160, 0.55)',
  blood: 'rgba(140, 30, 34, 0.7)', copBody: '#26314a', pedSkin: '#e2b083',
  policeRed: 'rgba(255, 64, 64, 0.85)', policeBlue: 'rgba(80, 130, 255, 0.85)',
  backdrop: '#2b2420', text: 'rgba(255, 240, 210, 0.6)',
};
const PARTICLE_COLOURS = new Map([['smoke', C.smoke], ['spark', C.spark], ['dust', C.dust], ['blood0', C.blood]]);


const isAvenue = (centre) => Math.round(centre / CELL) % 7 === 0;
const halfRoad = (centre) => (isAvenue(centre) ? AVENUE_W : STREET_W) * 0.5;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const haveCanvas = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

// Offscreen caches, created once per key and kept for the life of the module.
// An 8 x 8 tile of a glass pane between mullions: one createPattern makes a facade a single fill.
const patternCache = new Map();
function windowPattern(ctx, colour) {
  const hit = patternCache.get(colour);
  if (hit !== undefined) return hit;
  let pattern = null;
  if (haveCanvas()) {
    const tile = document.createElement('canvas');
    tile.width = 8;
    tile.height = 8;
    const g = tile.getContext('2d');
    g.fillStyle = colour;
    g.fillRect(1.5, 0.5, 5, 7);
    g.fillStyle = 'rgba(255, 240, 210, 0.18)';
    g.fillRect(1.5, 0.5, 5, 1); // the pane's top edge catches the amber sky
    pattern = ctx.createPattern(tile, 'repeat') || null;
  }
  patternCache.set(colour, pattern);
  return pattern;
}

// Per-building slab height and glass colour, computed once per building.
const skinCache = new WeakMap();
function skinFor(b) {
  let s = skinCache.get(b);
  if (s !== undefined) return s;
  s = { height: clamp(b.floors || 1, 1, 24) * FLOOR_H, colour: (b.windows && b.windows.colour) || C.glass };
  skinCache.set(b, s);
  return s;
}

// Hex shade: amount in -1..1, darker or lighter. Cached, since facades repeat tints.
const shadeCache = new Map();
function shade(hex, amount) {
  const key = hex + amount;
  const hit = shadeCache.get(key);
  if (hit !== undefined) return hit;
  let out = hex;
  if (typeof hex === 'string' && hex.length === 7 && hex[0] === '#') {
    out = '#';
    for (let i = 1; i < 7; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      const v = clamp(Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount), 0, 255);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
  }
  shadeCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  // cam is the eased follow point; view is the culled world rect for this frame.
  const cam = { x: 2688, y: 2688, zoom: 1, target: 1, ready: false };
  const view = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let shake = 0;
  let shakeClock = 0;
  let frame = 0;
  let cx = 2688; // city centre, refreshed per frame for the roof lean
  let cy = 2688;
  let vignette = null;
  const billboardLabels = new WeakMap();

  // Logical -> device: logical x dpr, CSS size letterboxed to the window aspect, dpr capped at 2.
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = Math.min((window.innerWidth || VIEW_W) / VIEW_W, (window.innerHeight || VIEW_H) / VIEW_H);
    const cssW = Math.max(1, Math.round(VIEW_W * s));
    const cssH = Math.max(1, Math.round(VIEW_H * s));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (canvas.style) {
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }
    vignette = null;
  }

  function buildVignette() {
    if (!ctx.createRadialGradient) return;
    const g = ctx.createRadialGradient(VIEW_W * 0.5, VIEW_H * 0.46, VIEW_H * 0.3, VIEW_W * 0.5, VIEW_H * 0.5, VIEW_H * 0.92);
    g.addColorStop(0, 'rgba(28, 18, 26, 0)');
    g.addColorStop(0.62, 'rgba(28, 18, 26, 0.06)');
    g.addColorStop(1, 'rgba(24, 14, 22, 0.42)');
    vignette = g;
  }

  // Follow the car if the player is in one, else the player. Exponential ease (dt-independent);
  // zoom follows speed through a smoothstep so a tap of throttle does not jump the scale.
  // Camera easing: the zoom follows speed (1.0 walking out to ~0.78 at full tilt).
  function updateCamera(state, dt) {
    const p = state.player || { x: 2688, y: 2688 };
    const car = p.car || null;
    const fx = car ? car.x : p.x;
    const fy = car ? car.y : p.y;
    const speed = car ? Math.abs(car.speed || 0) : Math.hypot(p.vx || 0, p.vy || 0);
    const max = car ? Math.max(60, car.maxSpeed || 420) : 260;
    const t = clamp(speed / max, 0, 1);
    cam.target = 1 - 0.22 * (t * t * (3 - 2 * t));
    if (!cam.ready) {
      cam.x = fx;
      cam.y = fy;
      cam.zoom = cam.target;
      cam.ready = true;
    } else {
      cam.x += (fx - cam.x) * (1 - Math.exp(-dt * 5.5));
      cam.y += (fy - cam.y) * (1 - Math.exp(-dt * 5.5));
      cam.zoom += (cam.target - cam.zoom) * (1 - Math.exp(-dt * 3.2));
    }
    // Clamp: never show past the map edges or below the water band.
    const size = state.city ? state.city.size : 5376;
    const worldH = state.city && state.city.water ? state.city.water.y + 160 : size;
    const hw = VIEW_W / (2 * cam.zoom);
    const hh = VIEW_H / (2 * cam.zoom);
    cam.x = hw * 2 >= size ? size * 0.5 : clamp(cam.x, hw, size - hw);
    cam.y = hh * 2 >= worldH ? worldH * 0.5 : clamp(cam.y, hh, worldH - hh);
    view.x0 = cam.x - hw - CULL_MARGIN;
    view.x1 = cam.x + hw + CULL_MARGIN;
    view.y0 = cam.y - hh - CULL_MARGIN;
    view.y1 = cam.y + hh + CULL_MARGIN;
  }

  const visible = (x, y, w, h) => x < view.x1 && x + w > view.x0 && y < view.y1 && y + h > view.y0;
  const visiblePoint = (x, y, r) => x + r > view.x0 && x - r < view.x1 && y + r > view.y0 && y - r < view.y1;

  // The camera transform. Paths are in world space, so the stroke width is the world width
  // divided by the zoom. Called after any pattern fill, which resets the transform.
  function resetTransform() {
    const k = cam.zoom;
    ctx.setTransform(k, 0, 0, k, VIEW_W * 0.5 - cam.x * k, VIEW_H * 0.5 - cam.y * k);
    ctx.lineWidth = 1 / k;
  }

  // -------------------------------------------------------------------------------------------
  // Sea and sand: wide world-space rects, so the band costs one fill per element.
  // -------------------------------------------------------------------------------------------
  function drawWaterAndBeach(state) {
    const waterY = state.city.water.y;
    const beachY = state.city.beach.y;
    const clock = state.clock || 0;
    const w = view.x1 - view.x0;
    if (view.y1 > waterY - 30) {
      const g = ctx.createLinearGradient ? ctx.createLinearGradient(0, waterY, 0, waterY + 520) : null;
      if (g) {
        g.addColorStop(0, C.waterShallow);
        g.addColorStop(0.18, C.waterMid);
        g.addColorStop(1, C.waterDeep);
        ctx.fillStyle = g;
      } else ctx.fillStyle = C.waterMid;
      ctx.fillRect(view.x0, waterY, w, view.y1 - waterY + 40);
      // Swell: broken strokes drifting south a few px a second, staggered row to row.
      const drift = (clock * 6) % 26;
      ctx.fillStyle = C.swell;
      for (let r = 0; r < 4; r += 1) {
        const y = (waterY + 24 + drift + r * 52) | 0;
        if (y < view.y0 || y > view.y1) continue;
        for (let x = view.x0 - (r % 2 ? 60 : 0) - 40; x < view.x1; x += 150) ctx.fillRect(x, y, 96, 3);
      }
      // Foam: a breathing band at the shoreline with a thin breakup line below it.
      const a = 0.55 + 0.25 * Math.sin(clock * 0.9);
      ctx.fillStyle = C.foam;
      ctx.globalAlpha = a;
      ctx.fillRect(view.x0, waterY - 6, w, 9);
      ctx.globalAlpha = a * 0.5;
      ctx.fillRect(view.x0, waterY + 10, w, 2);
      ctx.globalAlpha = 1;
    }
    if (view.y1 > beachY - 40) {
      ctx.fillStyle = C.sandWet;
      ctx.fillRect(view.x0, waterY - 26, w, 26);
      ctx.fillStyle = C.sand;
      ctx.fillRect(view.x0, beachY, w, waterY - 26 - beachY);
      // Dune streaks: stable in x, so the sand does not shimmer as the camera slides.
      ctx.fillStyle = C.dune;
      const x0 = view.x0;
      const y1 = Math.min(waterY - 34, view.y1);
      for (let x = x0 - (((x0 % 320) + 320) % 320); x < view.x1; x += 320) {
        const y = beachY + 30 + ((x >> 6) % 90);
        if (y > view.y0 && y < y1) ctx.fillRect(x, y, 40, 3);
      }
    }
  }

  // Dirt, then the dusty lots between buildings.
  function drawGround(state) {
    const top = Math.max(0, view.y0);
    const bottom = Math.min(state.city.beach.y, view.y1);
    if (top >= bottom) return;
    ctx.fillStyle = C.ground;
    ctx.fillRect(view.x0, top, view.x1 - view.x0, bottom - top);
    ctx.fillStyle = C.groundAlt;
    const blocks = state.city.blocks;
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      if (visible(b.x, b.y, b.w, b.h)) ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Roads: all asphalt, then lane dashes, then crosswalks, then pavements and kerbs. Each pass
  // runs once over the vertical lines and once over the horizontal ones; a pass gets the line's
  // centre, its half width and whether the line is horizontal, and draws if it crosses the view.
  function drawRoads(state) {
    const { roadsX, roadsY, size } = state.city;
    const beachY = state.city.beach.y;
    const y0 = Math.max(0, view.y0);
    const y1 = Math.min(beachY, view.y1);
    const x0 = Math.max(0, view.x0);
    const x1 = Math.min(size, view.x1);
    const vh = y1 - y0;
    const vw = x1 - x0;
    if (vh <= 0 || vw <= 0) return;

    // Road markings and kerbs are thin world-px strokes with no offscreen pattern. They ride the
    // world transform directly: an isometric scale is not a similarity, so it would break the
    // pattern and stroke widths. They go into one path per colour so the whole grid is one fill.
    ctx.save();
    resetTransform();
    const stroke = (sx, sy, w, h) => {
      for (let i = 0; i < roadsX.length; i += 1) {
        const x = roadsX[i];
        const hw = halfRoad(x);
        if (x + hw > view.x0 && x - hw < view.x1) sx(x, hw);
      }
      for (let j = 0; j < roadsY.length; j += 1) {
        const y = roadsY[j];
        const hw = halfRoad(y);
        if (y <= beachY + 4 && y + hw > view.y0 && y - hw < view.y1) sy(y, hw);
      }
    };
    const fillPath = (colour, sx, sy, w, h) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      stroke(sx, sy, w, h);
      ctx.fill();
    };
    // Lane dashes: a centre line on every road, plus lane dividers on avenues. Dashes every
    // DASH_LEN along the road, matched to the road's own axis.
    fillPath(C.line, (x, hw) => {
      for (let y = y0; y < y1; y += DASH_LEN * 2) ctx.rect(x - 1, y, 2, DASH_LEN);
      if (hw > STREET_W * 0.5 + 2) {
        for (let y = y0; y < y1; y += DASH_LEN * 2) {
          ctx.rect(x - hw * 0.5, y, 1.6, DASH_LEN);
          ctx.rect(x + hw * 0.5 - 1.6, y, 1.6, DASH_LEN);
        }
      }
    }, (y, hw) => {
      for (let x = x0; x < x1; x += DASH_LEN * 2) ctx.rect(x, y - 1, DASH_LEN, 2);
      if (hw > STREET_W * 0.5 + 2) {
        for (let x = x0; x < x1; x += DASH_LEN * 2) {
          ctx.rect(x, y - hw * 0.5, DASH_LEN, 1.6);
          ctx.rect(x, y + hw * 0.5 - 1.6, DASH_LEN, 1.6);
        }
      }
    });
    // Pavements and the bright kerb edge beside the carriageway.
    fillPath(C.walk, (x, hw) => {
      const e = hw + SIDEWALK;
      ctx.rect(x - e, y0, SIDEWALK, vh);
      ctx.rect(x + e - SIDEWALK, y0, SIDEWALK, vh);
    }, (y, hw) => {
      const e = hw + SIDEWALK;
      ctx.rect(x0, y - e, vw, SIDEWALK);
      ctx.rect(x0, y + e - SIDEWALK, vw, SIDEWALK);
    });
    fillPath(C.kerb, (x, hw) => {
      ctx.rect(x - hw - 1, y0, 1.5, vh);
      ctx.rect(x + hw - 0.5, y0, 1.5, vh);
    }, (y, hw) => {
      ctx.rect(x0, y - hw - 1, vw, 1.5);
      ctx.rect(x0, y + hw - 0.5, vw, 1.5);
    });
    ctx.restore();
    drawCrosswalks(state.city, beachY);
    resetTransform();
  }


  // Crosswalks just outside each approach to an intersection, spaced by that road's width.
  function drawCrosswalks(city, beachY) {
    const { roadsX, roadsY } = city;
    ctx.fillStyle = C.line;
    for (let i = 0; i < roadsX.length; i += 1) {
      const rx = roadsX[i];
      const hwx = halfRoad(rx);
      if (rx + AVENUE_W < view.x0 || rx - AVENUE_W > view.x1) continue;
      for (let j = 0; j < roadsY.length; j += 1) {
        const ry = roadsY[j];
        const hwy = halfRoad(ry);
        if (ry > beachY + 4 || ry + AVENUE_W < view.y0 || ry - AVENUE_W > view.y1) continue;
        const inX = hwx + 12;
        const inY = hwy + 12;
        const cols = Math.max(3, Math.floor((hwx * 2 - 8) / 16));
        const gapX = (hwx * 2 - 8) / cols;
        const rows = Math.max(3, Math.floor((hwy * 2 - 8) / 16));
        const gapY = (hwy * 2 - 8) / rows;
        // North and south: stripes run across the road, then a matching run away from it.
        for (let k = 0; k < cols; k += 1) {
          const sx = rx - hwx + 4 + k * gapX;
          const sw = Math.max(4, gapX * 0.55);
          ctx.fillRect(sx, ry - inY - 14, sw, 14);
          ctx.fillRect(sx, ry + inY, sw, 14);
        }
        // East and west: the same, rotated.
        for (let k = 0; k < rows; k += 1) {
          const sy = ry - hwy + 4 + k * gapY;
          const sh = Math.max(4, gapY * 0.55);
          ctx.fillRect(rx - inX - 14, sy, 14, sh);
          ctx.fillRect(rx + inX, sy, 14, sh);
        }
      }
    }
  }

  // Tyre marks: short segments appended by player.js, faded with age (capped there at 400).
  // Field names are not fixed by the contract, so both spellings are accepted.
  function drawMarks(state) {
    const marks = state.city.marks;
    if (!marks || marks.length === 0) return;
    ctx.lineCap = 'round';
    for (let i = 0; i < marks.length; i += 1) {
      const m = marks[i];
      const bx = m.x2 !== undefined ? m.x2 : m.ex;
      const by = m.y2 !== undefined ? m.y2 : m.ey;
      if (typeof m.x !== 'number' || typeof bx !== 'number') continue;
      if (Math.max(m.x, bx) < view.x0 || Math.min(m.x, bx) > view.x1) continue;
      if (Math.max(m.y, by) < view.y0 || Math.min(m.y, by) > view.y1) continue;
      const age = m.life !== undefined ? m.life : m.age !== undefined ? m.age : 1;
      ctx.strokeStyle = age < 0.5 ? C.tyreOld : C.tyre;
      ctx.lineWidth = (m.w !== undefined ? m.w : 5) / cam.zoom;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    resetTransform();
  }

  // One car shape for parked, traffic, police and the player's car. Local +x is the nose.
  // lights: 0 off, 1 police bar (blinks off frame), 2 tail lamps lit.
  function drawCar(x, y, w, h, angle, colour, kind, shadow, lights) {
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    if (shadow) {
      ctx.fillStyle = C.carShadow;
      ctx.fillRect(-w * 0.16, -h * 0.28, w, h);
    }
    // Tyres at the corners, then the body: lit top edge, dark lower half.
    ctx.lineWidth = 1 / cam.zoom;
    ctx.fillStyle = '#1b1c20';
    const tw = Math.max(3, w * 0.14);
    const th = Math.max(3, h * 0.16);
    ctx.fillRect(-w * 0.5, -h * 0.38, tw, th);
    ctx.fillRect(w * 0.5 - tw, -h * 0.38, tw, th);
    ctx.fillRect(-w * 0.5, h * 0.22, tw, th);
    ctx.fillRect(w * 0.5 - tw, h * 0.22, tw, th);
    ctx.fillStyle = colour || '#b8332c';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(-w * 0.5, -h * 0.5, w, h, Math.min(w, h) * 0.22);
      ctx.fill();
    } else ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(-w * 0.5 + 2, -h * 0.5 + 1, w - 4, h * 0.22);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.fillRect(-w * 0.5 + 2, h * 0.5 - h * 0.24, w - 4, h * 0.2);
    // Glass cabin, sized by kind so a van reads longer than a coupe, plus a sun smear.
    const cabin = kind === 'van' ? 0.58 : kind === 'wagon' ? 0.52 : kind === 'coupe' ? 0.38 : 0.46;
    ctx.fillStyle = C.glass;
    ctx.fillRect(-w * 0.34, -h * 0.5 + h * (0.5 - cabin * 0.5) * 0.6, w * 0.68, h * cabin * 0.7);
    ctx.fillStyle = 'rgba(255, 226, 180, 0.22)';
    ctx.fillRect(-w * 0.3, -h * 0.5 + h * 0.2, w * 0.6, 2);
    // Headlights at the nose, tail lamps at the back.
    ctx.fillStyle = '#fff3c8';
    ctx.fillRect(w * 0.5 - 2, -h * 0.5 + 3, 2, 3);
    ctx.fillRect(w * 0.5 - 2, h * 0.5 - 6, 2, 3);
    ctx.fillStyle = lights === 2 ? '#ff5a3c' : '#c8342c';
    ctx.fillRect(-w * 0.5, -h * 0.5 + 3, 2, 3);
    ctx.fillRect(-w * 0.5, h * 0.5 - 6, 2, 3);
    if (lights === 1) {
      // Police bar: red and blue halves swapping every 8 frames, glowing onto the road.
      const on = Math.floor(frame / 8) % 2 === 0;
      ctx.fillStyle = on ? C.policeRed : 'rgba(255, 64, 64, 0.18)';
      ctx.fillRect(-w * 0.22, -h * 0.34, w * 0.2, h * 0.68);
      ctx.fillStyle = on ? 'rgba(80, 130, 255, 0.18)' : C.policeBlue;
      ctx.fillRect(w * 0.02, -h * 0.34, w * 0.2, h * 0.68);
      ctx.fillStyle = on ? 'rgba(255, 80, 80, 0.10)' : 'rgba(90, 140, 255, 0.10)';
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(w, h) * 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Parked cars sit square to the kerb; traffic carries its own w/h for the axis it drives on.
  function drawParked(state) {
    const parked = state.city.parked;
    for (let i = 0; i < parked.length; i += 1) {
      const p = parked[i];
      if (!visiblePoint(p.x, p.y, 26)) continue;
      const tall = Math.abs(Math.sin(p.angle || 0)) > 0.5;
      drawCar(p.x, p.y, tall ? 18 : 34, tall ? 34 : 18, p.angle || 0, p.colour, p.kind, false, 0);
    }
  }

  // The goal: a gold diamond bobbing over a breathing halo.
  function drawMissionMarker(state) {
    const marker = state.missions && state.missions.marker;
    if (!marker || typeof marker.x !== 'number' || !visiblePoint(marker.x, marker.y, 60)) return;
    const pulse = 0.5 + 0.5 * Math.sin((state.clock || 0) * 3);
    ctx.save();
    ctx.translate(marker.x, marker.y);
    ctx.fillStyle = C.markerPulse;
    ctx.globalAlpha = 0.25 + pulse * 0.25;
    ctx.beginPath();
    ctx.arc(0, 0, 30 + pulse * 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.rotate(Math.PI / 4);
    const s = 13;
    const bob = pulse * 4;
    ctx.fillStyle = C.marker;
    ctx.fillRect(-s, -s + bob, s * 2, s * 2);
    ctx.fillStyle = 'rgba(255, 249, 220, 0.7)';
    ctx.fillRect(-s * 0.4, -s * 0.4 + bob, s * 0.8, s * 0.8);
    ctx.restore();
  }

  // -------------------------------------------------------------------------------------------
  // Buildings. Soft ground shadows for all first, then the slabs. The footprint is the base; the
  // roof is that rect slid away from the city centre, and the connecting strips are the walls.
  // -------------------------------------------------------------------------------------------
  // The building painter: each footprint's roof offsets toward the city centre by height * ROOF_SLIDE.
  function drawBuildings(state) {
    const buildings = state.city.buildings;
    ctx.fillStyle = C.shadow;
    for (let i = 0; i < buildings.length; i += 1) {
      const b = buildings[i];
      if (!visible(b.x - 80, b.y - 80, b.w + 260, b.h + 260)) continue;
      const h = skinFor(b).height;
      // East and south from the low sun, plus a little of the roof slide so the shadow reads as
      // falling away from the tower as well as across the ground.
      const sx = b.x + b.w * 0.5 > cx ? h * ROOF_SLIDE * 0.5 : -h * ROOF_SLIDE * 0.5;
      const sy = b.y + b.h * 0.5 > cy ? h * ROOF_SLIDE * 0.5 : -h * ROOF_SLIDE * 0.5;
      ctx.fillRect(b.x + h * SHADOW_X + sx, b.y + h * SHADOW_Y + sy, b.w, b.h);
    }
    for (let i = 0; i < buildings.length; i += 1) {
      const b = buildings[i];
      if (!visible(b.x - 100, b.y - 100, b.w + 280, b.h + 280)) continue;
      drawBuilding(b);
    }
  }

  function drawBuilding(b) {
    const skin = skinFor(b);
    const h = skin.height;
    // The slab leans toward the city centre, so the front face looks at the middle of town.
    const lx = b.x + b.w * 0.5 > cx ? -h * ROOF_SLIDE : h * ROOF_SLIDE;
    const ly = b.y + b.h * 0.5 > cy ? -h * ROOF_SLIDE : h * ROOF_SLIDE;
    const wall = b.tint;

    // Silhouette: footprint plus roof rect in one colour, so the walls fill the gap between them.
    ctx.fillStyle = C.sil;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillRect(b.x + lx, b.y + ly, b.w, b.h);
    // The two visible walls, the side one darker than the near one.
    const wx = lx > 0 ? b.x + b.w : b.x;
    quad(wx, b.y, wx + lx, b.y + ly, wx + lx, b.y + b.h + ly, wx, b.y + b.h, shade(wall, -0.22));
    const wy = ly > 0 ? b.y + b.h : b.y;
    quad(b.x, wy, b.x + b.w, wy, b.x + b.w + lx, wy + ly, b.x + lx, wy + ly, shade(wall, -0.34));

    // Roof slab, rimmed along its sun side.
    ctx.fillStyle = b.roofTint;
    ctx.fillRect(b.x + lx, b.y + ly, b.w, b.h);
    ctx.fillStyle = 'rgba(255, 236, 200, 0.35)';
    ctx.fillRect(b.x + lx, b.y + ly, b.w, 2);
    ctx.fillRect(b.x + lx, b.y + ly, 2, b.h);

    // Front face, then the window band as one patterned fill.
    ctx.fillStyle = wall;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const faceY = b.y + b.h * 0.16;
    const faceH = b.h * 0.72;
    if (h > 12) {
      const pattern = windowPattern(ctx, skin.colour);
      if (pattern) {
        // Tiles are 8 units wide, so lay them at cam.zoom / 8 to keep panes constant on screen.
        const k = cam.zoom / 8;
        ctx.save();
        ctx.setTransform(k, 0, 0, k, VIEW_W * 0.5 - cam.x * cam.zoom, VIEW_H * 0.5 - cam.y * cam.zoom);
        ctx.fillStyle = pattern;
        ctx.fillRect(b.x / k, faceY / k, b.w / k, faceH / k);
        ctx.restore();
      } else {
        // No canvas: a capped grid of glass rects instead of a pattern.
        ctx.fillStyle = skin.colour;
        const cols = Math.min(b.windows.cols, 10);
        const rows = Math.min(b.windows.rows, 9);
        const cw = b.w / cols;
        const ch = faceH / rows;
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) ctx.fillRect(b.x + c * cw + cw * 0.2, faceY + r * ch + ch * 0.2, cw * 0.6, ch * 0.55);
        }
      }
    }
    // Sunward edge and entrance.
    ctx.fillStyle = 'rgba(255, 240, 214, 0.28)';
    ctx.fillRect(b.x, b.y, 2, b.h);
    ctx.fillStyle = 'rgba(50, 40, 44, 0.55)';
    const dw = Math.min(10, b.w * 0.3);
    ctx.fillRect(b.x + b.w * 0.5 - dw * 0.5, b.y + b.h - 4, dw, 4);
    resetTransform();
  }

  function quad(ax, ay, bx2, by2, cx2, cy2, dx2, dy2, colour) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx2, by2);
    ctx.lineTo(cx2, cy2);
    ctx.lineTo(dx2, dy2);
    ctx.closePath();
    ctx.fill();
  }

  // -------------------------------------------------------------------------------------------
  // Lamps, palms, billboards.
  // -------------------------------------------------------------------------------------------
  function drawLamps(state) {
    const lamps = state.city.lamps;
    for (let i = 0; i < lamps.length; i += 1) {
      const l = lamps[i];
      if (!visiblePoint(l.x, l.y, 60)) continue;
      ctx.fillStyle = C.shadow;
      ctx.fillRect(l.x + 1, l.y + 6, 18, 2.5);
      ctx.fillStyle = C.lampGlow;
      ctx.beginPath();
      ctx.arc(l.x + 10, l.y + 8, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.lampPost;
      ctx.fillRect(l.x - 1.5, l.y - 3, 3, 12);
      ctx.fillStyle = C.lampCore;
      ctx.fillRect(l.x - 2.5, l.y - 5, 5, 4);
    }
  }

  function drawPalms(state) {
    const palms = state.city.palms;
    for (let i = 0; i < palms.length; i += 1) {
      const p = palms[i];
      const s = p.scale || 1;
      if (!visiblePoint(p.x, p.y, 70 * s)) continue;
      ctx.fillStyle = C.shadow;
      ctx.beginPath();
      ctx.ellipse(p.x + 26 * s, p.y + 16 * s, 34 * s, 9 * s, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.palmTrunk;
      ctx.fillRect(p.x - 2.5 * s, p.y - 20 * s, 5 * s, 22 * s);
      const topY = p.y - 22 * s;
      const len = 22 * s;
      for (let k = 0; k < 8; k += 1) {
        // A per-palm phase from x, so the crowns do not all point the same way.
        const a = (k / 8) * Math.PI * 2 + (p.x % 7) * 0.1;
        const dx = Math.cos(a) * len;
        const dy = Math.sin(a) * len * 0.6;
        ctx.strokeStyle = k % 2 === 0 ? C.palmMid : C.palmDark;
        ctx.lineWidth = (4 * s) / cam.zoom;
        ctx.beginPath();
        ctx.moveTo(p.x, topY);
        ctx.quadraticCurveTo(p.x + dx * 0.55, topY + dy * 0.55 - 4 * s, p.x + dx, topY + dy);
        ctx.stroke();
        if (dx < 0) {
          // Blades toward the sun catch a highlight near the tip.
          ctx.strokeStyle = C.palmLight;
          ctx.lineWidth = (2 * s) / cam.zoom;
          ctx.beginPath();
          ctx.moveTo(p.x + dx * 0.6, topY + dy * 0.6);
          ctx.lineTo(p.x + dx * 0.95, topY + dy * 0.95);
          ctx.stroke();
        }
      }
    }
    resetTransform();
  }

  function drawBillboards(state) {
    const boards = state.city.billboards;
    for (let i = 0; i < boards.length; i += 1) {
      const bb = boards[i];
      if (!visible(bb.x, bb.y, bb.w, bb.h)) continue;
      ctx.fillStyle = '#2f3033';
      ctx.fillRect(bb.x - 3, bb.y - 3, bb.w + 6, bb.h + 6);
      ctx.fillRect(bb.x + bb.w * 0.5 - 2, bb.y + bb.h, 4, 14);
      ctx.fillStyle = bb.bg || '#f7efe0';
      ctx.fillRect(bb.x, bb.y, bb.w, bb.h);
      // A diagonal sun glare across the poster.
      ctx.fillStyle = 'rgba(255, 236, 200, 0.22)';
      ctx.beginPath();
      ctx.moveTo(bb.x, bb.y + bb.h);
      ctx.lineTo(bb.x + bb.w * 0.55, bb.y);
      ctx.lineTo(bb.x + bb.w * 0.8, bb.y);
      ctx.lineTo(bb.x + bb.w * 0.25, bb.y + bb.h);
      ctx.closePath();
      ctx.fill();
      let label = billboardLabels.get(bb);
      if (label === undefined) billboardLabels.set(bb, (label = bb.brand || ''));
      ctx.fillStyle = bb.colour;
      ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bb.x + bb.w * 0.5, bb.y + bb.h * 0.5, bb.w - 6);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Agents: peds, traffic, police and officers, bullets, particles, then the player.
  // -------------------------------------------------------------------------------------------
  function drawPeds(state) {
    const peds = state.peds;
    if (!peds) return;
    for (let i = 0; i < peds.length; i += 1) {
      const p = peds[i];
      if (!visiblePoint(p.x, p.y, 20)) continue;
      const down = p.state === 'down';
      ctx.fillStyle = C.carShadow;
      ctx.fillRect(p.x - 5, p.y + 3, 10, 5);
      ctx.fillStyle = down ? '#8c8a86' : p.colour || '#c9a04a';
      ctx.fillRect(p.x - (down ? 7 : 4), p.y - (down ? 3.5 : 6.5), down ? 14 : 8, down ? 7 : 13);
      // Head, ahead along the facing; flat on the ground when down.
      ctx.fillStyle = C.pedSkin;
      const hx = p.x + Math.cos(p.angle || 0) * (down ? 4 : 1.5);
      const hy = p.y + Math.sin(p.angle || 0) * (down ? 2 : 1.5) - (down ? 0 : 5);
      ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
      if (p.state === 'flee') {
        ctx.fillStyle = 'rgba(255, 230, 160, 0.8)';
        ctx.fillRect(p.x - 1, p.y - 16, 2, 5);
      }
    }
  }

  function drawTraffic(state) {
    const cars = state.cars;
    if (!cars) return;
    for (let i = 0; i < cars.length; i += 1) {
      const c = cars[i];
      if (c.driver === 'player' || !visiblePoint(c.x, c.y, 40)) continue;
      // entities.js already sets w/h per axis; fall back to axis-derived sizes if absent.
      const v = c.axis === 'v';
      const w = c.w || (v ? 20 : 38);
      const h = c.h || (v ? 38 : 20);
      drawCar(c.x, c.y, w, h, c.angle || 0, c.colour, c.kind, true, 2);
    }
  }

  function drawPolice(state) {
    const police = state.police;
    if (!police) return;
    for (let i = 0; i < police.length; i += 1) {
      const cop = police[i];
      const car = cop.car;
      if (car && visiblePoint(car.x, car.y, 46)) {
        const v = car.axis === 'v';
        drawCar(car.x, car.y, v ? 20 : 38, v ? 38 : 20, car.angle || 0, '#1f2633', 'sedan', true, 1);
      }
      const off = cop.officer;
      if (off && cop.state === 'foot' && visiblePoint(off.x, off.y, 18)) {
        ctx.fillStyle = C.carShadow;
        ctx.fillRect(off.x - 5, off.y + 3, 10, 5);
        ctx.fillStyle = C.copBody;
        ctx.fillRect(off.x - 4, off.y - 7, 8, 13);
        ctx.fillStyle = 'rgba(90, 140, 255, 0.7)';
        ctx.fillRect(off.x - 4, off.y - 2, 8, 3);
        ctx.fillStyle = C.pedSkin;
        ctx.fillRect(off.x - 2.5, off.y - 11, 5, 5);
        if (off.hp > 0) {
          // The drawn sidearm, pointing along the officer's aim.
          ctx.strokeStyle = '#2a2a2e';
          ctx.lineWidth = 2 / cam.zoom;
          ctx.beginPath();
          ctx.moveTo(off.x, off.y - 2);
          ctx.lineTo(off.x + Math.cos(off.angle || 0) * 12, off.y + Math.sin(off.angle || 0) * 12);
          ctx.stroke();
        }
      }
    }
    // Light wash on the road: one additive disc per car, red or blue alternating with the bars.
    const on = Math.floor(frame / 8) % 2 === 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = on ? 'rgba(255, 60, 60, 0.07)' : 'rgba(70, 120, 255, 0.07)';
    for (let i = 0; i < police.length; i += 1) {
      const car = police[i].car;
      if (!car || !visiblePoint(car.x, car.y, 90)) continue;
      ctx.beginPath();
      ctx.arc(car.x, car.y, 78, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    resetTransform();
  }

  function drawBullets(state) {
    const bullets = state.bullets;
    if (!bullets) return;
    ctx.strokeStyle = C.bullet;
    ctx.lineWidth = 2 / cam.zoom;
    for (let i = 0; i < bullets.length; i += 1) {
      const b = bullets[i];
      if (!visiblePoint(b.x, b.y, 20)) continue;
      // A streak behind the round: 3% of its speed in px, capped at 18.
      const sp = Math.hypot(b.vx || 0, b.vy || 0) || 1;
      const len = Math.min(18, sp * 0.03);
      ctx.beginPath();
      ctx.moveTo(b.x - (b.vx / sp) * len, b.y - (b.vy / sp) * len);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawParticles(state) {
    const particles = state.particles;
    if (!particles) return;
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      if ((p.life !== undefined && p.life <= 0) || !visiblePoint(p.x, p.y, 12)) continue;
      const size = p.size !== undefined ? p.size : p.r !== undefined ? p.r : 4;
      ctx.fillStyle = PARTICLE_COLOURS.get(p.kind) || C.smoke;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // On foot: a small figure in an off-white jacket with a hat; a nose arm and gun when a pistol
  // is out. In a car: the car, with the body hidden.
  function drawPlayer(state) {
    const p = state.player;
    if (!p || p.dead) return;
    if (p.car) {
      const c = p.car;
      const v = c.axis ? c.axis === 'v' : Math.abs(Math.sin(c.angle || 0)) > 0.5;
      drawCar(c.x, c.y, v ? 20 : 38, v ? 38 : 20, c.angle || 0, c.colour, c.kind, true, 2);
      return;
    }
    if (!visiblePoint(p.x, p.y, 24)) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = C.carShadow;
    ctx.fillRect(4, 4, 12, 7); // shadow east from the low sun
    ctx.rotate(p.angle || 0);
    ctx.fillStyle = '#f4ede0';
    ctx.fillRect(-4, -5, 9, 10);
    ctx.fillStyle = '#cfc2a6';
    ctx.fillRect(-4, -5, 9, 2);
    ctx.fillStyle = '#f2e7cf';
    ctx.fillRect(-2, -3.5, 6, 7);
    ctx.fillStyle = '#e8dcc8';
    if (p.weapon === 'pistol') {
      ctx.fillRect(3, -1.2, 9, 2.4);
      ctx.fillStyle = '#2a2a2e';
      ctx.fillRect(11, -1.4, 6, 2.8);
    } else {
      ctx.fillRect(2, -4.5, 3, 2.4);
      ctx.fillRect(2, 2.1, 3, 2.4);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------------------------
  // Shake: sustained tremor from heat and low health plus one-off kicks from events, capped.
  // -------------------------------------------------------------------------------------------
  function updateShake(state, dt) {
    const p = state.player;
    let target = 0;
    if (p) {
      if (p.wanted > 0) target += Math.min(3, p.wanted) * 0.9;
      if (p.hp > 0 && p.hp < 30) target += 2.4;
    }
    const kick = state.shake || state.screenShake || 0;
    if (kick > shake) shake = kick;
    if (shake < target) shake = target;
    shake = shake < 0.01 ? 0 : shake * Math.exp(-dt * 6);
    shakeClock += dt;
  }

  // draw(): one frame, laying the layers down in the order fixed by the contract.
  function draw(state) {
    const dt = state.dt !== undefined ? state.dt : STEP;
    frame += 1;
    updateShake(state, dt);
    updateCamera(state, dt);
    if (state.city) cx = cy = state.city.size * 0.5;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.backdrop;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Logical space; the backing store is 1280x720 times the device ratio.
    const sx = canvas.width / VIEW_W;
    const sy = canvas.height / VIEW_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    // Shake is a small deterministic tremor in screen space, laid under the world.
    if (shake > 0) {
      const a = Math.min(SHAKE_MAX, shake);
      ctx.translate(Math.sin(shakeClock * 41) * a, Math.cos(shakeClock * 37) * a * 0.8);
    }
    resetTransform();
    ctx.fillStyle = C.ground;
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    drawWaterAndBeach(state);
    drawGround(state);
    drawRoads(state);
    drawMarks(state);
    drawParked(state);
    drawMissionMarker(state);
    drawBuildings(state);
    drawLamps(state);
    drawBillboards(state);
    drawPalms(state);
    drawPeds(state);
    drawTraffic(state);
    drawPolice(state);
    drawBullets(state);
    drawParticles(state);
    drawPlayer(state);
    // Warm wash over the finished world: sun-glow in the air, not a filter on one layer.
    ctx.fillStyle = WASH;
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);

    // Screen space: the vignette, then leave the context clean for the HUD.
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    if (!vignette) buildVignette();
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  resize();
  window.addEventListener('resize', resize);
  return { draw, resize };
}
