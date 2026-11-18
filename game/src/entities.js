// Vice Fortuna: everything on the street that is not the player.
//
// Traffic, peds, the police and their officers, bullets, and a fixed pool of particles. Same shape
// as player.js: one fixed step in, a set of EVENT_* bits out, so main.js owns sound and screens.
// From city.js only the spatial queries and the road grid are used.
//
// Traffic keeps a lane: each car runs along one road centre line at a fixed offset to one side of
// it (keep right), brakes for whatever is ahead in that lane - the car in front, the player on
// foot, the player's car - and now and then turns at a junction. Cars are recycled off-screen into
// a lane the player cannot see, and are never dropped inside a building.
//
// Peds walk a pavement along a block face, cross the carriageway at junctions, and scatter from
// gunfire and from a car bearing down on them.
//
// Police spawn off-screen around the player and close in; from two stars up the officers bail out
// and shoot. Bullets are pooled records the caller owns (cap 120). Particles are one fixed pool of
// 400, kinds smoke, spark, dust and blood0.
//
// Determinism: the spawn* functions use only the rng passed in, so a seed always builds the same
// world. The updates also need dice - which junction a car turns at, when an officer fires - and
// take them from a seeded stream created at the first spawn, so a fixed seed and the same inputs
// replay step for step.
import { blocked, onRoad } from './city.js';
import { hurt, EVENT_CRIME, EVENT_WASTED } from './player.js';

const CELL = 96;
const BEACH_Y = 4512; // north edge of the sand: nothing walks or drives south of it
const CAR_LONG = 38;
const CAR_SHORT = 20;
const BULLET_CAP = 120;
// The particle pool: PARTICLE_POOL fixed records, reused in place, so it never grows.
const PARTICLE_POOL = 400;

const COP_SHOTS_AT = 2; // stars at which officers leave the car and open fire
const COP_DISMOUNT = 230; // px at which a pair bails out of a slowed car
const COP_SHOOT_RANGE = 430;
const COP_DAMAGE = 9;
const COP_SPEED = 760;
const COP_MAX = 310;
const COP_ACCEL = 340;
const PLAYER_HIT = 11;
const PED_HIT = 9;

// ---------------------------------------------------------------------------------------------
// Randomness: one stream, seeded from the first spawn call and advanced every step, so the
// updates are as repeatable as the spawning.
// ---------------------------------------------------------------------------------------------
let stream = 0x9e3779b9;

function rand() {
  stream = (stream + 0x6d2b79f5) | 0;
  let t = Math.imul(stream ^ (stream >>> 15), 1 | stream);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const between = (min, max) => min + rand() * (max - min);
const randInt = (min, max) => Math.floor(min + rand() * (max - min + 0.999));
const stepRng = { next: rand, range: between, int: randInt, pick: (list) => list[Math.floor(rand() * list.length)] };

// Reseed from a caller's generator so the spawn and the run share one deterministic sequence.
function seedStream(rng) {
  if (rng && typeof rng.next === 'function') stream = ((rng.next() * 4294967296) | 0) || 1;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function turnToward(from, to, rate, dt) {
  const gap = wrapAngle(to - from);
  const step = rate * dt;
  if (gap > step) return from + step;
  if (gap < -step) return from - step;
  return from + gap;
}

// Carriageway half width per road line: every 7th line is a 96 px avenue, the rest 36 px streets.
const halfWidth = (index) => (index % 7 === 0 ? 48 : 18);
// Distance from a lane centre to one side of it: the drivers keep right, so a car travelling
// east is a little south of the line and one travelling north a little east of it. The offset has
// to clear half a car plus a margin on the narrowest street (36 px, i.e. 18 px either side of the
// line), or the two directions' lanes overlap and cars meet head-on in the same lane.
const laneOffset = (axis, dir, hw) => (axis === 'h' ? dir * Math.max(11, hw * 0.42) : -dir * Math.max(11, hw * 0.42));
const angleFor = (axis, dir) => (axis === 'h' ? (dir > 0 ? 0 : Math.PI) : dir > 0 ? Math.PI / 2 : -Math.PI / 2);
const roadsFor = (city, axis) => (axis === 'h' ? city.roadsY : city.roadsX);

// ---------------------------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------------------------
const CAR_COLOURS = ['#b8332c', '#2c6fa8', '#d5a02c', '#e8e3d6', '#3a4b3f', '#7c4a8f', '#c46a2a', '#22262b', '#1f6f6a'];
const CAR_KINDS = ['sedan', 'sedan', 'sedan', 'coupe', 'wagon', 'van'];

// Point a car down a lane: `line` is the road centre, `lane` its index, and the car sits at
// line + laneOffset. Everything else is reset so a recycled car cannot keep stale state.
function setLane(car, axis, dir, line, index) {
  const hw = halfWidth(index);
  car.axis = axis;
  car.dir = dir;
  car.lane = index;
  car.line = line + laneOffset(axis, dir, hw);
  car.angle = angleFor(axis, dir);
  car.w = axis === 'h' ? CAR_LONG : CAR_SHORT;
  car.h = axis === 'h' ? CAR_SHORT : CAR_LONG;
  car.nextLane = NaN; // crossing road line of an armed turn
  car.turnTimer = between(2.0, 5.0);
}

function newCar(rng) {
  const avenue = rand() < 0.3;
  return {
    x: 0, y: 0, w: CAR_LONG, h: CAR_SHORT, angle: 0, speed: 0,
    maxSpeed: avenue ? between(175, 245) : between(115, 165),
    axis: 'h', dir: 1, lane: 0,
    kind: list(rng, CAR_KINDS), colour: list(rng, CAR_COLOURS),
    driver: 'ai', hp: 100,
    line: 0, nextLane: NaN, turnTimer: 2, sinceTurn: 0, brake: 0, stuck: 0, wrecked: false, smokeTimer: 0,
  };
}

// Prefer the caller's rng, fall back to the stream.
function list(rng, items) {
  if (rng && typeof rng.pick === 'function') return rng.pick(items);
  return items[Math.floor(rand() * items.length)];
}

function num(rng, min, max) {
  if (rng && typeof rng.range === 'function') return rng.range(min, max);
  return between(min, max);
}

function roll(rng) {
  if (rng && typeof rng.next === 'function') return rng.next();
  return rand();
}

// Drop a car into a clear lane near (x, y) running on `axis`. Tries successive lanes either side
// of the nearest one; failing that, turns it onto the nearest crossing road.
function placeOnRoad(car, city, rng, x, y, axis, spread) {
  const roads = roadsFor(city, axis);
  const base = clamp(Math.round((axis === 'h' ? y : x) / CELL), 1, roads.length - 2);
  for (let k = 0; k < 10; k += 1) {
    const index = clamp(base + (k === 0 ? 0 : k % 2 ? k : -k), 1, roads.length - 2);
    if (roads[index] > BEACH_Y) continue;
    const dir = roll(rng) < 0.5 ? 1 : -1;
    const along = clamp((axis === 'h' ? x : y) + num(rng, -spread, spread), CELL, city.size - CELL);
    const off = laneOffset(axis, dir, halfWidth(index));
    const px = axis === 'h' ? along : roads[index] + off;
    const py = axis === 'h' ? roads[index] + off : Math.min(along, BEACH_Y - CELL);
    if (blocked(city, px, py, 15) || !onRoad(city, px, py)) continue;
    setLane(car, axis, dir, roads[index], index);
    car.x = px;
    car.y = py;
    car.speed = car.maxSpeed * num(rng, 0.25, 0.6);
    return car;
  }
  const other = axis === 'h' ? 'v' : 'h';
  const cross = roadsFor(city, other);
  const ci = clamp(Math.round((axis === 'h' ? x : y) / CELL), 1, cross.length - 2);
  setLane(car, other, 1, cross[ci], ci);
  if (other === 'v') {
    car.x = cross[ci];
    car.y = clamp(y, CELL, BEACH_Y - CELL);
  } else {
    car.y = cross[ci];
    car.x = clamp(x, CELL, city.size - CELL);
  }
  car.speed = 0;
  return car;
}

export function spawnTraffic(city, rng, count = 40) {
  const cars = [];
  if (!city) return cars;
  seedStream(rng);
  for (let i = 0; i < count; i += 1) {
    const car = newCar(rng);
    // Spread the opening grid over the whole map, off the sand.
    const px = num(rng, CELL * 2, city.size - CELL * 2);
    const py = num(rng, CELL * 2, BEACH_Y - CELL * 2);
    placeOnRoad(car, city, rng, px, py, roll(rng) < 0.5 ? 'h' : 'v', CELL * 2);
    cars.push(car);
  }
  return cars;
}

// The nearest obstruction ahead in this car's lane, in px (Infinity when clear). Only things
// really in the lane count: same-line cars, cars crossing at a junction, and the player.
// `speedAhead` comes back as the speed of the closest thing, or -1 for the player, so a stopped
// queue can creep forward instead of freezing at a stopping distance wider than its own gap.
function gapAhead(car, cars, player) {
  const along = car.axis === 'h' ? car.x : car.y;
  const across = car.axis === 'h' ? car.y : car.x;
  const centre = car.line - laneOffset(car.axis, car.dir, halfWidth(car.lane));
  const reach = 175 + Math.abs(car.speed) * 0.6;
  let gap = Infinity;
  let speedAhead = 0;
  const consider = (ox, oy, span, speed) => {
    const delta = ((car.axis === 'h' ? ox : oy) - along) * car.dir;
    if (delta <= 0 || delta > reach) return;
    if (Math.abs((car.axis === 'h' ? oy : ox) - across) > CAR_SHORT * 0.5 + span) return;
    if (delta < gap) {
      gap = delta;
      speedAhead = speed;
    }
  };
  for (let i = 0; i < cars.length; i += 1) {
    const other = cars[i];
    if (!other || other === car || other.wrecked) continue;
    if (other.axis === car.axis) {
      if (Math.abs(other.line - centre) > CAR_SHORT * 0.7) continue;
      consider(other.x, other.y, CAR_SHORT * 0.55, other.speed);
    } else {
      consider(other.x, other.y, CAR_SHORT * 0.6, other.speed);
    }
  }
  if (player && !player.dead) {
    if (player.car && player.car !== car) consider(player.car.x, player.car.y, CAR_SHORT * 0.7, -1);
    else if (!player.car) consider(player.x, player.y, 14, -1);
  }
  return { gap, speedAhead };
}

const wallAhead = (car, city) => blocked(
  city,
  car.x + Math.cos(car.angle) * (CAR_LONG * 0.5 + 8),
  car.y + Math.sin(car.angle) * (CAR_LONG * 0.5 + 8),
  2,
);

// Arm a turn at the next junction, or keep going straight for a while longer. A car that has just
// turned must cover a couple of cells before it may turn again, so it cannot oscillate on the
// spot at one intersection.
function planTurn(car, city, dt) {
  car.turnTimer -= dt;
  car.sinceTurn = (car.sinceTurn || 0) + Math.abs(car.speed) * dt;
  // Not eligible yet: leave the timer alone so the next chance comes when it is due, not every
  // frame (a stale negative timer would re-roll the dice on every step).
  if (car.turnTimer > 0) return;
  if (car.sinceTurn < CELL * 2) {
    car.turnTimer = 0.5;
    return;
  }
  car.turnTimer = between(2.4, 6.0);
  car.nextLane = NaN;
  if (rand() > 0.22) return;
  const cross = roadsFor(city, car.axis === 'h' ? 'v' : 'h');
  const index = Math.round(((car.axis === 'h' ? car.x : car.y) + car.dir * CELL) / CELL);
  if (index <= 0 || index >= cross.length - 1 || cross[index] > BEACH_Y) return;
  car.nextLane = index;
  car.nextDir = rand() < 0.5 ? 1 : -1;
}

// Take the armed turn: the car keeps its spot and heads down the crossing lane.
function takeTurn(car, city) {
  const axis = car.axis === 'h' ? 'v' : 'h';
  const speed = car.speed;
  setLane(car, axis, car.nextDir, roadsFor(city, axis)[car.nextLane], car.nextLane);
  if (axis === 'h') car.y = car.line;
  else car.x = car.line;
  car.speed = speed * 0.72; // the corner costs a little
  car.sinceTurn = 0;
  car.turnTimer = between(2.4, 6.0); // and no second turn at this same junction
}

// Put a car back into a lane a screen away from the player, so it never pops into view, then
// fall back to any clear lane if that spot happens to be inside a building.
function recycle(car, city, player) {
  const px = clamp(player ? player.x : city.size * 0.5, 0, city.size);
  const py = clamp(player ? player.y : city.size * 0.5, 0, city.size);
  const axis = rand() < 0.5 ? 'h' : 'v';
  const roads = roadsFor(city, axis);
  const cross = roadsFor(city, axis === 'h' ? 'v' : 'h');
  // Aim a screen away from the player along the road, from the middle of the map outward: near
  // the map edge the clamp below would otherwise park the car on the same outer line every time
  // and it would be recycled again on the very next step.
  const farSide = () => (rand() < 0.5 ? -1 : 1);
  const alongI = clamp(
    Math.round((axis === 'h' ? px : py) / CELL) + farSide() * (10 + randInt(0, 6)),
    4,
    cross.length - 5,
  );
  const acrossI = clamp(Math.round((axis === 'h' ? py : px) / CELL) + randInt(-5, 5), 4, roads.length - 5);
  // A car that never gets a distinct lane from the edge clamp would be recycled in place; if the
  // clamp bound, take any interior lane instead.
  const acrossFinal = acrossI === 4 || acrossI === roads.length - 5 ? randInt(4, roads.length - 5) : acrossI;
  setLane(car, axis, rand() < 0.5 ? 1 : -1, roads[acrossFinal], acrossFinal);
  // Snap onto the new lane on both axes, and place it mid-cell rather than on the junction line,
  // so it is not standing in the middle of an intersection.
  const mid = cross[alongI] + (rand() < 0.5 ? -CELL * 0.35 : CELL * 0.35);
  if (axis === 'h') {
    car.x = mid;
    car.y = car.line;
  } else {
    car.y = Math.min(mid, BEACH_Y - CELL);
    car.x = car.line;
  }
  car.wrecked = false;
  car.hp = 100;
  car.speed = car.maxSpeed * 0.4;
  car.stuck = 0;
  car.brake = 0;
  if (blocked(city, car.x, car.y, 16) || !onRoad(city, car.x, car.y)) placeOnRoad(car, city, stepRng, px, py, axis, CELL * 6);
}

export function updateTraffic(cars, dt, city, player, particles) {
  if (!cars || !city || !(dt > 0)) return 0;
  // Where the player is, clamped into the map: a caller that hands over a player far off the
  // edge (a stray spawn, a test harness) must not make every car recycle on every step.
  const px = clamp(player ? player.x : city.size * 0.5, 0, city.size);
  const py = clamp(player ? player.y : city.size * 0.5, 0, city.size);

  for (let i = 0; i < cars.length; i += 1) {
    const car = cars[i];
    if (!car) continue;
    // Not ours to drive: the player's car, or a police car owned by updatePolice.
    if (car.driver === 'player' || car.driver === 'cop') continue;

    // Wrecks smoke and sit dead until they are recycled far off-screen.
    if (car.wrecked || car.hp <= 0) {
      car.wrecked = true;
      car.hp = 0;
      car.speed = 0;
      car.smokeTimer -= dt;
      if (car.smokeTimer <= 0 && particles) {
        car.smokeTimer = between(0.14, 0.4);
        spawnParticles(particles, car.x, car.y - 4, 'smoke', 2);
        if (rand() < 0.4) spawnParticles(particles, car.x, car.y, 'spark', 1);
      }
      if (Math.abs(car.x - px) > 2200 && Math.abs(car.y - py) > 2200) recycle(car, city, player);
      continue;
    }

    if (Math.abs(car.x - px) > 3200 && Math.abs(car.y - py) > 3200) {
      recycle(car, city, player);
      continue;
    }

    // Throttle or brake: keep a car's length and a bit clear of whoever is ahead. A car following
    // another that is itself stopped only inches forward, which keeps a queue alive: a stopping
    // distance wider than the gap that actually formed would otherwise freeze both cars forever.
    const { gap, speedAhead } = gapAhead(car, cars, player);
    const wall = wallAhead(car, city);
    const held = speedAhead >= 0 && speedAhead < 8;
    const stopGap = (held ? CAR_LONG * 0.7 : CAR_LONG + 6) + Math.abs(car.speed) * 0.12;
    let target = car.maxSpeed;
    if (wall || gap < stopGap) {
      target = held && gap > CAR_LONG * 0.55 ? 45 : 0;
      car.brake = Math.min(1, car.brake + dt * 4);
    } else if (gap < stopGap + 90) {
      target = Math.max(45, car.maxSpeed * clamp((gap - stopGap) / 90, 0.12, 1));
      car.brake = Math.min(1, car.brake + dt * 2.2);
    } else {
      car.brake = Math.max(0, car.brake - dt * 2.2);
    }
    if (car.speed < target) car.speed = Math.min(target, car.speed + 90 * dt);
    else car.speed = Math.max(target, car.speed - 320 * dt);
    if (car.speed < 0) car.speed = 0;

    // Held up for a while with clear road behind: sidestep into the next lane.
    if (car.speed < 5 && (wall || gap < stopGap)) {
      car.stuck += dt;
      if (car.stuck > 2.5 && gap > 140) {
        car.stuck = 0;
        const roads = roadsFor(city, car.axis);
        const index = clamp(car.lane + (rand() < 0.5 ? -1 : 1), 1, roads.length - 2);
        const px = car.axis === 'h' ? car.x : roads[index];
        const py = car.axis === 'h' ? roads[index] : car.y;
        if (!blocked(city, px, py, 16)) {
          setLane(car, car.axis, car.dir, roads[index], index); // resets any armed turn
          if (car.axis === 'h') car.y = car.line;
          else car.x = car.line;
        }
      }
    } else {
      car.stuck = 0;
    }

    // Junctions: arm a turn on approach, take it inside the junction box. The car must still be
    // approaching the junction it armed (delta > 0), or a car sitting on the line it just turned
    // onto would turn again immediately and flip axis on every step.
    planTurn(car, city, dt);
    if (!Number.isNaN(car.nextLane)) {
      const delta = (roadsFor(city, car.axis === 'h' ? 'v' : 'h')[car.nextLane] - (car.axis === 'h' ? car.x : car.y)) * car.dir;
      if (delta > 0 && delta < CELL * 0.5) takeTurn(car, city);
      else if (delta <= 0) car.nextLane = NaN; // already past it
    }

    // Ease back onto the lane centre so a corner reads as a curve.
    const want = car.line - (car.axis === 'h' ? car.y : car.x);
    const pull = Math.min(Math.abs(want), (Math.abs(car.speed) * 0.55 + 50) * dt) * Math.sign(want);
    if (car.axis === 'h') car.y += pull;
    else car.x += pull;

    if (car.axis === 'h') car.x += car.speed * car.dir * dt;
    else car.y += car.speed * car.dir * dt;

    // Off the map or onto the sand: out of sight, back into a lane.
    const along = car.axis === 'h' ? car.x : car.y;
    if (along < CELL || along > city.size - CELL || car.y > BEACH_Y - CAR_SHORT) {
      car.x = clamp(car.x, CELL, city.size - CELL);
      car.y = clamp(car.y, CELL, BEACH_Y - CELL);
      recycle(car, city, player);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Peds
// ---------------------------------------------------------------------------------------------
const PED_COLOURS = ['#c9a04a', '#d36b5a', '#4f8a6b', '#5b6fa8', '#b8739a', '#e0d2b0', '#7a5a3f', '#3f6b7a'];
const PED_WALK = 48;
const PED_RUN = 168;
const PED_FLEE_RANGE = 300;
const PED_FLEE_TIME = 7;
const WALK_OFF = 7; // pavement centre, px off the kerb

// Put a ped on the pavement nearest (x, y), walking along the requested axis.
function placePed(ped, city, rng, x, y, axis) {
  const col = clamp(Math.round(x / CELL), 1, city.roadsX.length - 2);
  const row = clamp(Math.round(y / CELL), 1, Math.floor(BEACH_Y / CELL) - 2);
  ped.axis = axis;
  ped.dir = roll(rng) < 0.5 ? 1 : -1;
  ped.crossing = false;
  ped.state = 'walk';
  ped.speed = PED_WALK;
  ped.hp = 50;
  ped.timer = num(rng, 0.8, 2.8);
  if (axis === 'h') {
    const north = roll(rng) < 0.5;
    ped.kerb = north ? row : row + 1;
    ped.line = city.roadsY[ped.kerb] + (north ? -1 : 1) * (halfWidth(ped.kerb) + WALK_OFF);
    ped.y = ped.line;
    ped.x = num(rng, col * CELL, (col + 1) * CELL);
  } else {
    const west = roll(rng) < 0.5;
    ped.kerb = west ? col : col + 1;
    ped.line = city.roadsX[ped.kerb] + (west ? -1 : 1) * (halfWidth(ped.kerb) + WALK_OFF);
    ped.x = ped.line;
    ped.y = num(rng, row * CELL, (row + 1) * CELL);
  }
  ped.x = clamp(ped.x, CELL * 0.5, city.size - CELL * 0.5);
  ped.y = clamp(ped.y, CELL * 0.5, BEACH_Y - CELL * 0.5);
  ped.angle = angleFor(axis, ped.dir);
}

export function spawnPeds(city, rng, count = 60) {
  const peds = [];
  if (!city) return peds;
  seedStream(rng);
  for (let i = 0; i < count; i += 1) {
    const ped = {
      x: 0, y: 0, angle: 0, speed: PED_WALK, state: 'walk', hp: 50,
      colour: list(rng, PED_COLOURS), timer: 1, axis: 'h', dir: 1, line: 0, kerb: 0,
      crossing: false, crossTo: 0,
    };
    placePed(ped, city, rng, num(rng, CELL, city.size - CELL), num(rng, CELL, BEACH_Y - CELL), roll(rng) < 0.62 ? 'h' : 'v');
    peds.push(ped);
  }
  return peds;
}

// Walk a ped along one axis, turning back at the map edge and never through a wall.
function stepPed(ped, city, dx, dy) {
  const nx = ped.x + dx;
  const ny = ped.y + dy;
  if (!blocked(city, nx, ped.y, 7)) ped.x = nx;
  if (!blocked(city, ped.x, ny, 7)) ped.y = ny;
  if (ped.x < CELL || ped.x > city.size - CELL || ped.y < CELL || ped.y > BEACH_Y - CELL) {
    ped.x = clamp(ped.x, CELL, city.size - CELL);
    ped.y = clamp(ped.y, CELL, BEACH_Y - CELL);
    ped.dir = -ped.dir;
    ped.angle += Math.PI;
  }
}

export function updatePeds(peds, dt, city, player, particles) {
  if (!peds || !city || !(dt > 0)) return 0;
  const shot = !!(player && (player.noise > 0 || player.fireCooldown > 0.2));
  const noiseX = player ? player.x : 0;
  const noiseY = player ? player.y : 0;
  // A car bearing down at speed is its own alarm.
  const car = player && player.car && Math.abs(player.car.speed) > 140 ? player.car : null;

  for (let i = 0; i < peds.length; i += 1) {
    const ped = peds[i];
    if (!ped) continue;

    // Down: lie still, then fade away and come back somewhere else.
    if (ped.state === 'down') {
      ped.timer -= dt;
      if (ped.timer <= 0) {
        placePed(ped, city, stepRng, between(CELL * 2, city.size - CELL * 2), between(CELL * 2, BEACH_Y - CELL * 2), rand() < 0.6 ? 'h' : 'v');
      }
      continue;
    }

    // Gunfire nearby, or a speeding car: run from the source.
    if (ped.state !== 'flee') {
      const ex = car ? car.x : noiseX;
      const ey = car ? car.y : noiseY;
      const reach = car || !shot ? 110 : PED_FLEE_RANGE;
      const dx = ped.x - ex;
      const dy = ped.y - ey;
      if ((shot || car) && dx * dx + dy * dy < reach * reach) {
        ped.state = 'flee';
        ped.timer = shot ? PED_FLEE_TIME : 2.5;
        ped.crossing = false;
      }
    }

    // Fleeing: bolt away from the noise with a wobble, sliding along walls.
    if (ped.state === 'flee') {
      ped.timer -= dt;
      const away = Math.atan2(ped.y - noiseY, ped.x - noiseX);
      ped.angle = turnToward(ped.angle, away + Math.sin(ped.timer * 5) * 0.35, 7, dt);
      ped.speed = PED_RUN;
      stepPed(ped, city, Math.cos(ped.angle) * ped.speed * dt, Math.sin(ped.angle) * ped.speed * dt);
      if (particles && rand() < dt * 3) spawnParticles(particles, ped.x, ped.y + 4, 'dust', 1);
      if (ped.timer <= 0) placePed(ped, city, stepRng, ped.x, ped.y, rand() < 0.5 ? 'h' : 'v');
      continue;
    }

    // Crossing the carriageway: walk straight over, then carry on along the far pavement.
    if (ped.crossing) {
      const gap = ped.crossTo - (ped.axis === 'h' ? ped.y : ped.x);
      if (Math.abs(gap) < 1.5) {
        ped.crossing = false;
        ped.line = ped.crossTo;
        continue;
      }
      const step = Math.sign(gap) * Math.min(Math.abs(gap), PED_WALK * 1.2 * dt);
      if (ped.axis === 'h') ped.y += step;
      else ped.x += step;
      ped.speed = PED_WALK * 1.2;
      ped.angle = ped.axis === 'h' ? Math.sign(gap) * Math.PI * 0.5 : gap > 0 ? 0 : Math.PI;
      continue;
    }

    // Walking a pavement: step along it, and at a junction cross or turn the corner.
    ped.speed = PED_WALK;
    ped.timer -= dt;
    const along = ped.axis === 'h' ? ped.x : ped.y;
    const next = along + ped.dir * PED_WALK * dt;
    if (Math.round(next / CELL) !== Math.round(along / CELL)) {
      const dice = rand();
      const roads = roadsFor(city, ped.axis);
      if (dice < 0.3) {
        // Cross to the pavement on the far side of the road being walked.
        const kerb = ped.kerb;
        const side = ped.line < roads[kerb] ? -1 : 1;
        ped.crossTo = roads[kerb] - side * (halfWidth(kerb) + WALK_OFF);
        ped.crossing = true;
        continue;
      }
      if (dice < 0.55) {
        // Turn the corner onto the perpendicular pavement.
        const newAxis = ped.axis === 'h' ? 'v' : 'h';
        const keep = ped.line;
        ped.axis = newAxis;
        ped.dir = rand() < 0.5 ? 1 : -1;
        if (newAxis === 'v') {
          ped.x = keep;
          ped.y = next;
        } else {
          ped.y = keep;
          ped.x = next;
        }
        ped.angle = angleFor(newAxis, ped.dir);
        continue;
      }
    }
    if (ped.axis === 'h') ped.x = next;
    else ped.y = next;
    ped.angle = angleFor(ped.axis, ped.dir);
    stepPed(ped, city, 0, 0); // clamp to the map edge and turn back there
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Police
// ---------------------------------------------------------------------------------------------
const COP_COLOUR = '#1f2633';

// Just off the player's screen, on the road line nearest the player.
function spawnPointFor(city, player) {
  const px = player ? player.x : city.size * 0.5;
  const py = player ? player.y : city.size * 0.5;
  const ix = clamp(Math.round(px / CELL), 0, city.roadsX.length - 1);
  const iy = clamp(Math.round(py / CELL), 0, city.roadsY.length - 1);
  const off = 780;
  if (Math.abs(px - city.roadsX[ix]) < Math.abs(py - city.roadsY[iy])) {
    const y = clamp(py + (py > city.size * 0.5 ? -off : off), CELL, BEACH_Y - CELL * 2);
    return { x: city.roadsX[ix], y };
  }
  const x = clamp(px + (px > city.size * 0.5 ? -off : off), CELL, city.size - CELL);
  return { x, y: city.roadsY[iy] };
}

function makeCopCar(city, x, y) {
  const car = newCar(null);
  car.kind = 'sedan';
  car.colour = COP_COLOUR;
  car.maxSpeed = COP_MAX;
  car.driver = 'cop';
  car.hp = 160;
  return placeOnRoad(car, city, stepRng, x, y, rand() < 0.5 ? 'h' : 'v', CELL * 3);
}

export function spawnPolice(city, rng, count = 6) {
  const police = [];
  seedStream(rng);
  for (let i = 0; i < count; i += 1) {
    police.push({
      car: null,
      officer: { x: 0, y: 0, hp: 80, angle: 0, fireTimer: 0, dead: false },
      state: 'drive',
      lights: 0,
    });
  }
  return police;
}

// Chase steering: head for the player but never into a wall. Five headings are scored on
// clearance and on how close they point at the target, which is enough to round street corners.
function driveCop(car, city, player, dt) {
  const tx = player ? player.x : car.x;
  const ty = player ? player.y : car.y;
  const dist = Math.hypot(tx - car.x, ty - car.y) || 1;
  const wanted = Math.atan2(ty - car.y, tx - car.x);
  const probe = 46 + Math.abs(car.speed) * 0.14;
  let best = car.angle;
  let bestScore = -Infinity;
  for (let k = -2; k <= 2; k += 1) {
    const a = car.angle + k * 0.42;
    const x = car.x + Math.cos(a) * probe;
    const y = car.y + Math.sin(a) * probe;
    const clear = !(blocked(city, x, y, 11) || x < 16 || y < 16 || x > city.size - 16 || y > BEACH_Y - 16);
    const score = (clear ? 0 : -1.4) + Math.cos(wrapAngle(wanted - a)) - Math.abs(k) * 0.06;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  car.angle = turnToward(car.angle, best, 5.0, dt);

  const target = dist < 130 ? COP_MAX * 0.5 : COP_MAX;
  if (car.speed < target) car.speed = Math.min(target, car.speed + COP_ACCEL * dt);
  else car.speed = Math.max(target, car.speed - COP_ACCEL * 1.6 * dt);

  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  if (!blocked(city, nx, car.y, 12)) car.x = nx;
  else car.speed *= 0.55;
  if (!blocked(city, car.x, ny, 12)) car.y = ny;
  else car.speed *= 0.55;
  car.x = clamp(car.x, 14, city.size - 14);
  car.y = clamp(car.y, 14, BEACH_Y - 14);
  const vertical = Math.abs(Math.sin(car.angle)) > 0.7;
  car.axis = vertical ? 'v' : 'h';
  car.w = vertical ? CAR_SHORT : CAR_LONG;
  car.h = vertical ? CAR_LONG : CAR_SHORT;
}

// One officer on foot: run into pistol range, then stand and fire.
function updateOfficer(cop, dt, city, player, bullets, particles) {
  const off = cop.officer;
  if (off.hp <= 0) off.dead = true;
  if (!player || player.dead || off.dead) return;
  const dx = player.x - off.x;
  const dy = player.y - off.y;
  const dist = Math.hypot(dx, dy) || 1;
  off.angle = turnToward(off.angle, Math.atan2(dy, dx), 8, dt);

  const speed = dist > COP_SHOOT_RANGE * 0.75 ? 150 : dist < 90 ? -70 : 0;
  if (speed !== 0) {
    if (!blocked(city, off.x + (dx / dist) * speed * dt, off.y, 9)) off.x += (dx / dist) * speed * dt;
    if (!blocked(city, off.x, off.y + (dy / dist) * speed * dt, 9)) off.y += (dy / dist) * speed * dt;
  }

  off.fireTimer -= dt;
  if (dist > COP_SHOOT_RANGE || off.fireTimer > 0 || !bullets) return;
  off.fireTimer = 0.78;
  const angle = off.angle + (rand() - 0.5) * 0.13;
  fireBullet(bullets, off.x + Math.cos(angle) * 12, off.y + Math.sin(angle) * 12, angle, COP_SPEED, 'cop', COP_DAMAGE);
  if (particles) spawnParticles(particles, off.x, off.y, 'spark', 1);
}

// Send an officer out of the car beside it.
function dismount(cop, car, particles) {
  cop.state = 'foot';
  cop.officer.x = car.x + 22;
  cop.officer.y = car.y - 14;
  if (cop.officer.hp <= 0) cop.officer.hp = 80;
  cop.officer.dead = false;
  cop.officer.fireTimer = 0.3;
  car.speed = 0;
  if (particles) spawnParticles(particles, car.x, car.y, 'dust', 3);
}

export function updatePolice(police, dt, city, player, bullets, particles) {
  if (!police || !city || !(dt > 0)) return 0;
  const wanted = player && !player.dead ? player.wanted || 0 : 0;
  const wantCars = Math.min(police.length, wanted <= 0 ? 0 : 1 + wanted);
  const wantShooters = wanted >= COP_SHOTS_AT ? Math.min(police.length, wanted) : 0;
  const px = player ? player.x : city.size * 0.5;
  const py = player ? player.y : city.size * 0.5;

  for (let i = 0; i < police.length; i += 1) {
    const cop = police[i];
    if (!cop) continue;

    // No heat for this unit: leave the scene, then drop out of play once far enough away.
    if (i >= wantCars || !player) {
      cop.lights = 0;
      cop.state = 'drive';
      const car = cop.car;
      if (!car) continue;
      car.driver = 'cop';
      if (Math.abs(car.speed) < 10) car.speed = 40;
      car.angle = turnToward(car.angle, Math.atan2(car.y - py, car.x - px), 3, dt);
      car.x = clamp(car.x + Math.cos(car.angle) * car.speed * dt, 12, city.size - 12);
      car.y = clamp(car.y + Math.sin(car.angle) * car.speed * dt, 12, BEACH_Y - 12);
      if (Math.hypot(car.x - px, car.y - py) > 2400) cop.car = null;
      continue;
    }

    cop.lights = 1;
    if (!cop.car) {
      const spot = spawnPointFor(city, player);
      cop.car = makeCopCar(city, spot.x, spot.y);
      cop.state = 'drive';
      cop.officer.hp = 80;
      cop.officer.dead = false;
      cop.officer.fireTimer = 0.9;
      continue;
    }

    const car = cop.car;
    car.driver = 'cop';

    // Wrecked: smoke, and the pair bail out to keep shooting if the heat allows.
    if (car.wrecked || car.hp <= 0) {
      car.wrecked = true;
      car.hp = 0;
      car.speed = 0;
      car.smokeTimer -= dt;
      if (car.smokeTimer <= 0 && particles) {
        car.smokeTimer = 0.2;
        spawnParticles(particles, car.x, car.y, 'smoke', 2);
      }
      if (cop.state !== 'foot' && i < wantShooters) dismount(cop, car, particles);
      if (cop.state === 'foot') updateOfficer(cop, dt, city, player, bullets, particles);
      else if (Math.hypot(car.x - px, car.y - py) > 2000) cop.car = null;
      continue;
    }

    const dist = Math.hypot(car.x - px, car.y - py);
    // Two stars or more, close and slow: the pair gets out and shoots.
    if (cop.state === 'drive' && i < wantShooters && dist < COP_DISMOUNT && Math.abs(car.speed) < 140) {
      dismount(cop, car, particles);
    }
    if (cop.state === 'foot') {
      car.speed = 0;
      updateOfficer(cop, dt, city, player, bullets, particles);
      if (dist > COP_DISMOUNT * 2.2 && cop.officer.hp > 0) cop.state = 'drive'; // clean away
      continue;
    }
    driveCop(car, city, player, dt);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Bullets: pooled records the caller owns, capped at BULLET_CAP. A free slot is reused before the
// pool grows; when it is full the oldest round gives way.
// ---------------------------------------------------------------------------------------------
function fireBullet(bullets, x, y, angle, speed, from, damage) {
  let slot = null;
  let oldest = null;
  for (let i = 0; i < bullets.length; i += 1) {
    const b = bullets[i];
    if (!b) continue;
    if (!(b.life > 0)) {
      slot = b;
      break;
    }
    if (!oldest || b.life < oldest.life) oldest = b;
  }
  if (!slot) {
    if (bullets.length >= BULLET_CAP) slot = oldest;
    else slot = bullets[bullets.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, from: 'cop', damage: 0 }) - 1];
  }
  if (!slot) return;
  slot.x = x;
  slot.y = y;
  slot.vx = Math.cos(angle) * speed;
  slot.vy = Math.sin(angle) * speed;
  slot.life = 1.1;
  slot.from = from;
  slot.damage = damage;
}

export function updateBullets(bullets, dt, city, player, peds, cars) {
  let events = 0;
  if (!bullets || !bullets.length || !(dt > 0)) return events;

  for (let i = 0; i < bullets.length; i += 1) {
    const b = bullets[i];
    if (!b || !(b.life > 0)) continue;
    b.life -= dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Buildings, sand and the map edge stop a round.
    if (b.life <= 0 || (city && (blocked(city, b.x, b.y, 1) || b.y >= BEACH_Y || b.x < 0 || b.x > city.size))) {
      b.life = 0;
      continue;
    }

    // The player: a cop round lands on them on foot or in their car. Their own rounds never
    // score on them.
    if (player && b.from !== 'player' && !player.dead) {
      const tx = player.car ? player.car.x : player.x;
      const ty = player.car ? player.car.y : player.y;
      const reach = player.car ? 21 : PLAYER_HIT;
      if (Math.abs(b.x - tx) <= reach && Math.abs(b.y - ty) <= reach) {
        b.life = 0;
        if (player.car) player.car.hp = Math.max(0, (player.car.hp === undefined ? 100 : player.car.hp) - b.damage);
        events |= hurt(player, b.damage);
        if (player.hp <= 0 && !player.dead) events |= EVENT_WASTED;
        continue;
      }
    }

    // Peds: a player round that drops one is a crime.
    if (peds) {
      let hit = false;
      for (let j = 0; j < peds.length; j += 1) {
        const ped = peds[j];
        if (!ped || ped.state === 'down') continue;
        if (Math.abs(b.x - ped.x) > PED_HIT || Math.abs(b.y - ped.y) > PED_HIT) continue;
        b.life = 0;
        ped.hp = (ped.hp === undefined ? 50 : ped.hp) - b.damage;
        if (ped.hp <= 0) {
          ped.hp = 0;
          ped.state = 'down';
          ped.timer = 25;
          if (b.from === 'player' && player) {
            raiseWanted(player, 2);
            events |= EVENT_CRIME;
          }
        } else {
          ped.state = 'flee';
          ped.timer = PED_FLEE_TIME;
        }
        hit = true;
        break;
      }
      if (hit) continue;
    }

    // Cars take the round; enough of them wreck one.
    if (cars) {
      let hit = false;
      for (let j = 0; j < cars.length; j += 1) {
        const car = cars[j];
        if (!car || car.wrecked) continue;
        const hw = (car.axis === 'v' ? CAR_SHORT : CAR_LONG) * 0.5;
        const hh = (car.axis === 'v' ? CAR_LONG : CAR_SHORT) * 0.5;
        if (Math.abs(b.x - car.x) > hw || Math.abs(b.y - car.y) > hh) continue;
        b.life = 0;
        car.hp = (car.hp === undefined ? 100 : car.hp) - b.damage;
        if (car.hp <= 0) {
          car.hp = 0;
          car.wrecked = true;
          car.speed = 0;
          car.smokeTimer = 0.1;
        }
        hit = true;
        break;
      }
      if (hit) continue;
    }
  }
  return events;
}

// Raising the wanted level from a bullet hit (player.js keeps its own helper private): same rules,
// clamp 1..5 and refresh the cooling clock.
function raiseWanted(player, stars) {
  if (player.wanted >= 5) return;
  player.wanted = Math.min(5, Math.max(1, (player.wanted || 0) + stars));
  if (typeof player.wantedTimer === 'number') player.wantedTimer = 12;
}

// ---------------------------------------------------------------------------------------------
// Particles: one fixed pool of 400, recycled oldest-first so a step never allocates. Kinds are
// smoke, spark, dust and blood0; the renderer owns the colours.
// ---------------------------------------------------------------------------------------------
const PARTICLE_SPEC = {
  smoke: { life: 1.7, speed: 24, size: 6, rise: 14, grow: 2.6, drag: 0.7 },
  spark: { life: 0.34, speed: 215, size: 2, rise: 0, grow: 0, drag: 2.2 },
  dust: { life: 0.7, speed: 70, size: 4, rise: 0, grow: 1.5, drag: 1.8 },
  blood0: { life: 0.9, speed: 120, size: 3.5, rise: 0, grow: 0.4, drag: 2.0 },
};

// Bring the caller's array to exactly the pool size with dead records, and hand it back.
function ensurePool(particles) {
  if (!Array.isArray(particles)) return null;
  while (particles.length < PARTICLE_POOL) {
    particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, grow: 0, drag: 1, kind: 'smoke' });
  }
  if (particles.length > PARTICLE_POOL) particles.length = PARTICLE_POOL;
  return particles;
}

// The first dead record, else the one nearest the end of its life.
function freeParticle(pool) {
  let oldest = null;
  for (let i = 0; i < pool.length; i += 1) {
    const p = pool[i];
    if (!p) continue;
    if (!(p.life > 0)) return p;
    if (!oldest || p.life < oldest.life) oldest = p;
  }
  return oldest;
}

export function spawnParticles(particles, x, y, kind, count = 4) {
  const pool = ensurePool(particles);
  if (!pool) return;
  const spec = PARTICLE_SPEC[kind] || PARTICLE_SPEC.smoke;
  const n = Math.max(1, count | 0);
  for (let i = 0; i < n; i += 1) {
    const p = freeParticle(pool);
    if (!p) return;
    const angle = rand() * Math.PI * 2;
    const speed = spec.speed * (0.35 + rand() * 0.8);
    p.x = x + (rand() - 0.5) * 6;
    p.y = y + (rand() - 0.5) * 6;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed - spec.rise;
    p.maxLife = spec.life * (0.7 + rand() * 0.6);
    p.life = p.maxLife;
    p.size = spec.size * (0.7 + rand() * 0.7);
    p.grow = spec.grow;
    p.drag = spec.drag;
    p.kind = PARTICLE_SPEC[kind] ? kind : 'smoke';
  }
}

export function updateParticles(particles, dt) {
  if (!Array.isArray(particles) || !(dt > 0)) return;
  for (let i = 0; i < particles.length; i += 1) {
    const p = particles[i];
    if (!p || !(p.life > 0)) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.life = 0;
      continue;
    }
    const drag = 1 - Math.min(0.92, (p.drag || 1) * dt);
    p.vx *= drag;
    p.vy = p.vy * drag - (p.kind === 'smoke' ? 12 * dt : 0);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.grow) p.size = (p.size || 2) + p.grow * dt;
  }
}
