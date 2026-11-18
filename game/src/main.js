// Vice Fortuna: boot, screens and the one loop.
//
// ?seed=N builds the city (default 1). ?shot=NAME stages a screenshot scene instead of running the
// game: shots.js advances the real simulation with a scripted input log, then this file paints the
// result twice and sets window.__shotReady for the capture script.
//
// Screens: title, play, paused, wasted, busted. Input edges are read once per frame; the world then
// advances in fixed 1/60 s steps (at most MAX_STEPS per frame, so a stall never spirals). Faults go
// into the hidden #errors div, which the capture script greps.
import { buildCity } from './city.js';
import { createInput } from './input.js';
import { createPlayer, updatePlayer, EVENT_WASTED, EVENT_BUSTED, EVENT_MISSION } from './player.js';
import {
  spawnTraffic, updateTraffic,
  spawnPeds, updatePeds,
  spawnPolice, updatePolice,
  updateBullets, updateParticles,
} from './entities.js';
import { createRenderer } from './render.js';
import { drawHud } from './hud.js';
import { drawMinimap } from './minimap.js';
import { createMissions, updateMissions } from './missions.js';
import { createAudio } from './audio.js';
import { createRng } from './rng.js';
import { stageShot } from './shots.js';

const VIEW_W = 1280;
const VIEW_H = 720;
const STEP = 1 / 60;
const MAX_STEPS = 5;
/** A frame longer than this (a hidden tab, a breakpoint) is dropped rather than replayed. */
const MAX_FRAME = 0.25;
const SAVE_KEY = 'vice-fortuna-save';
const TRAFFIC = 40;
const PEDS = 60;
const POLICE = 6;
const MAP_RADIUS = 74;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const SCREEN_TITLE = 'title';
const SCREEN_PLAY = 'play';
const SCREEN_PAUSED = 'paused';
const SCREEN_WASTED = 'wasted';
const SCREEN_BUSTED = 'busted';

// ---------------------------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------------------------
const errors = document.getElementById('errors');

function reportError(message) {
  if (!errors) return;
  const line = String(message || 'unknown error');
  errors.textContent = errors.textContent ? `${errors.textContent}\n${line}` : line;
  errors.style.display = 'block';
  errors.hidden = false;
  errors.classList.add('show');
}

window.addEventListener('error', (event) => {
  const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
  reportError((event.message || 'script error') + where);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportError(`unhandled rejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
});

// ---------------------------------------------------------------------------------------------
// Boot arguments and dependencies
// ---------------------------------------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) && seedParam > 0 ? seedParam : 1;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const city = buildCity(seed);
const renderer = createRenderer(canvas);
const missions = createMissions(city);
const audio = createAudio();
const input = createInput(canvas);

// One generator per spawn family, all from the seed: the same seed gives the same traffic, crowd
// and patrol, and tuning one stream never shifts another.
const spawnRng = () => createRng(seed);
const bullets = [];
const particles = [];

let player;
let cars;
let peds;
let police;

// The single frame state every module reads. Fields are reassigned, never reallocated.
const state = {
  city,
  player: null,
  cars: null,
  peds: null,
  police: null,
  bullets,
  particles,
  missions,
  audio,
  input,
  screen: SCREEN_TITLE,
  clock: 0,
  dt: STEP,
  camera: null,
  shake: 0,
  bannerTime: 0,
};

function seedWorld() {
  player = createPlayer(city);
  cars = spawnTraffic(city, spawnRng(), TRAFFIC);
  peds = spawnPeds(city, spawnRng(), PEDS);
  police = spawnPolice(city, spawnRng(), POLICE);
  state.player = player;
  state.cars = cars;
  state.peds = peds;
  state.police = police;
}

function seedMissions() {
  missions.index = 0;
  missions.stage = 0;
  missions.done = false;
  missions.dialogue = null;
  missions._queue = null;
  missions._started = false;
  missions.banner = missions.list[0].title;
  missions.bannerTimer = 4;
  const first = missions.list[0].stages[0];
  missions.marker = { x: first.x, y: first.y };
}

seedWorld();
seedMissions();

// The renderer letterboxes 1280x720 to the window and sizes a capped-DPR backing store.
function resize() {
  renderer.resize();
}
resize();
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------------------------
// Save / load: {x,y,money,wanted,missionIndex,hp,weapon,ammo} under one localStorage key.
// ---------------------------------------------------------------------------------------------
function hasSave() {
  try {
    return !!window.localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
}

function saveGame() {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({
      x: player.x,
      y: player.y,
      money: player.money,
      wanted: player.wanted,
      missionIndex: missions.index,
      hp: player.hp,
      weapon: player.weapon,
      ammo: player.ammo,
    }));
    return true;
  } catch {
    return false; // private window or full quota: the run lasts this visit only
  }
}

function loadGame() {
  let data = null;
  try {
    data = JSON.parse(window.localStorage.getItem(SAVE_KEY) || 'null');
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') return false;
  if (Number.isFinite(data.x) && Number.isFinite(data.y)) {
    player.x = data.x;
    player.y = data.y;
    player.lastSafe = { x: data.x, y: data.y };
  }
  if (Number.isFinite(data.money)) player.money = data.money;
  if (Number.isFinite(data.wanted)) player.wanted = Math.max(0, Math.min(5, data.wanted));
  if (Number.isFinite(data.hp) && data.hp > 0) player.hp = Math.min(100, data.hp);
  if (typeof data.weapon === 'string') player.weapon = data.weapon;
  if (Number.isFinite(data.ammo)) player.ammo = Math.max(0, data.ammo);
  // Missions resume at the saved job's first stage; updateMissions rebuilds the stage state.
  if (Number.isInteger(data.missionIndex) && data.missionIndex >= 0 && data.missionIndex < missions.list.length) {
    const job = missions.list[data.missionIndex];
    missions.index = data.missionIndex;
    missions.stage = 0;
    missions.done = false;
    missions.dialogue = null;
    missions._queue = null;
    missions._started = false;
    missions.banner = job.title;
    missions.bannerTimer = 4;
    missions.marker = { x: job.stages[0].x, y: job.stages[0].y };
  }
  return true;
}

/** A fresh run from the top: every actor rebuilt from the seed, the world cleaned. */
function newGame() {
  seedWorld();
  seedMissions();
  bullets.length = 0;
  particles.length = 0;
  if (Array.isArray(city.marks)) city.marks.length = 0;
  state.clock = 0;
  state.bannerTime = 0;
  state.shake = 0;
  state.dt = STEP;
  accumulator = 0;
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------
/** Advance the world one fixed step; returns the OR of every module's event bits. */
function simStep(dt) {
  let events = 0;
  events |= updatePlayer(player, input, dt, state);
  events |= updateTraffic(cars, dt, city, player, particles);
  events |= updatePeds(peds, dt, city, player, particles);
  events |= updatePolice(police, dt, city, player, bullets, particles);
  events |= updateBullets(bullets, dt, city, player, peds, cars);
  updateParticles(particles, dt);
  events |= updateMissions(missions, state, dt);
  input.endFrame();
  state.clock += dt;
  return events;
}

/** Title screen: the city lives behind the overlay, but the player stands still. */
function idleStep(dt) {
  updateTraffic(cars, dt, city, player, particles);
  updatePeds(peds, dt, city, player, particles);
  updateParticles(particles, dt);
  input.endFrame();
  state.clock += dt;
}

function setScreen(screen) {
  state.screen = screen;
  if (screen !== SCREEN_PLAY) audio.setEngine(false, 0);
  if (screen === SCREEN_WASTED || screen === SCREEN_BUSTED) state.bannerTime = 0;
}

function onEvents(events) {
  if (events & EVENT_WASTED) {
    setScreen(SCREEN_WASTED);
    audio.play('crash');
  } else if (events & EVENT_BUSTED) {
    setScreen(SCREEN_BUSTED);
  } else if (events & EVENT_MISSION) {
    audio.play('pickup');
  }
}

// ---------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------
/** Screen space: the renderer leaves the context in 1280x720 logical units. */
function setScreenSpace() {
  ctx.setTransform(canvas.width / VIEW_W, 0, 0, canvas.height / VIEW_H, 0, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawWorld() {
  renderer.draw(state);
  setScreenSpace();
  drawHud(ctx, state);
  // Bottom-left, clear of the health/armour plate (whose bars sit at y = VIEW_H - 84).
  drawMinimap(ctx, state, 24 + MAP_RADIUS, VIEW_H - 84 - 22 - MAP_RADIUS, MAP_RADIUS);
  if (state.screen !== SCREEN_PLAY) drawOverlay();
}

function text(str, x, y, size, colour, weight = '600') {
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillText(str, x, y);
}

function drawOverlay() {
  const screen = state.screen;
  const dim = screen === SCREEN_TITLE ? 'rgba(18, 22, 30, 0.62)' : 'rgba(14, 16, 22, 0.6)';
  setScreenSpace();
  ctx.fillStyle = dim;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';

  if (screen === SCREEN_TITLE) {
    text('VICE FORTUNA', VIEW_W * 0.5, 246, 84, '#ffd27a', '800');
    ctx.fillStyle = 'rgba(255, 160, 90, 0.9)';
    ctx.fillRect(VIEW_W * 0.5 - 230, 268, 460, 3);
    text('a sun-soaked coast city that keeps its secrets', VIEW_W * 0.5, 302, 20, '#f4e6c8', '500');
    const rows = [
      ['WASD / ARROWS', 'walk, drive'],
      ['SHIFT', 'run · SPACE handbrake'],
      ['F / ENTER', 'get in and out of a car'],
      ['1 / 2', 'fists or pistol · LEFT MOUSE fire'],
      ['E', 'talk, page a line'],
      ['P / ESC', 'pause · F5 saves'],
    ];
    let y = 366;
    for (const [key, what] of rows) {
      ctx.textAlign = 'right';
      text(key, VIEW_W * 0.5 - 24, y, 15, '#ffcf7f', '700');
      ctx.textAlign = 'left';
      text(what, VIEW_W * 0.5 + 24, y, 15, '#d9cbb0', '400');
      y += 26;
    }
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(state.clock * 4);
    text('PRESS ENTER TO START', VIEW_W * 0.5, 578, 24, '#fff1d0', '700');
    ctx.globalAlpha = 1;
    if (hasSave()) text('C TO CONTINUE', VIEW_W * 0.5, 614, 17, '#ffb066', '600');
  } else if (screen === SCREEN_PAUSED) {
    text('PAUSED', VIEW_W * 0.5, 300, 64, '#ffd27a', '800');
    text('F5  SAVE        ENTER  RESUME        E  TITLE', VIEW_W * 0.5, 352, 17, '#e6d7bb', '600');
  }
  // wasted / busted: hud.js draws the banner over the world.
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------------------------
// Screens: one read of the frame's input edges, before any step
// ---------------------------------------------------------------------------------------------
function handleFrameInput() {
  const screen = state.screen;
  const pause = input.pressed('pause');
  const confirm = input.pressed('enter');
  const save = input.pressed('save');

  if (screen === SCREEN_PLAY) {
    if (pause) setScreen(SCREEN_PAUSED);
    else if (save) saveGame();
    // Everything else (fire, interact, weapon, enter/exit) is left for the player's step.
    if (!pause) return;
  } else if (screen === SCREEN_PAUSED) {
    if (save) saveGame();
    else if (pause || confirm) setScreen(SCREEN_PLAY);
    else if (input.pressed('interact')) setScreen(SCREEN_TITLE);
  } else if (screen === SCREEN_TITLE) {
    if (confirm) {
      newGame();
      setScreen(SCREEN_PLAY);
      audio.resume();
    } else if (input.state.c) {
      input.state.c = false;
      if (loadGame()) {
        setScreen(SCREEN_PLAY);
        audio.resume();
      }
    }
  } else if (confirm) {
    // wasted or busted
    newGame();
    setScreen(SCREEN_PLAY);
  }
  input.endFrame();
}

// F5 is a save everywhere it makes sense, and it also stops the browser reloading the page.
// Handled on the key event so a step cannot clear the edge before this menu reads it.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'F5') return;
  if (state.screen !== SCREEN_PLAY && state.screen !== SCREEN_PAUSED) return;
  event.preventDefault();
  saveGame();
});

// Leaving the tab pauses a running game rather than playing on unseen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.screen === SCREEN_PLAY) setScreen(SCREEN_PAUSED);
});

/** Any gesture may unlock audio; the first click or key is enough. */
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------
let accumulator = 0;
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.min((now - last) / 1000, MAX_FRAME);
  last = now;

  handleFrameInput();

  const screen = state.screen;
  if (screen === SCREEN_PLAY || screen === SCREEN_TITLE) {
    // The accumulator loop: at most MAX_STEPS (5) steps run per frame, so it never runs more than five.
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_STEPS) {
      accumulator -= STEP;
      steps += 1;
      state.dt = STEP;
      if (state.screen === SCREEN_PLAY) onEvents(simStep(STEP));
      else idleStep(STEP);
      if (state.screen !== SCREEN_PLAY && state.screen !== SCREEN_TITLE) break;
    }
    // Still more than a step behind after MAX_STEPS: drop the backlog instead of spiralling.
    if (accumulator >= STEP * MAX_STEPS) accumulator = 0;
  } else {
    accumulator = 0;
    if (screen === SCREEN_WASTED || screen === SCREEN_BUSTED) state.bannerTime += elapsed;
  }

  drawWorld();
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------
/** Paint `paints` whole frames, then signal the capture script. */
function readyAfter(paints) {
  let left = paints;
  function tick() {
    left -= 1;
    if (left > 0) {
      requestAnimationFrame(tick);
      return;
    }
    window.__shotReady = true;
  }
  requestAnimationFrame(tick);
}

function bootShot(name) {
  // The scene advances the real simulation; draw() and simStep() are the same functions the loop
  // uses, so the captured frame is what live play would show.
  stageShot(name, state, simStep, drawWorld);
  drawWorld();
  readyAfter(2);
}

if (shot) {
  bootShot(shot);
} else {
  requestAnimationFrame(frame);
}

// The world on the console (and for the capture script); harmless in normal play.
window.viceFortuna = { state, city, missions, renderer, saveGame, loadGame, hasSave };
