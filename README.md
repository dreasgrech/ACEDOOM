# ACEDOOM

DOOM (1993) running inside the Assetto Corsa EVO HUD as a UI app, loaded by the [ACE UI App Loader](https://github.com/dreasgrech/ACEUIAppLoader) and built on its library.

A showcase of how far a UI app can be pushed: a real game engine rendered through the game's own Cohtml UI, with no executable, no injected process and no game file replaced on disk. **This repository is GPL-2.0**, because the DOOM module it ships is.

## Installing

With the loader installed, this app is a folder and an empty marker file:

```
Saved Games\ACE\mods\uiresources\ACEUIAppLoader\doom\
Saved Games\ACE\Video\ACEUIAppLoader-doom.settingspreset
```

For the sounds, one more file — a package that swaps DOOM's effects into the game's own UI sound bank, because a Cohtml page cannot play audio at all:

```
Saved Games\ACE\mods\ACEUIAppLoader-doom.kspkg
```

It is optional. Without it DOOM is silent and everything else works. With it, the livery editor's paint and sticker sounds become DOOM's for as long as it is installed — see [`docs/sound.md`](docs/sound.md).

Then press `Insert` in the car.

## Controls

| Key | Does |
|---|---|
| `Insert` | show / hide the panel (hidden = paused). Off by default. |
| `Delete` | DOOM's Escape (menu). The real Escape is left alone: it pauses the sim and reloads the HUD page. |
| arrows | move / turn |
| `Ctrl`, or left mouse button on the screen | fire |
| `Space`, or right mouse button on the screen | use (doors, switches) |
| `Shift` | run |
| `,` `.` | strafe left / right |
| `Tab` | automap |
| `Enter`, `Backspace`, letters, digits | as in DOOM (menus, `y`/`n`, cheats) |

The `-` / `+` header buttons scale the panel (1 to 4, default 2 = 640 × 400 pixels), `x` hides it, and the header drags it. Position, open state and scale are remembered like every other app. The footer shows tics/s and frames shown/s.

Save Game and Load Game work, and **a saved game survives quitting the game** — see [`docs/saving.md`](docs/saving.md).

## Building it

Only needed to change the module or the sounds; the shipped files are committed.

```
python tools/build_module.py              # wasm2js over doom.wasm -> doom/doomjs.js  (needs binaryen)
python tools/build_wasm.py                # rebuild the module with the audio imports (needs wasi-sdk 24)
python tools/extract_sounds.py            # the 55 shareware effects out of the WAD as WAV
python tools/build_audio.py --install     # patch gui.bank, write the table override, pack, install
python <ACEUIAppLoader>/tools/install_app.py doom   # the loose half; needed after the line above
python -m unittest discover -s tests -v
```

**The sound path ships in two halves and both are needed.** `gui.bank` and `system/gui_events.table` are packed into the mod package; `doom/audiomap.js` is a loose app file. They are generated from the same `audio/sounds.json`, and installing one without the other is silent and reads exactly like a sound bug — with a stale map the host asks for the event types it used to use, whose samples are stock again, so DOOM's pistol comes out as Kunos' spray gun. [`docs/sound.md`](docs/sound.md) is the full account of how the audio reaches the game and what it cost to find out.

The FMOD Studio project is Kunos' SDK template and is **not** committed (`.gitignore` excludes `audio/fmod/project/`); copy it in from the SDK to rebuild the bank. Changing a sound means running **ACEDOOM ▸ 2. Add sounds and build** in Studio first, then the two commands above.

## Layout

```
doom/                  the shipped app: app.json, doom.js (the host), png.js, saves.js,
                       audiomap.js, doom.css, and doomjs.js (generated, 7 MB)
third_party/doom.wasm  the module as released upstream (4.4 MB); not shipped -- the game cannot run it
audio/sounds.json      which DOOM sound goes into which stock sample slot, and which event types carry them
tools/
  build_module.py      wasm2js + rewrite into the classic script the game can run
  build_wasm.py        rebuilds the module with DOOM's audio calls exported
  extract_sounds.py    pulls the DS* lumps out of the shareware WAD
  patch_bank.py        swaps samples inside the game's gui.bank, keeping every event intact
  build_audio.py       generates the Studio script and audiomap.js, packs the bank package
  build_table.py       overrides system/gui_events.table, to reach FMOD events no GUI type maps
tests/
  test_app.py          the loader's shared kit plus this app's contract
  harness.html         the real module in a headless browser: boot, 40 frames, a frame
                       decoded back and compared pixel for pixel, keys, pause, scale, detach
dev/
  preview.html         the app outside the game -- open the file, press Insert
  saveprobe.html       drives DOOM's own menus to produce a real saved game and measure it
docs/                  see below
```

## Documentation

| | |
|---|---|
| [`docs/how-it-works.md`](docs/how-it-works.md) | no WebAssembly, no `putImageData`, no `data:` URLs over 2 KB — how a frame reaches the screen anyway |
| [`docs/saving.md`](docs/saving.md) | the host save contract, and two module quirks that look like bugs |
| [`docs/sound.md`](docs/sound.md) | why the sounds live inside the game's own UI bank, and which stock sample each one replaced |

## Licences and attributions

Copyright (C) 2026 Andreas Grech. **This repository is GPL-2.0** -- the full text is in
[`LICENSE`](LICENSE). It is not a free choice: the DOOM module this ships is GPL-2.0, and
everything distributed with it goes the same way.

The host (`doom.js`), the PNG encoder (`png.js`), the CSS and every tool in `tools/` are ours,
and are GPL-2.0 as part of this work. Everything else, with its source:

- **DOOM engine.** `third_party/doom.wasm` and the generated `doom/doomjs.js` are GPL-2.0. They are [jacobenget/doom.wasm](https://github.com/jacobenget/doom.wasm) v0.1.0 (which vendors [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric), over id Software's DOOM source, GPL-2.0). Because the module is GPL-2.0, so is this repository. The module's **corresponding source is not vendored here** -- it is at that pinned upstream release, and [`third_party/README.md`](third_party/README.md) says what that means for anyone redistributing this.
- **DOOM shareware WAD** (`DOOM1.WAD`), embedded in the module: the levels, sprites, sound effects and music. Copyright id Software, Inc., freely distributable as the shareware data. jacobenget's build fetches it from `https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad`.
- **Sound effects**: the `DS*` lumps `tools/extract_sounds.py` pulls from that shareware WAD. id Software. Extracted lumps are not the shareware archive, so they are never committed: `audio/sfx/`, `audio/sfx44/` and `audio/sfx_padded/` are all gitignored and regenerate from the player's own WAD.
- **Music** (E1M1 etc.): the OGG renders from [farrelke/console-doom](https://github.com/farrelke/console-doom) (ISC wrapper). The compositions are the DOOM soundtrack by Bobby Prince, copyright id Software; the shareware tracks are the freely distributable ones.
- **Build tools** (needed only to rebuild, not shipped): [WASI SDK 24](https://github.com/WebAssembly/wasi-sdk) (clang 18.1.2, Apache-2.0 with LLVM exceptions) and [Binaryen version_123](https://github.com/WebAssembly/binaryen) (`wasm2js`, Apache-2.0).
- **FMOD** Studio 2.03.13 and FMOD Engine, Firelight Technologies Pty Ltd, `https://www.fmod.com/download`. Proprietary FMOD EULA; used to author the bank; not redistributed here.
- **Kunos FMOD modding template and `gui.bank`**: the FMOD Studio project the bank is built from and the game's own UI bank we override, both from the Assetto Corsa EVO SDK. Kunos Simulazioni. Excluded from the repo (`.gitignore`), copy from the SDK to rebuild.

"DOOM" is a registered trademark of ZeniMax Media Inc.; this app is unaffiliated and unapproved.
