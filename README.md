# Vice Fortuna

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/bongekanjing/gta6-01-vivid-walrus-33/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/bongekanjing/gta6-01-vivid-walrus-33/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

An original open-world crime game in the spirit of GTA 6: Vice Fortuna, a sun-soaked coast city of
invented streets, cars, brands and people. Top-down, drawn entirely with canvas paths and fills, no
library and no network request. Drive, steal cars, take jobs from a fixer, draw a pistol and outrun a
five-star wanted level.

## What is in it

- A hand-built city map: a coastline, a grid of invented streets, blocks of buildings, parks and a
  beach, all drawn with canvas paths.
- Cars you can steal and drive, with acceleration, steering and a handbrake, plus traffic that
  follows the roads and other vehicles on them.
- Jobs from a fixer: talk to him with E, take a mission and complete its objective for cash.
- A five-star wanted level that rises as you commit crimes and decays when you lay low, with police
  responding at higher ratings.
- The whole look is canvas art: gradients, flat fills and simple shapes for people, cars, palm trees
  and the sky, with no image files at all.
- Dialogue with the fixer and his contacts, each speaker in a box with a shape-built portrait drawn
  from the same flat canvas pieces as the rest of the art.

## Play it

Open `game/index.html` in desktop Chrome, or serve the folder and play in the browser:

```sh
node serve.ts
```

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` to the output directory and writes `dossier.json`.

## Controls

WASD or the arrow keys walk and drive, Shift runs, Space is the handbrake or a punch, F gets in and
out of a car, 1 and 2 pick fists or the pistol, the left mouse button fires, E talks, Esc pauses, F5
saves.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
