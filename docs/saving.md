# Saving

DOOM's Save Game / Load Game menus work, and a save survives quitting the game.

Upstream leaves saving to the host, which is the only reason this is possible: there is
no file system in a UI page. The three `gameSaving` imports are the whole contract.

Two quirks of the module are worth knowing, because both look like bugs:

- it asks for a 30000-byte buffer and reports its whole **capacity** as the length, not
  the part it filled (a measured E1M1 save uses 25349 of those bytes);
- it compares what the host returns against that same length and treats a mismatch as a
  write error, so `writeSaveGame` returns what it was handed, not what we chose to keep.

The load menu also re-reads every slot in full each time it opens, because the 24-byte
description it lists lives at the front of the save.

**Why the bytes are compacted.** The engine's container re-serialises every key whenever
anything saves, and `ui_storage.uistorage` is only about 17 kB before we add to it. Six
slots of raw base64 would be a quarter of a megabyte. `doom/saves.js` is therefore LZSS
then base64, hand-rolled because this engine has neither `btoa` nor `CompressionStream`:

| | |
|---|---|
| 30000 zero bytes | 468 characters |
| a real E1M1 save (30000 bytes, 25349 used) | **7120 characters** |
| incompressible data (worst case) | 1.5x the input |

So six full slots come to roughly 43 kB. A slot over 20000 characters, or a total over
96000, is kept in memory but never stored, rather than being allowed to bloat the file.

`dev/saveprobe.html` is the rig that measured this: it boots the real module in a headless
browser, drives DOOM's own menus (New Game, episode, skill, then Save Game, slot, name) and
reports the resulting blob. Note that `reportKeyDown` sets a **pressed-key cache** that the
module diffs once a tic, so a key pressed and released within one turn is never seen - the
probe holds each key across several frames.

The engine key/value container is what reaches disk; `localStorage` is what survives
the HUD page reload on Escape and resume. A save goes to both.
