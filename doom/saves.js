/**
 * ACEDoomSaves -- the byte codec behind DOOM's saved games.
 *
 * doom.wasm hands saving to its host: the module calls `gameSaving.writeSaveGame`
 * with a pointer and a length and expects those bytes back later through
 * `sizeOfSaveGame` / `readSaveGame`. Keeping them in memory is easy; keeping them
 * across a game restart is the hard part, because the only writable store a UI app
 * has is the engine's key/value container, whose values are JSON strings.
 *
 * So a save has to become text, and it has to become *small* text: the module asks
 * for a 30000-byte buffer and reports its whole capacity as the length, the engine
 * re-serialises every key whenever anything saves, and there are six slots. Plain
 * base64 of six slots is a quarter of a megabyte in a file that is otherwise 17 kB.
 *
 * Hence LZSS then base64. DOOM save data is mostly arrays of similar structures
 * with long runs of zeros (the unused tail of the buffer included), which a sliding
 * window squashes well, and neither `btoa` nor `CompressionStream` exists here.
 *
 *     const text = ACEDoomSaves.encode(bytes);   // Uint8Array -> string
 *     const bytes = ACEDoomSaves.decode(text);   // string -> Uint8Array, or null
 *
 * `decode` returns null for anything it cannot read rather than throwing: stored
 * text comes from an earlier run of this app, so it is never trusted.
 */
const ACEDoomSaves = (function () {

    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const PAD = "=";
    const BYTE = 255;
    const BYTE_BITS = 8;

    /** Bumped only if the stream layout changes; decode refuses anything else. */
    const FORMAT = 1;

    const WINDOW = 4096;                  // offsets are 12 bits, so this far back at most
    const MIN_MATCH = 3;                  // shorter than this costs more than the literals
    const SHORT_MAX = MIN_MATCH + 15;     // the longest match a length nibble can hold
    const LONG_MAX = SHORT_MAX + BYTE;    // one extra byte extends it this far
    const HASH_SIZE = 4096;
    const HASH_MASK = HASH_SIZE - 1;
    const WINDOW_MASK = WINDOW - 1;
    /** How many earlier positions with the same hash the match finder tries. */
    const CHAIN_LIMIT = 64;
    const FLAG_BITS = 8;
    const NIBBLE = 15;
    const NIBBLE_BITS = 4;
    const OFFSET_SHIFT = 4;
    const VARINT_BITS = 7;
    const VARINT_MASK = 127;
    const VARINT_MORE = 128;

    const REVERSE = (function () {
        const table = new Int16Array(128);
        let i = 0;

        while (i < table.length) {
            table[i] = -1;
            i += 1;
        }

        for (i = 0; i < ALPHABET.length; i += 1) { table[ALPHABET.charCodeAt(i)] = i; }

        return table;
    }());

    // ---- base64 ----------------------------------------------------------------------

    const toBase64 = function (bytes) {
        const out = [];
        let i = 0;

        while (i + 2 < bytes.length) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

            out.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], ALPHABET[(n >> 6) & 63], ALPHABET[n & 63]);
            i += 3;
        }

        if (i + 1 === bytes.length) {
            const n = bytes[i] << 16;

            out.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], PAD, PAD);
        } else if (i + 2 === bytes.length) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8);

            out.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], ALPHABET[(n >> 6) & 63], PAD);
        }

        return out.join("");
    };

    /** null when the text is not base64 we wrote. */
    const fromBase64 = function (text) {
        let end = text.length;

        while (end > 0 && text.charAt(end - 1) === PAD) { end -= 1; }

        if (end % 4 === 1) { return null; }

        const out = new Uint8Array(Math.floor(end * 3 / 4));
        let held = 0;
        let bits = 0;
        let at = 0;
        let i = 0;

        while (i < end) {
            const code = text.charCodeAt(i);
            const value = code < REVERSE.length ? REVERSE[code] : -1;

            if (value < 0) { return null; }

            held = (held << 6) | value;
            bits += 6;

            if (bits >= BYTE_BITS) {
                bits -= BYTE_BITS;
                out[at] = (held >> bits) & BYTE;
                at += 1;
            }

            i += 1;
        }

        return at === out.length ? out : out.subarray(0, at);
    };

    // ---- LZSS ------------------------------------------------------------------------

    const hashAt = function (bytes, at) {
        return ((bytes[at] << BYTE_BITS) ^ (bytes[at + 1] << NIBBLE_BITS) ^ bytes[at + 2]) & HASH_MASK;
    };

    /**
     * The longest earlier copy of the bytes at `at`, as { length, offset }, or a zero
     * length when there is none worth taking. Walks the chain of earlier positions that
     * share a hash, newest first, and gives up after CHAIN_LIMIT of them: this runs on
     * the UI thread while DOOM is paused on a menu, so a good ratio beats a perfect one.
     */
    const longestMatch = function (bytes, at, head, prev) {
        const limit = Math.min(bytes.length - at, LONG_MAX);

        if (limit < MIN_MATCH) { return { length: 0, offset: 0 }; }

        let candidate = head[hashAt(bytes, at)];
        let bestLength = 0;
        let bestAt = -1;
        let steps = 0;

        while (candidate >= 0 && steps < CHAIN_LIMIT && at - candidate <= WINDOW) {
            let n = 0;

            while (n < limit && bytes[candidate + n] === bytes[at + n]) { n += 1; }

            if (n > bestLength) {
                bestLength = n;
                bestAt = candidate;

                if (n === limit) { break; }
            }

            // the slot may have been reused by a newer position; only ever walk backwards
            const next = prev[candidate & WINDOW_MASK];

            if (next >= candidate) { break; }

            candidate = next;
            steps += 1;
        }

        return { length: bestLength, offset: bestAt >= 0 ? at - bestAt : 0 };
    };

    const remember = function (bytes, at, head, prev) {
        if (at + MIN_MATCH > bytes.length) { return; }

        const slot = hashAt(bytes, at);

        prev[at & WINDOW_MASK] = head[slot];
        head[slot] = at;
    };

    const writeVarint = function (out, value) {
        let left = value;

        while (left > VARINT_MASK) {
            out.push((left & VARINT_MASK) | VARINT_MORE);
            left = Math.floor(left / VARINT_MORE);
        }

        out.push(left);
    };

    /**
     * A flag byte every eight items, then the items: a set bit means one literal byte,
     * a clear bit means two bytes of (12-bit offset, 4-bit length), plus a third byte of
     * extra length when the nibble is full. Literals cost 9 bits, matches 17 or 25.
     */
    const compress = function (bytes) {
        const out = [FORMAT];
        const head = new Int32Array(HASH_SIZE);
        const prev = new Int32Array(WINDOW);
        let i = 0;

        while (i < HASH_SIZE) {
            head[i] = -1;
            i += 1;
        }

        for (i = 0; i < WINDOW; i += 1) { prev[i] = -1; }

        writeVarint(out, bytes.length);

        let at = 0;
        let flagAt = 0;
        let flags = 0;
        let filled = 0;

        while (at < bytes.length) {
            if (filled === 0) {
                flagAt = out.length;
                out.push(0);
            }

            const found = longestMatch(bytes, at, head, prev);
            let taken = 1;

            if (found.length >= MIN_MATCH) {
                const back = found.offset - 1;
                const nibble = Math.min(found.length - MIN_MATCH, NIBBLE);

                out.push(back >> OFFSET_SHIFT, ((back & NIBBLE) << NIBBLE_BITS) | nibble);

                if (nibble === NIBBLE) { out.push(found.length - SHORT_MAX); }

                taken = found.length;
            } else {
                flags |= 1 << filled;
                out.push(bytes[at]);
            }

            for (i = 0; i < taken; i += 1) { remember(bytes, at + i, head, prev); }

            at += taken;
            filled += 1;

            if (filled === FLAG_BITS) {
                out[flagAt] = flags;
                flags = 0;
                filled = 0;
            }
        }

        if (filled > 0) { out[flagAt] = flags; }

        return out;
    };

    /** null when the stream is truncated, over-long or not ours. */
    const expand = function (data) {
        if (!data || data.length < 2 || data[0] !== FORMAT) { return null; }

        let at = 1;
        let rawLength = 0;
        let shift = 1;

        while (at < data.length) {
            const byte = data[at];

            at += 1;
            rawLength += (byte & VARINT_MASK) * shift;
            shift *= VARINT_MORE;

            if (!(byte & VARINT_MORE)) { break; }
        }

        const out = new Uint8Array(rawLength);
        let written = 0;
        let flags = 0;
        let left = 0;

        while (written < rawLength) {
            if (left === 0) {
                if (at >= data.length) { return null; }

                flags = data[at];
                at += 1;
                left = FLAG_BITS;
            }

            if (flags & 1) {
                if (at >= data.length) { return null; }

                out[written] = data[at];
                written += 1;
                at += 1;
            } else {
                if (at + 1 >= data.length) { return null; }

                const back = (data[at] << OFFSET_SHIFT) | (data[at + 1] >> NIBBLE_BITS);
                const nibble = data[at + 1] & NIBBLE;

                at += 2;

                let length = MIN_MATCH + nibble;

                if (nibble === NIBBLE) {
                    if (at >= data.length) { return null; }

                    length = SHORT_MAX + data[at];
                    at += 1;
                }

                const from = written - (back + 1);

                if (from < 0 || written + length > rawLength) { return null; }

                for (let i = 0; i < length; i += 1) {
                    out[written] = out[from + i];
                    written += 1;
                }
            }

            flags = flags >> 1;
            left -= 1;
        }

        return out;
    };

    // ---- the pair the app uses -------------------------------------------------------

    const encode = function (bytes) {
        return toBase64(compress(bytes));
    };

    const decode = function (text) {
        if (typeof text !== "string" || !text) { return null; }

        const data = fromBase64(text);

        if (!data) { return null; }

        return expand(data);
    };

    return {
        FORMAT: FORMAT,
        WINDOW: WINDOW,
        LONG_MAX: LONG_MAX,
        encode: encode,
        decode: decode,
        toBase64: toBase64,
        fromBase64: fromBase64
    };
}());
