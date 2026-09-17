"""
build_audio.py - everything the audio path derives from audio/sounds.json.

  1. doom/audiomap.js                the host's map: DOOM sound number -> GUI event type
                                     (classic script loaded before doom.js);
  2. audio/fmod/project/Scripts/acedoom.js
                                     the FMOD Studio menu script that imports every sfx the
                                     slots name and builds our bank (Vorbis, see README);
  3. build/package/content/sfx/gui.bank
                                     the game's UI bank with the slots' stock samples replaced by
                                     ours (tools/patch_bank.py), from the bank Studio built;
  4. with --pack / --install         ACEUIModLoaderApps-doom.kspkg carrying that gui.bank, packed by
                                     the loader's pack_kspkg.py (named to list after the loader).

Usage:
    python tools/build_audio.py [--pack] [--install] [--no-bank] [--release] [--dups=N]

--release plans the padding for a stock install rather than this machine's mods folder.
          Anything other people will download has to be built this way.

--no-bank skips step 3 (before Studio has built our bank). Steps 1 and 2 never need
the bank.
--dups=N  how many table records the gui.bank override carries (default below). One
          record wins the game's lookup only about half the time once anything else is
          installed; see pack_kspkg.py --dups.
"""
import glob
import hashlib
import shutil as _shutil
import tempfile
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_table  # noqa: E402
import patch_bank  # noqa: E402

SOUNDS = os.path.join(ROOT, "audio", "sounds.json")
AUDIOMAP = os.path.join(ROOT, "doom", "audiomap.js")
STUDIO_TEMPLATE = os.path.join(ROOT, "audio", "fmod", "studio_template.js")
PROJECT = os.path.join(ROOT, "audio", "fmod", "project")
STUDIO_SCRIPT = os.path.join(PROJECT, "Scripts", "acedoom.js")
PADDED_DIR = os.path.join(ROOT, "audio", "sfx_padded")   # sources lengthened by padTo
OUR_BANK_DIRS = (os.path.join(ROOT, "audio", "acevo_content"), os.path.join(PROJECT, "Build"))
MUSIC_DIR = os.path.join(os.path.dirname(ROOT), "console-doom", "music")
PACKAGE_DIR = os.path.join(ROOT, "build", "package")
PATCHED_BANK = os.path.join(PACKAGE_DIR, "content", "sfx", "gui.bank")
PACKAGE_NAME = "ACEUIModLoaderApps-doom.kspkg"
BANK_PATH = "content/sfx/gui.bank"          # the samples DOOM's sounds are swapped into
TABLE_PATH = "system/gui_events.table"      # the map that reaches gui_navigation params 5-8
BANK_IN_TABLE = "content\\sfx\\gui.bank"      # how the table spells it
# Table records for those overrides. Measured 2026-09-17 against 48 package sets (the loader
# alongside, plus 0-5 synthetic car mods), scoring a set as won only when BOTH overrides win --
# the bank without the table plays DOOM's samples on types nothing fires, and the table without
# the bank fires types whose samples are still Kunos'. 1 record 19%, 16 88%, 32 90%, 64 98%,
# 96 98%, 128 100%, and 128 scored 24/24 on a held-out population nothing was selected on.
# Two overrides that must both land need more records than the one this package used to have.
# The good counts depend on the package's whole hash set: re-measure if it gains a file, with
#   tune_dups.tune(package_dir, [BANK_PATH, TABLE_PATH], ..., require="all",
#                  package_name=PACKAGE_NAME)
DEFAULT_DUPS = 128
LOADER_TOOLS = os.path.join(os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIModLoader"), "tools")

# S_sfx order in doomgeneric/src/sounds.c (index = the number I_StartSound reports)
SFX_NAMES = ("none pistol shotgn sgcock dshtgn dbopn dbcls dbload plasma bfg sawup sawidl sawful sawhit rlaunc rxplod "
             "firsht firxpl pstart pstop doropn dorcls stnmov swtchn swtchx plpain dmpain popain vipain mnpain pepain "
             "slop itemup wpnup oof telept posit1 posit2 posit3 bgsit1 bgsit2 sgtsit cacsit brssit cybsit spisit bspsit "
             "kntsit vilsit mansit pesit sklatk sgtatk skepch vilatk claw skeswg pldeth pdiehi podth1 podth2 podth3 "
             "bgdth1 bgdth2 sgtdth cacdth skldth brsdth cybdth spidth bspdth vildth kntdth pedth skedth posact bgact "
             "dmact bspact bspwlk vilact noway barexp punch hoof metal chgun tink bdopn bdcls itmbk flame flamst getpow "
             "bospit boscub bossit bospn bosdth manatk mandth sssit ssdth keenpn keendt skeact skesit skeatk radio").split()
# S_music order in sounds.c (index = the number S_ChangeMusic reports)
MUSIC_NAMES = ("none e1m1 e1m2 e1m3 e1m4 e1m5 e1m6 e1m7 e1m8 e1m9 e2m1 e2m2 e2m3 e2m4 e2m5 e2m6 e2m7 e2m8 e2m9 e3m1 e3m2 "
               "e3m3 e3m4 e3m5 e3m6 e3m7 e3m8 e3m9 inter intro bunny victor introa runnin stalks countd betwee doom the_da "
               "shawn ddtblu in_cit dead stlks2").split()

HEADER = """/*
 * audiomap.js -- GENERATED by tools/build_audio.py from audio/sounds.json, do not edit.
 *
 * Which of the game's GUI event types plays which DOOM sound: the host asks the game
 * for the type (UIAudioRequestAudioEvent) and the stock event plays the sample that
 * tools/patch_bank.py swapped for DOOM's inside gui.bank. Numbers are DOOM's own
 * S_sfx / S_music indices, reported by the module's audio imports.
 */
const ACEDoomAudioMap = (function () {
    return {
        sfx: {
%s
        },
        music: {
%s
        },
        names: [%s]
    };
}());
"""


def load():
    with open(SOUNDS, encoding="utf-8") as f:
        return json.load(f)


def write_audiomap(config):
    """One line per DOOM sound number: the slot's own sfx and every sound listed under `also`."""
    pairs = []
    for s in config["slots"]:
        if not s.get("gui"):
            continue
        for name in [s["sfx"]] + list(s.get("also", [])):
            if name not in SFX_NAMES:
                raise SystemExit(f"unknown sfx {name}")
            pairs.append((SFX_NAMES.index(name), s["gui"], name))
    pairs.sort()
    sfx = [f'            {index}: "{gui}"' for index, gui, name in pairs]
    music = [f'            {MUSIC_NAMES.index(m["music"])}: {{ gui: "{m["gui"]}", seconds: {m.get("seconds", 0)} }}'
             for m in config.get("music", []) if m.get("gui")]
    with open(AUDIOMAP, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER % (",\n".join(sfx), ",\n".join(music), ", ".join(f'"{n}"' for n in SFX_NAMES)))
    return len(sfx), len(music)


def source_wav(slot):
    """The WAV a slot is built from: the 44.1 kHz 16-bit copy when it will be amplified,
    because gain on an 11 kHz 8-bit sample amplifies its quantisation noise with it."""
    folder = "sfx44" if slot.get("normalize") else "sfx"
    return os.path.join(ROOT, "audio", folder, slot["sfx"] + ".wav")


def bank_sample(slot):
    """
    The name this slot's sound carries in OUR bank.

    A prepared sound is named after its own content: `<sfx>_<hash of the source and the
    preparation>`. That is not tidiness. The Studio script keeps any event that already
    exists and cannot delete one (ManagedObject.delete is not in 2.03.13's API), so a
    sound whose name stays the same can never be updated -- the padded blip was imported
    once and then silently kept at its old, too-quiet version. A name that changes when
    the audio changes makes every revision arrive as a new event, which the script does
    handle. Old events pile up in the project, unused and harmless.
    """
    if not (slot.get("padTo") or slot.get("normalize")):
        return slot["sfx"]
    key = repr((round(slot.get("padTo") or 0, 4), round(slot.get("normalize") or 0, 4))).encode()
    with open(source_wav(slot), "rb") as f:
        key += f.read()
    return slot["sfx"] + "_" + hashlib.sha1(key).hexdigest()[:6]


def prepare_wav(slot):
    """
    The slot's source, amplified and padded as it asks, written into audio/sfx_padded.

    `normalize` is a peak as a fraction of full scale. DOOM's item blip peaks at 15% of
    full scale where its gunfire peaks at 100%, and in game that difference is the whole
    story: it was inaudible under gunfire and music at its own level, at both 0.202 s and
    0.550 s. `padTo` appends silence; the fill is the format's zero, which for unsigned
    8-bit is 0x80 rather than 0, or it would click.
    """
    import array
    import wave

    source = source_wav(slot)
    with wave.open(source, "rb") as src:
        params = src.getparams()
        raw = src.readframes(params.nframes)

    if params.sampwidth == 1:
        values = array.array("h", [b - 128 for b in raw])
        limit, quiet = 127, 0x80
    else:
        values = array.array("h", raw)
        limit, quiet = 32767, 0

    if slot.get("normalize"):
        peak = max(abs(v) for v in values) or 1
        factor = slot["normalize"] * limit / float(peak)
        values = array.array("h", [max(-limit, min(limit, int(round(v * factor)))) for v in values])

    want = int((slot.get("padTo") or 0) * params.framerate)
    pad = max(0, want - params.nframes)
    if params.sampwidth == 1:
        out = bytes(v + 128 for v in values) + bytes([quiet]) * (pad * params.nchannels)
    else:
        out = values.tobytes() + bytes(pad * params.nchannels * 2)

    os.makedirs(PADDED_DIR, exist_ok=True)
    dest = os.path.join(PADDED_DIR, bank_sample(slot) + ".wav")
    with wave.open(dest, "wb") as w:
        w.setparams(params)
        w.writeframes(out)
    print(f"  prepared {os.path.basename(source)} -> {os.path.basename(dest)}: "
          f"{params.nframes / params.framerate:.3f}s"
          + (f" x{slot['normalize'] * limit / float(max(abs(v) for v in values) or 1):.1f} gain" if False else "")
          + (f", normalised to {int(slot['normalize'] * 100)}% peak" if slot.get("normalize") else "")
          + (f", padded to {want / params.framerate:.3f}s" if pad else ""))
    return dest


def write_studio_script(config):
    """The FMOD Studio menu script with the import list baked in (Studio scripts cannot read files)."""
    entries = []
    for slot in config["slots"]:
        if not slot.get("sfx"):
            continue
        file = source_wav(slot)
        if slot.get("padTo") or slot.get("normalize"):
            file = prepare_wav(slot)
        entries.append({"name": bank_sample(slot), "event": "doom/" + bank_sample(slot),
                        "file": file.replace("\\", "/"), "music": False})
    for track in config.get("music", []):
        file = os.path.join(MUSIC_DIR, "d_" + track["music"] + ".ogg")
        entries.append({"name": "music_" + track["music"], "event": "doom/music_" + track["music"],
                        "file": file.replace("\\", "/"), "music": True})
    with open(STUDIO_TEMPLATE, encoding="utf-8") as f:
        text = f.read()
    text = text.replace("/*SLOTS*/[]", json.dumps(entries, indent=8).replace("\n", "\n    "))
    os.makedirs(os.path.dirname(STUDIO_SCRIPT), exist_ok=True)
    with open(STUDIO_SCRIPT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return [e["file"] for e in entries if not os.path.isfile(e["file"])]


def our_bank():
    hits = [h for d in OUR_BANK_DIRS for h in glob.glob(os.path.join(d, "**", "master_bank.bank"), recursive=True)]
    if not hits:
        raise SystemExit("our bank not found: build the FMOD project (ACEDOOM > 2. Add sounds and build) first, or pass --no-bank")
    return max(hits, key=os.path.getmtime)


def write_patched_bank(config):
    mapping = {s["stockSample"]: (bank_sample(s) if s.get("sfx") else "stock:" + s["copyStock"]) for s in config["slots"] if s.get("stockSample")}
    # alsoSamples: the same DOOM sound put into every sample a param might turn out to play.
    # Which stock sample a gui_navigation param plays can only be learned by ear, and a wrong
    # guess is a launch. Filling all the candidates makes the slot right whichever it is, at
    # the price of those stock sounds being DOOM's if the game ever plays them itself.
    for slot in config["slots"]:
        for extra in slot.get("alsoSamples", []):
            mapping[extra] = bank_sample(slot)
    # musicSwaps replace a whole music track in gui.bank with one of our bank's music samples (raw name)
    for m in config.get("musicSwaps", []):
        mapping[m["stockSample"]] = m["bankSample"]
    # probes: a raw sample -> our sample swap that is not a slot. Which stock sample a
    # gui_navigation param plays is only knowable by ear, so putting a DIFFERENT and
    # unmistakable DOOM sound in each candidate turns one launch into a definite answer.
    for probe in config.get("probes", []):
        mapping[probe["stockSample"]] = probe["bankSample"]
    path = our_bank()
    with open(path, "rb") as f:
        ours = f.read()
    out, report = patch_bank.patch(patch_bank.stock_gui_bank(), ours, mapping)
    if os.path.isdir(PACKAGE_DIR):
        shutil.rmtree(PACKAGE_DIR)                 # the package holds exactly this one file
    os.makedirs(os.path.dirname(PATCHED_BANK), exist_ok=True)
    with open(PATCHED_BANK, "wb") as f:
        f.write(out)
    return path, len(out), report


KNOWN_FLAGS = {"--pack", "--install", "--no-bank", "--release"}


def write_table(config):
    """
    The gui_events.table override that claims the types the effects now use.

    The effects play on gui_navigation params 5-8, which the stock table maps no type to.
    Claiming four types the stock table leaves unmapped reaches them without altering a
    single line the game already uses, so nothing the game plays for itself changes.
    """
    claims = config.get("claims", [])
    if not claims:
        return None, []
    mapping = {c["gui"]: {"event": c["event"], "bank": BANK_IN_TABLE, "param": c["param"]} for c in claims}
    table = build_table.build(build_table.stock_table(), mapping)
    dest = os.path.join(PACKAGE_DIR, *TABLE_PATH.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(table)
    return dest, [f'  {c["gui"]} -> {c["event"]} param {c["param"]}  ({c.get("_plays", "?")})' for c in claims]


def main(argv):
    # A typo must not look like success: an unrecognised --instal would build the bank and
    # quietly not install it, which reads exactly like a build that worked.
    unknown = sorted(a for a in argv if a.startswith("--")
                     and a not in KNOWN_FLAGS and not a.startswith("--dups="))
    if unknown:
        raise SystemExit(__doc__ + "\nunknown option(s): " + ", ".join(unknown))
    asked = next((a.split("=", 1)[1] for a in argv if a.startswith("--dups=")), str(DEFAULT_DUPS))
    if not asked.isdigit():
        raise SystemExit(f"--dups takes a whole number, not {asked!r}")
    config = load()
    for s in config["slots"]:
        if s.get("sfx") and s["sfx"] not in SFX_NAMES:
            raise SystemExit(f"unknown sfx {s['sfx']}")
    n_sfx, n_music = write_audiomap(config)
    print(f"wrote {AUDIOMAP}: {n_sfx} effects, {n_music} music slot(s)")
    missing = write_studio_script(config)
    print(f"wrote {STUDIO_SCRIPT}" + (f" (source files missing: {missing})" if missing else ""))
    if "--no-bank" not in argv:
        source, size, report = write_patched_bank(config)
        print(f"wrote {PATCHED_BANK} ({size:,} bytes) from {source}, {len(report)} sample(s) replaced:")
        print("\n".join(report))
    table_file, claim_report = write_table(config)
    if table_file:
        print(f"wrote {table_file}, claiming {len(claim_report)} unmapped type(s):")
        print("\n".join(claim_report))

    if "--pack" in argv or "--install" in argv:
        if not os.path.isfile(PATCHED_BANK):
            raise SystemExit("nothing to pack: build the bank first")
        out = os.path.join(ROOT, "dist", PACKAGE_NAME)
        # gui.bank is an override, and an override with one table record wins the game's
        # lookup only about half the time once anything else is installed (the base package
        # is added first, so its record starts ahead of ours). Extra records for the same
        # hash give it several places in that equal run. See pack_kspkg.py --dups.
        cmd = [sys.executable, os.path.join(LOADER_TOOLS, "pack_kspkg.py"), PACKAGE_DIR, out]
        # A normal build plans its padding against THIS machine's mods folder, so it is tuned
        # to keep whatever happens to be installed here working. A player has a different set,
        # usually none -- and on 2026-09-17 a package built this way lost BOTH its overrides
        # with only the loader alongside, which is the commonest setup there is. A package
        # other people will install has to be planned for a stock install.
        stock = None
        if "--release" in argv:
            # A stock install of THIS package is not an empty folder: DOOM cannot run without
            # the loader, so the loader is always alongside it. Planning against nothing at all
            # produced a package that won on its own and lost both overrides the moment the
            # loader was there (2026-09-17) -- which is every real installation.
            loader_pkg = os.path.join(os.path.dirname(LOADER_TOOLS), "dist", "ACEUIModLoader.kspkg")
            if not os.path.isfile(loader_pkg):
                raise SystemExit("--release needs the loader's release package built first:\n  "
                                 + loader_pkg + "\nBuild it with --release there, then come back.")
            stock = tempfile.mkdtemp(prefix="acedoom-release-")
            _shutil.copyfile(loader_pkg, os.path.join(stock, os.path.basename(loader_pkg)))
            cmd.append(f"--mods-dir={stock}")
            print("release build: padding planned for a stock install -- the loader alongside, "
                  "nothing else", flush=True)
        if int(asked) > 1:
            # Both overrides have to win, not either: the bank without the table plays DOOM's
            # sounds on types nothing fires, and the table without the bank fires types whose
            # samples are still Kunos'. That is why DEFAULT_DUPS is measured with require=all.
            cmd += [f"--dups={asked}", f"--dup={BANK_PATH}"]
            if table_file:
                cmd.append(f"--dup={TABLE_PATH}")
        if "--install" in argv:
            cmd.append("--install")
        try:
            subprocess.run(cmd, check=True)
        finally:
            if stock:
                _shutil.rmtree(stock, ignore_errors=True)
        if "--install" in argv:
            # audiomap.js and gui.bank are two halves of the same sounds.json, and they ship
            # by different routes: the bank is packed, the map is a loose app file. Installing
            # one without the other is silent and looks like a sound bug -- with a stale map
            # the host asks for the types it used to use, whose samples are stock again, so
            # DOOM's pistol comes out as Kunos' spray gun. It cost a launch on 2026-09-17.
            print("\nNOTE: the package is installed, but doom/audiomap.js is a LOOSE file and"
                  "\n      this did not install it. The map and the bank must match:"
                  "\n      python <ACEUIModLoader>/tools/install_app.py " + os.path.join(ROOT, "doom"))


if __name__ == "__main__":
    main(sys.argv[1:])
