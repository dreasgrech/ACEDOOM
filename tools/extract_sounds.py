"""
extract_sounds.py - pull DOOM's sound effects out of the shareware WAD embedded in
third_party/doom.wasm and write them as WAV files for the FMOD Studio project.

DOOM sound lumps (DS<name>) are DMX format: uint16 format (3), uint16 sample rate
(11025), uint32 sample count, 16 padding bytes, unsigned 8-bit samples, 16 padding
bytes. Music lumps (D_<name>) are MUS files; console-doom already has OGG renders of
the shareware tracks, so those are only listed here.

Usage:
    python tools/extract_sounds.py [<output dir>]      (default audio/sfx)
"""
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WASM = os.path.join(ROOT, "third_party", "doom.wasm")
DEFAULT_OUT = os.path.join(ROOT, "audio", "sfx")
DMX_HEADER = 8
DMX_PAD = 16


def find_wad(blob):
    """(offset, size) of the IWAD embedded in the module's data segment."""
    at = blob.find(b"IWAD")
    while at >= 0:
        count, directory = struct.unpack_from("<II", blob, at + 4)
        if 0 < count < 5000 and at + directory + count * 16 <= len(blob):
            return at, directory + count * 16
        at = blob.find(b"IWAD", at + 1)
    raise SystemExit("no IWAD header found in " + WASM)


def lumps(wad):
    count, directory = struct.unpack_from("<II", wad, 4)
    for i in range(count):
        offset, size, raw = struct.unpack_from("<II8s", wad, directory + i * 16)
        yield raw.split(b"\0")[0].decode("ascii", "replace"), wad[offset:offset + size]


def wav_bytes(samples, rate):
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(samples), b"WAVE", b"fmt ", 16, 1, 1,
                         rate, rate, 1, 8, b"data", len(samples))
    return header + samples


def main(argv):
    out_dir = argv[0] if argv else DEFAULT_OUT
    with open(WASM, "rb") as f:
        blob = f.read()
    at, size = find_wad(blob)
    wad = blob[at:at + size]
    os.makedirs(out_dir, exist_ok=True)
    sounds, music = [], []
    for name, data in lumps(wad):
        if name.startswith("DS") and len(data) > DMX_HEADER + 2 * DMX_PAD:
            fmt, rate, count = struct.unpack_from("<HHI", data, 0)
            if fmt != 3:
                continue
            samples = data[DMX_HEADER + DMX_PAD:DMX_HEADER + DMX_PAD + count - 2 * DMX_PAD]
            path = os.path.join(out_dir, name[2:].lower() + ".wav")
            with open(path, "wb") as f:
                f.write(wav_bytes(samples, rate))
            sounds.append((name[2:].lower(), rate, len(samples) / rate))
        elif name.startswith("D_"):
            music.append((name[2:].lower(), len(data)))
    print(f"WAD at offset {at}, {size} bytes; {len(sounds)} sound effects written to {out_dir}")
    for name, rate, seconds in sounds:
        print(f"  {name:<8} {rate} Hz {seconds:5.2f} s")
    print(f"{len(music)} music lumps (MUS, not extracted): " + ", ".join(n for n, _ in music))


if __name__ == "__main__":
    main(sys.argv[1:])
