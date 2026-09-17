/**
 * ACE DOOM -- DOOM (1993) running inside the Assetto Corsa EVO HUD as a UI app,
 * built on the ACEUIAppLoader library.
 *
 * The game itself is jacobenget/doom.wasm (the id Software source under the GPL,
 * built as a plain WebAssembly module with the shareware WAD embedded; ten small
 * imports). The game's Cohtml starts V8 with --noexpose_wasm, so the module is
 * shipped as `doomjs.js`: the same code translated to JavaScript by binaryen's
 * wasm2js (tools/build_module.py), which defines `ACEDoomModule(imports)` and
 * returns the module's exports. This file is the host:
 *
 *   - loads that script from the app folder and instantiates the module;
 *   - runs `tickGame()` at DOOM's 35 Hz from the shared frame loop, feeding it a
 *     clock that only advances while the panel is open, so closing it pauses;
 *   - shows every frame the module draws: the BGRA buffer becomes a PNG
 *     (png.js), the PNG a Blob, the Blob an object URL on the src of an <img>.
 *     Cohtml blanks an <img> the moment its src changes and draws the new
 *     picture a frame or two later, `load` fires before that, and a single image
 *     or two images swapped on `load` both flicker in game. So two images are
 *     stacked: the hidden one (opacity 0, still rendered) receives the frame and
 *     is revealed only `swapDelay` frames after its `load`. That is the only
 *     pixel path this Cohtml has (no ImageData writes, data: URLs capped at 2048);
 *   - keeps DOOM's six save slots, which the module also leaves to its host: they
 *     live in memory, and a compacted copy (saves.js) goes to localStorage and to the
 *     engine's key/value container, so a saved game survives closing the game;
 *   - maps keyboard events to DOOM keys while the panel is open, and the mouse
 *     on the screen to fire (left) and use (right). `Insert` shows/hides the
 *     panel, `Delete` stands in for DOOM's Escape because the real Escape
 *     pauses the sim and reloads the HUD page;
 *   - plays sound through the game: a page cannot make audio, but it can ask the
 *     game for one of its GUI event types (UIAudioRequestAudioEvent), and the
 *     ACEDOOM package remaps a few of those types (audiomap.js, generated from
 *     audio/sounds.json) to DOOM events in acedoom.bank. The module's audio
 *     imports report which sound starts; the host asks for the matching type.
 *
 * The loader creates `<div id="doom">` and `ACEUIAppLoader.app("doom")` describes
 * the app, so identity is not repeated here. Styling lives in doom.css.
 */
const ACEDoom = (function () {

    const me = ACEUIAppLoader.app("doom");
    const log = me.log;
    const setClass = ACEUIAppLoader.dom.setClass;
    const persist = ACEUIAppLoader.persist;
    const el = ACEUIAppLoader.el;
    const close = ACEUIAppLoader.close;
    const toArray = ACEUIAppLoader.toArray;

    const MODULE_FILE = "doomjs.js";
    const MODULE_GLOBAL = "ACEDoomModule";
    const PNG_TYPE = "image/png";
    /** DOOM's tic rate; tickGame is called at most this often. */
    const TIC_RATE = 35;
    const TIC_MS = 1000 / TIC_RATE;
    const MS_PER_S = 1000;
    /** A stalled frame does not make DOOM run many tics to catch up. */
    const MAX_CLOCK_STEP_MS = 100;
    /**
     * DOOM busy-waits on its clock inside one tickGame call (TryRunTics until a tic
     * is due, the screen melt until the next tic). With a clock that only moves
     * between calls that never ends, so after this many polls within one call the
     * clock is pushed a tic ahead: the wait ends, the melt runs at CPU speed.
     */
    const POLL_LIMIT = 50;
    /** A frame whose <img> reports neither load nor error within this is given up on. */
    const PENDING_TIMEOUT_MS = 500;
    /** That many give-ups in a row and load events are not waited for any more. */
    const BLIND_AFTER = 3;
    /** Frames between an image's `load` and revealing it: Cohtml draws the picture later than it fires the event. */
    const SWAP_DELAY_FRAMES = 2;
    /** Runtime knobs, changeable from the dev console: ACEDoom.tune({ swapDelay: 3, waitForLoad: false, logSounds: true }). */
    const settings = { swapDelay: SWAP_DELAY_FRAMES, waitForLoad: true, logSounds: false };
    /** Consecutive frames that failed to load before presenting stops. */
    const ERROR_LIMIT = 10;
    const STATS_EVERY_MS = 5000;
    const BYTES_PER_PIXEL = 4;
    /** DOOM draws 320 wide; the module hands out an integer upscale of it, undone before encoding. */
    const NATIVE_WIDTH = 320;
    const ASCII_CHUNK = 4096;
    /** Key events DOOM has no use for are logged this many times, to learn what the engine sends. */
    const UNMAPPED_LOG_LIMIT = 8;

    const AUDIO_COMMAND = "UIAudioRequestAudioEvent";
    /** DOOM volumes are 0..127 after distance attenuation; quieter starts are not worth a request. */
    const MIN_SOUND_VOLUME = 24;
    /** DOOM can start many sounds in one tic; the game's UI audio does not need them all. */
    const MAX_REQUESTS_PER_FRAME = 6;
    /** A looping track is asked for again this long before its length runs out. */
    const MUSIC_RESTART_MARGIN_MS = 250;

    const SCALE_DEFAULT = 2;
    const SCALE_MIN = 1;
    const SCALE_MAX = 4;
    const SCALE_STEP = 0.5;
    /**
     * The scale lived under its own key before it was a setting. Seed the setting's
     * default from it so upgrading does not silently reset a screen someone had sized.
     */
    const scaleWas = function () {
        const was = me.recall("scale", SCALE_DEFAULT);

        return typeof was === "number" ? was : SCALE_DEFAULT;
    };

    const TOGGLE_KEY = "Insert";
    const MENU_KEY = "Delete";

    /** DOOM's six save slots; one key names both stores the slots go to. */
    const SAVE_SLOTS = 6;
    const SAVES_KEY = me.key("saves");
    /** Bumped only if the stored shape changes; anything else is ignored on read. */
    const SAVES_FORMAT = 1;
    /**
     * How much stored text the slots may come to. The engine re-serialises every key of
     * its container whenever anything saves and the whole file is around 17 kB before we
     * add to it, so this is a real budget, not a formality.
     *
     * A measured E1M1 save is 30000 raw bytes (25349 of them used) that compact to about
     * 7100 characters, so six full slots come to roughly 43000. The caps sit above that
     * with room for a big level, and a slot over the per-slot cap is kept in memory but
     * never stored, rather than being allowed to bloat the file.
     */
    const SAVE_CHARS_PER_SLOT = 20000;
    const SAVE_CHARS_TOTAL = 96000;

    /** The attached state, for the settings pane, which is declared before there is one. */
    let attached = null;

    const savesSummary = function () {
        if (!attached) { return "not running"; }

        const used = Object.keys(attached.saves).length;

        if (!used) { return "no saved games yet"; }

        return used + (used === 1 ? " slot used, " : " slots used, ") + attached.savedChars + " characters stored";
    };

    /**
     * Settings, drawn by the loader in the app drawer's options pane. The show/hide key
     * is here because a hardcoded hotkey collides with whatever the player has bound in
     * the game; this lets them move ours rather than lose theirs.
     */
    const options = ACEUIAppLoader.settings.define(me.name, [
            {
                key: "toggleKey",
                type: "key",
                label: "Show/hide key",
                value: TOGGLE_KEY,
                hint: "Click, then press the key you want"
            },
            {
                key: "scale",
                type: "range",
                label: "Screen scale",
                value: scaleWas(),
                min: SCALE_MIN,
                max: SCALE_MAX,
                step: SCALE_STEP,
                digits: 1
            },
            {
                key: "saves",
                type: "info",
                label: "Saved games",
                text: savesSummary
            },
            {
                key: "clearSaves",
                type: "action",
                label: "All six slots",
                button: "Clear",
                press: function () { clearSaves(); }
        }
    ]);
    /**
     * Key names, the legacy keyCodes the engine reports, and the characters `key` sends
     * instead of names: all three live in ACEUIAppLoader.keys, which DOOM and the dev
     * console had each grown a partial copy of. This one was missing Escape.
     */
    const keyLib = ACEUIAppLoader.keys;
    /** Key name -> the module's exported global holding DOOM's code for it. */
    const SPECIAL_KEYS = [
        ["ArrowLeft", "KEY_LEFTARROW"], ["ArrowRight", "KEY_RIGHTARROW"], ["ArrowUp", "KEY_UPARROW"],
        ["ArrowDown", "KEY_DOWNARROW"], ["Comma", "KEY_STRAFE_L"], ["Period", "KEY_STRAFE_R"],
        ["Control", "KEY_FIRE"], ["ControlLeft", "KEY_FIRE"], ["ControlRight", "KEY_FIRE"],
        ["Space", "KEY_USE"], ["Shift", "KEY_SHIFT"], ["ShiftLeft", "KEY_SHIFT"], ["ShiftRight", "KEY_SHIFT"],
        ["Tab", "KEY_TAB"], [MENU_KEY, "KEY_ESCAPE"], ["Enter", "KEY_ENTER"], ["Backspace", "KEY_BACKSPACE"],
        ["Alt", "KEY_ALT"], ["AltLeft", "KEY_ALT"], ["AltRight", "KEY_ALT"]
    ];
    /** `key` values that differ from the names above. */
    const KEY_ALIASES = { " ": "Space", ",": "Comma", ".": "Period" };
    const MOUSE_LEFT = 0;
    const MOUSE_RIGHT = 2;
    const LETTER_A = 65;
    const LETTER_Z = 90;
    const DIGIT_0 = 48;
    const DIGIT_9 = 57;
    const TO_LOWER = 32;

    const PHASE = { idle: "idle", loading: "loading", compiling: "compiling", running: "running", failed: "failed" };

    const ACTION_ATTR = "data-action";
    const NO_DRAG_ATTR = "data-nodrag";
    const ACTION_SMALLER = "smaller";
    const ACTION_LARGER = "larger";
    const ACTION_CLOSE = "close";

    const TITLE_TEXT = "ACE DOOM";
    /** The controls line. The show/hide key is a setting, so the hint has to follow it. */
    const hintText = function () {
        return (options.toggleKey || TOGGLE_KEY) + " show/hide · " + MENU_KEY
            + " menu · arrows move · Ctrl or click fire · Space or right-click use · Shift run";
    };

    /** Class names shared with doom.css. */
    const CLASS = {
        root: "ace-doom",
        closed: "dm-closed",
        header: "dm-header",
        title: "dm-title",
        version: "dm-version",
        tools: "dm-tools",
        button: "dm-button",
        screen: "dm-screen",
        frame: "dm-frame",
        shown: "dm-shown",
        footer: "dm-footer",
        status: "dm-status",
        hint: "dm-hint"
    };

    /** The app folder's URL: from this script's own src, or the loader's description. */
    const scriptBase = function () {
        const script = document.currentScript;
        const src = script && script.src ? String(script.src) : "";
        const cut = src.lastIndexOf("/");

        return cut >= 0 ? src.slice(0, cut + 1) : me.base;
    };

    const SCRIPT_BASE = scriptBase();

    // ---- markup ------------------------------------------------------------------

    const button = function (action, label) {
        const attrs = {};

        attrs[ACTION_ATTR] = action;
        attrs[NO_DRAG_ATTR] = "";

        return el("div", CLASS.button, attrs) + label + close("div");
    };

    const markup = function () {
        const screenAttrs = {};

        screenAttrs[NO_DRAG_ATTR] = "";

        return el("div", CLASS.header)
            + el("div", CLASS.title) + TITLE_TEXT + el("span", CLASS.version) + me.version + close("span") + close("div")
            + el("div", CLASS.tools) + button(ACTION_SMALLER, "-") + button(ACTION_LARGER, "+") + button(ACTION_CLOSE, "x") + close("div")
            + close("div")
            + el("div", CLASS.screen, screenAttrs) + el("img", CLASS.frame + " " + CLASS.shown) + el("img", CLASS.frame) + close("div")
            + el("div", CLASS.footer)
            + el("span", CLASS.status) + "press " + TOGGLE_KEY + close("span")
            + el("span", CLASS.hint) + hintText() + close("span")
            + close("div");
    };

    const newStats = function () {
        return { ticks: 0, tickMs: 0, drawn: 0, presented: 0, encodeMs: 0, loaded: 0, shown: 0, errors: 0, timeouts: 0, sounds: 0, requests: 0 };
    };

    /** Build the DOM once (or re-use it) and return the state everything else works on. */
    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.screen)) { root.innerHTML = markup(); }

        return {
            root: root,
            screen: root.querySelector("." + CLASS.screen),
            status: root.querySelector("." + CLASS.status),
            hint: root.querySelector("." + CLASS.hint),
            frames: toArray(root.querySelectorAll("." + CLASS.frame)).map(function (img) {
                return { el: img, url: null, pending: false, since: 0, readyAt: -1 };
            }),
            shown: 0,                   // index of the visible frame; the other one receives the next picture
            frameCount: 0,              // animation frames so far, for readyAt
            blind: false,               // load events stopped coming: reveal after swapDelay without them
            timeouts: 0,                // consecutive frames given up on
            consecutiveErrors: 0,
            presentingFailed: false,
            open: false,
            toggleDown: false,
            focusUnbind: null,      // click-to-focus watcher while the panel is open
            mouseKey: null,             // DOOM key held by a mouse button on the screen
            unmappedLogged: 0,
            soundsLogged: 0,
            requestsThisFrame: 0,
            music: null,                // { gui, lengthMs, looping, startedAt } while DOOM plays a mapped track
            scale: SCALE_DEFAULT,
            scaler: null,               // me.scale handle: the loader owns panel scaling
            saves: {},                  // slot -> Uint8Array, DOOM's save slots
            savesDirty: false,          // a slot changed; the frame loop stores them
            savesLoaded: false,         // the stores have been read (or had nothing)
            savedChars: 0,              // size of the last stored copy, for the settings pane
            base: SCRIPT_BASE,
            encoder: null,              // ACEDoomPng encoder, sized by onGameInit
            doom: {
                phase: PHASE.idle,
                exports: null,
                memory: null,
                width: 0,
                height: 0,
                framePtr: 0,
                frameDirty: false,
                clockMs: 0,             // DOOM's clock: advances only while open and running
                polls: 0,               // clock reads within the current tickGame call, see POLL_LIMIT
                keys: {},               // keyCode -> DOOM key, from the module's KEY_* globals
                named: {}               // key/code name -> DOOM key, same source
            },
            stats: newStats(),
            lastNow: 0,
            lastTickAt: 0,
            statsAt: 0,
            lastStatus: "",
            bag: null,                  // every listener this panel added, for detach
            unsubscribeSettings: null,
            ui: null                    // me.panel handle: the panel and its frame loop
        };
    };

    // ---- the module: loading, imports, boot ------------------------------------------

    const bytesToText = function (bytes) {
        let text = "";

        for (let i = 0; i < bytes.length; i += ASCII_CHUNK) {
            text += String.fromCharCode.apply(null, bytes.subarray(i, i + ASCII_CHUNK));
        }

        return text;
    };

    const setStatus = function (state, text) {
        if (text === state.lastStatus) { return; }

        state.lastStatus = text;
        state.status.textContent = text;
    };

    const fail = function (state, reason) {
        state.doom.phase = PHASE.failed;
        log("failed: " + reason);
        setStatus(state, "failed: " + reason);
    };

    const logModuleText = function (state, prefix, ptr, length) {
        const text = bytesToText(new Uint8Array(state.doom.memory.buffer, ptr, length));

        text.split("\n").forEach(function (line) {
            if (line.trim()) { log(prefix + line.trim()); }
        });
    };

    const onGameInit = function (state, width, height) {
        const step = width % NATIVE_WIDTH === 0 ? width / NATIVE_WIDTH : 1;

        state.doom.width = width;
        state.doom.height = height;
        state.encoder = ACEDoomPng.create(width, height, step);
    };

    // ---- audio: DOOM's sound calls, reported by the module's ACEDOOM patch -------------------

    /** The generated map (audiomap.js) or an empty one when the page has none. */
    const audioMap = function () {
        return typeof ACEDoomAudioMap === "undefined" ? { sfx: {}, music: {} } : ACEDoomAudioMap;
    };

    /** Ask the game to play one of its GUI event types; false without an engine (preview, harness). */
    const requestGuiEvent = function (state, type) {
        if (typeof engine === "undefined" || !engine.trigger) { return false; }

        engine.trigger("OnUICommand", AUDIO_COMMAND, { __Type: AUDIO_COMMAND, type: type });
        state.stats.requests += 1;

        return true;
    };

    /** Sound effect `sfxId` (index into DOOM's S_sfx) started at `volume` 0..127. */
    const onSoundStart = function (state, sfxId, volume, separation) {
        const map = audioMap();
        const type = map.sfx[sfxId];
        const name = map.names ? map.names[sfxId] : "";

        state.stats.sounds += 1;

        if (settings.logSounds || state.soundsLogged < UNMAPPED_LOG_LIMIT) {
            state.soundsLogged += 1;
            log("sfx " + sfxId + (name ? " " + name : "") + " volume " + volume + " sep " + separation + (type ? " -> " + type : " (no slot)")
                + (type && volume < MIN_SOUND_VOLUME ? " (too quiet, skipped)" : ""));
        }

        if (!type || volume < MIN_SOUND_VOLUME || state.requestsThisFrame >= MAX_REQUESTS_PER_FRAME) { return; }

        state.requestsThisFrame += 1;
        requestGuiEvent(state, type);
    };

    const playMusic = function (state, now) {
        if (requestGuiEvent(state, state.music.gui)) { state.music.startedAt = now; }
    };

    /**
     * DOOM changed music. DOOM's title screen cycles demos and flips tracks every second or two, so
     * this must not restart our track on every change: start it once and let the frame loop keep it
     * looping. An unmapped track (the intro sting) is left to the current music, not a stop.
     */
    const onMusicStart = function (state, musicId, looping) {
        const slot = audioMap().music[musicId];

        if (!slot || state.music) { return; }

        log("music " + musicId + " -> " + slot.gui + ", looping");
        state.music = { gui: slot.gui, lengthMs: slot.seconds * MS_PER_S, startedAt: -1 };
        playMusic(state, state.lastNow);
    };

    /** DOOM stops music between every track change, so ignore it; the panel closing (setOpen) ends our music. */
    const onMusicStop = function (state) {
        return state;
    };

    /** Stop looping our music; the last one-shot plays out within one track length. */
    const stopMusic = function (state) {
        state.music = null;
    };

    // ---- saved games -----------------------------------------------------------------

    /**
     * DOOM's save slots. doom.wasm has no file system: it hands saving to the host, so
     * `writeSaveGame` gets the bytes and `sizeOfSaveGame` / `readSaveGame` have to give
     * them back -- including after the game has been closed and reopened, which is the
     * point. The slots live in memory, and a compacted copy (saves.js) goes to both of
     * the stores an app has: localStorage, which survives the HUD page reload that
     * Escape/resume causes, and the engine's key/value container, which reaches disk.
     *
     * Two things about the module's side are worth knowing, because both look like bugs:
     *
     *   - it asks for a 30000-byte buffer and reports its whole *capacity* as the length,
     *     not the part it filled, so most of a slot is unused space. That is what the
     *     codec is for.
     *   - it compares what we return against that same length and treats a mismatch as a
     *     write error, so `writeSaveGame` returns `length` -- what it was handed, not what
     *     we decided to keep.
     *
     * The load menu calls all three for every slot each time it opens (it reads a whole
     * save to get at the 24-byte description in its header), so these stay cheap.
     */
    const sizeOfSave = function (state, slot) {
        const bytes = state.saves[slot];

        return bytes ? bytes.length : 0;
    };

    const readSave = function (state, slot, ptr) {
        const bytes = state.saves[slot];

        if (!bytes || !ptr) { return 0; }

        // a fresh view every time: the module's memory object is replaced when it grows
        new Uint8Array(state.doom.memory.buffer, ptr, bytes.length).set(bytes);

        return bytes.length;
    };

    const writeSave = function (state, slot, ptr, length) {
        if (!ptr || length <= 0) { return 0; }

        const copy = new Uint8Array(length);

        copy.set(new Uint8Array(state.doom.memory.buffer, ptr, length));
        state.saves[slot] = copy;
        state.savesDirty = true;
        log("slot " + slot + " written, " + length + " bytes");

        return length;
    };

    /** { v, slots: { "<slot>": text } }, and how many characters that came to. */
    const packSaves = function (state) {
        const slots = {};
        let chars = 0;

        Object.keys(state.saves).forEach(function (slot) {
            const text = ACEDoomSaves.encode(state.saves[slot]);

            if (text.length > SAVE_CHARS_PER_SLOT) {
                log("slot " + slot + " compacts to " + text.length + " characters, over the "
                    + SAVE_CHARS_PER_SLOT + " allowed for one slot; it stays in memory only");
                return;
            }

            if (chars + text.length > SAVE_CHARS_TOTAL) {
                log("slot " + slot + " would take the stored saves past " + SAVE_CHARS_TOTAL
                    + " characters; it stays in memory only");
                return;
            }

            slots[slot] = text;
            chars += text.length;
        });

        return { data: { v: SAVES_FORMAT, slots: slots }, chars: chars };
    };

    /** { slots, chars } restored. Anything unreadable is dropped, never thrown. */
    const unpackSaves = function (state, stored) {
        const result = { slots: 0, chars: 0 };

        if (!stored || stored.v !== SAVES_FORMAT || !stored.slots) { return result; }

        Object.keys(stored.slots).forEach(function (slot) {
            const text = stored.slots[slot];
            const bytes = ACEDoomSaves.decode(text);

            if (!bytes) {
                log("slot " + slot + " could not be read back and was dropped");
                return;
            }

            state.saves[slot] = bytes;
            result.slots += 1;
            result.chars += text.length;
        });

        return result;
    };

    const flushSaves = function (state) {
        const packed = packSaves(state);

        state.savesDirty = false;
        state.savedChars = packed.chars;
        persist.writeLocal(SAVES_KEY, packed.data);

        const toDisk = persist.writeStore(SAVES_KEY, packed.data);

        log("saved games stored, " + packed.chars + " characters"
            + (toDisk ? "" : " (this session only: the engine container is not there)"));
    };

    const clearSaves = function () {
        if (!attached) { return; }

        attached.saves = {};
        attached.savedChars = 0;
        persist.removeLocal(SAVES_KEY);
        persist.removeStore(SAVES_KEY);
        log("saved games cleared");
    };

    /**
     * localStorage first: it is written at the same moment as the container and so is
     * never staler, and it is there synchronously. With nothing there this is a fresh
     * session, and the container -- which arrives a little later -- is worth waiting for.
     */
    const loadSaves = function (state) {
        const local = persist.readLocal(SAVES_KEY);

        if (!local) { return; }

        const found = unpackSaves(state, local);

        state.savesLoaded = true;
        state.savedChars = found.chars;
        log("restored " + found.slots + " saved game(s) from this session");
    };

    /** Called from the frame loop until the engine's container has its contents. */
    const pollStoredSaves = function (state) {
        if (state.savesLoaded || !persist.storeLoaded()) { return; }

        state.savesLoaded = true;

        const found = unpackSaves(state, persist.readStore(SAVES_KEY));

        if (!found.slots) { return; }

        state.savedChars = found.chars;
        log("restored " + found.slots + " saved game(s) from disk");
    };

    /**
     * The module's imports: the ten doom.wasm declares, plus `env.getTempRet0`,
     * which wasm2js adds to legalise the i64 clock (low 32 bits returned, high 32
     * read back through it). The embedded shareware WAD is used.
     */
    const imports = function (state) {
        return {
            env: {
                getTempRet0: function () { return 0; }
            },
            audio: {
                onSoundStart: function (sfxId, volume, separation) { onSoundStart(state, sfxId, volume, separation); },
                onMusicStart: function (musicId, looping) { onMusicStart(state, musicId, looping); },
                onMusicStop: function () { onMusicStop(state); }
            },
            console: {
                onInfoMessage: function (ptr, length) { logModuleText(state, "doom: ", ptr, length); },
                onErrorMessage: function (ptr, length) { logModuleText(state, "doom error: ", ptr, length); }
            },
            gameSaving: {
                sizeOfSaveGame: function (slot) { return sizeOfSave(state, slot); },
                readSaveGame: function (slot, ptr) { return readSave(state, slot, ptr); },
                writeSaveGame: function (slot, ptr, length) { return writeSave(state, slot, ptr, length); }
            },
            loading: {
                onGameInit: function (width, height) { onGameInit(state, width, height); },
                wadSizes: function () {},
                readWads: function () {}
            },
            runtimeControl: {
                timeInMilliseconds: function () {
                    const doom = state.doom;

                    doom.polls += 1;

                    if (doom.polls > POLL_LIMIT) {
                        doom.polls = 0;
                        doom.clockMs += TIC_MS;
                    }

                    return Math.floor(doom.clockMs);
                }
            },
            ui: {
                drawFrame: function (ptr) {
                    state.doom.framePtr = ptr;
                    state.doom.frameDirty = true;
                    state.stats.drawn += 1;
                }
            }
        };
    };

    /** { keys: keyCode -> DOOM key, named: key/code name -> DOOM key }, from the module's KEY_* globals. */
    const keyMap = function (exports) {
        const keys = {};
        const named = {};

        SPECIAL_KEYS.forEach(function (pair) {
            const global = exports[pair[1]];

            if (!global || typeof global.value !== "number") { return; }

            keys[keyLib.CODES[pair[0]]] = global.value;
            named[pair[0]] = global.value;
        });
        Object.keys(KEY_ALIASES).forEach(function (alias) {
            if (named[KEY_ALIASES[alias]] !== undefined) { named[alias] = named[KEY_ALIASES[alias]]; }
        });

        return { keys: keys, named: named };
    };

    const started = function (state, exports, instantiateMs) {
        const doom = state.doom;
        const t0 = Date.now();
        const map = keyMap(exports);

        doom.exports = exports;
        doom.memory = exports.memory;
        doom.keys = map.keys;
        doom.named = map.named;

        try {
            exports.initGame();
        } catch (e) {
            fail(state, "initGame threw: " + e);
            return;
        }

        doom.phase = PHASE.running;
        state.lastTickAt = 0;
        log("instantiated in " + instantiateMs + " ms, initGame in " + (Date.now() - t0) + " ms, frame " + doom.width + "x" + doom.height
            + " shown as " + state.encoder.width + "x" + state.encoder.height + ", memory " + doom.memory.buffer.byteLength + " bytes, "
            + Object.keys(doom.keys).length + " special keys");
        setStatus(state, "running");
    };

    /** Load the module's script once and instantiate it; later calls are no-ops. */
    const boot = function (state) {
        const doom = state.doom;
        const url = state.base + MODULE_FILE;
        const t0 = Date.now();

        if (doom.phase !== PHASE.idle) { return; }

        doom.phase = PHASE.loading;
        setStatus(state, "loading");
        log("loading " + url);
        ACEUIAppLoader.addScript(url, function (ok) {
            const factory = window[MODULE_GLOBAL];
            const t1 = Date.now();
            let exports;

            if (!ok || typeof factory !== "function") {
                fail(state, "could not load " + url + (ok ? " (no " + MODULE_GLOBAL + " in it)" : ""));
                return;
            }

            log(MODULE_FILE + " loaded in " + (t1 - t0) + " ms, instantiating");
            doom.phase = PHASE.compiling;
            setStatus(state, "instantiating");

            try {
                exports = factory(imports(state));
            } catch (e) {
                fail(state, "instantiate threw: " + e);
                return;
            }

            started(state, exports, Date.now() - t1);
        });
    };

    // ---- rendering -----------------------------------------------------------------

    /** Reveal frames[index] (opacity 1) and hide the one shown so far; its URL stays alive until it is reused. */
    const swap = function (state, index) {
        const next = state.frames[index];
        const prev = state.frames[state.shown];

        next.pending = false;
        next.readyAt = -1;
        next.el.classList.add(CLASS.shown);

        if (prev !== next) { prev.el.classList.remove(CLASS.shown); }

        state.shown = index;
        state.stats.shown += 1;
    };

    /** `load` on the hidden image: schedule its reveal a few frames later, when Cohtml has drawn it. */
    const onFrameLoaded = function (state, index) {
        const frame = state.frames[index];

        if (!frame.pending || frame.readyAt >= 0) { return; }

        frame.readyAt = state.frameCount + settings.swapDelay;
        state.timeouts = 0;
        state.consecutiveErrors = 0;
        state.stats.loaded += 1;
    };

    const onFrameError = function (state, index) {
        const frame = state.frames[index];

        if (!frame.pending) { return; }

        frame.pending = false;
        frame.readyAt = -1;
        URL.revokeObjectURL(frame.url);
        frame.url = null;
        state.stats.errors += 1;
        state.consecutiveErrors += 1;

        if (state.consecutiveErrors >= ERROR_LIMIT && !state.presentingFailed) {
            state.presentingFailed = true;
            log("frames cannot be shown: " + ERROR_LIMIT + " blob PNGs in a row failed to load");
            setStatus(state, "running, but frames cannot be shown");
        }
    };

    /** Encode the module's frame buffer and hand it to the hidden image. */
    const present = function (state, now) {
        const doom = state.doom;
        const index = 1 - state.shown;
        const back = state.frames[index];
        const t0 = Date.now();

        if (back.pending) { return; }

        const pixels = new Uint8Array(doom.memory.buffer, doom.framePtr, doom.width * doom.height * BYTES_PER_PIXEL);
        const png = ACEDoomPng.encodeBgra(state.encoder, pixels);
        const url = URL.createObjectURL(new Blob([png.slice(0).buffer], { type: PNG_TYPE }));

        if (back.url) { URL.revokeObjectURL(back.url); }

        back.url = url;
        back.pending = true;
        back.since = now;
        back.readyAt = (state.blind || !settings.waitForLoad) ? state.frameCount + settings.swapDelay : -1;
        back.el.src = url;
        doom.frameDirty = false;
        state.stats.presented += 1;
        state.stats.encodeMs += Date.now() - t0;
    };

    /** Reveal the hidden image when its time has come; give up waiting for a `load` that never arrives. */
    const watchPending = function (state, now) {
        const index = 1 - state.shown;
        const back = state.frames[index];

        if (!back.pending) { return; }

        if (back.readyAt < 0 && now - back.since >= PENDING_TIMEOUT_MS) {
            back.readyAt = state.frameCount;
            state.timeouts += 1;
            state.stats.timeouts += 1;

            if (state.timeouts >= BLIND_AFTER && !state.blind) {
                state.blind = true;
                log("no load events from <img> for " + BLIND_AFTER + " frames in a row; revealing after " + settings.swapDelay + " frames without them");
            }
        }

        if (back.readyAt >= 0 && state.frameCount >= back.readyAt) { swap(state, index); }
    };

    const runTick = function (state) {
        const t0 = Date.now();

        state.doom.polls = 0;

        try {
            state.doom.exports.tickGame();
        } catch (e) {
            fail(state, "tickGame threw: " + e);
            return;
        }

        state.stats.ticks += 1;
        state.stats.tickMs += Date.now() - t0;
    };

    const perSecond = function (count, elapsedMs) {
        return elapsedMs > 0 ? (count * MS_PER_S / elapsedMs).toFixed(1) : "-";
    };

    const average = function (total, count) {
        return count > 0 ? (total / count).toFixed(1) : "-";
    };

    const reportStats = function (state, elapsedMs) {
        const s = state.stats;
        const summary = perSecond(s.ticks, elapsedMs) + " tics/s (" + average(s.tickMs, s.ticks) + " ms), "
            + perSecond(s.shown, elapsedMs) + " fps";

        log("stats: " + summary + ", drawn " + s.drawn + ", presented " + s.presented + " (encode " + average(s.encodeMs, s.presented)
            + " ms), loaded " + s.loaded + ", errors " + s.errors + ", timeouts " + s.timeouts + (state.blind ? ", blind" : "")
            + ", swapDelay " + settings.swapDelay + ", sounds " + s.sounds + ", requests " + s.requests + ", clock " + Math.floor(state.doom.clockMs) + " ms");
        setStatus(state, summary);
        state.stats = newStats();
    };

    /** One animation frame: settle the panel, advance DOOM at 35 Hz, present the newest frame. */
    const tick = function (state, now) {
        const doom = state.doom;
        const step = state.lastNow ? Math.min(now - state.lastNow, MAX_CLOCK_STEP_MS) : 0;

        state.lastNow = now;
        // both before the early return: a save is often the last thing done before closing
        if (state.savesDirty) { flushSaves(state); }

        if (!state.savesLoaded) { pollStoredSaves(state); }

        if (!state.open || ACEUIAppLoader.hudHidden() || doom.phase !== PHASE.running) {
            state.statsAt = now;
            return;
        }

        doom.clockMs += step;
        state.frameCount += 1;
        state.requestsThisFrame = 0;

        if (now - state.lastTickAt >= TIC_MS) {
            state.lastTickAt = now;
            ACEUIAppLoader.section("doom tic", function () { runTick(state); });
        }

        if (state.music && state.music.startedAt >= 0 && state.music.lengthMs > 0
                && now - state.music.startedAt >= state.music.lengthMs - MUSIC_RESTART_MARGIN_MS) {
            playMusic(state, now);
        }

        watchPending(state, now);

        if (doom.frameDirty && !state.presentingFailed) {
            ACEUIAppLoader.section("present frame", function () { present(state, now); });
        }

        if (now - state.statsAt >= STATS_EVERY_MS) {
            reportStats(state, now - state.statsAt);
            state.statsAt = now;
        }
    };

    // ---- state changes -------------------------------------------------------------

    /**
     * DOOM's keys are movement and fire, and the game must not also read them as car
     * controls -- the arrow keys would otherwise shove the driver's seat about while you
     * play. But holding the keyboard for as long as the panel is open would mean you
     * could never leave DOOM open and drive, so it is click-to-focus: clicking inside the
     * panel takes the keyboard, clicking anywhere else gives it back. Opening the panel
     * takes it too, since you just asked for DOOM.
     *
     * ACEUIAppLoader.input counts holders, so this neither steals the keyboard from
     * another app nor hands it back while one still wants it (the dev console holds it
     * while its prompt has focus).
     */
    const releaseKeys = function (state) {
        if (!state.focusUnbind) { return; }

        state.focusUnbind();            // unbinds the click watcher and releases
        state.focusUnbind = null;
    };

    const grabKeys = function (state) {
        const input = ACEUIAppLoader.input;

        releaseKeys(state);

        if (!input) { return; }

        input.capture(me.name);
        state.focusUnbind = input.bindClickFocus(state.root, me.name);
    };

    const setOpen = function (state, open) {
        state.open = Boolean(open);
        setClass(state.root, CLASS.closed, !state.open);
        me.remember("open", state.open);
        state.lastTickAt = 0;

        if (state.open) {
            grabKeys(state);
            boot(state);
        } else {
            releaseKeys(state);
            stopMusic(state);
        }
    };

    /** Change the presentation knobs at runtime (dev console): returns the settings in force. */
    const tune = function (changes) {
        Object.keys(changes || {}).forEach(function (name) {
            if (settings[name] !== undefined) { settings[name] = changes[name]; }
        });
        log("tuned: swapDelay=" + settings.swapDelay + ", waitForLoad=" + settings.waitForLoad + ", logSounds=" + settings.logSounds);

        return settings;
    };

    /**
     * Screen scale, through `me.scale`: one font-size in rem on the root, everything
     * inside in em. DOOM had its own copy of this, which wrote the style and stored the
     * value but never *listened* -- so moving the slider in the settings window changed
     * the stored number and nothing on the screen until the app was restarted. The
     * library's version follows the setting both ways, and is the same one the console,
     * the profiler and the probe use.
     */
    const setScale = function (state, scale) {
        return state.scaler ? state.scaler.set(scale) : state.scale;
    };

    // ---- input -----------------------------------------------------------------------

    /**
     * The show/hide key is a setting, not a constant: a hardcoded Insert collides with
     * whatever the player has bound in the game, and their bindings are not ours to
     * shadow. The default stays Insert; the settings pane in the app drawer moves it.
     */
    const isToggleKey = function (e) {
        return keyLib.is(e, options.toggleKey || TOGGLE_KEY);
    };

    /** The DOOM key for a keyboard event, or null when DOOM has no use for it. */
    const doomKeyFor = function (state, e) {
        const doom = state.doom;
        const code = e.keyCode;

        if (doom.keys[code] !== undefined) { return doom.keys[code]; }

        if (typeof e.code === "string" && doom.named[e.code] !== undefined) { return doom.named[e.code]; }

        if (typeof e.key === "string" && doom.named[e.key] !== undefined) { return doom.named[e.key]; }

        if (code >= LETTER_A && code <= LETTER_Z) { return code + TO_LOWER; }

        if (code >= DIGIT_0 && code <= DIGIT_9) { return code; }

        if (typeof e.key === "string" && e.key.length === 1) { return e.key.charCodeAt(0); }

        return null;
    };

    const report = function (state, key, down) {
        if (down) {
            state.doom.exports.reportKeyDown(key);
        } else {
            state.doom.exports.reportKeyUp(key);
        }
    };

    const onKey = function (state, e, down) {
        // typing into an input (the dev console, chat) must never be taken as DOOM input
        if (keyLib.isTyping(e)) { return; }

        if (isToggleKey(e)) {
            if (down && !state.toggleDown) { setOpen(state, !state.open); }

            state.toggleDown = down;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (!state.open || state.doom.phase !== PHASE.running) { return; }

        const key = doomKeyFor(state, e);

        if (key === null) {
            if (down && state.unmappedLogged < UNMAPPED_LOG_LIMIT) {
                state.unmappedLogged += 1;
                log("unmapped key: keyCode=" + e.keyCode + " key=" + e.key + " code=" + e.code);
            }

            return;
        }

        e.preventDefault();
        e.stopPropagation();
        report(state, key, down);
    };

    /** Mouse on the screen: left button fires, right button uses; released anywhere. */
    const onScreenMouseDown = function (state, e) {
        const named = state.doom.named;
        const key = e.button === MOUSE_LEFT ? named.Control : (e.button === MOUSE_RIGHT ? named.Space : undefined);

        if (!state.open || state.doom.phase !== PHASE.running || key === undefined || state.mouseKey !== null) { return; }

        state.mouseKey = key;
        e.preventDefault();
        report(state, key, true);
    };

    const onMouseUp = function (state) {
        if (state.mouseKey === null) { return; }

        if (state.doom.phase === PHASE.running) { report(state, state.mouseKey, false); }

        state.mouseKey = null;
    };

    const onClick = function (state, e) {
        const action = ACEUIAppLoader.closestWithAttribute(e.target, ACTION_ATTR, state.root);
        const name = action ? action.getAttribute(ACTION_ATTR) : "";

        if (name === ACTION_SMALLER) { state.scaler.nudge(-1); }

        if (name === ACTION_LARGER) { state.scaler.nudge(1); }

        if (name === ACTION_CLOSE) { setOpen(state, false); }
    };

    // ---- lifecycle ---------------------------------------------------------------

    const attach = function (root) {
        const state = create(root);
        const storedOpen = me.recall("open", false);
        const storedScale = ACEUIAppLoader.settings.get(me.name, "scale");

        state.bag = ACEUIAppLoader.dom.listeners();
        state.bag.on(window, "keydown", function (e) { onKey(state, e, true); }, true);
        state.bag.on(window, "keyup", function (e) { onKey(state, e, false); }, true);
        state.bag.on(window, "mouseup", function () { onMouseUp(state); });
        state.bag.on(root, "click", function (e) { onClick(state, e); });
        state.bag.on(state.screen, "mousedown", function (e) { onScreenMouseDown(state, e); });
        state.frames.forEach(function (frame, index) {
            state.bag.on(frame.el, "load", function () { onFrameLoaded(state, index); });
            state.bag.on(frame.el, "error", function () { onFrameError(state, index); });
        });

        // the hint advertises the show/hide key, so it follows the setting as well
        state.unsubscribeSettings = ACEUIAppLoader.settings.onChange(me.name, function (key) {
            if (key === "toggleKey" && state.hint) { state.hint.textContent = hintText(); }
        });
        state.scaler = me.scale(root, {
            min: SCALE_MIN,
            max: SCALE_MAX,
            step: SCALE_STEP,
            value: typeof storedScale === "number" ? storedScale : SCALE_DEFAULT,
            onScale: function (value) { state.scale = value; }
        });
        setOpen(state, Boolean(storedOpen));
        attached = state;
        loadSaves(state);

        state.ui = me.panel(root, function (now) { tick(state, now); });
        log("attached, " + (state.open ? "open" : "closed") + ", scale " + state.scale
            + ", toggle key " + (options.toggleKey || TOGGLE_KEY)
            + ", module " + state.base + MODULE_FILE);

        return state;
    };

    /** Stop the loop, release listeners and object URLs. The DOM is left in place. */
    const detach = function (state) {
        state.ui.stop();
        releaseKeys(state);          // never leave the game unable to read its controls

        if (state.scaler) {
            state.scaler.stop();
            state.scaler = null;
        }

        if (state.unsubscribeSettings) {
            state.unsubscribeSettings();
            state.unsubscribeSettings = null;
        }

        if (state.savesDirty) { flushSaves(state); }   // a save made since the last frame

        if (attached === state) { attached = null; }

        if (state.bag) {
            state.bag.off();
            state.bag = null;
        }

        state.frames.forEach(function (frame) {
            if (frame.url) { URL.revokeObjectURL(frame.url); }

            frame.url = null;
            frame.pending = false;
            frame.readyAt = -1;
        });
    };

    return {
        TIC_MS: TIC_MS,
        TOGGLE_KEY: TOGGLE_KEY,
        MENU_KEY: MENU_KEY,
        /* the library's table, re-exported: DOOM no longer keeps its own */
        KEY_CODES: keyLib.CODES,
        SCALE_MIN: SCALE_MIN,
        SCALE_MAX: SCALE_MAX,
        SCALE_STEP: SCALE_STEP,
        PENDING_TIMEOUT_MS: PENDING_TIMEOUT_MS,
        BLIND_AFTER: BLIND_AFTER,
        SWAP_DELAY_FRAMES: SWAP_DELAY_FRAMES,
        settings: settings,
        tune: tune,
        ERROR_LIMIT: ERROR_LIMIT,
        PHASE: PHASE,
        CLASS: CLASS,
        SAVE_SLOTS: SAVE_SLOTS,
        SAVES_KEY: SAVES_KEY,
        SAVES_FORMAT: SAVES_FORMAT,
        SAVE_CHARS_PER_SLOT: SAVE_CHARS_PER_SLOT,
        SAVE_CHARS_TOTAL: SAVE_CHARS_TOTAL,
        sizeOfSave: sizeOfSave,
        readSave: readSave,
        writeSave: writeSave,
        packSaves: packSaves,
        unpackSaves: unpackSaves,
        flushSaves: flushSaves,
        loadSaves: loadSaves,
        pollStoredSaves: pollStoredSaves,
        clearSaves: clearSaves,
        MIN_SOUND_VOLUME: MIN_SOUND_VOLUME,
        MAX_REQUESTS_PER_FRAME: MAX_REQUESTS_PER_FRAME,
        AUDIO_COMMAND: AUDIO_COMMAND,
        create: create,
        imports: imports,
        keyMap: keyMap,
        doomKeyFor: doomKeyFor,
        boot: boot,
        tick: tick,
        present: present,
        setOpen: setOpen,
        setScale: setScale,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #doom: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("doom").mount(ACEDoom.attach, ACEDoom.detach);
