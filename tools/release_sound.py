"""Wrap the sound package in a release zip laid out like every other download.

    python tools/release_sound.py

reads `dist/ACEUIAppLoader-doom.kspkg` (built by `build_audio.py`) and writes
`dist/ACEDOOM-sound-<version>.zip` holding

    mods/ACEUIAppLoader-doom.kspkg

so a player installs it exactly as the app zip and the loader zip: drag the `mods` folder
into `Saved Games\\ACE`, merge. The version is the app's (`doom/app.json`): the package and
`doom/audiomap.js` are two halves of one sound path and must come from the same release.
The zip is reproducible (fixed entry timestamps, via the loader's `release.write_zip`).
"""
import hashlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER_TOOLS = os.path.join(os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIAppLoader"), "tools")
sys.path.insert(0, LOADER_TOOLS)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_audio  # noqa: E402
import release  # noqa: E402

PACKAGE = os.path.join(ROOT, "dist", build_audio.PACKAGE_NAME)
APP_JSON = os.path.join(ROOT, "doom", "app.json")


def app_version(path=APP_JSON):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)["version"]


def release_name(version):
    """`ACEDOOM-sound-0.6.0.zip`: the app's version, because the two halves of the sound path must match."""
    return f"ACEDOOM-sound-{version}.zip"


def zip_sound(package, dest):
    """Write the zip around the built package; returns dest."""
    with open(package, "rb") as f:
        blob = f.read()
    release.write_zip(dest, [(release.ZIP_MODS + "/" + os.path.basename(package), blob)])
    return dest


def main(argv):
    if argv:
        raise SystemExit("release_sound.py takes no options")
    if not os.path.isfile(PACKAGE):
        raise SystemExit(f"no sound package at {PACKAGE}; build it first: python tools/build_audio.py")
    dest = os.path.join(ROOT, "dist", release_name(app_version()))
    zip_sound(PACKAGE, dest)
    with open(dest, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    print(f"release: {dest} ({os.path.getsize(dest) // 1024} KB)")
    print(f"sha256:  {digest}")
    print(f"inside:  {release.ZIP_MODS}/{build_audio.PACKAGE_NAME}")
    print("next: attach it to the same release as the app zip; the README names it")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
