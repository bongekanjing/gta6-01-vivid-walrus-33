// Keyboard and pointer input for Vice Fortuna.
//
// Held keys become an axis (WASD / arrows) and the held-key map; one-shot presses (enter, exit,
// fire, ...) are queued per frame and read with pressed(), then cleared by endFrame() once the
// simulation has run its steps. A press between two frames is never lost and never counted twice.
// The pointer is tracked in canvas coordinates so player.js can aim with it.
export function createInput(canvas) {
  // Code -> the action name player.js asks about. Key map: edge actions below are cleared once per step.
  const KEY_ACTIONS = new Map([
    ['Enter', 'enter'],
    ['KeyF', 'interact'],
    ['Space', 'fire'],
    ['KeyR', 'reload'],
    ['Digit1', 'weapon1'],
    ['Digit2', 'weapon2'],
    ['Escape', 'pause'],
    ['KeyP', 'pause'],
    ['F5', 'save'],
  ]);
  const HELD = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ShiftLeft', 'ShiftRight', 'Space',
    'KeyF', 'KeyR', 'Digit1', 'Digit2', 'Enter',
  ]);

  const state = Object.create(null); // held-key map, lowercased code without the "key" prefix
  const edge = new Set(); // actions pressed since the last endFrame()
  const mouse = { x: 0, y: 0, down: false, clicked: false };
  // 'enter' doubles as the car door key (F) and the confirm key (Enter): one name, two codes.
  const DOWN_TO = new Map([['Enter', 'enter'], ['KeyF', 'enter']]);

  function keyName(event) {
    return event.code ? event.code.replace(/^Key/, '').replace(/^Arrow/, '').toLowerCase() : String(event.key || '').toLowerCase();
  }

  function toCanvas(event) {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 1280, height: 720 };
    const w = rect.width || 1280;
    const h = rect.height || 720;
    mouse.x = ((event.clientX - rect.left) / w) * 1280;
    mouse.y = ((event.clientY - rect.top) / h) * 720;
  }

  window.addEventListener('keydown', (event) => {
    const name = keyName(event);
    state[name] = true;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') state.shift = true;
    if (event.code === 'Space') state.space = true;
    if (HELD.has(event.code)) event.preventDefault();
    // F5 keeps reloading the page unless we take it here; the game saves on it, as the spec says.
    if (event.code === 'F5') event.preventDefault();
    if (event.repeat) return;
    const action = KEY_ACTIONS.get(event.code);
    if (action) edge.add(action);
    const door = DOWN_TO.get(event.code);
    if (door) edge.add(door);
  });

  window.addEventListener('keyup', (event) => {
    const name = keyName(event);
    state[name] = false;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') state.shift = false;
    if (event.code === 'Space') state.space = false;
  });

  // A key released while the tab is hidden never sends keyup: let go of everything on blur.
  window.addEventListener('blur', () => {
    for (const key of Object.keys(state)) state[key] = false;
    mouse.down = false;
  });

  canvas.addEventListener('mousemove', toCanvas);
  canvas.addEventListener('mousedown', (event) => {
    toCanvas(event);
    mouse.down = true;
    mouse.clicked = true;
    edge.add('fire');
    event.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    mouse.down = false;
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  return {
    state,
    mouse,
    /** -1..1 from WASD / arrows, normalised so diagonals are not faster. */
    axis() {
      const x = (state.d || state.right ? 1 : 0) - (state.a || state.left ? 1 : 0);
      const y = (state.s || state.down ? 1 : 0) - (state.w || state.up ? 1 : 0);
      if (x !== 0 && y !== 0) {
        const k = Math.SQRT1_2;
        return { x: x * k, y: y * k };
      }
      return { x, y };
    },
    /** Shift held. */
    run() {
      return !!state.shift;
    },
    /** Edge-triggered: true once per press, for the actions in the contract. */
    pressed(action) {
      return edge.has(action);
    },
    /** Clear the edge set; main.js calls this once per simulation step. */
    endFrame() {
      edge.clear();
      mouse.clicked = false;
    },
  };
}
