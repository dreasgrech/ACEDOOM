"""
install_bank.py - copy the bank FMOD Studio built into the game's mods folder.

FMOD Studio (audio/fmod/project, menu ACEDOOM > 2) builds master_bank.bank and
master_bank.strings.bank into audio/acevo_content/content/sfx/ (Kunos's workspace
setting, kept) or the project's Build folder. The game loads them like a modded car's sfx folder when the
GUI events table names the bank:

    Saved Games\\ACE\\mods\\content\\sfx\\acedoom\\master_bank.bank
    Saved Games\\ACE\\mods\\content\\sfx\\acedoom\\master_bank.strings.bank

Usage:
    python tools/install_bank.py [--remove]
"""
import glob
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.join(ROOT, "audio", "fmod", "project")
TARGET = os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "mods", "content", "sfx", "acedoom")
FILES = ("master_bank.bank", "master_bank.strings.bank")


# Kunos's workspace builds to ../../acevo_content/content (relative to the project); a plain Build/ folder is the FMOD default
OUTPUT_DIRS = (os.path.join(ROOT, "audio", "acevo_content"), os.path.join(PROJECT, "Build"))


def built_files():
    found = {}
    for name in FILES:
        hits = [h for d in OUTPUT_DIRS for h in glob.glob(os.path.join(d, "**", name), recursive=True)]
        if not hits:
            raise SystemExit(f"{name} not found under {' or '.join(OUTPUT_DIRS)}: build the project in FMOD Studio first")
        found[name] = max(hits, key=os.path.getmtime)
    return found


def main(argv):
    if "--remove" in argv:
        if os.path.isdir(TARGET):
            shutil.rmtree(TARGET)
        print(f"removed {TARGET}")
        return
    found = built_files()
    os.makedirs(TARGET, exist_ok=True)
    for name, path in found.items():
        shutil.copyfile(path, os.path.join(TARGET, name))
        print(f"installed {name} ({os.path.getsize(path):,} bytes) from {os.path.relpath(path, PROJECT)}")
    print(f"-> {TARGET}")


if __name__ == "__main__":
    main(sys.argv[1:])
