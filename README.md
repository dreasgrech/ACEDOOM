# ACEDOOM

DOOM (1993) running inside the Assetto Corsa EVO HUD as a UI mod, loaded by the
[ACEUIModLoader](../ACEUIModLoader) and built on its library. A showcase of how
far a UI mod can be pushed: a real game engine rendered through the game's own
Cohtml UI, with no executable and no game file touched.

## How it works

- **The game** is [jacobenget/doom.wasm](https://github.com/jacobenget/doom.wasm)
  v0.1.0 (`third_party/doom.wasm`): the id Software DOOM source (GPL-2.0) built
  as a plain WebAssembly module with the shareware `DOOM1.WAD` embedded. No
  Emscripten, no WASI: ten small imports (frame callback, clock, logging, WAD
  and save hooks) and four exports (`initGame`, `tickGame`, `reportKeyDown`,
  `reportKeyUp`).
- **No WebAssembly in the game.** The UI middleware ships V8 9.4, which has
  WebAssembly, but Cohtml starts it with `--noexpose_wasm`: `WebAssembly` is
  undefined on every page (confirmed in game). So `tools/build_module.py` runs
  binaryen's wasm2js over the module and ships the result as `doom/doomjs.js`
  (7 MB, committed): the same code as plain JavaScript, JIT-compiled by V8,
  defining one global `ACEDoomModule(imports)` that returns the exports.
- **The host** is `doom/doom.js`: it loads that script from the mod's own
  folder, instantiates the module, runs `tickGame()` at DOOM's 35 Hz from the
  loader's shared frame loop and feeds it a clock that only advances while the
  panel is open, so hiding the panel pauses the game. DOOM busy-waits on that
  clock inside a single tick (TryRunTics, the screen melt), so the clock jumps a
  tic ahead after 50 reads within one call; without that the page hangs.
- **Pixels.** The game's Cohtml has a canvas but no `putImageData`/`ImageData`,
  and its URL parser caps `data:` URLs at 2048 characters. What it does have is
  `Blob`, `URL.createObjectURL` and a PNG decoder. So `doom/png.js` turns each
  frame into a truecolour PNG with stored (uncompressed) deflate blocks, the PNG
  becomes a Blob, the Blob an object URL on the src of an `<img>`. Cohtml blanks
  an image the moment its src changes and draws the new picture a frame or two
  later, and its `load` event fires before that, so both a single image and two
  images swapped on `load` flickered in game. What works: two stacked images,
  the hidden one at `opacity: 0` (still rendered, so its texture is ready)
  receives the frame and is revealed two animation frames after its `load`.
  `ACEDoom.tune({ swapDelay, waitForLoad })` changes that from the dev console.
  The module outputs 640x400 as doubled pixels; the encoder samples it back to
  320x200 losslessly. Constant parts of the PNG are written once; a frame costs
  a pixel copy, an Adler-32 and a CRC-32, about 1 ms, and shows at 29 fps.
- **Keys.** While the panel is open, keyboard events are mapped to DOOM keys and
  swallowed at the page level (the sim still sees them natively). The module
  exports its key codes, so the mapping is read from it at start; modifiers are
  matched by legacy keyCode (both the generic and the left/right codes) and by
  name. Keys DOOM cannot use are logged a few times as `unmapped key:` lines so
  the engine's codes can be learnt from the game log.

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

The `-` / `+` header buttons scale the panel (1 to 4, default 2 = 640 x 400
pixels), `x` hides it; the header drags it. Position, open state and scale are
remembered like the other mods. The footer shows tics/s and frames shown/s.

## Layout

- `doom/` - the shipped mod, exactly what lands in
  `Saved Games\ACE\mods\uiresources\ACEUIModLoaderMods\doom\`: `mod.json`
  (version, styles, scripts, files), `png.js`, `doom.js`, `doom.css`,
  `doomjs.js` (generated, 7 MB).
- `third_party/doom.wasm` - the module as released upstream (4.4 MB), the input
  of `tools/build_module.py`. Not shipped: the game cannot run it.
- `tools/build_module.py` - wasm2js + rewrite into the classic script above.
  Needs a binaryen release (`--wasm2js <path>` or `WASM2JS`); nobody else does.
- `tests/test_mod.py` - the loader's shared test kit plus this mod's contract
  (the wasm import section matches the imports the host provides, the generated
  script is a classic script defining the factory, blob URLs only, Escape never
  taken, the legalised clock).
- `tests/harness.html` - runs the real module in a headless browser: encoder
  checks, boot, 40 frames at 35 Hz, a shown frame decoded back and compared
  pixel for pixel with the module's buffer, keys, pause, scale, detach.
- `dev/preview.html` - the mod outside the game (Edge or Chrome, open the file,
  press Insert; the module is a script, so no server is needed).

## Install

With the loader package installed (`python tools/build_loader.py --install` in
the loader repo):

```
python ..\ACEUIModLoader\tools\install_mod.py doom
```

Escape and resume in the car reloads the HUD and picks up changes. In the game
log, lines start with `[DOOM]`: the script load and instantiate times, DOOM's
own start-up messages, then a `stats:` line every 5 s while the panel is open.

## Tests

```
python -m unittest discover -s tests -v
```

## Licences and attributions

The host (`doom.js`), the PNG encoder (`png.js`), the CSS and every tool in
`tools/` are ours. Everything else, with its source:

- **DOOM engine.** `third_party/doom.wasm` and the generated `doom/doomjs.js`
  are GPL-2.0. They are [jacobenget/doom.wasm](https://github.com/jacobenget/doom.wasm)
  v0.1.0 (which vendors [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric),
  over id Software's DOOM source, GPL-2.0). Because the module is GPL-2.0, this
  repo carries that licence and the corresponding source (the module input and
  the build tools below).
- **DOOM shareware WAD** (`DOOM1.WAD`), embedded in the module: the levels,
  sprites, sound effects and music. Copyright id Software, Inc., freely
  distributable as the shareware data. jacobenget's build fetches it from
  `https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad`.
- **Sound effects**: the `DS*` lumps `tools/extract_sounds.py` pulls from that
  shareware WAD. id Software.
- **Music** (E1M1 etc.): the OGG renders from
  [farrelke/console-doom](https://github.com/farrelke/console-doom) (ISC
  wrapper). The compositions are the DOOM soundtrack by Bobby Prince, copyright
  id Software; the shareware tracks are the freely distributable ones.
- **Build tools** (needed only to rebuild, not shipped):
  [WASI SDK 24](https://github.com/WebAssembly/wasi-sdk) (clang 18.1.2,
  Apache-2.0 with LLVM exceptions) and
  [Binaryen version_123](https://github.com/WebAssembly/binaryen) (`wasm2js`,
  Apache-2.0).
- **FMOD** Studio 2.03.13 and FMOD Engine, Firelight Technologies Pty Ltd,
  `https://www.fmod.com/download`. Proprietary FMOD EULA; used to author the
  bank; not redistributed here.
- **Kunos FMOD modding template and `gui.bank`**: the FMOD Studio project the
  bank is built from and the game's own UI bank we override, both from the
  Assetto Corsa EVO SDK (`C:\AssettoEvoSDKDocumentation`). Kunos Simulazioni.
  Excluded from the repo (`.gitignore`), copy from the SDK to rebuild.

"DOOM" is a registered trademark of ZeniMax Media Inc.; this mod is unaffiliated
and unapproved.

## Sound: through the game's own UI bank

A page cannot play audio in this Cohtml build (`<audio>` is not a media
element, `<video>` has no demuxers, no Web Audio), and the game never loads a
bank a mod names for its UI sounds: those events are created once at startup
from five fixed banks. So DOOM's sounds live **inside the game's UI bank**:

- `tools/build_wasm.py` rebuilds the module with three audio imports
  (`audio.onSoundStart(sfx, volume, sep)`, `onMusicStart`, `onMusicStop`)
  patched into DOOM's `I_StartSound`, `S_ChangeMusic` and `S_StopMusic`. Needs
  wasi-sdk 24 and a binaryen release; the result is committed.
- `tools/extract_sounds.py` writes the 55 shareware effects as WAV.
  `audio/fmod/project/` is Kunos's FMOD Studio 2.03.13 modding template (from
  the SDK) without its car samples; `tools/build_audio.py` generates
  `project/Scripts/acedoom.js`, a Studio menu script that follows Kunos's
  pipeline (clone the master bank, drop the template events) and imports the
  effects `audio/sounds.json` names, one event each. The project's Desktop
  encoding must be Vorbis, the format of the game's banks. That template is
  Kunos's SDK content, so it is not committed here (`.gitignore` excludes
  `audio/fmod/project/`): copy it in from the SDK to rebuild.
- `tools/patch_bank.py` rebuilds the sample container of the stock
  `content/sfx/gui.bank` with the livery-editor samples swapped for ours,
  keeping every event, name and index, and fixing the container sizes, the
  32-byte data alignment and the `SNDH` record that tells FMOD where the
  container is (each of those cost a silent launch). The stock menu clicks
  are untouched. `sounds.json` `musicSwaps` also replaces one long garage
  sample with a DOOM music track (see Music below).
- `build_audio.py --install` packs that `gui.bank` as
  `ACEUIModLoaderMods-doom.kspkg` through the loader's `pack_kspkg.py`, named
  to list after the loader package, padded so both overrides win. About
  150 MB, since the whole bank rides along.
- The host asks the game for the stock GUI event type whose sample is now a
  DOOM sound (`doom/audiomap.js`, generated from `sounds.json`): volume above
  24 of 127, at most 6 requests per frame. The livery-editor event plays seven
  samples, one per GUI type (the type-to-sample map was verified in game with
  `snippets/guisounddisc.js`; `GUI_PART_REMOVE` plays nothing), so six DOOM
  effects are heard and their relatives share the slot, and the seventh
  (`GUI_PART_APPLY`) carries the music.

| GUI type | stock sample | DOOM sound in its place | also sent there |
|---|---|---|---|
| `GUI_PAINT_APPLY` | paint spray gun | pistol | chaingun |
| `GUI_PAINT_REMOVE` | spray paint 07 | shotgun | super shotgun |
| `GUI_STICKER_APPLY` | can spray paint | door slide | door close, blaze doors, switches, lifts |
| `GUI_STICKER_REMOVE` | paper wrap | player pain grunt | oof, enemy pain |
| `GUI_PART_APPLY` | pneumatic wrench | **music** (E1M1) | -- carries the level track, see Music |
| `GUI_WHEEL_APPLY` | ext gun install | death gurgle | enemy and player deaths |
| `GUI_WHEEL_REMOVE` | ext gun remove | barrel explosion | rocket blasts |

The paper-wrap slot swallows samples shorter than about 0.2 s. The pickup
blip used to live in the pneumatic slot, but that slot now carries the music,
so the pickup sound is dropped. Imp fireball impacts are left silent because
they read as explosions.

Side effect while installed: the livery editor's paint, sticker, part and
wheel sounds are DOOM's (its "part apply" now plays DOOM music). Every game
update that changes `gui.bank` needs the package rebuilt (`build_audio.py
--install` does it from the installed game).

### Music

The dedicated UI music bus (`gui/gui_music`) is faded to zero during a driving
session, so tracks routed there play only in menus, never in the HUD while
racing. What plays music **in-session** is the same trick as the effects: a
DOOM track is swapped into a garage effect sample. `GUI_PART_APPLY` (the
pneumatic-wrench sample) is the one garage slot that plays its sample as a
one-shot to its full length; the menu-click slots truncate anything long. So
`sounds.json` `musicSwaps` puts `d_e1m1` (about 103 s) in that sample, and the
host fires `GUI_PART_APPLY` when a DOOM level starts, re-firing every 103 s to
loop. The garage effect bus is not faded and does not steal voices, so the
music and the six gunfire/door effects play together.

Limits, all properties of the game's audio engine rather than the mod:

- **One track for every level.** There is one garage slot, so all levels play
  E1M1. `sounds.json` maps E1M1-E1M9, but every entry currently points at E1M1
  (the deliberate experiment: any music heard is unmistakably ours). The
  intended final build fans them out per level.
- **No hard stop.** A UI sound cannot be stopped once fired, so closing the
  DOOM panel can leave the music playing for up to its ~103 s tail. The host
  stops re-firing on close; it cannot cut the current instance.
- **Demo screen thrash.** DOOM's attract/demo screen re-requests its music
  every frame. The host (`doom.js`) accepts a music start only for a track it
  has a slot for and only when nothing is already playing, ignores DOOM's stop
  requests, and stops only when the panel closes, so the loop starts once
  instead of restarting constantly.
