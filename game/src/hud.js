// Vice Fortuna: the HUD in screen space on the 1280x720 frame. Bars, money, weapon and ammo, five
// wanted stars, the clock, the objective line, the dialogue box with a shape-built portrait, the
// opening control hints, and the wasted/busted banner. Flat shapes, no images, system sans only;
// type sits on dark plates so the warm cream stays readable over a bright beach.
const VIEW_W = 1280;
const VIEW_H = 720;
const C = {
  plate: 'rgba(20, 13, 22, 0.88)', panel: 'rgba(16, 10, 18, 0.72)', trough: 'rgba(26, 16, 26, 0.78)',
  cream: '#fdf0d3', dim: 'rgba(253, 240, 211, 0.62)', amber: '#f5b942', hot: '#ffd479',
  gold: '#f6c53c', oxblood: '#7a2a2e', hotox: '#c8323c', health: '#d84a4a', low: '#ff6a5c',
  armour: '#6fb8cf', money: '#bfe8a6', starOff: 'rgba(246, 197, 60, 0.22)', badge: '#5a74b8',
};
const FONT = (size, weight) => `${weight || 'bold'} ${size}px "Helvetica Neue", Arial, sans-serif`;
const HINT_HOLD = 14, HINT_FADE = 2.5, BANNER_IN = 0.35; // opening hints, then the banner settle
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// A rounded plate: every cluster of HUD text sits on one.
function plate(ctx, x, y, w, h, r, fill) {
  const rad = Math.min(r, h * 0.5, w * 0.5);
  ctx.fillStyle = fill || C.panel;
  ctx.beginPath();
  ctx.moveTo(x + rad, y); ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad); ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h); ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad); ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y); ctx.fill();
}

// Single-colour type, clipped with an ellipsis when it would run past maxWidth.
function label(ctx, text, x, y, size, colour, align, weight, maxWidth) {
  let t = String(text == null ? '' : text);
  ctx.font = FONT(size, weight);
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'alphabetic';
  if (maxWidth) {
    const room = Math.floor(maxWidth / (size * 0.56)) - 1;
    if (t.length > room) t = (room > 0 ? t.slice(0, room) : '') + '\u2026';
  }
  ctx.fillStyle = colour || C.cream;
  ctx.fillText(t, x, y);
}

// A horizontal bar: plate, trough, fill, bright lip.
function bar(ctx, x, y, w, h, value, max, colour) {
  const pct = clamp(max > 0 ? value / max : 0, 0, 1);
  plate(ctx, x - 3, y - 3, w + 6, h + 6, 4, C.trough);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(x, y, w, h);
  if (pct <= 0) return;
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, Math.max(2, w * pct), h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(x, y, Math.max(2, w * pct), 2);
}

// A five-point star path centred on cx, cy.
function star(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.44;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    else ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

// Bars, money, weapon, stars ----------------------------------------------------------------

function drawBars(ctx, player) {
  const hp = clamp(num(player.hp, 100), 0, 100), armour = clamp(num(player.armour, 0), 0, 100);
  const low = hp <= 30, x = 196, y0 = VIEW_H - 84;
  const beat = low ? 0.65 + 0.35 * Math.sin(num(player.hurtFlash, 0) * 9) : 1; // the low light beats
  plate(ctx, x - 40, y0 - 12, 300, 62, 8, C.panel);
  label(ctx, 'HP', x - 10, y0 + 10, 12, low ? C.low : C.dim, 'right');
  ctx.globalAlpha = beat;
  bar(ctx, x, y0, 190, 12, hp, 100, low ? C.low : C.health);
  ctx.globalAlpha = 1;
  label(ctx, 'AR', x - 10, y0 + 32, 12, C.dim, 'right');
  bar(ctx, x, y0 + 22, 190, 12, armour, 100, C.armour);
  label(ctx, String(Math.round(hp)), x + 202, y0 + 10, 13, C.cream);
  label(ctx, String(Math.round(armour)), x + 202, y0 + 32, 13, C.dim);
}

function drawMoney(ctx, player) {
  const text = '$' + Math.round(num(player.money, 0)).toLocaleString('en-US');
  const w = Math.max(104, text.length * 15.4 + 30), x = VIEW_W - 24 - w;
  plate(ctx, x, 18, w, 42, 6, C.panel);
  ctx.fillStyle = C.money;
  ctx.fillRect(x + 10, 24, 3, 30); // the wallet's spine
  label(ctx, text, x + w - 12, 48, 28, C.money, 'right');
}

function drawWeapon(ctx, player) {
  const pistol = player.weapon === 'pistol', x = 156, y = VIEW_H - 44;
  plate(ctx, x - 12, y - 18, 322, 30, 6, C.panel);
  // A silhouette of the weapon itself, so the slot reads before the number does.
  ctx.fillStyle = pistol ? C.dim : C.amber;
  if (pistol) {
    ctx.fillRect(x, y - 11, 22, 6); ctx.fillRect(x + 16, y - 5, 6, 10); ctx.fillRect(x + 4, y - 5, 4, 4);
  } else {
    ctx.fillRect(x, y - 10, 12, 12); ctx.fillRect(x + 12, y - 7, 8, 6);
  }
  label(ctx, pistol ? `${num(player.clip, 0)} / ${num(player.ammo, 0)}` : 'FISTS', x + 32, y + 4, 16, pistol ? C.hot : C.dim);
  label(ctx, pistol ? 'PISTOL' : 'FIST', x + 154, y + 4, 13, C.dim);
  if (pistol && num(player.reloading, 0) > 0) label(ctx, 'RELOAD', x + 236, y + 4, 12, C.amber);
}

// The stars painter: the wanted level is capped at 5, so five stars is the maximum drawn.
// The wanted stars painter: at three stars and up the lit stars flash.
function drawStars(ctx, player, clock) {
  const wanted = clamp(Math.floor(num(player.wanted, 0)), 0, 5);
  const left = VIEW_W - 24 - 5 * 30 + 4;
  const flash = wanted >= 3 ? 0.55 + 0.45 * Math.sin(clock * 7) : 1; // flashing from three stars up
  plate(ctx, left - 10, 66, 5 * 30 + 12, 36, 6, C.panel);
  for (let i = 0; i < 5; i += 1) {
    ctx.globalAlpha = i < wanted ? flash : 1;
    star(ctx, left + 6 + i * 30, 84, 13);
    ctx.fillStyle = i < wanted ? C.gold : C.starOff;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Heat cooling: a police-blue length under the stars that shrinks with the wanted timer.
  if (wanted > 0 && num(player.wantedTimer, 0) > 0) {
    ctx.fillStyle = C.trough;
    ctx.fillRect(VIEW_W - 174, 104, 150, 4);
    ctx.fillStyle = C.badge;
    ctx.fillRect(VIEW_W - 174, 104, 150 * clamp(num(player.wantedTimer, 0) / 12, 0, 1), 4);
  }
}

// Clock, objective, hints -------------------------------------------------------------------

function drawClock(ctx, state) { // a day from 07:00, two game minutes per real second, 24-hour
  const minutes = Math.floor((7 * 60 + num(state.clock, 0) * 2) % (24 * 60));
  const hh = Math.floor(minutes / 60), mm = minutes % 60;
  plate(ctx, VIEW_W * 0.5 - 62, 16, 124, 40, 6, C.panel);
  label(ctx, `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`, VIEW_W * 0.5, 45, 24, C.cream, 'center');
  ctx.fillStyle = C.amber;
  ctx.fillRect(VIEW_W * 0.5 - 26, 60, 52, 2); // a warm rule under the time
}

function drawObjective(ctx, state) {
  const m = state.missions;
  if (!m || !m.list || m.done) return;
  const job = m.list[m.index];
  const stage = job && job.stages[Math.min(m.stage, job.stages.length - 1)];
  if (!stage) return;
  const width = 470;
  plate(ctx, 20, 18, width, 62, 8, C.panel);
  ctx.fillStyle = C.gold;
  ctx.fillRect(20, 18, 5, 62); // a gold spine: the job line is the one thing that matters
  label(ctx, String(job.title || 'JOB').toUpperCase(), 38, 40, 13, C.gold, 'left', 'bold', width - 60);
  label(ctx, stage.text || '', 38, 62, 15, C.cream, 'left', '600', width - 30);
  label(ctx, `${m.stage + 1}/${job.stages.length}`, 12 + width, 40, 12, C.dim, 'right');
}

function drawHints(ctx, state) {
  const clock = num(state.clock, 0);
  if (clock > HINT_HOLD + HINT_FADE) return;
  const rows = [['WASD', 'walk'], ['SHIFT', 'run'], ['F', 'in / out of a car'],
    ['1 / 2', 'fists or pistol'], ['E', 'talk, page a line']];
  const x = 24, y = VIEW_H - 250;
  ctx.globalAlpha = clamp(clock <= HINT_HOLD ? 1 : 1 - (clock - HINT_HOLD) / HINT_FADE, 0, 1);
  plate(ctx, x - 10, y - 12, 200, rows.length * 22 + 24, 8, C.panel);
  label(ctx, 'PRESS', x, y + 4, 11, C.amber);
  for (let i = 0; i < rows.length; i += 1) {
    label(ctx, rows[i][0], x + 54, y + 24 + i * 22, 13, C.hot, 'right');
    label(ctx, rows[i][1], x + 66, y + 24 + i * 22, 13, C.dim);
  }
  ctx.globalAlpha = 1;
}

// Dialogue ----------------------------------------------------------------------------------

// One spare line of hair per face; everything else (backdrop, coat, neck, head, eyes) is shared.
function hair(ctx, cx, top, headR, kind) {
  const H = headR * 5; // the portrait side the proportions are drawn against
  if (kind === 'rue') { // the mechanic: a flat cap and a streak of oil
    ctx.fillStyle = '#3a2f26';
    ctx.beginPath(); ctx.arc(cx, top + H * 0.38, headR * 1.04, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillRect(cx - headR * 1.06, top + H * 0.372, headR * 2.12, 3);
    ctx.fillStyle = 'rgba(40, 32, 26, 0.7)'; ctx.fillRect(cx + headR * 0.2, top + H * 0.44, headR * 0.5, 2);
  } else if (kind === 'cole') { // the inspector: a fedora, collar and tie
    ctx.fillStyle = '#151a24';
    ctx.fillRect(cx - headR * 1.25, top + H * 0.365, headR * 2.5, 4);
    ctx.beginPath(); ctx.arc(cx, top + H * 0.35, headR * 0.72, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8e2d4'; ctx.beginPath();
    ctx.moveTo(cx - H * 0.1, top + H * 0.62); ctx.lineTo(cx + H * 0.1, top + H * 0.62);
    ctx.lineTo(cx + H * 0.05, top + H * 0.72); ctx.lineTo(cx - H * 0.05, top + H * 0.72); ctx.fill();
    ctx.fillStyle = C.hotox; ctx.fillRect(cx - 2, top + H * 0.62, 4, H * 0.1);
  } else { // Dex: slicked-back hair and a heavy brow
    ctx.fillStyle = '#2a1d1a';
    ctx.beginPath(); ctx.arc(cx, top + H * 0.405, headR * 1.02, Math.PI * 1.06, Math.PI * 1.94); ctx.fill();
    ctx.fillRect(cx - headR * 0.62, top + H * 0.4, headR * 1.24, 2);
  }
}

function drawPortrait(ctx, x, y, size, who) {
  const cx = x + size * 0.5, headR = size * 0.2, H = size;
  plate(ctx, x, y, size, size, 6, 'rgba(10, 6, 12, 0.9)');
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 4, y + 4, size - 8, size - 8); ctx.clip();
  ctx.fillStyle = 'rgba(120, 62, 58, 0.55)'; // a warm dusk wash...
  ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
  ctx.fillStyle = 'rgba(245, 185, 66, 0.35)'; // ...with a low sun behind the head
  ctx.beginPath(); ctx.arc(x + size * 0.72, y + size * 0.28, size * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = (who && who.coat) || '#3b2b4f'; // shoulders, wider than the frame so the bust sits in
  ctx.beginPath();
  ctx.moveTo(cx - H * 0.4, y + H); ctx.quadraticCurveTo(cx - H * 0.32, y + H * 0.66, cx, y + H * 0.64);
  ctx.quadraticCurveTo(cx + H * 0.32, y + H * 0.66, cx + H * 0.4, y + H); ctx.closePath(); ctx.fill();
  ctx.fillStyle = (who && who.skin) || '#c98f63';
  ctx.fillRect(cx - H * 0.07, y + H * 0.5, H * 0.14, H * 0.16); // neck
  ctx.beginPath(); ctx.arc(cx, y + H * 0.425, headR, 0, Math.PI * 2); ctx.fill(); // head
  hair(ctx, cx, y, headR, (who && who.portrait) || 'dexter');
  ctx.fillStyle = 'rgba(28, 20, 22, 0.9)'; // two dark eyes
  ctx.fillRect(cx - headR * 0.5, y + H * 0.42, headR * 0.3, 3); ctx.fillRect(cx + headR * 0.2, y + H * 0.42, headR * 0.3, 3);
  ctx.fillStyle = 'rgba(70, 30, 32, 0.75)'; // and a mouth slot
  ctx.fillRect(cx - headR * 0.28, y + H * 0.5, headR * 0.56, 2);
  ctx.fillStyle = 'rgba(20, 10, 16, 0.28)'; // shade down the left edge, so it is not a flat sticker
  ctx.fillRect(x + 4, y + 4, H * 0.16, H - 8);
  ctx.restore();
  ctx.strokeStyle = 'rgba(246, 197, 60, 0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
}

// Two lines at most: wrapped on words to the box width, the rest cut with an ellipsis.
function wrapLine(text, maxWidth, size) {
  const per = Math.max(8, Math.floor(maxWidth / (size * 0.52))), out = [];
  let line = '';
  const words = String(text || '').split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? line + ' ' + words[i] : words[i];
    if (next.length > per && line) { out.push(line); line = words[i]; } else line = next;
  }
  if (line) out.push(line);
  if (out.length > 2) out.length = 2;
  return out;
}

function drawDialogue(ctx, state) {
  const page = state.missions && state.missions.dialogue;
  if (!page) return;
  const w = 760, h = 150, x = (VIEW_W - w) * 0.5, y = VIEW_H - h - 26;
  plate(ctx, x, y, w, h, 10, C.plate);
  ctx.strokeStyle = 'rgba(246, 197, 60, 0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const size = 104;
  drawPortrait(ctx, x + 20, y + (h - size) * 0.5, size, page);
  const tx = x + 142, tw = w - 168;
  label(ctx, String(page.name || '?').toUpperCase(), tx, y + 34, 17, C.gold, 'left', 'bold', tw);
  ctx.fillStyle = 'rgba(246, 197, 60, 0.35)';
  ctx.fillRect(tx, y + 44, tw, 1);
  const lines = wrapLine(page.line, tw, 16);
  for (let i = 0; i < lines.length; i += 1) label(ctx, lines[i], tx, y + 72 + i * 24, 16, C.cream, 'left', '600', tw);
  // The advance prompt, blinking so it reads as a prompt and not a label.
  ctx.globalAlpha = 0.55 + 0.45 * Math.sin(num(state.clock, 0) * 4);
  plate(ctx, x + w - 118, y + h - 38, 100, 26, 5, 'rgba(246, 197, 60, 0.16)');
  label(ctx, 'E', x + w - 100, y + h - 19, 14, C.hot);
  label(ctx, 'advance', x + w - 84, y + h - 19, 12, C.dim);
  ctx.globalAlpha = 1;
}

// Banners -----------------------------------------------------------------------------------

// The job title card, driven by missions.banner/bannerTimer: small, under the clock.
function drawJobBanner(ctx, state) {
  const m = state.missions;
  if (!m || !(num(m.bannerTimer, 0) > 0) || !m.banner) return;
  ctx.globalAlpha = clamp(num(m.bannerTimer, 0) / 0.6, 0, 1);
  plate(ctx, VIEW_W * 0.5 - 200, 116, 400, 44, 8, C.panel);
  ctx.fillStyle = C.gold;
  ctx.fillRect(VIEW_W * 0.5 - 200, 116, 4, 44);
  label(ctx, String(m.banner), VIEW_W * 0.5, 136, 15, C.cream, 'center', 'bold', 370);
  label(ctx, `$${Math.round(num(m.money, 0)).toLocaleString('en-US')} JOB`, VIEW_W * 0.5, 153, 11, C.money, 'center');
  ctx.globalAlpha = 1;
}

function drawBanner(ctx, state) {
  // The screen decides, with the player's own flags as the fallback when no screen is given.
  const player = state.player || {}, screen = state.screen;
  const busted = screen === 'busted' || (screen !== 'wasted' && (player.busted || player.arrested));
  const wasted = screen === 'wasted' || (!busted && (player.dead || num(player.hp, 1) <= 0));
  if (!wasted && !busted) return;
  const rise = clamp(num(state.bannerTime, 1) / BANNER_IN, 0, 1), colour = busted ? C.badge : C.hotox;
  const h = 190, y = VIEW_H * 0.5 - h * 0.5 + (1 - rise) * 40, mid = y + h * 0.5;
  ctx.globalAlpha = rise;
  ctx.fillStyle = 'rgba(12, 7, 14, 0.62)';
  ctx.fillRect(0, y, VIEW_W, h);
  ctx.fillStyle = colour;
  ctx.fillRect(0, y, VIEW_W, 3);
  ctx.fillRect(0, y + h - 3, VIEW_W, 3);
  label(ctx, busted ? 'BUSTED' : 'WASTED', VIEW_W * 0.5, mid + 28, 78, colour, 'center');
  label(ctx, busted ? 'the precinct has your name' : 'the coast keeps its secrets', VIEW_W * 0.5, mid + 46, 14, C.dim, 'center', '600');
  label(ctx, 'PRESS ENTER', VIEW_W * 0.5, mid + 74, 12, C.dim, 'center');
  ctx.globalAlpha = 1;
}

// Draw the whole HUD over the world. `state` is main.js's frame state: {player, missions, clock,
// screen, ...}. Every read is defended, so a partial state still paints what it can.
export function drawHud(ctx, state) {
  if (!ctx) return;
  state = state || {};
  const player = state.player || {}, dead = state.screen === 'wasted' || state.screen === 'busted';
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  drawObjective(ctx, state);
  drawJobBanner(ctx, state);
  drawClock(ctx, state);
  drawMoney(ctx, player);
  drawStars(ctx, player, num(state.clock, 0));
  drawBars(ctx, player);
  drawWeapon(ctx, player);
  drawHints(ctx, state);
  if (!dead) drawDialogue(ctx, state); // the banner covers everything when it shows
  drawBanner(ctx, state);
  ctx.restore();
}
