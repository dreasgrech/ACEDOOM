# How it works

DOOM (1993) rendered through the game's own Cohtml UI, with no executable
and no game file touched. Five problems had to be solved; none of them the ones you would expect.


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
- **Saving works.** doom.wasm has no file system, so it hands saving to its host
  through three imports: `writeSaveGame` gets the bytes, `sizeOfSaveGame` and
  `readSaveGame` have to give them back. `doom/doom.js` keeps DOOM's six slots in
  memory and `doom/saves.js` compacts them into text that goes to `localStorage`
  (which survives the HUD page reload on Escape/resume) and to the engine's
  key/value container (which reaches disk), so **a saved game survives closing the
  game**. See "Saving" below.
- **The host** is `doom/doom.js`: it loads that script from the app's own
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
