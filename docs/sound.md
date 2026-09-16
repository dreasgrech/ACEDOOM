# Sound

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
