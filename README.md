<div align="center">

# ACE DOOM

**DOOM (1993), playable on the HUD of Assetto Corsa EVO.**<br>

</div>

<p align="center">
<img width="2560" height="1440" alt="20B00A~1" src="https://github.com/user-attachments/assets/d111f19a-d5c3-4123-9180-0fec4ce8955b" />
</p>

The real DOOM engine, rendered through the game's own UI. No executable, no injected process, no
game file replaced. Press a key in the car and it opens in a panel you can drag, scale and hide;
your saved games survive quitting the sim.

<p align="center">
<img width="768" height="432" alt="ace21_cmp_R_768_4s_single" src="https://github.com/user-attachments/assets/ab991e95-d2b0-4a44-88c4-2418bc3decdb" />
</p>

---

## Installing the ACEDOOM app

> [!WARNING]
> This is an app for the [ACE UI App Loader](https://github.com/dreasgrech/ACEUIAppLoader) mod so that needs to be installed (a single file) as well.


<table>
<tr><td width="40" align="center"><h3>1</h3></td><td>

Download the **`ACEDOOM-….zip`** from the [latest release](../../releases/latest) and open it.
Inside are two folders, `mods` and `Video`.

</td></tr>
<tr><td align="center"><h3>2</h3></td><td>

Press <kbd>Win</kbd> + <kbd>R</kbd>, paste this in, press <kbd>Enter</kbd>:

```
%USERPROFILE%\Saved Games\ACE
```

</td></tr>
<tr><td align="center"><h3>3</h3></td><td>

Drag **both** folders out of the zip into that window. If Windows asks, choose to **merge**.
Nothing to run.

</td></tr>
</table>

**Sound is optional.** A UI page cannot play audio, so DOOM's effects come through the game's
own UI sound bank instead. For that, also download **`ACEDOOM-sound-….zip`** from the same
release and install it the same way: drag its `mods` folder into that window, merge. While it
is installed, the livery editor's paint and sticker sounds are DOOM's too. Without it, DOOM is
silent and everything else works.

In the car, press <kbd>Insert</kbd>. DOOM is also listed in the app drawer (mouse to the right
edge of the screen) with its own switch and an **OPTIONS** button.

<p align="center">
<img width="486" height="322" alt="DOOM running on the ACE HUD" src="https://github.com/user-attachments/assets/6bc8cc0a-3882-4274-850c-0fd0b5e756d7" />
</p>

---

## Controls

| Key | Does |
|---|---|
| <kbd>Insert</kbd> | show / hide (hidden is paused) |
| <kbd>Delete</kbd> | DOOM's menu. The real <kbd>Esc</kbd> is left to the sim. |
| arrows | move / turn |
| <kbd>Ctrl</kbd> or left click | fire |
| <kbd>Space</kbd> or right click | use |
| <kbd>Shift</kbd> | run |
| <kbd>,</kbd> <kbd>.</kbd> | strafe |
| <kbd>Tab</kbd> | automap |
| letters, digits, <kbd>Enter</kbd> | as in DOOM: menus, `y`/`n`, cheats |

The header drags the panel; its `-` / `+` buttons scale it and `x` hides it. Save Game and
Load Game work from DOOM's own menu.

<p align="center">
<img width="2560" height="1440" alt="207B17~1" src="https://github.com/user-attachments/assets/6ea1e6a1-1c76-4aa3-a384-27779058d80d" />
</p>

---

## If something isn't right

<details>
<summary><b>It isn't in the app drawer</b></summary><br>

1. **The loader isn't installed**, or its drawer doesn't appear at all. Start with the
   [loader's own help](https://github.com/dreasgrech/ACEUIAppLoader#if-something-isnt-right).
2. **Only one of the two folders was copied.** The app needs both: the folder under `mods`
   and the small file under `Video`. That file must stay completely empty.

</details>

<details>
<summary><b>No sound, or the wrong sounds</b></summary><br>

The sound zip is a separate download; without it DOOM is silent. If the pistol sounds like a
spray gun, the sound zip and the app zip are from different releases: install both from the
same one.

</details>

<details>
<summary><b>Anything else</b></summary><br>

Open an [issue](../../issues) with the newest file from `Saved Games\ACE\Logs`.

</details>

---

## Uninstalling

Delete the `doom` folder under `Saved Games\ACE\mods\uiresources\ACEUIAppLoader`, the
`ACEUIAppLoader-doom.settingspreset` file under `Saved Games\ACE\Video`, and, if you installed
the sound package, `ACEUIAppLoader-doom.kspkg` under `Saved Games\ACE\mods`. Clear the save
slots from **OPTIONS** first if you want them gone too.

---

## Licence and attributions

**This repository is GPL-2.0** ([`LICENSE`](LICENSE)): the
DOOM module it ships is GPL-2.0, so everything distributed with it is too. The host, the PNG
encoder, the CSS and the tools are ours under the same licence. Everything else:

- **DOOM engine**: [jacobenget/doom.wasm](https://github.com/jacobenget/doom.wasm) v0.1.0, over
  [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric) and id Software's DOOM source, GPL-2.0.
  Its corresponding source is at that upstream release, not vendored here; see
  [`third_party/README.md`](third_party/README.md).
- **DOOM shareware WAD**, embedded in the module, and the **sound effects** extracted from it:
  copyright id Software, freely distributable as the shareware data. Extracted lumps are never
  committed.
- **Music**: OGG renders from [farrelke/console-doom](https://github.com/farrelke/console-doom)
  (ISC wrapper); the soundtrack is Bobby Prince's, copyright id Software.
- **Build tools**, not shipped: [WASI SDK 24](https://github.com/WebAssembly/wasi-sdk) and
  [Binaryen](https://github.com/WebAssembly/binaryen) (Apache-2.0); FMOD Studio (Firelight
  Technologies, proprietary EULA, used to author the bank); Kunos' FMOD template and `gui.bank`
  from the Assetto Corsa EVO SDK, excluded from the repo.

"DOOM" is a registered trademark of ZeniMax Media Inc.; this app is unaffiliated and unapproved.

<div align="center">
<sub>ACE DOOM 0.6.0 · needs ACE UI App Loader 0.23.0 or newer</sub>
</div>
