"""
build_table.py - the game file that makes DOOM audible: an override of
system/gui_events.table with extra GUI event types pointing at our FMOD bank.

How the game plays UI sounds: a page sends the UI command
UIAudioRequestAudioEvent { type: <AudioGuiEventType> } and the game looks the
type up in system/gui_events.table (a TableData protobuf inside content.kspkg):
each line maps a type to an FMOD event path, a bank file path and a parameter
value. Types the stock table leaves unmapped (GUI_MUSIC_INTRO, GUI_SWITCH_*,
GUI_MONEY_*, GUI_LEVEL_*) are free for a mod; the livery-editor types
(GUI_PAINT_*, ...) can be borrowed at the price of odd sounds in that editor.

This tool reads the stock table from content.kspkg, appends the lines given in a
mapping JSON and writes the result to <package dir>/system/gui_events.table,
ready for pack_kspkg.py (the override must be packed: loose files never beat
packed ones). Lines for a type already in the stock table replace it.

Mapping JSON: { "<GUI type name or number>": { "event": "doom/pistol",
                                              "bank": "content\\sfx\\acedoom.bank",
                                              "param": 0 }, ... }

Usage:
    python tools/build_table.py <mapping.json> <package dir> [--game-dir <folder>]
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERNALS = os.environ.get("ACE_INTERNALS_DIR") or os.path.join(os.path.dirname(ROOT), "ACEGameInternals")
sys.path.insert(0, os.path.join(INTERNALS, "tools"))

import kspkg  # noqa: E402
import lookup_sim  # noqa: E402

TABLE_PATH = "system/gui_events.table"
# AudioGuiEventType (LogicScene.proto), recovered from the game
GUI_TYPES = {
    "GUI_NONE": 0, "GUI_CONFIRM": 1, "GUI_SELECT": 2, "GUI_SCROLL": 3, "GUI_WARNING": 4,
    "GUI_MUSIC_MENU": 5, "GUI_MUSIC_INTRO": 6, "GUI_MUSIC_END": 7, "GUI_CANCEL": 8,
    "GUI_PAINT_APPLY": 9, "GUI_PAINT_REMOVE": 10, "GUI_STICKER_APPLY": 11, "GUI_STICKER_REMOVE": 12,
    "GUI_PART_APPLY": 13, "GUI_PART_REMOVE": 14, "GUI_WHEEL_APPLY": 15, "GUI_WHEEL_REMOVE": 16,
    "GUI_SWITCH_ON": 17, "GUI_SWITCH_OFF": 18, "GUI_MUSIC_GAMEPLAY": 19, "GUI_MONEY_GAIN": 20,
    "GUI_MONEY_LOSS": 21, "GUI_LEVEL_UP": 22, "GUI_LEVEL_DOWN": 23,
}
AUDIO_EVENT_TYPE_GUI = 100          # AudioEventDataType.GuiEvent
# field numbers (CustomTable.proto / LogicScene.proto)
F_TABLE_PRESET = 2                  # TableData.preset
F_PRESET_LINES = 3                  # PresetTableData.lines
F_LINE_AUDIO_GUI = 12               # PresetTableData.Line.audio_gui_events
F_AGE_TYPE, F_AGE_EVENT = 1, 2      # AudioGuiEvents.type / .eventData
F_AED_EVENT, F_AED_TYPE, F_AED_TRANSFORM, F_AED_BANK, F_AED_PARAM = 1, 2, 5, 6, 7   # AudioEventData
# stock lines carry an empty TransformData (three empty sub-messages); mirrored so our lines differ in nothing else
EMPTY_TRANSFORM = bytes([0x0A, 0x00, 0x12, 0x00, 0x1A, 0x00])


# ---- minimal protobuf wire codec -------------------------------------------------------

def read_varint(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def write_varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def parse(buf):
    """[(field, wire_type, value)]; value is int for varints, bytes otherwise (fixed sizes kept raw)."""
    fields, pos = [], 0
    while pos < len(buf):
        key, pos = read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = read_varint(buf, pos)
        elif wire == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        elif wire == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            value, pos = buf[pos:pos + length], pos + length
        else:
            raise ValueError(f"unsupported wire type {wire}")
        fields.append((field, wire, value))
    return fields


def serialize(fields):
    out = bytearray()
    for field, wire, value in fields:
        out += write_varint((field << 3) | wire)
        if wire == 0:
            out += write_varint(value)
        elif wire == 2:
            out += write_varint(len(value)) + value
        else:
            out += value
    return bytes(out)


def varint_field(field, value):
    return (field, 0, value)


def bytes_field(field, value):
    return (field, 2, value if isinstance(value, bytes) else value.encode("utf-8"))


# ---- the table -----------------------------------------------------------------------

def gui_type(name_or_number):
    if isinstance(name_or_number, int) or str(name_or_number).isdigit():
        return int(name_or_number)
    return GUI_TYPES[name_or_number]


def audio_line(type_id, event, bank, param):
    event_data = [bytes_field(F_AED_EVENT, event), varint_field(F_AED_TYPE, AUDIO_EVENT_TYPE_GUI),
                  bytes_field(F_AED_TRANSFORM, EMPTY_TRANSFORM), bytes_field(F_AED_BANK, bank)]
    if param:
        event_data.append(varint_field(F_AED_PARAM, int(param)))
    gui_events = [varint_field(F_AGE_TYPE, type_id), bytes_field(F_AGE_EVENT, serialize(event_data))]
    return bytes_field(F_PRESET_LINES, serialize([bytes_field(F_LINE_AUDIO_GUI, serialize(gui_events))]))


def line_type(line_bytes):
    """The GUI type of an existing audio_gui_events line, or None."""
    for field, wire, value in parse(line_bytes):
        if field == F_LINE_AUDIO_GUI and wire == 2:
            for inner, inner_wire, inner_value in parse(value):
                if inner == F_AGE_TYPE and inner_wire == 0:
                    return inner_value
            return 0     # GUI_NONE is stored as an absent field
    return None


def stock_table(game_dir=None):
    base = lookup_sim.find_base_package(game_dir)
    if not base:
        raise SystemExit("content.kspkg not found (set ACE_GAME_DIR or pass --game-dir)")
    return kspkg.extract(base, TABLE_PATH)


def build(stock, mapping):
    """The table with the mapping's lines appended (or replacing lines for the same type)."""
    wanted = {gui_type(key): spec for key, spec in mapping.items()}
    top = parse(stock)
    out = []
    for field, wire, value in top:
        if field != F_TABLE_PRESET or wire != 2:
            out.append((field, wire, value))
            continue
        preset = []
        for pf, pw, pv in parse(value):
            if pf == F_PRESET_LINES and pw == 2 and line_type(pv) in wanted:
                continue                           # replaced below
            preset.append((pf, pw, pv))
        for type_id in sorted(wanted):
            spec = wanted[type_id]
            preset.append(audio_line(type_id, spec["event"], spec["bank"], spec.get("param", 0)))
        out.append((field, wire, serialize(preset)))
    return serialize(out)


def describe(table):
    """Human-readable lines of every audio_gui_events entry."""
    names = {v: k for k, v in GUI_TYPES.items()}
    rows = []
    for field, wire, value in parse(table):
        if field != F_TABLE_PRESET:
            continue
        for pf, pw, pv in parse(value):
            if pf != F_PRESET_LINES:
                continue
            for lf, lw, lv in parse(pv):
                if lf != F_LINE_AUDIO_GUI:
                    continue
                type_id, event, bank, param = 0, "", "", 0
                for af, aw, av in parse(lv):
                    if af == F_AGE_TYPE:
                        type_id = av
                    elif af == F_AGE_EVENT:
                        for ef, ew, ev in parse(av):
                            if ef == F_AED_EVENT:
                                event = ev.decode()
                            elif ef == F_AED_BANK:
                                bank = ev.decode()
                            elif ef == F_AED_PARAM:
                                param = ev
                rows.append(f"  {names.get(type_id, type_id):<20} -> {event} param {param} ({bank})")
    return rows


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    game_dir = argv[argv.index("--game-dir") + 1] if "--game-dir" in argv else None
    with open(argv[0], encoding="utf-8") as f:
        mapping = json.load(f)
    table = build(stock_table(game_dir), mapping)
    target = os.path.join(argv[1], *TABLE_PATH.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(table)
    print(f"wrote {target} ({len(table)} bytes):")
    print("\n".join(describe(table)))


if __name__ == "__main__":
    main(sys.argv[1:])
