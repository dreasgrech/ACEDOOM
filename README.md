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
  becomes a Blob, the Blob an object URL that is set as the src of one `<img>`.
  The engine keeps the old picture until the new one is decoded, so nothing is
  hidden or swapped (two images toggled on `load` flickered in game: Cohtml
  fires `load` before the image is drawable). The next frame is presented once
  `load` arrives, or without waiting if load events stop coming for three
  frames. The module outputs 640x400 as doubled pixels; the
  encoder samples it back to 320x200 losslessly. Constant parts of the PNG are
  written once; a frame costs a pixel copy, an Adler-32 and a CRC-32.
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

## Licences

`third_party/doom.wasm` and the generated `doom/doomjs.js` are GPL-2.0 (id
Software's DOOM source as built by jacobenget/doom.wasm) and embed the freely
distributable DOOM shareware WAD. The host, encoder, stylesheet and tools in
this repository are ours. No sound: the module has none.
