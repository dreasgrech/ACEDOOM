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

**The effects and the music are on different FMOD events, and that is the whole
design.** An event holds a small pool of instances and steals the oldest when it
fills. The music is a 103 s instance, so it is permanently the oldest thing in
its pool: while the effects shared `gui_garage` with it, DOOM's gunfire evicted
the music within a frame or two -- audible effects, silent music, which is
exactly what the game did until 2026-09-17. Nothing on `gui_garage` now but the
track.

| GUI type | event, param | stock sample | DOOM sound | also sent there |
|---|---|---|---|---|
| `GUI_MONEY_GAIN` | navigation 7 | `switch1` (0.29 s) | pistol | chaingun, shotgun, super shotgun |
| `GUI_MONEY_LOSS` | navigation 8 | `switch2` (0.27 s) | death gurgle | all deaths, pain grunts, oof |
| `GUI_SWITCH_OFF` | navigation 6 | money prize (1.49 s) | door slide | door close, blaze doors, switches, lifts |
| `GUI_SWITCH_ON` | navigation 5 | money whoosh (4.40 s) | barrel explosion | rocket blasts |
| `GUI_PART_APPLY` | garage 4 | pneumatic wrench (3.52 s) | **music** (E1M1) | -- alone on its event, see Music |

Four effect groups, not six: `gui_navigation` stops at param 8, so the shotgun
shares the weapons slot and pain shares deaths. `GUI_WARNING` (param 1) is a
fifth slot that would unmerge one pair at the price of one stock menu sound; its
stock sample has never been identified. The pickup blip is still dropped. Every
DOOM effect sample is 0.05-0.39 s, so sample length -- what forced the music onto
a garage slot -- does not constrain the effects.

Side effect while installed: the livery editor's "part apply" plays DOOM music,
and four sounds the game does not currently use are DOOM's. Its paint, sticker
and wheel sounds are **stock again**, and so is every menu click: the four
claimed types are ones no stock line maps, so nothing the game plays for itself
changed. Every game update that changes `gui.bank` or the table needs the package
rebuilt (`build_audio.py --install` does it from the installed game).

### Music

The dedicated UI music bus (`gui/gui_music`) is faded to zero during a driving
session, so tracks routed there play only in menus, never in the HUD while
racing. What plays music **in-session** is the same trick as the effects: a
DOOM track is swapped into a garage effect sample. `GUI_PART_APPLY` (the
pneumatic-wrench sample) is the one garage slot that plays its sample as a
one-shot to its full length; the menu-click slots truncate anything long. So
`sounds.json` `musicSwaps` puts `d_e1m1` (about 103 s) in that sample, and the
host fires `GUI_PART_APPLY` when a DOOM level starts, re-firing every 103 s to
loop. The garage bus is not faded, and one effect alongside the music leaves it
playing.

**The music is still not audible in game, and the leading explanation is that
the effects evict it.** What is established: `GUI_PART_APPLY` on its own plays
E1M1 (`snippets/musiccheck.js`, in game); a single `GUI_PAINT_APPLY` plays the
pistol without stopping it; and firing `GUI_PART_APPLY` a second time
*restarts* the track, so that event keeps one instance and re-triggering steals
it. Reading the bank's strings, `gui_garage` is a **single event** -- all seven
garage types are parameter values of it -- while `gui_select`, `gui_confirm`,
`gui_scroll`, `gui_cancel`, `gui_warning` and the rest are separate events with
their own instances. One event with limited instances and oldest-stolen-first
would explain everything seen: the 103 s music is always the oldest thing in
that pool, so DOOM's stream of effects evicts it within a frame or two while
the effects themselves stay audible.

**Confirmed in game** (`snippets/musicburst.js`, 2026-09-17): streaming effects
at DOOM's own rate of six a frame kills the music when they go to a garage type,
and leaves it playing when the same stream goes to `GUI_SELECT`. The game sends
no `UIAudioResponseEvent` for any of it, so there is nothing to read; the ear is
the instrument.

So the fix is to take DOOM's six effects off `gui_garage` and leave it carrying
nothing but the music. Two things decide how far that can go, and the stock
bank's 31 samples say what there is to work with:

| non-garage sample | length | plausible event |
|---|---|---|
| `menu_rollover` | 0.09 s | scroll / rollover |
| `click.6` | 0.17 s | select |
| `switch2`, `switch1` | 0.27, 0.29 s | switch off / on |
| `confirm` | 0.79 s | confirm |
| `281953171-uimvmt_ui-card-menu-shop-item-` | 1.33 s | shop / card |
| `199746459-money-prize` | 1.49 s | money gain |
| `cancel` | 1.57 s | cancel |
| `load` | 1.58 s | loading |
| `039716271-money-bonus-whoosh` | 4.40 s | money bonus |
| `125068160-level-e` | 6.95 s | level up |

(The other eleven samples are 95-521 s music tracks on `gui_music`, the bus that
is faded to zero in-session -- which is why the music had to borrow a garage
slot in the first place, and why it still has to.)

The catch is reach, and the game's own `system/gui_events.table` (dumped with
`tools/build_table.py`) says exactly how far it goes: **only three events are
mapped at all.**

| event | params | GUI types |
|---|---|---|
| `gui/gui_navigation` | 0-4 | `GUI_SCROLL`, `GUI_WARNING`, `GUI_SELECT`, `GUI_CONFIRM`, `GUI_CANCEL` |
| `gui/gui_garage` | 0-7 | the eight garage types |
| `gui/gui_music` | 0-2 | the three music types |

So the five click types are **one event**, not five -- moving DOOM's effects
there would work (the music would be alone on `gui_garage`), but it would make
every menu click in the game a DOOM sound, and `gui_navigation`'s samples are
the short ones.

**A table override does reach the game, and it is read.** The first probe
(2026-09-17) pointed the six unmapped types at events named after the leftover
samples -- `gui/gui_switch_on`, `gui/gui_money_gain`, `gui/gui_level_up` -- and
the game logged, for each one:

    [audio] [warning] event not found event:/gui/gui_switch_on
    [audio] [error]   AudioEvent initInstance: description null for ...

which is the useful failure: the package won the lookup, the game parsed our
extra lines and tried to load exactly what they named. Those names are therefore
not events but **parameter labels**, the same way `gui_scroll` and `gui_cancel`
label `gui_navigation`'s params 0 and 4. `tools/build_table.py` is confirmed
working, and `system/gui_events.table` is confirmed overridable by a packed mod.

**`gui_navigation` has nine parameters, not five** (probe 2, 2026-09-17).
Params 5, 6, 7 and 8 all play a sample; 9 and 10 are silent, so the event ends
at 8. The stock table uses only 0-4, which leaves **four slots no GUI type
reaches** -- claimable with a table override without touching any sound the game
plays itself.

**And the music survives them.** In the same run, E1M1 was started on
`gui_garage` and `gui_navigation` was then streamed at six requests a frame,
DOOM's own limit: the music played on through it. Separate events, separate
instance pools, measured rather than argued -- which is the whole fix.

So the shape of the repair is settled:

- `gui_garage` keeps **only** the music, on `GUI_PART_APPLY`. Nothing is left in
  its pool to evict the 103 s instance.
- DOOM's effects move to `gui_navigation` params 5-8, claimed by four of the
  unmapped types through a `gui_events.table` override.
- Four slots for six effect groups, so either two groups merge, or one rarely
  heard stock param (`GUI_WARNING`, param 1) is borrowed to make five.
- Every DOOM effect sample is between 0.05 s and 0.39 s, so sample length --
  the thing that forced the music onto a garage slot in the first place -- does
  not constrain the effects at all.

The remaining unknown is small and purely mechanical: which stock sample each of
params 5-8 plays, since `patch_bank.py` swaps by sample name. The package will
then override two files (`gui.bank` and `system/gui_events.table`) and both must
win rather than either, so its record count wants re-measuring for the pair.
