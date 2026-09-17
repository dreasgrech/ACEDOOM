"""
build_wasm.py - build third_party/doom.wasm from the upstream jacobenget/doom.wasm
sources plus ACEDOOM's audio hooks, on Windows, without Docker or make.

Upstream builds with `make` inside the WASI SDK 24 Docker image and a locally
built Binaryen. This script replays the Makefile's recipe with the WASI SDK and a
Binaryen release unpacked anywhere on this machine:

  1. copy `doomgeneric/` and `src/` of the checkout into build/wasm/stage/ and
     patch three files there (the checkout itself is never touched):
       - i_sound.c: I_StartSound reports (sfx number, volume, separation) to the
         import audio.onSoundStart before the (absent) sound module is consulted;
       - s_sound.c: S_ChangeMusic reports audio.onMusicStart(music number,
         looping), S_StopMusic reports audio.onMusicStop();
     `-Wl,--import-undefined` turns those undefined functions into imports.
  2. embed the shareware WAD (taken from the module we already have, so nothing
     is downloaded) with upstream's utils/generate_code_for_embedded_file.py;
  3. compile every source with clang --target=wasm32-unknown-wasi, link as a
     reactor with --export-dynamic --import-undefined;
  4. post-link exactly like upstream: assemble the three .wat helpers, merge the
     WASI trampolines, merge the two init functions into initGame, strip every
     export not in reachability_graph_for_wasm-metadce.json, add the KEY_*
     globals;
  5. write third_party/doom.wasm and print its imports. Run
     tools/build_module.py afterwards to regenerate doom/doomjs.js.

Usage:
    python tools/build_wasm.py [--source <doom.wasm checkout>] [--wasi-sdk <dir>] [--binaryen <dir>]

Defaults: source ../doom.wasm (a sibling checkout), WASI_SDK and BINARYEN from the
environment. Tested with wasi-sdk 24.0 (clang 18.1.2) and binaryen version_123.
"""
import os
import shutil
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build", "wasm")
OUTPUT = os.path.join(ROOT, "third_party", "doom.wasm")

CFLAGS = ["--target=wasm32-unknown-wasi", "-Wall", "-g", "-Os"]
LDFLAGS = ["-Wl,--export-dynamic", "-Wl,--import-undefined", "-mexec-model=reactor"]
LIBS = ["-lm", "-lc"]
BINARYEN_FLAGS = ["--enable-bulk-memory"]

SRC_DOOM = ("dummy.c am_map.c doomdef.c doomstat.c dstrings.c d_event.c d_items.c d_iwad.c d_loop.c d_main.c "
            "d_mode.c d_net.c f_finale.c f_wipe.c g_game.c hu_lib.c hu_stuff.c info.c i_cdmus.c i_endoom.c "
            "i_joystick.c i_scale.c i_sound.c i_system.c i_timer.c memio.c m_argv.c m_bbox.c m_cheat.c "
            "m_config.c m_controls.c m_fixed.c m_menu.c m_misc.c m_random.c p_ceilng.c p_doors.c p_enemy.c "
            "p_floor.c p_inter.c p_lights.c p_map.c p_maputl.c p_mobj.c p_plats.c p_pspr.c p_saveg.c p_setup.c "
            "p_sight.c p_spec.c p_switch.c p_telept.c p_tick.c p_user.c r_bsp.c r_data.c r_draw.c r_main.c "
            "r_plane.c r_segs.c r_sky.c r_things.c sha1.c sounds.c statdump.c st_lib.c st_stuff.c s_sound.c "
            "tables.c v_video.c wi_stuff.c w_checksum.c w_file.c w_wad.c z_zone.c i_input.c i_video.c "
            "doomgeneric.c").split()
SRC_WASM_SPECIFIC = ["doom_wasm.c", "internal__wasi-snapshot-preview1.c"]
WAT_FILES = ["wasi_snapshot_preview1-trampolines", "merge-two-initialization-functions-into-one", "global-constants"]
EXPECTED_AUDIO_IMPORTS = {("audio", "onSoundStart"), ("audio", "onMusicStart"), ("audio", "onMusicStop")}

AUDIO_DECLS = """
/* ACEDOOM: audio goes to the host, which plays it through the game's FMOD (see ACEDOOM/tools/build_wasm.py). */
#include <stdint.h>
__attribute__((import_module("audio"))) void onSoundStart(int32_t sfxId, int32_t volume, int32_t separation);
__attribute__((import_module("audio"))) void onMusicStart(int32_t musicId, int32_t looping);
__attribute__((import_module("audio"))) void onMusicStop(void);
"""

# (relative file, old, new): each `old` must occur exactly once in the staged copy
PATCHES = [
    ("doomgeneric/src/i_sound.c", '#include "m_config.h"\n', '#include "m_config.h"\n#include "sounds.h"\n' + AUDIO_DECLS),
    ("doomgeneric/src/i_sound.c",
     "int I_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep) {\n  if (sound_module != NULL) {",
     "int I_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep) {\n"
     "  onSoundStart((int32_t)(sfxinfo - S_sfx), vol, sep); /* ACEDOOM */\n"
     "  if (sound_module != NULL) {"),
    ("doomgeneric/src/s_sound.c", '#include "z_zone.h"\n', '#include "z_zone.h"\n' + AUDIO_DECLS),
    ("doomgeneric/src/s_sound.c",
     "  // shutdown old music\n  S_StopMusic();\n",
     "  // shutdown old music\n  S_StopMusic();\n  onMusicStart(musicnum, looping); /* ACEDOOM */\n"),
    ("doomgeneric/src/s_sound.c",
     "void S_StopMusic(void) {\n  if (mus_playing) {\n",
     "void S_StopMusic(void) {\n  if (mus_playing) {\n    onMusicStop(); /* ACEDOOM */\n"),
]


def arg(argv, name, default):
    return argv[argv.index(name) + 1] if name in argv else default


def run(cmd, **kwargs):
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        raise SystemExit("command failed: " + " ".join(cmd) + "\n" + result.stdout + result.stderr)
    return result


def stage_sources(source):
    stage = os.path.join(BUILD, "stage")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    for folder in ("doomgeneric", "src", "utils"):
        shutil.copytree(os.path.join(source, folder), os.path.join(stage, folder))
    for rel, old, new in PATCHES:
        path = os.path.join(stage, *rel.split("/"))
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if text.count(old) != 1:
            raise SystemExit(f"{rel}: patch anchor found {text.count(old)} times, expected 1:\n{old}")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text.replace(old, new))
    return stage


def embedded_wad(stage):
    """The shareware WAD, cut out of the module we ship, as C source via upstream's generator."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import extract_sounds
    with open(OUTPUT, "rb") as f:
        blob = f.read()
    at, size = extract_sounds.find_wad(blob)
    wad_path = os.path.join(BUILD, "DOOM1.WAD")
    with open(wad_path, "wb") as f:
        f.write(blob[at:at + size])
    folder = os.path.join(BUILD, "file_embedded_in_code")
    os.makedirs(folder, exist_ok=True)
    run([sys.executable, os.path.join(stage, "utils", "generate_code_for_embedded_file.py"),
         "--input", wad_path, "--destination-folder", folder])
    return os.path.join(folder, "DOOM1.WAD.c")


def compile_all(clang, sysroot, stage, wad_c):
    objects = []
    obj_dir = os.path.join(BUILD, "obj")
    os.makedirs(obj_dir, exist_ok=True)
    common = [clang, "--sysroot=" + sysroot] + CFLAGS
    doom_inc = ["-I" + os.path.join(stage, "doomgeneric"), "-I" + os.path.join(stage, "doomgeneric", "include")]
    for name in SRC_DOOM:
        obj = os.path.join(obj_dir, name[:-2] + ".o")
        run(common + doom_inc + ["-c", os.path.join(stage, "doomgeneric", "src", name), "-o", obj])
        objects.append(obj)
    for name in SRC_WASM_SPECIFIC:
        obj = os.path.join(obj_dir, "wasm_" + name[:-2] + ".o")
        run(common + ["-I" + os.path.join(stage, "doomgeneric"), "-I" + BUILD, "-c", os.path.join(stage, "src", name), "-o", obj])
        objects.append(obj)
    obj = os.path.join(obj_dir, "DOOM1.WAD.o")
    run(common + ["-c", wad_c, "-o", obj])
    objects.append(obj)
    return objects


def link(clang, sysroot, objects):
    raw = os.path.join(BUILD, "doom-directly-after-linking.wasm")
    run([clang, "--sysroot=" + sysroot] + CFLAGS + LDFLAGS + objects + ["-s", "-o", raw] + LIBS)
    return raw


def post_link(binaryen, stage, raw):
    tool = lambda name: os.path.join(binaryen, "bin", name + ".exe" if os.name == "nt" else name)
    wat_dir = os.path.join(BUILD, "util-wasm-modules")
    os.makedirs(wat_dir, exist_ok=True)
    wat = {}
    for name in WAT_FILES:
        wat[name] = os.path.join(wat_dir, name + ".wasm")
        run([tool("wasm-as"), os.path.join(stage, "src", "wat", name + ".wat"), "-o", wat[name]])
    step1 = os.path.join(BUILD, "doom-with-wasi-holes-filled.wasm")
    run([tool("wasm-merge"), raw, "wasi-implementation", wat["wasi_snapshot_preview1-trampolines"], "wasi_snapshot_preview1",
         "-o", step1] + BINARYEN_FLAGS)
    step2 = os.path.join(BUILD, "doom-with-init-functions-merged.wasm")
    run([tool("wasm-merge"), step1, "has-two-init-functions", wat["merge-two-initialization-functions-into-one"],
         "merges-init-functions", "-o", step2] + BINARYEN_FLAGS)
    step3 = os.path.join(BUILD, "doom-with-trimmed-exports.wasm")
    run([tool("wasm-metadce"), step2, "--graph-file", os.path.join(stage, "src", "reachability_graph_for_wasm-metadce.json"),
         "-o", step3] + BINARYEN_FLAGS)
    final = os.path.join(BUILD, "doom.wasm")
    run([tool("wasm-merge"), step3, "doom", wat["global-constants"], "global-constants", "-o", final] + BINARYEN_FLAGS)
    return final


def imports_of(path):
    """(module, name) of every function import; the same walk tests/test_app.py does."""
    def leb(buf, pos):
        result = shift = 0
        while True:
            byte = buf[pos]
            pos += 1
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return result, pos

    def name(buf, pos):
        length, pos = leb(buf, pos)
        return buf[pos:pos + length].decode(), pos + length

    with open(path, "rb") as f:
        data = f.read()
    pos, found = 8, []
    while pos < len(data):
        section = data[pos]
        size, pos = leb(data, pos + 1)
        if section == 2:
            count, p = leb(data, pos)
            for _ in range(count):
                module, p = name(data, p)
                item, p = name(data, p)
                kind = data[p]
                p += 1
                _, p = leb(data, p)
                if kind == 0:
                    found.append((module, item))
            break
        pos += size
    return found


def main(argv):
    source = os.path.abspath(arg(argv, "--source", os.path.join(os.path.dirname(ROOT), "doom.wasm")))
    wasi_sdk = arg(argv, "--wasi-sdk", os.environ.get("WASI_SDK"))
    binaryen = arg(argv, "--binaryen", os.environ.get("BINARYEN"))
    if not os.path.isfile(os.path.join(source, "Makefile")):
        raise SystemExit(f"{source} is not a doom.wasm checkout (pass --source)")
    if not wasi_sdk or not os.path.isdir(wasi_sdk):
        raise SystemExit("WASI SDK not found: pass --wasi-sdk <dir> or set WASI_SDK (wasi-sdk 24 release)")
    if not binaryen or not os.path.isdir(binaryen):
        raise SystemExit("Binaryen not found: pass --binaryen <dir> or set BINARYEN (binaryen release)")
    clang = os.path.join(wasi_sdk, "bin", "clang.exe" if os.name == "nt" else "clang")
    sysroot = os.path.join(wasi_sdk, "share", "wasi-sysroot")

    os.makedirs(BUILD, exist_ok=True)
    stage = stage_sources(source)
    print(f"staged and patched sources from {source}")
    wad_c = embedded_wad(stage)
    print("embedded the shareware WAD")
    objects = compile_all(clang, sysroot, stage, wad_c)
    print(f"compiled {len(objects)} objects")
    raw = link(clang, sysroot, objects)
    final = post_link(binaryen, stage, raw)
    shutil.copyfile(final, OUTPUT)
    imports = imports_of(OUTPUT)
    missing = EXPECTED_AUDIO_IMPORTS - set(imports)
    print(f"wrote {OUTPUT} ({os.path.getsize(OUTPUT):,} bytes), {len(imports)} imports:")
    for module, item in imports:
        print(f"  {module}.{item}")
    if missing:
        raise SystemExit(f"audio imports missing from the module: {sorted(missing)}")
    print("now run: python tools/build_module.py --wasm2js <binaryen>/bin/wasm2js.exe")


if __name__ == "__main__":
    main(sys.argv[1:])
