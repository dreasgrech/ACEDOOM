# third_party

## `doom.wasm`

The DOOM engine as a WebAssembly module, with the shareware `DOOM1.WAD` embedded.
`tools/build_wasm.py` rebuilds it with ACEDOOM's three audio imports patched in, and
`tools/build_module.py` runs Binaryen's `wasm2js` over the result to produce
`doom/doomjs.js`. Both of those outputs are derived from this module, so both are
GPL-2.0, and so is this repository as distributed.

| | |
|---|---|
| upstream | [jacobenget/doom.wasm](https://github.com/jacobenget/doom.wasm), release **v0.1.0** |
| which vendors | [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric) |
| over | id Software's DOOM source |
| licence | GPL-2.0 (see [`../LICENSE`](../LICENSE)) |

### Corresponding source

GPL-2.0 section 3 requires that anyone given this binary can get the source it was
built from. **This repository does not vendor that source**; it is obtainable at the
upstream release above, which is pinned to an exact tag for that reason. If that
upstream ever becomes unreachable, whoever is distributing this repository is the one
who has to provide the source instead — the obligation follows the binary, not the
link. Vendoring `doomgeneric` here would settle it permanently and is the right move
before any wider release.

The build tools needed to go from that source to this module are named in the
repository README, with their own licences and exact versions.

## `DOOM1.WAD`

Not a file here: it is embedded inside `doom.wasm` by the upstream build, which fetches
it from `https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad`. Its contents
-- levels, sprites, sound effects and music -- are copyright id Software, Inc., and are
freely distributable *as the shareware data*.

That last distinction is why `audio/sfx/`, `audio/sfx44/` and `audio/sfx_padded/` are
all excluded from this repository by `.gitignore`. They hold `DS*` sound lumps that
`tools/extract_sounds.py` pulls out of the WAD, and one of them normalised and padded
by `tools/build_audio.py`: individual extracted lumps are not the shareware archive,
so they are regenerated from the player's own copy rather than shipped.
