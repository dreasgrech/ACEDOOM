/**
 * ACE DOOM -- DOOM (1993) running inside the Assetto Corsa EVO HUD as a UI mod,
 * built on the ACEUIModLoader library.
 *
 * The game itself is jacobenget/doom.wasm (the id Software source under the GPL,
 * built as a plain WebAssembly module with the shareware WAD embedded; ten small
 * imports). The game's Cohtml starts V8 with --noexpose_wasm, so the module is
 * shipped as `doomjs.js`: the same code translated to JavaScript by binaryen's
 * wasm2js (tools/build_module.py), which defines `ACEDoomModule(imports)` and
 * returns the module's exports. This file is the host:
 *
 *   - loads that script from the mod folder and instantiates the module;
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
 *   - maps keyboard events to DOOM keys while the panel is open, and the mouse
 *     on the screen to fire (left) and use (right). `Insert` shows/hides the
 *     panel, `Delete` stands in for DOOM's Escape because the real Escape
 *     pauses the sim and reloads the HUD page.
 *
 * The loader creates `<div id="doom">` and `ACEUIModLoader.mod("doom")` describes
 * the mod, so identity is not repeated here. Styling lives in doom.css.
 */
const ACEDoom = (function () {

    const me = ACEUIModLoader.mod("doom");
    const log = me.log;
    const persist = ACEUIModLoader.persist;
    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;

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
    /** Runtime knobs, changeable from the dev console: ACEDoom.tune({ swapDelay: 3, waitForLoad: false }). */
    const settings = { swapDelay: SWAP_DELAY_FRAMES, waitForLoad: true };
    /** Consecutive frames that failed to load before presenting stops. */
    const ERROR_LIMIT = 10;
    const STATS_EVERY_MS = 5000;
    const BYTES_PER_PIXEL = 4;
    /** DOOM draws 320 wide; the module hands out an integer upscale of it, undone before encoding. */
    const NATIVE_WIDTH = 320;
    const ASCII_CHUNK = 4096;
    /** Key events DOOM has no use for are logged this many times, to learn what the engine sends. */
    const UNMAPPED_LOG_LIMIT = 8;

    const SCALE_DEFAULT = 2;
    const SCALE_MIN = 1;
    const SCALE_MAX = 4;
    const SCALE_STEP = 0.5;
    const OPEN_KEY = me.key("open");
    const SCALE_KEY = me.key("scale");

    const TOGGLE_KEY = "Insert";
    const MENU_KEY = "Delete";
    /** Legacy keyCodes: the engine reports those reliably, `key`/`code` less so. */
    const KEY_CODES = {
        Insert: 45, Delete: 46, Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
        Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Comma: 188, Period: 190,
        ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165
    };
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
    const HINT_TEXT = TOGGLE_KEY + " show/hide · " + MENU_KEY + " menu · arrows move · Ctrl or click fire · Space or right-click use · Shift run";

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

    /** The mod folder's URL: from this script's own src, or the loader's description. */
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
            + el("span", CLASS.hint) + HINT_TEXT + close("span")
            + close("div");
    };

    const newStats = function () {
        return { ticks: 0, tickMs: 0, drawn: 0, presented: 0, encodeMs: 0, loaded: 0, shown: 0, errors: 0, timeouts: 0 };
    };

    /** Build the DOM once (or re-use it) and return the state everything else works on. */
    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.screen)) { root.innerHTML = markup(); }

        return {
            root: root,
            screen: root.querySelector("." + CLASS.screen),
            status: root.querySelector("." + CLASS.status),
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
            mouseKey: null,             // DOOM key held by a mouse button on the screen
            unmappedLogged: 0,
            scale: SCALE_DEFAULT,
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
            panel: null,                // ACEUIModLoader.panel state (drag + position)
            loop: null,                 // ACEUIModLoader.loop handle
            handlers: null
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

    /**
     * The module's imports: the ten doom.wasm declares, plus `env.getTempRet0`,
     * which wasm2js adds to legalise the i64 clock (low 32 bits returned, high 32
     * read back through it). Saving is unsupported; the embedded shareware WAD is used.
     */
    const imports = function (state) {
        return {
            env: {
                getTempRet0: function () { return 0; }
            },
            console: {
                onInfoMessage: function (ptr, length) { logModuleText(state, "doom: ", ptr, length); },
                onErrorMessage: function (ptr, length) { logModuleText(state, "doom error: ", ptr, length); }
            },
            gameSaving: {
                sizeOfSaveGame: function () { return 0; },
                readSaveGame: function () { return 0; },
                writeSaveGame: function () { return 0; }
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

            keys[KEY_CODES[pair[0]]] = global.value;
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
        ACEUIModLoader.addScript(url, function (ok) {
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
            + ", swapDelay " + settings.swapDelay + ", clock " + Math.floor(state.doom.clockMs) + " ms");
        setStatus(state, summary);
        state.stats = newStats();
    };

    /** One animation frame: settle the panel, advance DOOM at 35 Hz, present the newest frame. */
    const tick = function (state, now) {
        const doom = state.doom;
        const step = state.lastNow ? Math.min(now - state.lastNow, MAX_CLOCK_STEP_MS) : 0;

        state.lastNow = now;
        ACEUIModLoader.panel.update(state.panel, now);

        if (!state.open || ACEUIModLoader.hudHidden() || doom.phase !== PHASE.running) {
            state.statsAt = now;
            return;
        }

        doom.clockMs += step;
        state.frameCount += 1;

        if (now - state.lastTickAt >= TIC_MS) {
            state.lastTickAt = now;
            runTick(state);
        }

        watchPending(state, now);

        if (doom.frameDirty && !state.presentingFailed) { present(state, now); }

        if (now - state.statsAt >= STATS_EVERY_MS) {
            reportStats(state, now - state.statsAt);
            state.statsAt = now;
        }
    };

    // ---- state changes -------------------------------------------------------------

    const setClass = function (node, className, on) {
        if (on) {
            node.classList.add(className);
        } else {
            node.classList.remove(className);
        }
    };

    const setOpen = function (state, open) {
        state.open = Boolean(open);
        setClass(state.root, CLASS.closed, !state.open);
        persist.writeLocal(OPEN_KEY, state.open);
        state.lastTickAt = 0;

        if (state.open) { boot(state); }
    };

    /** Change the presentation knobs at runtime (dev console): returns the settings in force. */
    const tune = function (changes) {
        Object.keys(changes || {}).forEach(function (name) {
            if (settings[name] !== undefined) { settings[name] = changes[name]; }
        });
        log("tuned: swapDelay=" + settings.swapDelay + ", waitForLoad=" + settings.waitForLoad);

        return settings;
    };

    const setScale = function (state, scale) {
        const value = ACEUIModLoader.clamp(Math.round(scale / SCALE_STEP) * SCALE_STEP, SCALE_MIN, SCALE_MAX);

        state.scale = value;
        state.root.style.fontSize = value + "rem";
        persist.writeLocal(SCALE_KEY, value);
    };

    // ---- input -----------------------------------------------------------------------

    const isToggleKey = function (e) {
        return e.key === TOGGLE_KEY || e.code === TOGGLE_KEY || e.keyCode === KEY_CODES[TOGGLE_KEY];
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
        const action = ACEUIModLoader.closestWithAttribute(e.target, ACTION_ATTR, state.root);
        const name = action ? action.getAttribute(ACTION_ATTR) : "";

        if (name === ACTION_SMALLER) { setScale(state, state.scale - SCALE_STEP); }

        if (name === ACTION_LARGER) { setScale(state, state.scale + SCALE_STEP); }

        if (name === ACTION_CLOSE) { setOpen(state, false); }
    };

    // ---- lifecycle ---------------------------------------------------------------

    const attach = function (root) {
        const state = create(root);
        const storedOpen = persist.readLocal(OPEN_KEY);
        const storedScale = persist.readLocal(SCALE_KEY);

        state.handlers = {
            keyDown: function (e) { onKey(state, e, true); },
            keyUp: function (e) { onKey(state, e, false); },
            click: function (e) { onClick(state, e); },
            screenDown: function (e) { onScreenMouseDown(state, e); },
            mouseUp: function () { onMouseUp(state); },
            loads: state.frames.map(function (frame, index) {
                return function () { onFrameLoaded(state, index); };
            }),
            errors: state.frames.map(function (frame, index) {
                return function () { onFrameError(state, index); };
            })
        };
        window.addEventListener("keydown", state.handlers.keyDown, true);
        window.addEventListener("keyup", state.handlers.keyUp, true);
        window.addEventListener("mouseup", state.handlers.mouseUp);
        root.addEventListener("click", state.handlers.click);
        state.screen.addEventListener("mousedown", state.handlers.screenDown);
        state.frames.forEach(function (frame, index) {
            frame.el.addEventListener("load", state.handlers.loads[index]);
            frame.el.addEventListener("error", state.handlers.errors[index]);
        });

        setScale(state, typeof storedScale === "number" ? storedScale : SCALE_DEFAULT);
        setOpen(state, Boolean(storedOpen));

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: log });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });
        log("attached, " + (state.open ? "open" : "closed") + ", scale " + state.scale + ", toggle key " + TOGGLE_KEY
            + ", module " + state.base + MODULE_FILE);

        return state;
    };

    /** Stop the loop, release listeners and object URLs. The DOM is left in place. */
    const detach = function (state) {
        ACEUIModLoader.loop.stop(state.loop);
        ACEUIModLoader.panel.detach(state.panel);

        if (state.handlers) {
            window.removeEventListener("keydown", state.handlers.keyDown, true);
            window.removeEventListener("keyup", state.handlers.keyUp, true);
            window.removeEventListener("mouseup", state.handlers.mouseUp);
            state.root.removeEventListener("click", state.handlers.click);
            state.screen.removeEventListener("mousedown", state.handlers.screenDown);
            state.frames.forEach(function (frame, index) {
                frame.el.removeEventListener("load", state.handlers.loads[index]);
                frame.el.removeEventListener("error", state.handlers.errors[index]);
            });
            state.handlers = null;
        }

        state.frames.forEach(function (frame) {
            if (frame.url) { URL.revokeObjectURL(frame.url); }

            frame.url = null;
            frame.pending = false;
            frame.readyAt = -1;
        });
    };

    log("script loaded, version=" + me.version + ", lib=" + ACEUIModLoader.VERSION + ", url=" + location.href);

    return {
        TIC_MS: TIC_MS,
        TOGGLE_KEY: TOGGLE_KEY,
        MENU_KEY: MENU_KEY,
        KEY_CODES: KEY_CODES,
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
ACEUIModLoader.mod("doom").mount(ACEDoom.attach);
