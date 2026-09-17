"""
patch_bank.py - put DOOM's sounds inside the game's own UI bank.

The game creates its UI sound events once at startup from five fixed banks and
never loads a bank a mod names, so the only place a UI sound can come from is one
of those five. content/sfx/gui.bank holds the UI clicks, the livery-editor
sounds and the menu music as 31 Vorbis samples in an FSB5 container after the
event metadata. The event metadata references samples by index and repeats
neither their sizes nor offsets, so swapping a sample's bytes for another
Vorbis sample, keeping the index and the name, leaves every event intact and
playing the new sound.

This tool rebuilds gui.bank's FSB5 with chosen samples replaced by samples from
a bank FMOD Studio built for us (audio/fmod/project, platform encoding Vorbis, so
the sample format matches), fixes the container and RIFF sizes and writes the
result for pack_kspkg.py. With no replacements the output is byte-identical to
the input (tests/test_mod.py checks that).

FSB5 layout (version 1): 60-byte header {magic, version, numSamples,
sampleHeadersSize, nameTableSize, dataSize, mode, 8 zero bytes, 16-byte hash,
8 bytes}, then per sample a 64-bit header {bit 0 more-chunks, bits 1-4 frequency
code, bit 5 stereo, bits 6-33 data offset / 16, bits 34-63 sample count} followed
by 32-bit metadata chunks {bit 0 more, bits 1-24 size, bits 25-31 type} + payload,
then the name table {uint32 offsets, NUL-terminated names}, then sample data,
each sample 32-byte aligned.

Usage:
    python tools/patch_bank.py <our master_bank.bank> <mapping.json> <output gui.bank> [--game-dir <dir>]
    mapping.json: { "<gui.bank sample name>": "<our sample name>" | "stock:<gui.bank sample name>", ... }
"""
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERNALS = os.environ.get("ACE_INTERNALS_DIR") or os.path.join(os.path.dirname(ROOT), "ACEGameInternals")
sys.path.insert(0, os.path.join(INTERNALS, "tools"))

import kspkg  # noqa: E402
import lookup_sim  # noqa: E402

GUI_BANK_PATH = "content/sfx/gui.bank"
FSB5_MAGIC = b"FSB5"
FSB5_HEADER = 60
OFFSET_UNIT = 16                  # the header's data offset field counts 16-byte units
ALIGN = 32                        # FMOD pads each sample's data to 32 bytes
MODE_VORBIS = 15
MODES = {1: "PCM8", 2: "PCM16", 3: "PCM24", 4: "PCM32", 5: "PCMFLOAT", 15: "VORBIS", 16: "FADPCM", 17: "OPUS"}


class Sample:
    def __init__(self, name, header, metas, data, frequency_code, channels, samples):
        self.name = name
        self.header = header          # the 8 header bytes as read (offset field rewritten on output)
        self.metas = metas            # raw metadata chunk bytes (headers + payloads), in order
        self.data = data
        self.frequency_code = frequency_code
        self.channels = channels
        self.samples = samples


def parse_fsb5(blob):
    """(fields, samples) of an FSB5 container starting at blob[0]."""
    if blob[:4] != FSB5_MAGIC:
        raise ValueError("not an FSB5 container")
    version, count, headers_size, names_size, data_size, mode = struct.unpack_from("<IIIIII", blob, 4)
    fields = {"version": version, "count": count, "headers_size": headers_size, "names_size": names_size,
              "data_size": data_size, "mode": mode, "rest": blob[28:FSB5_HEADER]}
    headers_at = FSB5_HEADER
    names_at = headers_at + headers_size
    data_at = names_at + names_size
    pos = headers_at
    raw = []
    for _ in range(count):
        head = struct.unpack_from("<Q", blob, pos)[0]
        header = blob[pos:pos + 8]
        pos += 8
        more = head & 1
        metas = bytearray()
        while more:
            chunk = struct.unpack_from("<I", blob, pos)[0]
            size = (chunk >> 1) & 0xFFFFFF
            metas += blob[pos:pos + 4 + size]
            pos += 4 + size
            more = chunk & 1
        raw.append((header, bytes(metas), (head >> 1) & 0xF, ((head >> 5) & 1) + 1, ((head >> 6) & 0x0FFFFFFF) * OFFSET_UNIT, head >> 34))
    offsets = [struct.unpack_from("<I", blob, names_at + 4 * k)[0] for k in range(count)]
    names = [blob[names_at + o:blob.index(b"\0", names_at + o)].decode() for o in offsets]
    samples = []
    for k, (header, metas, freq, channels, offset, count_samples) in enumerate(raw):
        end = raw[k + 1][4] if k + 1 < len(raw) else data_size
        samples.append(Sample(names[k], header, metas, blob[data_at + offset:data_at + end], freq, channels, count_samples))
    fields["names_blob"] = blob[names_at:data_at]
    return fields, samples


def build_fsb5(fields, samples):
    """An FSB5 container from parsed fields and (possibly replaced) samples; names come from fields."""
    headers = bytearray()
    data = bytearray()
    for sample in samples:
        offset = len(data)
        head = struct.unpack("<Q", sample.header)[0]
        head = (head & ~(0x0FFFFFFF << 6)) | ((offset // OFFSET_UNIT) << 6)
        headers += struct.pack("<Q", head) + sample.metas
        data += sample.data
        data += b"\0" * ((-len(data)) % ALIGN)
    # FMOD pads the name table so the sample data starts 32-byte aligned; a bank whose
    # data starts off that boundary loads without complaint and plays nothing at all
    names = bytearray(fields["names_blob"])
    names += b"\0" * ((-(FSB5_HEADER + len(headers) + len(names))) % ALIGN)
    out = bytearray(FSB5_MAGIC)
    out += struct.pack("<IIIIII", fields["version"], len(samples), len(headers), len(names), len(data), fields["mode"])
    out += fields["rest"]
    out += headers + names + data
    if (len(out) - len(data)) % ALIGN:
        raise AssertionError("sample data not 32-byte aligned after rebuild")
    return bytes(out)


def split_bank(bank):
    """(prefix up to and including the SND chunk header, FSB5 offset) of an FMOD Studio bank."""
    fsb_at = bank.find(FSB5_MAGIC)
    snd_at = bank.rfind(b"SND ", 0, fsb_at)
    if fsb_at < 0 or snd_at < 0:
        raise ValueError("no SND chunk with an FSB5 container in this bank")
    return snd_at, fsb_at


# FSB5 frequency codes (the 4 bits at header bits 1-4), as Hz.
FREQUENCIES = {0: 4000, 1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000,
               7: 32000, 8: 44100, 9: 48000, 10: 96000}


def seconds(sample):
    """
    A sample's real length.

    Every sample carries its own rate: DOOM's effects are 11 kHz and its music 44.1 kHz,
    so assuming one rate for the bank understates the effects four-fold. This reported
    0.202 s samples as 0.05 s on 2026-09-17, which is exactly the range where a slot
    swallows a sound, and sent an afternoon after the wrong explanation.
    """
    return sample.samples / float(FREQUENCIES.get(sample.frequency_code, 44100))


def patch(gui_bank, our_bank, mapping):
    """gui.bank with mapping's samples replaced (by name) from our bank; also returns a report."""
    snd_at, fsb_at = split_bank(gui_bank)
    fields, samples = parse_fsb5(gui_bank[fsb_at:])
    report = []
    if mapping:
        _, our_fsb_at = split_bank(our_bank)
        our_fields, ours = parse_fsb5(our_bank[our_fsb_at:])
        if our_fields["mode"] != fields["mode"]:
            raise SystemExit(f"sample format mismatch: gui.bank is {MODES.get(fields['mode'], fields['mode'])}, our bank is "
                             f"{MODES.get(our_fields['mode'], our_fields['mode'])}; set the project's Desktop encoding to Vorbis and rebuild")
        by_name = {s.name: s for s in ours}
        stock_by_name = {s.name: s for s in samples}       # "stock:<name>" copies one of gui.bank's own samples
        for target, source in mapping.items():
            if source.startswith("stock:"):
                by_name[source] = stock_by_name[source[len("stock:"):]]
            if source not in by_name:
                raise SystemExit(f"our bank has no sample named {source!r} (has {sorted(by_name)})")
            hits = [k for k, s in enumerate(samples) if s.name == target]
            if not hits:
                raise SystemExit(f"gui.bank has no sample named {target!r}")
            for k in hits:
                old = samples[k]
                new = by_name[source]
                samples[k] = Sample(old.name, new.header, new.metas, new.data, new.frequency_code, new.channels, new.samples)
                report.append(f"  #{k:2} {old.name[:40]:<40} {seconds(old):6.2f} s -> {source} {seconds(new):6.2f} s")
    fsb = build_fsb5(fields, samples)
    prefix = bytearray(gui_bank[:fsb_at])              # everything before the FSB5, SND header included, gap zeros included
    body_start = snd_at + 8
    struct.pack_into("<I", prefix, snd_at + 4, (fsb_at - body_start) + len(fsb))
    # the SNDH record in the event metadata holds {flags, FSB5 file offset, FSB5 size}: a stale size made
    # FMOD read a container of the wrong length and play nothing at all (launches 30-31)
    sndh_at = prefix.rfind(b"SNDH", 0, snd_at)
    if sndh_at < 0 or struct.unpack_from("<I", prefix, sndh_at + 4)[0] != 12:
        raise SystemExit("SNDH record not found or not 12 bytes; bank layout differs from what this tool knows")
    flags, offset, size = struct.unpack_from("<III", prefix, sndh_at + 8)
    if offset != fsb_at or size != len(gui_bank) - fsb_at:
        raise SystemExit(f"SNDH {offset}/{size} does not describe the FSB5 at {fsb_at}/{len(gui_bank) - fsb_at}")
    struct.pack_into("<III", prefix, sndh_at + 8, flags, fsb_at, len(fsb))
    out = bytes(prefix) + fsb
    out = bytearray(out)
    struct.pack_into("<I", out, 4, len(out) - 8)
    return bytes(out), report


def stock_gui_bank(game_dir=None):
    base = lookup_sim.find_base_package(game_dir)
    if not base:
        raise SystemExit("content.kspkg not found (set ACE_GAME_DIR or pass --game-dir)")
    return kspkg.extract(base, GUI_BANK_PATH)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    game_dir = argv[argv.index("--game-dir") + 1] if "--game-dir" in argv else None
    with open(argv[0], "rb") as f:
        our_bank = f.read()
    with open(argv[1], encoding="utf-8") as f:
        mapping = json.load(f)
    gui_bank = stock_gui_bank(game_dir)
    out, report = patch(gui_bank, our_bank, mapping)
    os.makedirs(os.path.dirname(os.path.abspath(argv[2])), exist_ok=True)
    with open(argv[2], "wb") as f:
        f.write(out)
    print(f"wrote {argv[2]} ({len(out):,} bytes, stock {len(gui_bank):,}); {len(report)} sample(s) replaced:")
    print("\n".join(report))


if __name__ == "__main__":
    main(sys.argv[1:])
