// Vice Fortuna: the four-mission story line and the cast who hand it out.
//
// Markers come from the city data, never a fixed seed: car markers sit in a lane beside their venue,
// walk markers are nudged onto real pavement, and both are pushed clear of buildings. A mission
// chains stages; holding the marker in the right pose ticks one, so a car passing through the ring
// is not a delivery. A stage may instead ask for work: `lose` is stars to shed, `thugs` a shootout.
//
// The HUD box is missions.dialogue, read through dialogue(). 'E' pages it; a stage never ticks
// while the box is open. updateMissions() returns EVENT_MISSION (128) only on a payout step.
import { EVENT_CRIME, EVENT_SHOT, EVENT_WASTED } from './player.js';
import { isSidewalk } from './city.js';

const MISSION_DONE = 128;
const REACH_DRIVE = 74; // px from the marker at which a car counts as parked there
const REACH_WALK = 40; // px on foot
const HOLD = 0.9; // seconds a marker must be held before it counts
const LINE_SECONDS = 3.4; // a dialogue page closes itself after this long
const LINE_TAPPED = 2.2; // a page the player has tapped through lives a little shorter
const SHOT_RANGE = 460; // gunfire this close to the marker answers the gunmen
const BODY_PAD = 13; // a body's half width, for the marker clearance test
const PISTOL_ROUNDS = 60; // rounds handed over at the Saltwind job
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// --- City queries ----------------------------------------------------------------------------
function nearestIndex(roads, v) {
  let best = 0;
  for (let i = 1; i < roads.length; i += 1) if (Math.abs(roads[i] - v) < Math.abs(roads[best] - v)) best = i;
  return best;
}

// The nearest avenue (an entry of avenuesX/avenuesY) to a coordinate.
function nearestAvenue(city, near) {
  const { roadsX, avenuesX } = city;
  let best = null;
  for (let i = 0; i < roadsX.length; i += 1) {
    if (avenuesX && avenuesX.size && !avenuesX.has(roadsX[i])) continue;
    if (best === null || Math.abs(roadsX[i] - near) < Math.abs(best - near)) best = roadsX[i];
  }
  return best === null ? roadsX[0] || 0 : best;
}

// True if a body of `radius` at (x, y) would be inside a building or the sea.
function solid(city, x, y, r) {
  if (y + r >= city.water.y) return true;
  const b = city.buildings || [];
  for (let i = 0; i < b.length; i += 1) {
    if (x + r > b[i].x && x - r < b[i].x + b[i].w && y + r > b[i].y && y - r < b[i].y + b[i].h) return true;
  }
  return false;
}

// The point moved along a widening ring until a body fits on it.
function clearSpot(city, x, y) {
  if (!solid(city, x, y, BODY_PAD)) return { x, y };
  for (let ring = 1; ring <= 6; ring += 1) {
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2, nx = x + Math.cos(a) * ring * 22, ny = y + Math.sin(a) * ring * 22;
      if (!solid(city, nx, ny, BODY_PAD)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

// A lane centre on the nearest road to (x, y), pushed into the lane on `side` (keep right).
function kerb(city, x, y, side) {
  const ix = nearestIndex(city.roadsX, x);
  const iy = nearestIndex(city.roadsY, y);
  const lane = (road, avenues) => clamp(side * ((avenues && avenues.has(road) ? 96 : 36) * 0.5) * 0.35, -42, 42);
  // Horizontal street closest: keep its y, take a lane either side of the centre. Else the same down.
  if (Math.abs(y - city.roadsY[iy]) <= Math.abs(x - city.roadsX[ix])) {
    return { x: clamp(x, 40, city.size - 40), y: city.roadsY[iy] - lane(city.roadsY[iy], city.avenuesY) };
  }
  return { x: city.roadsX[ix] + lane(city.roadsX[ix], city.avenuesX), y: clamp(y, 40, city.beach.y - 40) };
}

// A pull-in on the avenue beside a venue block, north or south of it (`side` = -1 or 1).
function kerbside(city, block, side) {
  const centre = block ? block.x + block.w * 0.5 : city.size * 0.5;
  const y = block ? (side > 0 ? block.y + block.h + 40 : block.y - 40) : city.size * 0.5;
  return kerb(city, nearestAvenue(city, centre), clamp(y, 60, city.beach.y - 60), side);
}
// A walkable marker: the point moved onto the nearest pavement within `reach`, never a wall. Where a

// region has no pavement at all (the beach road) the nearest lane is walkable ground too.
function walkSpot(city, x, y, reach = 70) {
  const start = clearSpot(city, x, y);
  if (isSidewalk(city, start.x, start.y)) return start;
  for (let d = 3; d <= reach; d += 3) {
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * Math.PI * 2, nx = start.x + Math.cos(a) * d, ny = start.y + Math.sin(a) * d;
      if (!solid(city, nx, ny, BODY_PAD) && isSidewalk(city, nx, ny)) return { x: nx, y: ny };
    }
  }
  const lane = kerb(city, start.x, start.y, 1);
  return clearSpot(city, lane.x, lane.y);
}

// The nearest block lot with room for a body: a stand-in for a named venue.
function blockAt(city, x, y) {
  let best = null;
  const blocks = city.blocks || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.w < BODY_PAD * 2 || b.h < BODY_PAD * 2 || b.y + b.h >= city.beach.y) continue;
    const gap = Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y);
    if (best === null || gap < best.gap) best = { block: b, gap };
  }
  return best && best.block;
}

// --- Cast: the HUD draws each portrait from shapes, so these are the colours it reads. ----------
const DEX = { name: 'Dex Marlow', portrait: 'dexter', coat: '#3b2b4f', skin: '#c98f63' };
const RUE = { name: 'Rue', portrait: 'rue', coat: '#4b6b3f', skin: '#8a5a3c' };
const COLE = { name: 'Inspector Vance Cole', portrait: 'cole', coat: '#1f2633', skin: '#d9a878' };

// --- Four jobs. Each stage is one objective; the last one pays. need: 'foot'|'car'|'any'. -----

// heat: stars the job puts on at stage start. give: a weapon handed over. lose: stars to shed.

// thugs: gunmen who must go down before the marker counts.
function buildMissions(city) {
  const size = city.size;
  // Venues ride on real block lots, so their markers sit on the pavement or kerb beside them.
  const at = (fx, fy) => blockAt(city, size * fx, size * fy);
  const beside = (block, dy) => walkSpot(city, block ? block.x + 8 : size * 0.5, block ? block.y + 8 + dy : size * 0.5);
  // The Coupé sits in the lane just south of its lot; everything else is a pavement beside a lot.
  const coupeBlock = at(0.5, 0.64) || { x: size * 0.5, y: size * 0.64, w: 0, h: 0 };
  const S = {
    pier: walkSpot(city, size * 0.5, city.beach.y - 70, 60),
    docks: kerbside(city, at(0.2, 0.78), -1), bayside: kerbside(city, at(0.3, 0.36), 1),
    coupe: kerb(city, coupeBlock.x, coupeBlock.y + coupeBlock.h + 30, 1),
    rue: beside(at(0.3, 0.44), 40), market: beside(at(0.66, 0.52), 40), wharf: beside(at(0.66, 0.6), 40),
    copstop: beside(at(0.22, 0.32), 30), saltwind: beside(at(0.82, 0.44), 40), east: beside(at(0.66, 0.42), 40),
  };
  const stage = (text, spot, need, extra) => Object.assign({ text, x: spot.x, y: spot.y, need }, extra);
  const line = (who, text) => ({ who, line: text });
  // The mission list: the jobs chain in order, each one opening only after the one before it closes.
  // The mission table: the jobs chain, each opening once the one before it is paid out.
  const list = [
    { id: 'pier', title: 'A favour for Dex', reward: 750,
      stages: [stage('Meet Dex Marlow on the pier front at the beach road', S.pier, 'any'), stage('Get in a car and drive to the docks in the south-west', S.docks, 'car')],
      meet: [line(DEX, 'So you are the new face. Dex Marlow. I fix things for people who do not ask questions.'), line(DEX, 'Two crates came in on the night boat, and somebody else wants them first.'), line(DEX, 'Keep a car running. The docks, south end, by the cranes. I will find you.')],
      arrive: [line(DEX, 'Not bad. Keep that car close.')],
      end: [line(DEX, 'Clean run. Seven-fifty now, and a bigger job if you can get through the week quietly.')] },
    { id: 'coupe', title: 'The Solva Coupé', reward: 1400,
      stages: [stage('Find Rue at the bayside lot and hear about the Coupé, on foot', S.rue, 'foot'),
        stage('Steal the Solva Coupé parked on the avenue by the lot', S.coupe, 'foot'),
        stage('Shake the police in the car: lose 2 clear stars', S.bayside, 'car', { lose: 2 })],
      meet: [line(RUE, 'Rue. I build what Dex drives and I patch what he breaks. You are the one lifting the Coupé.'), line(RUE, 'Solva red, plates six-seven. The wiring hides under the front wheel arch, so no keys.'), line(RUE, 'The owner pays for security patrols, so the police hear about the car before you do.')],
      arrive: [line(RUE, 'When the heat drops, bring it to the bayside lot. I will have it midnight blue by morning.')],
      end: [line(RUE, 'Not a scratch. Fourteen hundred, in a bag by the door.')] },
    { id: 'package', title: 'The package', reward: 2000,
      stages: [stage('Collect the package from the market stall on foot', S.market, 'foot'),
        stage('Carry it on foot to the wharf north of the market while the police respond', S.wharf, 'foot', { heat: 2 }),
        stage('Get clear of the police: lose 2 clear stars, in a car or on foot', S.copstop, 'any', { lose: 2 })],
      meet: [line(DEX, '(radio) Market stall, north side. Say "cold cola" and it will be in your hand before you blink.'), line(COLE, '(radio) This is Inspector Cole. Word is a package is moving through the market tonight.'), line(DEX, '(radio) Wharf, then lose them. Do not run, do not look up, do not stop.')],
      arrive: [line(DEX, '(radio) Take the long way round. The ladders at the wharf hide a lot more than they should.')],
      end: [line(DEX, '(radio) Two grand and the case still shut. Cole gets nervous around people who are good at this.')] },
    { id: 'saltwind', title: 'Saltwind warehouse', reward: 5000,
      stages: [stage('Take the pistol from Dex in the alley, then drive to the Saltwind warehouse', S.saltwind, 'any', { give: 'pistol', heat: 1 }),
        stage('Put down the three gunmen at the Saltwind lot, on foot', S.saltwind, 'foot', { thugs: 3 }),
        stage('Get clear of Saltwind: lose 1 clear star and reach the east avenue', S.east, 'any', { lose: 1 })],
      meet: [line(DEX, 'Cole keeps his ledgers at Saltwind, and those ledgers keep me awake. Tonight they go quiet.'), line(DEX, 'Take this. Safety is the little button. Try to remember which one is the trigger.'), line(COLE, 'Saltwind is mine, Marlow, and so is anybody who walks into that lot with a gun.')],
      arrive: [line(DEX, 'That is the last of them. Cole is two streets out, so lose the car and get clear.')],
      end: [line(DEX, 'Five thousand. The ledgers are ash and I am done owing anybody anything.'), line(DEX, 'If Cole comes for you, call Rue. If Rue is busy, call me. Die somewhere useful.'), line(COLE, '(radio) Your file just got longer, friend. Vice Fortuna remembers everybody.'),] },
  ];
  // Sit every marker on pavement or tarmac, clear of walls, and fix the radius its pose wants.
  for (const job of list) {
    for (const st of job.stages) {
      const spot = st.need === 'car' ? clearSpot(city, st.x, st.y) : walkSpot(city, st.x, st.y);
      st.x = spot.x, st.y = spot.y, st.reach = st.need === 'foot' ? REACH_WALK : REACH_DRIVE;
    }
    job.done = false, job.met = false;
  }
  return list;
}

export function createMissions(city) {
  const list = buildMissions(city);
  const first = list[0].stages[0];
  // banner/bannerTimer feed the HUD title card. Underscored fields are bookkeeping: queued dialogue,
  // marker hold, gunmen, stars shed, the star watch, job heat, gifts sent, counted events.
  return {
    list, index: 0, stage: 0, timer: 0, done: false, money: 0, city,
    marker: { x: first.x, y: first.y }, dialogue: null,
    banner: list[0].title, bannerTimer: 4,
    _queue: null, _hold: 0, _thugs: 0, _lost: 0, _wanted: 0, _armed: false, _hot: 0, _started: false, _pending: 0,
  };
}

// What to do next, and where. Null once every job is over.
export function currentObjective(missions) {
  const job = missions && !missions.done && missions.list[missions.index];
  if (!job) return null;
  const s = job.stages[Math.min(missions.stage, job.stages.length - 1)];
  return { text: s.text, x: s.x, y: s.y, mission: job.title };
}

// The open dialogue page, or null: {name, line, portrait} exactly as the HUD contract wants.
export function dialogue(missions) {
  const page = missions && missions.dialogue;
  return page ? { name: page.name, line: page.line, portrait: page.portrait } : null;
}

function showPage(missions, page) {
  const w = page.who;
  missions.dialogue = { name: w.name, line: page.line, portrait: w.portrait, coat: w.coat, skin: w.skin, timer: 0, tapped: false };
}

// Start a conversation, or hold the lines back until the open one is done.
function say(missions, lines) {
  if (!lines || !lines.length) return;
  if (missions.dialogue) missions._queue = (missions._queue || []).concat(lines);
  else showPage(missions, lines[0]), (missions._queue = lines.slice(1));
}

// Page forward, closing the box on the last page.
function nextPage(missions) {
  const queue = missions._queue;
  if (!queue || !queue.length) missions.dialogue = null, (missions._queue = null);
  else showPage(missions, queue[0]), (missions._queue = queue.slice(1));
}

function setMarker(missions, s) {
  missions.marker = { x: s.x, y: s.y };
  Object.assign(missions, { _hold: 0, _thugs: s.thugs || 0, _lost: 0, _wanted: 0, _armed: false, _hot: 0, _started: false });
}

// What a stage hands over the moment it starts: heat and a weapon.
function startStage(missions, job, s, player) {
  let events = 0;
  if (!player) return events;
  if (s.heat) {
    player.wanted = clamp(num(player.wanted, 0) + s.heat, 1, 5);
    player.wantedTimer = Math.max(num(player.wantedTimer, 0), 12);
    missions._hot = player.wanted, (events |= EVENT_CRIME);
  }
  if (s.give === 'pistol' && !job._handed) {
    job._handed = true, (player.weapon = 'pistol');
    player.ammo = Math.max(num(player.ammo, 0), PISTOL_ROUNDS);
  }
  return events;
}

function completeMission(missions, job, player) {
  job.done = true;
  if (player) {
    const reward = num(job.reward, 0);
    player.money = num(player.money, 0) + reward;
    missions.money += reward;
    // A closed job takes its own scripted stars with it.
    player.wanted = Math.max(0, num(player.wanted, 0) - Math.min(missions._hot, 2)), (player.wantedTimer = 0);
  }
  missions._hot = 0, missions.dialogue = null, missions._queue = null;
  say(missions, job.end);
  missions._pending += MISSION_DONE;
  missions.index += 1, missions.stage = 0;
  if (missions.index >= missions.list.length) {
    Object.assign(missions, { done: true, marker: null, banner: 'All four jobs are closed', bannerTimer: 6 });
    return;
  }
  const next = missions.list[missions.index];
  setMarker(missions, next.stages[0]);
  missions.banner = next.title, missions.bannerTimer = 4;
}

// Tick to the next stage, or pay the job out when this was its last.
function advanceStage(missions, s, player) {
  const job = missions.list[missions.index];
  missions.stage += 1;
  if (missions.stage >= job.stages.length) return completeMission(missions, job, player);
  setMarker(missions, job.stages[missions.stage]);
  if (s.arrive) say(missions, s.arrive);
}

function markerDistance(missions, player) {
  const m = missions.marker;
  return m && player ? Math.hypot(num(player.x, 0) - m.x, num(player.y, 0) - m.y) : Infinity;
}

const stars = (player) => clamp(Math.floor(num(player && player.wanted, 0)), 0, 5);

// The star watch for a "lose N" stage: count stars as they drop, once the player is on the road.
function watchStars(missions, s, player) {
  const now = stars(player);
  if (!missions._armed) {
    if (player.onFoot) return false; // the job's chase belongs to the road
    missions._armed = true, missions._lost = 0;
  }
  if (now < missions._wanted) missions._lost += missions._wanted - now;
  else if (now > missions._wanted) missions._lost = Math.max(0, missions._lost - (now - missions._wanted));
  missions._wanted = now;
  return missions._lost >= s.lose;
}

// One stage's rules: returns the events caused and ticks the stage when it is met.
function checkStage(missions, s, events, player, dt) {
  if (!player || player.dead) return (missions._hold = 0), events;
  const quiet = !missions.dialogue, dist = markerDistance(missions, player);
  if (s.lose) {
    if (!watchStars(missions, s, player) || !quiet) return events;
    // Clear only once the chase is off, or the player has come back to the marker.
    if (stars(player) > 1 && dist > s.reach) return events;
    return advanceStage(missions, s, player), events;
  }
  if (s.thugs) {
    if ((events & EVENT_SHOT) && dist < SHOT_RANGE) {
      missions._thugs = Math.max(0, missions._thugs - 1), (missions._hot = Math.max(missions._hot, stars(player)));
    }
    if (missions._thugs <= 0 && quiet && dist <= s.reach) advanceStage(missions, s, player);
    return events;
  }
  const poseOk = s.need === 'car' ? !player.onFoot : s.need === 'foot' ? !!player.onFoot : true;
  if (!(dist <= s.reach && poseOk) || !quiet) return (missions._hold = 0), events;
  // Hold the marker for a beat, so a car passing through the ring is not a delivery.
  missions._hold += dt;
  if (missions._hold >= HOLD) missions._hold = 0, advanceStage(missions, s, player);
  return events;
}

export function updateMissions(missions, state, dt) {
  if (!missions) return 0;
  state = state || {};
  const player = state.player || null, step = num(dt, 0) > 0 ? dt : 1 / 60;
  missions.timer += step;
  let events = missions._pending; // counted events from the step before, if the caller skipped us
  missions._pending = 0;
  if (missions.bannerTimer > 0) missions.bannerTimer = Math.max(0, missions.bannerTimer - step);
  // The box: 'E' pages it, and each page also closes on a timer of its own.
  const page = missions.dialogue;
  if (page) {
    page.timer += step;
    const tap = state.input && typeof state.input.pressed === 'function' && state.input.pressed('interact');
    if (tap) page.tapped = true, nextPage(missions);
    else if (page.timer > (page.tapped ? LINE_TAPPED : LINE_SECONDS)) nextPage(missions);
  }
  if (missions.done || !missions.list[missions.index]) return (missions.dialogue = null), events;
  const job = missions.list[missions.index];
  const s = job.stages[Math.min(missions.stage, job.stages.length - 1)];
  if (!missions.marker || !Number.isFinite(missions.marker.x)) missions.marker = { x: s.x, y: s.y };
  // Stage gifts once per stage, whether it was reached by walking or by a fresh load.
  if (!missions._started) missions._started = true, (events |= startStage(missions, job, s, player));
  // Each job opens with its handler's lines, the first time the player walks up to them.
  if (!job.met && !missions.dialogue && markerDistance(missions, player) <= s.reach) job.met = true, say(missions, job.meet);
  events |= checkStage(missions, s, events, player, step);
  // A wipe resets the gunfight, so a reloaded run never starts three gunmen down.
  if ((events & EVENT_WASTED) && player && player.dead) Object.assign(missions, { _thugs: s.thugs || 0, _lost: 0, _hold: 0 });
  events |= missions._pending, (missions._pending = 0);
  return events;
}
