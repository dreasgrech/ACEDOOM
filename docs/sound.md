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
- The host asks the game for the GUI event type whose sample is now a DOOM
  sound (`doom/audiomap.js`, generated from `sounds.json`): volume above 24 of
  127, at most 6 requests per frame.
- `tools/build_table.py` writes an override of `system/gui_events.table`, the
  file that maps a GUI type to an FMOD event and parameter. The effects need
  four parameters of `gui_navigation` that the stock table maps no type to, so
  the override claims four types it leaves unmapped. Both that file and
  `gui.bank` ride in the package, and both have to win the lookup.

**The effects and the music sit on different FMOD events, and that is the whole
design** -- see Music below for why, because it is the reason this mod was silent
for weeks.

| GUI type | event, param | stock sample | DOOM sound | also sent there |
|---|---|---|---|---|
| `GUI_MONEY_GAIN` | navigation 7 | `switch1` (0.29 s) | pistol | chaingun, shotgun, super shotgun |
| `GUI_MONEY_LOSS` | navigation 8 | `switch2` (0.27 s) | death gurgle | all deaths, pain grunts, oof |
| `GUI_SWITCH_OFF` | navigation 6 | shop item (1.33 s) | door slide | door close, blaze doors, switches, lifts |
| `GUI_SWITCH_ON` | navigation 5 | money whoosh (4.40 s) | barrel explosion | rocket blasts |
| `GUI_WARNING` | navigation 1 | `load` (1.58 s) | item pickup blip | weapon pickups |
| `GUI_PART_APPLY` | garage 4 | pneumatic wrench (3.52 s) | **music** (E1M1) | -- alone on its event |

Five effect groups. `gui_navigation` stops at param 8, so params 5-8 are claimed
through the table override, and `GUI_WARNING` (param 1) is borrowed from the stock
five -- it needs no claim, the stock table already maps it, so it costs the game's
warning sound and nothing else. The shotgun shares the weapons slot and pain shares
deaths, for want of two more parameters. The pickup blip is normalised to 90% peak;
at its own level it cannot be heard at all.

Side effect while installed: the livery editor's "part apply" plays DOOM music, the
warning sound is a pickup blip, and loading screens blip too (`load` is the
borrowed sample). The livery editor's paint, sticker and wheel sounds are **stock
again**, and so is every menu click but the warning: the four claimed types are
ones no stock line maps, so nothing else the game plays for itself changed. Every
game update that changes `gui.bank` or the table needs the package rebuilt
(`build_audio.py --install` does it from the installed game, and
`install_mod.py` after it -- see below).

## How much room is left

The binding constraint is **parameters on an event that is not `gui_garage`**,
because anything sharing the garage event evicts the music. There is exactly one
such event reachable, `gui_navigation`, and it has nine parameters:

| params | state |
|---|---|
| 0, 2, 3, 4 | the game's own menu clicks: scroll, select, confirm, cancel |
| 1 | **DOOM's pickups** (borrowed; was the warning sound) |
| 5-8 | **DOOM's four other effect slots** |
| 9+ | do not exist -- silent, tested |

So **four more slots exist, and each costs one stock menu sound.** Spending one
would give the shotgun its own sound back instead of sharing the pistol's. Taking
all four would mean every menu click in the game is a DOOM sound.

What is *not* the constraint: GUI types (eight garage types are free to remap, plus
three still unmapped), samples (31 in the bank), or our own bank, which holds
`shotgn`, `plpain`, `dorcls`, `sgcock`, `posit1` and `itemup` unused.

The one way to get slots for free would be another event with spare parameters. The
bank's strings hold six labels nothing accounts for (`gui_buy`, `gui_sell`,
`gui_level_up/down`, `gui_xp_gain/loss`), so such an event may exist. Finding it is
cheap and needs no listening, because the game logs every event name that does not
resolve: point spare types at guessed names and any name absent from the log is
real. Ten names can be tested in one launch.

## Music

The dedicated UI music bus (`gui/gui_music`) is faded to zero during a driving
session, so tracks routed there play only in menus, never in the HUD while racing.
What plays music **in-session** is the same trick as the effects: `sounds.json`
`musicSwaps` puts `d_e1m1` (103 s) into the pneumatic-wrench sample, and the host
fires `GUI_PART_APPLY` when a DOOM level starts, re-firing every 103 s to loop.
That garage slot is the only one that plays a sample of that length to its end,
and the garage bus is not faded.

**`gui_garage` carries nothing else, and that is the design.** An FMOD event holds
a small pool of instances and steals the oldest when it fills. A 103 s instance is
permanently the oldest thing in its pool, so while DOOM's effects shared the garage
event, its gunfire evicted the music within a frame or two -- audible effects,
silent music. That is what the mod did from the day music was added until
2026-09-17, and no amount of rate-limiting would have fixed it: any cap still
leaves the music first out whenever the pool fills.

Proven rather than reasoned (`snippets/musicburst.js`): streaming effects at DOOM's
own six-a-frame kills the music when they go to a garage type and leaves it playing
when the identical stream goes to `gui_navigation`. The game emits no
`UIAudioResponseEvent` for any of it, so the ear is the only instrument.

One track for every level: there is one slot of that length, so all nine map to
E1M1. The FMOD project now builds `d_e1m1`-`d_e1m9`, so the samples are ready if a
second long slot is ever found. Closing the panel cannot cut the current instance;
the host only stops re-firing.

## What the game's UI audio actually is

Worth stating plainly, because most of it took a launch each to learn.

**A page asks for a GUI event type**, and `system/gui_events.table` -- a TableData
protobuf inside `content.kspkg` -- maps that type to an FMOD event, a bank and a
parameter value. **A packed mod can override that table**, which
`tools/build_table.py` does. Confirmed in game on 2026-09-17.

**Only three events are mapped**, and the types are parameters of them:

| event | params | GUI types |
|---|---|---|
| `gui/gui_navigation` | 0-4 | `GUI_SCROLL`, `GUI_WARNING`, `GUI_SELECT`, `GUI_CONFIRM`, `GUI_CANCEL` |
| `gui/gui_garage` | 0-7 | the eight garage types |
| `gui/gui_music` | 0-2 | the three music types |

So the five click types are **one event**, not five. The other `gui_*` strings in
the bank -- `gui_switch_on`, `gui_money_gain`, `gui_level_up`, `gui_buy`, `gui_sell`,
`gui_xp_*` -- are **parameter labels, not events**. Pointing a table line at
`gui/gui_switch_on` makes the game say so:

    [audio] [warning] event not found event:/gui/gui_switch_on
    [audio] [error]   AudioEvent initInstance: description null for ...

That failure is a gift: **the log names every event that does not exist**, so
candidate event names can be tested in bulk with no listening at all. Any name
absent from the log is real.

**`gui_navigation` has nine parameters, not five.** Params 5-8 play; 9 and 10 are
silent. The stock table uses 0-4, so 5-8 are reachable only by claiming types the
stock table leaves unmapped (`GUI_SWITCH_*`, `GUI_MONEY_*`, `GUI_LEVEL_*`), which
costs nothing the game plays for itself.

**The parameter-to-sample map, measured by ear** -- there is no other way, and
`patch_bank.py` swaps by sample name, so this is the map the whole mod rests on:

| param | stock sample | used by |
|---|---|---|
| 0, 2, 3 | short menu clicks | the game |
| 1 | `load` (1.58 s) | **DOOM pickups** |
| 4 | `cancel` (1.57 s) | the game |
| 5 | `039716271-money-bonus-whoosh` (4.40 s) | **DOOM explosions** |
| 6 | `281953171-uimvmt_ui-card-menu-shop-item-` (1.33 s) | **DOOM doors** |
| 7 | `switch1` (0.29 s) | **DOOM weapons** |
| 8 | `switch2` (0.27 s) | **DOOM deaths and pain** |

`199746459-money-prize` and `125068160-level-e` are reached by no parameter at all.
Two tools exist for filling in that map: `alsoSamples` puts one DOOM sound into
every sample a param might play, so the slot is right whichever it is; `probes`
puts a *different* sound in each, so one run names them. Params 1 and 6 were both
guessed wrong before `probes` settled them.

## Things that cost a launch to learn

**The two halves ship by different routes.** `gui.bank` and `gui_events.table` are
packed; `doom/audiomap.js` is a loose mod file. They are generated from the same
`sounds.json`, and installing one without the other is silent and reads exactly
like a sound bug -- with a stale map the host asks for the types it used to use,
whose samples are stock again, so DOOM's pistol comes out as Kunos' spray gun.
`build_audio.py --install` prints a reminder; run `install_mod.py` after it.

**Both overrides must win, not either.** The bank without the table plays DOOM's
samples on types nothing fires; the table without the bank fires types whose
samples are still Kunos'. `tune_dups.py` scores with `require="all"` for this
package (and needs `package_name`, since load order decides who wins and it
otherwise assumes the loader's filename). Measured 2026-09-17: **128 records**,
100% of 48 selection sets and 24/24 held out.

**Every sample carries its own rate.** DOOM's effects are 11 kHz and its music
44.1 kHz, so reading an FSB5 with one bank-wide rate understates the effects more
than four-fold. `patch_bank.py` did exactly that in its report until 2026-09-17,
turning a 0.202 s sample into "0.05 s" -- which invented a length problem that was
never there and cost two rebuilds.

**The pickup blip failed on level, not length.** DOOM's `itemup` peaks at 15% of
full scale where its gunfire peaks at 100%, and it was inaudible at 0.202 s and,
after padding, at 0.550 s in the same slot that plays a 0.530 s clack perfectly
well. `normalize` in `sounds.json` brings a sound to a given peak, taken from the
44.1 kHz 16-bit source in `audio/sfx44` so the gain does not amplify 11 kHz 8-bit
quantisation noise with it. Measure amplitude before theorising about length.

**FMOD Studio keeps events and cannot delete them.** The script skips any event
that already exists, and `ManagedObject.delete` is not in 2.03.13's scripting API
("TypeError: not a function"), so a sound whose name stays the same can never be
updated: a prepared file changed on disk while the project quietly kept serving the
old one. Prepared sounds are therefore named `<sfx>_<hash of source and settings>`,
so every revision arrives as a new event, which the script does handle. Old events
accumulate in the project, unused and harmless.

**The stock samples are a fixed budget.** 31 in `gui.bank`: 13 music tracks on the
faded bus, 7 garage, 11 on `gui_navigation`. Nothing a mod ships can add to it --
the game builds its UI events once at startup from five fixed banks and never loads
a mod's bank, which is why samples are swapped inside Kunos' file at all.
