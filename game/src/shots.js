// The four frames behind ?shot=start|drive|chase|mission.
//
// A shot resets the state, then plays the real simulation forward for a fixed number of 1/60 s
// steps driven by a scripted input log, so the frame is what the game looks like after a few
// seconds of that scene. A log entry is {t, action}: '+key' / '-key' hold or release a key from
// then on, 'aim:x,y[,1]' lands the pointer (holding its button when the 1 is there), and any other
// action is tapped on the frame it falls due. Each scene puts the cast on real road lanes and
// writes the run's history (tyre marks, wrecks) into the city; everything follows from the seed.
//
// The fake input is the whole of input.js as player.js and missions.js read it. A step runs the
// modules in main.js's order, and stepFn sees each step's events, so a scene can react to them.
import { buildCity } from './city.js';
import { createPlayer, updatePlayer } from './player.js';
import {
  spawnTraffic, updateTraffic, spawnPeds, updatePeds, spawnPolice, updatePolice,
  updateBullets, spawnParticles, updateParticles,
} from './entities.js';
import { createMissions, updateMissions, currentObjective } from './missions.js';
import { createRng } from './rng.js';

const STEP = 1 / 60; // the run length unit: the simulation's fixed step, as main.js runs it
const AVENUE_PITCH = 7; // every 7th road line is a 96 px avenue, the rest 36 px streets
const LANE_KEEP = 0.3; // lane centre as a fraction of the carriageway half width
const DEFAULT_SEED = 1;
const FRAME_W = 1280;
const FRAME_H = 720;

const KEY = { up: 1, down: 2, left: 3, right: 4, run: 5, handbrake: 6 };
const ACT = { enter: 1, exit: 2, fire: 3, punch: 4, weapon1: 5, weapon2: 6, reload: 7, pause: 8, save: 9, interact: 10 };
const bit = (table, name) => (table[name] ? 1 << table[name] : 0);

/** A pointer well off the player, to aim with. */
function pointerFor(x, y, angle) {
  return { x: x + Math.cos(angle) * 440, y: y + Math.sin(angle) * 440 };
}

function createScript() {
  const state = {}; // the held-key map player.js reads (space is the handbrake)
  let held = 0; // bit mask over KEY, held from the step that set it until the step that clears it
  let edges = 0; // one-shot actions for this frame only
  let firing = false; // the pointer stays held down for the rest of the run
  let log = [];
  let at = 0;

  function apply(entry) {
    const a = entry.action;
    if (typeof a !== 'string') return;
    if (a.startsWith('aim:')) {
      const [x, y, down] = a.slice(4).split(',');
      Object.assign(input.mouse, { x: Number(x), y: Number(y) });
      firing = down === '1';
      edges |= bit(ACT, 'fire');
    } else if (a[0] === '+' || a[0] === '-') {
      const k = KEY[a.slice(1)];
      if (k === undefined) return;
      held = a[0] === '+' ? held | (1 << k) : held & ~(1 << k);
      state.space = (held & (1 << KEY.handbrake)) !== 0;
    } else {
      edges |= bit(ACT, a);
    }
  }

  const input = {
    state,
    /** -1..1 on each axis, normalised so a diagonal walk is not faster than a straight one. */
    axis() {
      const x = (held & (1 << KEY.right) ? 1 : 0) - (held & (1 << KEY.left) ? 1 : 0);
      const y = (held & (1 << KEY.down) ? 1 : 0) - (held & (1 << KEY.up) ? 1 : 0);
      const m = Math.hypot(x, y);
      return m > 1 ? { x: x / m, y: y / m } : { x, y };
    },
    run: () => (held & (1 << KEY.run)) !== 0,
    pressed: (action) => (edges & bit(ACT, action)) !== 0,
    endFrame() {},
    mouse: { x: FRAME_W * 0.62, y: FRAME_H * 0.34, down: false, clicked: false },
  };

  return {
    input,
    /** Apply every entry due by `now`. Held keys persist, so the log reads as one input, not events. */
    begin(now) {
      while (at < log.length && log[at].t <= now) apply(log[at++]);
      if (firing) {
        input.mouse.down = true;
        input.mouse.clicked = true;
      }
    },
    /** main.js clears the edge set once per step, and the pointer's click lasts that one step. */
    end() {
      edges = 0;
      input.mouse.clicked = false;
    },
    plan(entries) {
      log = entries.slice().sort((a, b) => a.t - b.t);
      at = 0;
      return this;
    },
    /** Let go of every held key: a scene that wants the player standing still mid-run. */
    release() {
      held = 0;
      state.space = false;
      return this;
    },
  };
}

// Lanes and actors: the only road-grid and car-shape knowledge these scenes need.
const halfWidth = (index) => (index % AVENUE_PITCH === 0 ? 48 : 18);

/** The index of the road line nearest v. ('h' lines run east-west, so they live in roadsY.) */
function lineNear(city, axis, v) {
  const roads = axis === 'h' ? city.roadsY : city.roadsX;
  let best = 1;
  for (let i = 1; i < roads.length - 1; i += 1) if (Math.abs(roads[i] - v) < Math.abs(roads[best] - v)) best = i;
  return best;
}

/** A point in the lane of road line `index` running `dir`, `along` px down it (keep right). */
function lane(city, axis, index, dir, along) {
  const roads = axis === 'h' ? city.roadsY : city.roadsX;
  const off = dir * Math.max(11, halfWidth(index) * LANE_KEEP);
  return axis === 'h' ? { x: along, y: roads[index] + off } : { x: roads[index] + off, y: along };
}

const angleFor = (axis, dir) => (axis === 'h' ? (dir > 0 ? 0 : Math.PI) : dir > 0 ? Math.PI / 2 : -Math.PI / 2);

/** A car stopped in a lane, with the fields entities.js and render.js read. */
function makeCar(city, axis, index, dir, along, kind, colour) {
  const p = lane(city, axis, index, dir, along);
  const long = axis === 'h';
  return {
    x: p.x, y: p.y, w: long ? 38 : 20, h: long ? 20 : 38, angle: angleFor(axis, dir),
    speed: 0, maxSpeed: 220, axis, dir, lane: index, line: long ? p.y : p.x, kind, colour,
    driver: 'ai', hp: 100, wrecked: false, smokeTimer: 0, brake: 0, stuck: 0,
    sinceTurn: 0, turnTimer: 99, nextLane: NaN,
  };
}

/** The player's coupé, already rolling. 290 px/s is 0.6 of its top speed. */
function playerCar(city, axis, index, dir, along, speed) {
  return Object.assign(makeCar(city, axis, index, dir, along, 'coupe', '#1b2a4a'),
    { driver: 'player', maxSpeed: 290, speed, drift: 0 });
}

/** A cruiser in the police's dark livery. */
function policeCar(city, axis, index, dir, along) {
  return Object.assign(makeCar(city, axis, index, dir, along, 'sedan', '#1f2633'),
    { driver: 'cop', maxSpeed: 310, hp: 160 });
}

/** The player on foot at (x, y), pistol in hand, magazine full. */
function standPlayer(player, x, y, angle) {
  Object.assign(player, {
    onFoot: true, car: null, x, y, angle, aim: angle, vx: 0, vy: 0, speed: 0, dead: false,
    invuln: 0, weapon: 'pistol', clip: 12, ammo: 72, fireCooldown: 0, punchCooldown: 0, reloading: 0,
  });
}

/** A police unit: the car, the pair in it or out on foot at `at` {x, y, angle, hp}, lights on. */
function policeUnit(car, at) {
  if (!at) return { car, officer: { x: car.x + 22, y: car.y - 14, hp: 80, angle: car.angle, fireTimer: 0.9, dead: false }, state: 'drive', lights: 1 };
  car.speed = 0;
  const hp = at.hp === undefined ? 80 : at.hp;
  return { car, officer: { x: at.x, y: at.y, angle: at.angle, hp, fireTimer: 0.2, dead: hp <= 0 }, state: 'foot', lights: 1 };
}

/** Two skid lines from `from` to `to` along y, `gap` px either side, inside city.js's cap of 400. */
function layTrail(city, from, to, y, gap) {
  for (let x = from; x < to; x += 24) {
    if (city.marks.length > 396) city.marks.splice(0, city.marks.length - 396);
    for (const dy of [-gap, gap]) city.marks.push({ x, y: y + dy, x2: x + 22, y2: y + dy, w: 5, life: 1 });
  }
}

/** (x, y) pushed clear of any building or the sea, ring by ring, for a body of 14 px. */
function clearSpot(city, x, y) {
  const solid = (px, py) => py + 14 >= city.water.y || city.buildings.some(
    (b) => px + 14 > b.x && px - 14 < b.x + b.w && py + 14 > b.y && py - 14 < b.y + b.h,
  );
  if (!solid(x, y)) return { x, y };
  for (let ring = 1; ring <= 6; ring += 1) {
    for (let k = 0; k < 12; k += 1) {
      const a = (k / 12) * Math.PI * 2;
      const nx = x + Math.cos(a) * ring * 20;
      const ny = y + Math.sin(a) * ring * 20;
      if (!solid(nx, ny)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

/** The frame's clock, seconds past 11:40, which the HUD reads as a late-afternoon hour. */
const CLOCK = 17 * 3600 + 52 * 60 - (11 * 3600 + 40 * 60);

/** One fixed step in main.js's order. Returns the events; calls state.stepFn with them. */
function simulate(state, script, now) {
  script.begin(now);
  state.clock += STEP;
  state.input = script.input;
  let events = updatePlayer(state.player, script.input, STEP, state);
  updateTraffic(state.cars, STEP, state.city, state.player, state.particles);
  updatePeds(state.peds, STEP, state.city, state.player, state.particles);
  updatePolice(state.police, STEP, state.city, state.player, state.bullets, state.particles);
  events |= updateBullets(state.bullets, STEP, state.city, state.player, state.peds, state.cars);
  updateParticles(state.particles, STEP);
  events |= updateMissions(state.missions, state, STEP);
  script.end();
  state.steps += 1;
  if (state.stepFn) state.stepFn(events);
  return events;
}

/** Play `seconds` of fixed steps. `after(i, events)` runs between steps and ends the run on false. */
function play(state, script, seconds, after) {
  const between = typeof after === 'function' ? after : () => true;
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    if (between(i, simulate(state, script, i * STEP)) === false) break;
  }
  return state;
}

// The scenes: each places the cast, then plays its log through the real rules.

/** Start: the title frame. The city runs five seconds on its own; the player stands at a junction. */
function stageStart(state) {
  const city = state.city;
  const line = lineNear(city, 'h', city.roadsY[26]);
  state.cars = spawnTraffic(city, state.rng, 46);
  state.peds = spawnPeds(city, state.rng, 64);
  const at = clearSpot(city, city.roadsX[21] + 14, city.roadsY[line] - 30);
  Object.assign(state.player, { x: at.x, y: at.y, angle: -Math.PI / 2, aim: -Math.PI / 2 });
  play(state, createScript().plan([]), 5);
  return { screen: 'title' };
}

/** Drive: the coupé at 0.6 of its top speed, two stars, a cruiser 300 px back, the first job live. */
function stageDrive(state) {
  const city = state.city;
  const avenue = 14;
  const line = lineNear(city, 'h', city.roadsY[26]);
  const start = city.roadsX[avenue] + 200;
  const car = playerCar(city, 'h', line, 1, start, 180);
  state.cars = spawnTraffic(city, state.rng, 44);
  state.cars.push(car);
  state.peds = spawnPeds(city, state.rng, 60);
  // The cruiser keeps station: it starts on the player's tail already at the speed that follows.
  const cruiser = Object.assign(policeCar(city, 'h', line, 1, start - 300), { speed: 172 });
  state.police = [policeUnit(cruiser)];
  const objective = currentObjective(state.missions);
  Object.assign(state.player, {
    onFoot: false, car, x: car.x, y: car.y, angle: car.angle, aim: car.angle,
    wanted: 2, wantedTimer: 12, money: 1250, hp: 92, armour: 18, weapon: 'fist',
    lastSafe: objective ? { x: objective.x, y: objective.y } : state.player.lastSafe,
  });
  layTrail(city, start - 640, start - 30, car.y, 7);
  // Held throttle with the cruise pinned during the opening steps: a rolling start at speed. A single
  // frame of left at 2.4 s is a real correction, small enough to stay in the lane.
  const script = createScript().plan([
    { t: 0, action: '+up' }, { t: 2.4, action: '+left' }, { t: 2.42, action: '-left' },
  ]);
  play(state, script, 3.0, (i) => {
    if (i < 2) car.speed = 250;
  });
  return { screen: 'play' };
}

/** Chase: four stars, the pistol out in a junction, three cruisers boxed in, two pairs shooting. */
function stageChase(state) {
  const city = state.city;
  const avenue = 14;
  const line = lineNear(city, 'h', city.roadsY[26]);
  const { x, y } = clearSpot(city, city.roadsX[avenue] + 16, city.roadsY[line] - 14);
  standPlayer(state.player, x, y, -Math.PI / 2);
  Object.assign(state.player, { wanted: 4, wantedTimer: 12, hp: 68, armour: 42, money: 3120 });
  state.peds = spawnPeds(city, state.rng, 56);
  state.cars = spawnTraffic(city, state.rng, 30);
  const north = Object.assign(policeCar(city, 'h', line, 1, x - 250), { wrecked: true, hp: 0, smokeTimer: 0.05 });
  const south = policeCar(city, 'h', line + 1, -1, x + 240);
  const east = Object.assign(policeCar(city, 'v', avenue, -1, y + 250), { hp: 40 });
  state.cars.push(north, south, east);
  state.police = [
    policeUnit(north, { x: x - 150, y: y - 52, angle: 0.28 }),
    policeUnit(south, { x: x + 160, y: y + 56, angle: Math.PI - 0.3 }),
    policeUnit(east, { x: x + 46, y: y + 140, angle: -Math.PI / 2, hp: 0 }),
  ];
  // The fight so far: rubber where the cars boxed in, brass on the tarmac, blood by the fallen cop.
  layTrail(city, x - 210, x - 120, y - 52, 5);
  spawnParticles(state.particles, x + 46, y + 140, 'blood0', 4);
  spawnParticles(state.particles, x - 150, y - 52, 'spark', 3);
  // The pointer holds the button down, so the pistol keeps firing for the whole run.
  const aim = pointerFor(x, y, Math.atan2(-52, -150));
  play(state, createScript().plan([{ t: 0, action: `aim:${Math.round(aim.x)},${Math.round(aim.y)},1` }]), 1.4);
  return { screen: 'play' };
}

/** Mission: the first marker at the pier front; the player walks up and Dex's opening page opens. */
function stageMission(state) {
  const city = state.city;
  state.peds = spawnPeds(city, state.rng, 52);
  state.cars = spawnTraffic(city, state.rng, 34);
  state.police = spawnPolice(city, state.rng, 6);
  const objective = currentObjective(state.missions);
  if (!objective) return { screen: 'play' };
  // Just outside the marker's reach, facing it: the walk up is what opens the box. The page opens the
  // frame after the player crosses into reach, so the shot runs the walk, then stands.
  const missionStage = state.missions.list[state.missions.index].stages[state.missions.stage];
  const start = clearSpot(city, objective.x, objective.y + (missionStage.reach || 74) + 34);
  standPlayer(state.player, start.x, start.y, -Math.PI / 2);
  Object.assign(state.player, { money: 860, weapon: 'fist', clip: 0, ammo: 0 });
  const script = createScript().plan([{ t: 0, action: '+up' }]);
  play(state, script, 2.2, (i, events) => {
    if (state.missions.dialogue) script.release(); // stand and talk, do not stride past Dex
    if (events & 128) return false; // EVENT_MISSION: a job closed under us
  });
  // The pointer rests just ahead of the player, inside the frame: the box is the subject here.
  const view = pointerFor(state.player.x, state.player.y, -Math.PI / 2 + 0.5);
  Object.assign(script.input.mouse, { x: view.x, y: view.y });
  return { screen: 'play' };
}

// The scene table: each scene resets the state before it stages its cast and script.
const SCENES = { start: stageStart, drive: stageDrive, chase: stageChase, mission: stageMission };

/** Stage the named scene (start, drive, chase or mission; anything else is start) on `state`, which
 * must carry the shared lists {city, player, cars, peds, police, bullets, particles} and may carry
 * `seed` and `audio`. Resets the state, plays the scene's scripted log through the real simulation
 * (calling `stepFn(events)` after every step), calls `renderFn()` once, and returns {screen, steps}.
 */
export function stageShot(name, state, stepFn, renderFn) {
  const stage = Object.prototype.hasOwnProperty.call(SCENES, name) ? SCENES[name] : stageStart;
  const seed = Number.isFinite(state.seed) ? state.seed | 0 : DEFAULT_SEED;
  const city = buildCity(seed);
  // A fresh city per shot, so tyre marks and wrecks never leak from one shot into the next.
  Object.assign(state, {
    city,
    player: createPlayer(city),
    cars: [], peds: [], police: [], bullets: [], particles: [],
    missions: createMissions(city),
    clock: CLOCK, screen: 'play', shake: 0, dt: STEP, steps: 0, camera: null,
    rng: createRng(seed * 7919 + 13),
    stepFn: typeof stepFn === 'function' ? stepFn : null,
    audio: state.audio || { play() {}, setEngine() {}, resume() {} },
  });
  const scene = stage(state) || {};
  state.screen = scene.screen || 'play';
  state.bannerTime = 1;
  if (typeof renderFn === 'function') renderFn();
  return { screen: state.screen, steps: state.steps };
}
