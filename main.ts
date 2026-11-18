// A working gta6-01 entry (Node 22, standard library only): the game is this directory's
// game/ folder, plain static files a desktop browser loads offline (game/index.html and its ES
// modules, no library and no network request), and the program hands it in. It copies game/ and
// screenshots/ from beside this file to /output and writes /output/dossier.json, the summary the
// judge reads, with the vendored make.fun library. Only the plumbing, not an open world: Block
// Dodger, a plain 2D canvas game where a paddle dodges falling blocks and catches coins, with a
// title screen, score, lives and levels, game over and restart, flat colours and no sound. Build
// your own open-world crime game in its place (three.js or any library you vendor under game/),
// put your 3 or 4 PNG or JPEG screenshots in screenshots/ (the first by name is the cover) and run it.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** Refuse the run: one line on stderr, then exit 1 (no stack trace, no partial entry). */
function fail(message: string): never {
  process.stderr.write(`main.ts: ${message}\n`);
  process.exit(1);
}

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const gameIn = join(here, 'game');
const shotsIn = join(here, 'screenshots');

// The game is game/index.html and its modules; without it there is nothing to hand in.
const index = join(gameIn, 'index.html');
if (!existsSync(index) || !statSync(index).isFile()) fail(`no game/index.html beside this file (${index} is missing): the game's page at game/index.html is what the entry hands in`);

// The entry needs its renders: 3 or 4 PNG or JPEG files, the first by name the cover.
let shots: string[] = [];
if (existsSync(shotsIn) && statSync(shotsIn).isDirectory()) {
  shots = readdirSync(shotsIn, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name);
}
if (shots.length === 0) fail(`no screenshots in ${shotsIn}: put 3 or 4 PNG or JPEG renders of the game here (the first by name is the cover)`);

mkdirSync(out, { recursive: true });
cpSync(gameIn, join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
cpSync(shotsIn, join(out, 'screenshots'), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all, or a path under game/ over 1000 bytes: game/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
try {
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: 163840,
      screenshots: { max: 4, max_bytes: 262144 },
      game_max_files: 993,
      game_max_bytes: 50331648,
      game_path_max_bytes: 1000,
    }),
  );
} catch (err) {
  fail(`the entry in ${out} cannot be handed in: ${(err as Error).message}`);
}

process.stdout.write(`wrote ${out} (game/, screenshots/ and dossier.json)\n`);
