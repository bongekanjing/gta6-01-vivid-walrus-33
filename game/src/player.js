// The player: one body walking Vice Fortuna and, once they take a car, the car itself.
//
// One fixed step goes in (updatePlayer) and a set of EVENT_* bits comes out, so main.js can react
// (sound, screens, shake) without this module knowing about screens or audio. The player also owns
// the parts of the run-time that belong to them: hp/armour/money, the weapon and its ammo, the
// wanted level and its cooling clock, and the health and armour pickups parked on the lamps.
//
// Everything mutable lives on the player object created here; the city, cars, peds, police and
// bullets are borrowed from ctx every step and only written to when the player acts.
import { blocked, onRoad, isSidewalk } from './city.js';

// Event bits reported to the caller.
export const EVENT_WASTED = 1;
export const EVENT_BUSTED = 2;
export const EVENT_CRIME = 4;
export const EVENT_SHOT = 8;
export const EVENT_ENTER_CAR = 16;
export const EVENT_EXIT_CAR = 32;
export const EVENT_PICKUP = 64;
export const EVENT_MISSION = 128;

// On foot.
const WALK_SPEED = 130; // px/s
const RUN_SPEED = 250; // px/s
const BODY_RADIUS = 12; // collision radius against buildings and water
const ENTER_RANGE = 70; // px from a car's centre to its door handle
const PICKUP_RANGE = 26; // px to walk over a pickup
const PICKUP_RESPAWN = 60; // seconds

// Cars.
const CAR_RADIUS = 14; // what the player's car is tested against
const REVERSE_FACTOR = 0.4; // top reverse speed as a fraction of maxSpeed
const DRIVE_ACCEL = 1.15; // throttle acceleration in maxSpeed/s
const BRAKE_ACCEL = 2.4; // brakes and reverse throttle
const COAST_DRAG = 0.9; // rolling drag per second when nothing is held
const CAR_DRAG = 3.0; // how hard the sea and walls slow the car when it is stuck against them
const CRASH_SPEED = 150; // px/s of lost speed that counts as a crash
const STEER_RATE = 2.3; // rad/s at a standstill-ish, scaled up by speed below
const STEER_SLIP = 1.55; // steering is this much livelier with the handbrake down
const DRIFT_ANGLE = 0.16; // heading vs travel gap (rad) past which the car is drifting
const DRIFT_MARKS = 0.055; // the milder slip that lays rubber when cornering hard
const TYRE_MARK_GAP = 9; // px of travel between two tyre mark segments
const MARKS_CAP = 400;

// Weapons.
const FIST_RANGE = 40;
const FIST_DAMAGE = 12;
const FIST_COOLDOWN = 0.35;
const PISTOL_DAMAGE = 25;
const PISTOL_COOLDOWN = 0.28;
const PISTOL_SPEED = 900; // px/s
const BULLET_LIFE = 0.9; // seconds
const RELOAD_TIME = 0.9;
const MAG_SIZE = 12; // rounds a clip holds; reserve is player.ammo
const MAX_RESERVE = 96;
const AIM_RANGE = 900; // mouse projection distance when the pointer is idle

// Law.
const MAX_WANTED = 5;
const WANTED_COOLDOWN = 12; // seconds unseen before a star drops
const PURSUIT_RANGE = 700; // a cop this close can see you
const SIGHT_BLOCKED = 24; // a building this far inside the sight line breaks it
const CRIMES = {
  pedHit: 1,
  stealCar: 1,
  gunfire: 1,
  pedKill: 2,
  ramPolice: 2,
  copKill: 3,
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

// The nearest road-aligned car centre to the spawn point, so a new player never wakes up inside a
// block of buildings.
function safeSpot(city) {
  const x = Math.round(city.size * 0.5);
  const y = Math.round((city.water.y - 12 * city.cell) / city.cell) * city.cell;
  if (!blocked(city, x, y, BODY_RADIUS)) return { x, y };
  for (let i = 0; i < city.roadsX.length; i += 1) {
    for (let j = 0; j < city.roadsY.length; j += 1) {
      const rx = city.roadsX[i];
      const ry = city.roadsY[j];
      if (!blocked(city, rx, ry, BODY_RADIUS)) return { x: rx, y: ry };
    }
  }
  return { x, y };
}

// Three pickups on the first three lamps: index 0 and 2 carry health, 1 carries armour. They are
// plain numbers in a short-lived object, so nothing borrows the city's lamp list.
function createPickups(city) {
  const kinds = ['health', 'armour', 'health'];
  const spots = city.lamps && city.lamps.length ? city.lamps : [];
  const pickups = [];
  for (let i = 0; i < 3; i += 1) {
    const lamp = spots[i];
    if (!lamp) break;
    pickups.push({ kind: kinds[i], x: lamp.x + 10, y: lamp.y + 10, timer: 0, active: true });
  }
  return pickups;
}

export function createPlayer(city) {
  const spawn = safeSpot(city);
  const player = {
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2, // facing north up the avenue
    onFoot: true,
    car: null,
    hp: 100,
    armour: 0,
    money: 0,
    weapon: 'fist',
    ammo: 0, // reserve rounds carried outside the clip
    clip: 0, // rounds in the magazine; the pistol loads itself the first time it is drawn

    wanted: 0,
    wantedTimer: 0,
    aim: -Math.PI / 2,
    dead: false,
    lastSafe: { x: spawn.x, y: spawn.y },
    // Bookkeeping the renderer, HUD and other modules may read.
    radius: BODY_RADIUS,
    speed: 0,
    drifting: false,
    fireCooldown: 0,
    punchCooldown: 0,
    reloading: 0,
    invuln: 0,
    hurtFlash: 0,
    crimes: 0,
    spotted: false,
    pickups: createPickups(city),
    // Scratch state for the car, so entering and leaving stays cheap.
    carMileage: 0,
  };
  return player;
}

// ---------------------------------------------------------------------------------------------
// Wanted level
// ---------------------------------------------------------------------------------------------

function crime(player, stars) {
  if (player.wanted >= MAX_WANTED) return 0;
  player.wanted = Math.min(MAX_WANTED, Math.max(1, player.wanted + stars));
  // A fresh crime restarts the cooling clock: the heat has just been noticed.
  player.wantedTimer = WANTED_COOLDOWN;
  player.crimes += 1;
  return EVENT_CRIME;
}

// True if a building sits on the segment between the cop and the player.
function sightBlocked(city, x1, y1, x2, y2) {
  const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / SIGHT_BLOCKED));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (blocked(city, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 2)) return true;
  }
  return false;
}

function policeHasSight(city, police, x, y) {
  if (!police) return false;
  for (let i = 0; i < police.length; i += 1) {
    const cop = police[i];
    if (!cop) continue;
    // A cop is somewhere near their car whether mounted or on foot.
    const cx = cop.state === 'foot' && cop.officer ? cop.officer.x : cop.car ? cop.car.x : cop.x;
    const cy = cop.state === 'foot' && cop.officer ? cop.officer.y : cop.car ? cop.car.y : cop.y;
    if (typeof cx !== 'number' || typeof cy !== 'number') continue;
    if (cop.car && cop.car.hp !== undefined && cop.car.hp <= 0) continue;
    if (Math.hypot(cx - x, cy - y) > PURSUIT_RANGE) continue;
    if (!sightBlocked(city, cx, cy, x, y)) return true;
  }
  return false;
}

// Wanted level: heat decays only while no officer has the player in sight.
function updateWanted(player, city, police, dt) {
  player.spotted = player.wanted > 0 && policeHasSight(city, police, player.x, player.y);
  if (player.wanted <= 0) {
    player.wantedTimer = 0;
    return;
  }
  if (player.spotted) {
    player.wantedTimer = WANTED_COOLDOWN;
    return;
  }
  player.wantedTimer -= dt;
  if (player.wantedTimer <= 0) {
    player.wanted = Math.max(0, player.wanted - 1);
    player.wantedTimer = player.wanted > 0 ? WANTED_COOLDOWN : 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Input helpers: the contract's input, with defensive fallbacks so a stub input cannot crash.
// ---------------------------------------------------------------------------------------------

function axisX(input) {
  if (typeof input.axis === 'function') return input.axis().x;
  const s = input.state || {};
  return (s.d || s.arrowright ? 1 : 0) - (s.a || s.arrowleft ? 1 : 0);
}

function axisY(input) {
  if (typeof input.axis === 'function') return input.axis().y;
  const s = input.state || {};
  return (s.s || s.arrowdown ? 1 : 0) - (s.w || s.arrowup ? 1 : 0);
}

function pressed(input, action) {
  return typeof input.pressed === 'function' ? !!input.pressed(action) : false;
}

function heldRun(input) {
  return typeof input.run === 'function' ? !!input.run() : false;
}

function mouse(input) {
  return input.mouse || { x: 0, y: 0, down: false, clicked: false };
}

// ---------------------------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------------------------

// The mouse arrives in canvas coordinates, which are not world coordinates: accept an optional
// camera {x, y, zoom} in ctx and map the pointer into the world before turning it into an angle.
function aimAt(player, input, ctx) {
  const m = mouse(input);
  const cam = ctx && ctx.camera;
  let mx = m.x;
  let my = m.y;
  if (cam && typeof cam.x === 'number') {
    const zoom = typeof cam.zoom === 'number' && cam.zoom > 0 ? cam.zoom : 1;
    mx = cam.x + (m.x - (typeof cam.screenW === 'number' ? cam.screenW * 0.5 : 640)) / zoom;
    my = cam.y + (m.y - (typeof cam.screenH === 'number' ? cam.screenH * 0.5 : 360)) / zoom;
  }
  const dx = mx - player.x;
  const dy = my - player.y;
  // A pointer parked on the player gives no direction: keep the current facing.
  if (Math.hypot(dx, dy) > 6) player.aim = Math.atan2(dy, dx);
  else player.aim = player.angle;
}

function switchWeapon(player, input) {
  if (pressed(input, 'weapon1') && player.weapon !== 'fist') {
    player.weapon = 'fist';
    player.reloading = 0;
  }
  if (pressed(input, 'weapon2') && player.weapon !== 'pistol') {
    player.weapon = 'pistol';
    player.reloading = 0;
    if (player.clip === 0 && player.ammo > 0) startReload(player);
  }
}

function startReload(player) {
  if (player.weapon !== 'pistol' || player.reloading > 0 || player.clip >= MAG_SIZE || player.ammo <= 0) return;
  player.reloading = RELOAD_TIME;
}

function finishReload(player) {
  const want = MAG_SIZE - player.clip;
  const take = Math.min(want, player.ammo);
  player.clip += take;
  player.ammo -= take;
}

// A fist punch: everything within 40 px and roughly in front of the barrel of the arm.
function punch(player, ctx, events) {
  player.punchCooldown = FIST_COOLDOWN;
  let hit = false;
  const peds = ctx.peds || [];
  for (let i = 0; i < peds.length && !hit; i += 1) {
    const ped = peds[i];
    if (!ped || ped.state === 'down') continue;
    const dx = ped.x - player.x;
    const dy = ped.y - player.y;
    if (Math.hypot(dx, dy) > FIST_RANGE) continue;
    if (Math.abs(wrapAngle(Math.atan2(dy, dx) - player.aim)) > 1.1) continue;
    ped.hp = (ped.hp === undefined ? 100 : ped.hp) - FIST_DAMAGE;
    ped.hitByPlayer = true;
    if (ped.hp <= 0) {
      ped.hp = 0;
      ped.state = 'down';
      ped.timer = 8;
      events |= crime(player, CRIMES.pedKill);
    } else {
      ped.state = 'flee';
      ped.timer = 4;
      events |= crime(player, CRIMES.pedHit);
    }
    hit = true;
  }
  // The cops are people too: a fist on an officer is a crime and may put them down.
  const police = ctx.police || [];
  for (let i = 0; i < police.length && !hit; i += 1) {
    const officer = police[i] && police[i].officer;
    if (!officer || (officer.hp !== undefined && officer.hp <= 0)) continue;
    if (Math.hypot(officer.x - player.x, officer.y - player.y) > FIST_RANGE) continue;
    officer.hp = (officer.hp === undefined ? 60 : officer.hp) - FIST_DAMAGE;
    events |= crime(player, officer.hp <= 0 ? CRIMES.copKill : CRIMES.pedHit);
    hit = true;
  }
  if (ctx.audio && typeof ctx.audio.play === 'function') ctx.audio.play(hit ? 'punch' : 'swing');
  if (hit && ctx.particles && typeof ctx.particles.push === 'function') {
    // particles are drawn by updateParticles from entities.js; a push here is enough.
    ctx.particles.push({ x: player.x, y: player.y, vx: 0, vy: 0, life: 0.2, kind: 'spark' });
  }
  return events;
}

// A pistol round travels from the muzzle toward the aim.
function shoot(player, ctx, events) {
  player.clip -= 1;
  player.fireCooldown = PISTOL_COOLDOWN;
  const cos = Math.cos(player.aim);
  const sin = Math.sin(player.aim);
  const bullets = ctx.bullets;
  if (Array.isArray(bullets)) {
    // The pool is the caller's: overwrite dead/expired rounds before growing it.
    let slot = null;
    for (let i = 0; i < bullets.length; i += 1) {
      if (!bullets[i] || bullets[i].life <= 0) {
        slot = bullets[i];
        break;
      }
    }
    if (!slot) {
      slot = {};
      bullets.push(slot);
    }
    slot.x = player.x + cos * 14;
    slot.y = player.y + sin * 14;
    slot.vx = cos * PISTOL_SPEED;
    slot.vy = sin * PISTOL_SPEED;
    slot.life = BULLET_LIFE;
    slot.from = 'player';
    slot.damage = PISTOL_DAMAGE;
  }
  if (ctx.audio && typeof ctx.audio.play === 'function') ctx.audio.play('shot');
  events |= EVENT_SHOT;
  // Firing in public: a star unless the shots are already ringing out.
  if (player.wanted === 0) events |= crime(player, CRIMES.gunfire);
}

function updateWeapon(player, input, dt, ctx, events) {
  if (player.fireCooldown > 0) player.fireCooldown -= dt;
  if (player.punchCooldown > 0) player.punchCooldown -= dt;
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) {
      player.reloading = 0;
      finishReload(player);
    }
  }
  switchWeapon(player, input);
  if (pressed(input, 'reload')) startReload(player);

  const m = mouse(input);
  const wantFire = pressed(input, 'fire') || m.down || m.clicked;
  const wantPunch = pressed(input, 'punch') || (player.weapon !== 'pistol' && m.clicked);

  if (player.weapon === 'fist') {
    if ((wantPunch || wantFire) && player.punchCooldown <= 0) events |= punch(player, ctx, events);
  } else if (wantFire && player.fireCooldown <= 0 && player.reloading <= 0) {
    if (player.clip > 0) events |= shoot(player, ctx, events);
    else if (player.ammo > 0) startReload(player);
  } else if (m.clicked && player.clip === 0 && player.ammo > 0) {
    startReload(player);
  }
}

// ---------------------------------------------------------------------------------------------
// On foot
// ---------------------------------------------------------------------------------------------

// Try a move along one axis; if the destination is solid, slide by stepping back toward the
// current position. A tiny search keeps doorways and kerbs forgiving without tunnelling.
function tryMove(city, x, y, nx, ny, radius) {
  if (!blocked(city, nx, ny, radius)) return { x: nx, y: ny };
  for (let back = 0.25; back < 1; back += 0.25) {
    const px = x + (nx - x) * (1 - back);
    const py = y + (ny - y) * (1 - back);
    if (!blocked(city, px, py, radius)) return { x: px, y: py };
  }
  return { x, y };
}

function walk(player, input, dt, city) {
  const ax = axisX(input);
  const ay = axisY(input);
  const magnitude = Math.hypot(ax, ay);
  const speed = heldRun(input) ? RUN_SPEED : WALK_SPEED;
  let dx = 0;
  let dy = 0;
  if (magnitude > 0.01) {
    dx = (ax / Math.max(1, magnitude)) * speed;
    dy = (ay / Math.max(1, magnitude)) * speed;
    player.angle = Math.atan2(dy, dx);
  }
  // Ease toward the wanted velocity so starting and stopping has a little weight.
  player.vx = approach(player.vx, dx, speed * 8 * dt);
  player.vy = approach(player.vy, dy, speed * 8 * dt);
  player.speed = Math.hypot(player.vx, player.vy);

  const nx = player.x + player.vx * dt;
  const ny = player.y + player.vy * dt;
  const moved = tryMove(city, player.x, player.y, nx, ny, BODY_RADIUS);
  if (moved.x === player.x) player.vx = 0;
  if (moved.y === player.y) player.vy = 0;
  player.x = moved.x;
  player.y = moved.y;

  // Remember the last pavement as a safe respawn spot (police hand you back here after a bust).
  if (isSidewalk(city, player.x, player.y) || (onRoad(city, player.x, player.y) && player.spotted === false)) {
    player.lastSafe.x = player.x;
    player.lastSafe.y = player.y;
  }
}

// The nearest car to the player's feet within the door range. A car somebody else is driving only
// wins when it is much closer, so the player is never yanked out of a free car by passing traffic.
function nearestCar(cars, x, y, range) {
  if (!Array.isArray(cars)) return null;
  let best = null;
  let bestDist = range;
  for (let i = 0; i < cars.length; i += 1) {
    const car = cars[i];
    if (!car || typeof car.x !== 'number' || typeof car.y !== 'number') continue;
    const d = Math.hypot(car.x - x, car.y - y);
    const occupied = !!car.driver && car.driver !== 'player';
    if (d < bestDist && (!occupied || d < bestDist * 0.75)) {
      best = car;
      bestDist = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------------------------

// Get the player into a car: the pickup radius is ENTER_RANGE (70 px from the car's centre).
function enterCar(player, car, ctx, events) {
  if (!car) return events;
  // Parking a stolen car home is not a theft: only a car nobody is already driving counts.
  // Traffic cars carry driver 'ai'; parked ones carry nothing.
  const wasStolen = !car.driver || car.driver !== 'player';
  car.driver = 'player';
  car.speed = car.speed || 0;
  if (typeof car.angle !== 'number') car.angle = car.axis === 'v' ? Math.PI / 2 : 0;
  if (typeof car.maxSpeed !== 'number') car.maxSpeed = 220;
  player.car = car;
  player.onFoot = false;
  player.x = car.x;
  player.y = car.y;
  player.angle = car.angle;
  player.vx = 0;
  player.vy = 0;
  player.speed = 0;
  if (wasStolen) {
    const witnessed = Array.isArray(ctx.peds) && ctx.peds.some((p) => p && p.state !== 'down' && Math.hypot(p.x - car.x, p.y - car.y) < 260);
    if (witnessed) events |= crime(player, CRIMES.stealCar);
  }
  return events | EVENT_ENTER_CAR;
}

function exitCar(player, events) {
  const car = player.car;
  if (!car) return events;
  car.driver = null;
  // Step out of the driver's door: the car's left side, in world space.
  const left = car.angle - Math.PI / 2;
  let ox = car.x + Math.cos(left) * 34;
  let oy = car.y + Math.sin(left) * 34;
  const city = player.city;
  if (city && blocked(city, ox, oy, BODY_RADIUS)) {
    ox = car.x - Math.cos(left) * 34;
    oy = car.y - Math.sin(left) * 34;
  }
  if (city && blocked(city, ox, oy, BODY_RADIUS)) {
    ox = car.x;
    oy = car.y;
  }
  player.car = null;
  player.onFoot = true;
  player.x = ox;
  player.y = oy;
  player.angle = car.angle + Math.PI; // facing back at the car
  player.vx = 0;
  player.vy = 0;
  player.speed = 0;
  return events | EVENT_EXIT_CAR;
}

// Drop one tyre mark pair at the car's rear wheels. Marks are born at full life and fade from
// there; the oldest segment goes first at the cap.
function layMarks(city, car, x, y) {
  let marks = city.marks;
  if (!Array.isArray(marks)) return;
  const back = car.h * 0.42;
  const side = car.w * 0.34;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  const bx = x - cos * back;
  const by = y - sin * back;
  // Someone else's list may already be over the cap: trim first so it never grows past 400.
  if (marks.length > MARKS_CAP - 2) {
    marks.splice(0, marks.length - (MARKS_CAP - 2));
  }
  for (let s = -1; s <= 1; s += 2) {
    marks.push({
      x: bx - sin * side * s,
      y: by + cos * side * s,
      x2: bx - sin * side * s - cos * 6,
      y2: by + cos * side * s - sin * 6,
      w: 5,
      life: 1,
    });
  }
}

function drive(player, input, dt, ctx, events) {
  const car = player.car;
  const city = ctx.city;
  if (!car) return events;

  const throttle = clamp(-axisY(input), -1, 1); // up is -1 on the axis, so forward is positive
  const steer = clamp(-axisX(input), -1, 1); // screen right (positive x) turns the nose clockwise
  const handbrake = heldHandbrake(input);
  const maxSpeed = car.maxSpeed || 220;
  const prevSpeed = car.speed || 0;

  // Longitudinal: throttle to max, brake into reverse, gentle drag otherwise.
  if (throttle > 0) {
    if (car.speed < -2) car.speed = Math.min(0, car.speed + BRAKE_ACCEL * maxSpeed * dt);
    else car.speed = Math.min(maxSpeed, car.speed + DRIVE_ACCEL * maxSpeed * throttle * dt);
  } else if (throttle < 0) {
    if (car.speed > 2) car.speed = Math.max(0, car.speed + BRAKE_ACCEL * maxSpeed * throttle * dt);
    else car.speed = Math.max(-maxSpeed * REVERSE_FACTOR, car.speed + BRAKE_ACCEL * maxSpeed * throttle * dt);
  } else {
    car.speed = approach(car.speed, 0, COAST_DRAG * maxSpeed * 0.35 * dt + Math.abs(car.speed) * COAST_DRAG * dt);
  }
  if (handbrake) car.speed = approach(car.speed, 0, BRAKE_ACCEL * 1.4 * maxSpeed * dt);

  // Steering fades out at a crawl and at top speed, and turns reverse the right way round.
  const speedFactor = Math.min(1, Math.abs(car.speed) / (maxSpeed * 0.35));
  const direction = car.speed < 0 ? -1 : 1;
  const grip = handbrake ? STEER_SLIP : 1;
  const turn = steer * STEER_RATE * grip * speedFactor * direction * dt;
  car.angle = wrapAngle((typeof car.angle === 'number' ? car.angle : 0) + turn);

  // Drift: the travel direction lags the nose when the rear tyres are loose.
  if (typeof car.drift !== 'number') car.drift = 0;
  const wantDrift = handbrake && Math.abs(car.speed) > maxSpeed * 0.25 && Math.abs(steer) > 0.2 ? -steer * 0.35 : 0;
  car.drift = approach(car.drift, wantDrift, 2.4 * dt);
  const travel = car.angle + car.drift;
  const travelGap = Math.abs(wrapAngle(car.angle - travel));
  player.drifting = travelGap > DRIFT_ANGLE || handbrake;

  const stepX = Math.cos(travel) * car.speed * dt;
  const stepY = Math.sin(travel) * car.speed * dt;
  const nx = car.x + stepX;
  const ny = car.y + stepY;
  if (city && blocked(city, nx, ny, CAR_RADIUS)) {
    // The nose is into a wall: try sliding along the open axis, like a skid down the kerb.
    const slideX = city && !blocked(city, nx, car.y, CAR_RADIUS);
    const slideY = city && !blocked(city, car.x, ny, CAR_RADIUS);
    if (slideX && !slideY) {
      car.y = ny; // the wall runs along x: keep the sideways part of the travel
      car.speed *= 0.92;
    } else if (slideY && !slideX) {
      car.x = nx;
      car.speed *= 0.92;
    } else if (slideX && slideY) {
      car.x = nx;
      car.y = ny;
      car.speed *= 0.55;
    } else {
      car.speed *= 0.1;
      car.drift = 0;
    }
    // The car body takes the hit, and so does whoever is sitting in it.
    const impact = Math.abs(prevSpeed) - Math.abs(car.speed);
    if (impact > CRASH_SPEED * 0.5) {
      events |= damageCar(player, car, Math.min(24, impact * 0.05));
      if (ctx.audio && typeof ctx.audio.play === 'function') ctx.audio.play('crash');
    }
  } else {
    car.x = nx;
    car.y = ny;
  }
  car.axis = Math.abs(Math.sin(car.angle)) > 0.7 ? 'v' : 'h';

  player.x = car.x;
  player.y = car.y;
  player.angle = car.angle;
  player.speed = Math.abs(car.speed);
  player.vx = Math.cos(travel) * car.speed;
  player.vy = Math.sin(travel) * car.speed;

  // Tyre marks: handbrake, hard cornering at speed, or a real slide all lay rubber.
  const slip = travelGap > DRIFT_MARKS || (handbrake && Math.abs(car.speed) > maxSpeed * 0.15);
  if (slip || Math.abs(car.speed) > maxSpeed * 0.45) {
    const travelled = car.speed * dt;
    player.carMileage += Math.abs(travelled);
    if (player.carMileage >= TYRE_MARK_GAP || slip) {
      player.carMileage = 0;
      layMarks(city, car, car.x, car.y);
    }
  }

  // Running over people is a crime, and it hurts them.
  const peds = ctx.peds || [];
  if (Math.abs(car.speed) > 60) {
    for (let i = 0; i < peds.length; i += 1) {
      const ped = peds[i];
      if (!ped || ped.state === 'down' || ped.struck) continue;
      if (Math.hypot(ped.x - car.x, ped.y - car.y) > Math.max(car.w, car.h) * 0.6) continue;
      ped.struck = true;
      ped.hp = (ped.hp === undefined ? 100 : ped.hp) - Math.abs(car.speed) * 0.25;
      car.speed *= 0.82;
      if (ped.hp <= 0) {
        ped.hp = 0;
        ped.state = 'down';
        ped.timer = 8;
        events |= crime(player, CRIMES.pedKill);
      } else {
        ped.state = 'flee';
        ped.timer = 5;
        events |= crime(player, CRIMES.pedHit);
      }
    }
  }

  // Ramming a police car brings heat.
  const police = ctx.police || [];
  for (let i = 0; i < police.length; i += 1) {
    const pc = police[i] && police[i].car;
    if (!pc || pc === car || pc.hp === undefined) continue;
    if (Math.hypot(pc.x - car.x, pc.y - car.y) > (car.w + pc.w) * 0.5) continue;
    pc.hp -= Math.max(4, Math.abs(prevSpeed) * 0.08);
    car.speed *= 0.7;
    if (!pc.rammed) {
      pc.rammed = 1.2;
      events |= crime(player, CRIMES.ramPolice);
    }
    if (pc.hp <= 0) {
      pc.hp = 0;
      pc.driver = null;
      events |= crime(player, CRIMES.copKill);
    }
  }

  if (ctx.audio && typeof ctx.audio.setEngine === 'function') {
    ctx.audio.setEngine(true, Math.abs(car.speed) / maxSpeed);
  }
  return events;
}

function heldHandbrake(input) {
  const state = input.state;
  if (!state) return false;
  return !!(state.space || state.spacebar || state.handbrake);
}

// Car damage lands on the driver (armour first, then hp) and can be fatal.
function damageCar(player, car, amount) {
  if (car) car.hp = Math.max(0, (car.hp === undefined ? 100 : car.hp) - amount);
  return hurt(player, amount * 0.6);
}

// ---------------------------------------------------------------------------------------------
// Damage and pickups
// ---------------------------------------------------------------------------------------------

// Shared with entities/police by re-export: armour soaks damage first, then hp.
export function hurt(player, amount) {
  if (player.dead || amount <= 0) return 0;
  player.hurtFlash = 0.35;
  if (player.armour > 0) {
    const soak = Math.min(player.armour, amount * 0.75);
    player.armour -= soak;
    amount -= soak;
  }
  player.hp = Math.max(0, player.hp - amount);
  if (player.hp <= 0) {
    player.dead = true;
    return EVENT_WASTED;
  }
  return 0;
}

function updatePickups(player, city, dt, events, ctx) {
  const pickups = player.pickups;
  for (let i = 0; i < pickups.length; i += 1) {
    const pick = pickups[i];
    if (!pick.active) {
      pick.timer -= dt;
      if (pick.timer <= 0) pick.active = true;
      continue;
    }
    if (player.onFoot === false) continue; // you cannot rummage a lamp post from a moving car
    if (Math.hypot(pick.x - player.x, pick.y - player.y) > PICKUP_RANGE) continue;
    if (pick.kind === 'health') {
      if (player.hp >= 100) continue;
      player.hp = Math.min(100, player.hp + 25);
    } else {
      if (player.armour >= 100) continue;
      player.armour = Math.min(100, player.armour + 50);
    }
    pick.active = false;
    pick.timer = PICKUP_RESPAWN;
    events |= EVENT_PICKUP;
    if (ctx.audio && typeof ctx.audio.play === 'function') ctx.audio.play('pickup');
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------------------------

export function updatePlayer(player, input, dt, ctx) {
  ctx = ctx || {};
  const city = ctx.city || player.city || null;
  player.city = city;
  let events = 0;

  if (player.dead) {
    // A wasted body stays where it fell: no movement, but the timers still drain so the pickup
    // and cooldown state is sane if the run is saved.
    if (ctx.audio && typeof ctx.audio.setEngine === 'function') ctx.audio.setEngine(false, 0);
    return 0;
  }
  if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);
  if (player.hurtFlash > 0) player.hurtFlash = Math.max(0, player.hurtFlash - dt);

  // Getting in or out of a car.
  const toggle = pressed(input, 'enter') || pressed(input, 'exit');
  if (toggle) {
    if (player.onFoot) {
      const car = nearestCar(ctx.cars, player.x, player.y, ENTER_RANGE);
      if (car) events |= enterCar(player, car, ctx, events);
    } else {
      events |= exitCar(player, events);
    }
  }

  if (player.onFoot) {
    walk(player, input, dt, city);
    aimAt(player, input, ctx);
    updateWeapon(player, input, dt, ctx, events);
    if (ctx.audio && typeof ctx.audio.setEngine === 'function') ctx.audio.setEngine(false, 0);
  } else {
    // Aim in a car follows the nose: you cannot lean out of the window here.
    player.aim = player.angle;
    events |= drive(player, input, dt, ctx, events);
    if (player.hp <= 0) {
      events |= EVENT_WASTED;
      // The car is left behind, engine off, when the driver goes down at the wheel.
      if (player.car) {
        player.car.speed = 0;
        player.car.driver = null;
        player.car = null;
        player.onFoot = true;
        if (ctx.audio && typeof ctx.audio.setEngine === 'function') ctx.audio.setEngine(false, 0);
      }
    }
  }

  events |= updatePickups(player, city, dt, events, ctx);
  updateWanted(player, city, ctx.police, dt);

  // Busted: the cops standing right beside a stopped player take them in.
  if (player.wanted >= 3 && player.speed < 30 && policeHasSight(city, ctx.police, player.x, player.y)) {
    events |= evaluateBust(player, ctx);
  }

  if (player.hp <= 0 && !player.dead) {
    player.dead = true;
    events |= EVENT_WASTED;
  }
  return events;
}

// Close-range arrest: a cop within arm's length of a stopped, badly outnumbered player.
function evaluateBust(player, ctx) {
  const police = ctx.police || [];
  let close = 0;
  for (let i = 0; i < police.length; i += 1) {
    const cop = police[i];
    if (!cop) continue;
    const ox = cop.state === 'foot' && cop.officer ? cop.officer.x : cop.car ? cop.car.x : cop.x;
    const oy = cop.state === 'foot' && cop.officer ? cop.officer.y : cop.car ? cop.car.y : cop.y;
    if (Math.hypot(ox - player.x, oy - player.y) < 48) close += 1;
  }
  if (close < 2) return 0;
  return EVENT_BUSTED;
}
