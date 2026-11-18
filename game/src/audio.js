// All of Vice Fortuna's sound, synthesised at run time: no files, no network, no samples.
// Browsers refuse to start an AudioContext until the player has touched the page, so createAudio()
// only binds the unlock handlers and builds the node graph on the first key, click or touch.
// Every public call is a no-op before that, or when the context cannot be built.

const MASTER = 0.35, SIREN_LEN = 2.4; // master level; siren sweep length in seconds

/** A gain that fades in for `rise` then decays to silence over `dur`: every sound's envelope. */
function envelope(ctx, at, dur, level, rise) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + rise);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  return gain;
}

/** A noise burst through a resonant filter: the body of every impact. */
function burst(ctx, out, noise, at, dur, level, type, from, to, q) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur);
  const gain = envelope(ctx, at, dur, level, 0.008);
  src.connect(filter); filter.connect(gain); gain.connect(out);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** One oscillator with a pitch sweep and a decay envelope; the tail of every tonal sound. */
function tone(ctx, out, at, dur, level, type, from, to, cut) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cut;
  const gain = envelope(ctx, at, dur, level, 0.01);
  osc.connect(filter); filter.connect(gain); gain.connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  return osc;
}

export function createAudio() {
  let ctx = null;       // AudioContext, built on the first gesture
  let master = null;    // everything ends here
  let noise = null;     // the shared noise buffer
  let engine = null;    // the running car, while setEngine(true) holds
  let unlocked = false; // a real user gesture has happened; no context before it
  let missing = false;  // no AudioContext constructor: give up quietly, not once per call

  // The context only exists once the page has been touched; nothing here runs before that.
  function ensure() {
    if (missing) return null;
    if (ctx) {
      if (ctx.state === 'suspended') resumeContext();
      return ctx.state === 'closed' ? null : ctx;
    }
    if (!unlocked) return null;
    const Ctor = typeof globalThis !== 'undefined'
      ? (globalThis.AudioContext || globalThis.webkitAudioContext) : null;
    if (typeof Ctor !== 'function') { missing = true; return null; }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = MASTER; // everything rides this, so one gain silences the game
      master.connect(ctx.destination);
      const rate = ctx.sampleRate || 44100;
      noise = ctx.createBuffer(1, Math.floor(rate * 0.25), rate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      ctx = null; master = null; noise = null; missing = true; // stay silent for good
      return null;
    }
    return ctx.state === 'closed' ? null : ctx;
  }

  function resumeContext() {
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    try {
      const pending = ctx.resume();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* still blocked: stay silent */ }
  }

  // The engine: a low sawtooth and a detuned square through a resonant lowpass, plus a band of
  // noise that rises with speed. It runs continuously; only its levels and pitch move.
  // The engine voice: one oscillator pair (sawtooth plus a detuned square) on one shared envelope.
  function startEngine() {
    if (engine) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator(), sub = ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = 46;
    sub.type = 'square'; sub.frequency.value = 23;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 300; filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, now); // starts near its idling level; fades in under the key
    const hiss = ctx.createBufferSource();
    hiss.buffer = noise; hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass'; hissFilter.frequency.value = 900; hissFilter.Q.value = 0.8;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.015;
    osc.connect(filter); sub.connect(filter); filter.connect(gain); gain.connect(master);
    hiss.connect(hissFilter); hissFilter.connect(hissGain); hissGain.connect(master);
    osc.start(); sub.start(); hiss.start();
    engine = { osc, sub, filter, gain, hiss, hissGain };
  }

  function stopEngine() {
    const running = engine;
    engine = null;
    if (!running) return;
    const at = ctx.currentTime;
    for (const g of [running.gain.gain, running.hissGain.gain]) {
      g.cancelScheduledValues(at);
      g.setValueAtTime(0.0001, at); // silence first, then stop: never a click
    }
    for (const node of [running.osc, running.sub, running.hiss]) {
      try { node.stop(at + 0.05); } catch { /* already stopped */ }
    }
  }

  // Every one-shot lives in this table: named, tuned in one place, dispatched by play().
  const ONE_SHOTS = {
    shot(a) {
      burst(ctx, master, noise, a, 0.22, 0.5, 'bandpass', 2600, 300, 0.7);
      tone(ctx, master, a, 0.16, 0.5, 'square', 190, 45, 1800);
      tone(ctx, master, a + 0.02, 0.1, 0.18, 'sine', 120, 40, 600);
    },
    punch(a) {
      burst(ctx, master, noise, a, 0.12, 0.6, 'lowpass', 1400, 180, 0.5);
      tone(ctx, master, a, 0.11, 0.45, 'sine', 150, 48, 700);
    },
    swing(a) {
      burst(ctx, master, noise, a, 0.16, 0.22, 'bandpass', 900, 2200, 1.2);
    },
    crash(a) {
      burst(ctx, master, noise, a, 0.5, 0.55, 'lowpass', 3000, 120, 0.6);
      burst(ctx, master, noise, a + 0.04, 0.3, 0.25, 'highpass', 5000, 1800, 0.4);
      tone(ctx, master, a, 0.35, 0.4, 'triangle', 90, 30, 400);
      tone(ctx, master, a + 0.02, 0.2, 0.2, 'square', 240, 70, 900);
    },
    pickup(a) {
      // A two-note chime, an octave-fifths jump up, with a quiet third partial on top.
      tone(ctx, master, a, 0.09, 0.4, 'triangle', 880, 880, 4000);
      tone(ctx, master, a + 0.07, 0.2, 0.4, 'triangle', 1320, 1320, 5000);
      tone(ctx, master, a + 0.07, 0.14, 0.12, 'sine', 1760, 1760, 6000);
    },
    horn(a) {
      // Two horns a fifth apart, held for most of the note and then released together.
      const second = tone(ctx, master, a, 0.6, 0.28, 'square', 330, 315, 1800);
      tone(ctx, master, a, 0.6, 0.4, 'sawtooth', 220, 210, 1600);
      second.frequency.cancelScheduledValues(a + 0.54);
      second.frequency.setValueAtTime(315, a + 0.54);
      second.frequency.linearRampToValueAtTime(300, a + 0.6);
    },
    siren(a) {
      // A police two-tone wail: the pitch is stepped up and down across the whole sweep.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const gain = envelope(ctx, a, SIREN_LEN, 0.22, 0.15);
      osc.connect(gain); gain.connect(master);
      const span = SIREN_LEN / 8;
      for (let i = 0; i < 8; i += 1) {
        const high = i % 2 === 0;
        osc.frequency.setValueAtTime(high ? 900 : 620, a + i * span);
        osc.frequency.linearRampToValueAtTime(high ? 620 : 900, a + (i + 1) * span);
      }
      osc.start(a);
      osc.stop(a + SIREN_LEN + 0.05);
    },
    engine() { startEngine(); },
  };

  function play(name) {
    if (!ensure()) return;
    const recipe = ONE_SHOTS[name];
    if (typeof recipe === 'function') recipe(ctx.currentTime);
  }

  function setEngine(on, speed) {
    if (!ensure()) return;
    if (!on) { stopEngine(); return; }
    startEngine();
    const s = Number.isFinite(speed) ? Math.min(1, Math.max(0, speed)) : 0;
    const at = ctx.currentTime;
    const glide = 0.08;  // seconds for the pitch and levels to settle on the new speed
    engine.osc.frequency.setTargetAtTime(46 + s * 120, at, glide);
    engine.sub.frequency.setTargetAtTime(23 + s * 60, at, glide);
    engine.filter.frequency.setTargetAtTime(300 + s * 1500, at, glide);
    engine.gain.gain.setTargetAtTime(0.1 + s * 0.09, at, glide);
    engine.hissGain.gain.setTargetAtTime(0.015 + s * 0.07, at, glide);
  }

  function resume() {
    unlocked = true; // the gesture is what earns us a context
    if (ensure()) resumeContext();
  }

  // Listeners stay attached for good: browsers suspend a context again when the tab is hidden.
  const host = typeof globalThis !== 'undefined' ? globalThis : null;
  if (host && typeof host.addEventListener === 'function') {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      host.addEventListener(type, resume, { passive: true });
    }
  }

  return {
    play, setEngine, resume,
    get ready() { return !!ctx && ctx.state === 'running'; },
  };
}
