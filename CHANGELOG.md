# Changelog

## 0.6.1 — 2026-09-25

Works with ACE UI App Loader 0.27.0's right-click for options; still runs on 0.23.0 or newer.

- A right-click on DOOM's screen stays "use": it no longer opens DOOM's options with loader 0.27.0.
- A right-click on DOOM's title bar opens its options; another closes them.
- A held fire or "use" lets go when the game window loses focus or DOOM is closed.
- A right tap while firing keeps the fire held; any other release lets the held key go.
- Update the sound zip with the app: `ACEDOOM-sound-0.6.1.zip` from the same release.

## 0.6.0 — 2026-09-21

First public release.

### Before the first release
- Sound through the game's UI sound bank, as a separate download; music and the item pickup sound.
- Save and load games, kept on disk.
- Options window, scale, and the Insert key to show and hide DOOM.
- Keyboard captured while DOOM is focused, so driving keys do not reach the game.
- Runs Doom Generic compiled to JavaScript, as the game's UI engine has no WebAssembly.
