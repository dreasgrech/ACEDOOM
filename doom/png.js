/**
 * ACEDoomPng -- a fixed-size PNG encoder for the ACE DOOM mod.
 *
 * Why this exists: the game's Cohtml has a canvas but no putImageData/ImageData,
 * data: URLs are capped at 2048 characters, and there is no other way to hand a
 * pixel buffer to the renderer. What it does have is Blob + URL.createObjectURL
 * and a PNG decoder. So every DOOM frame becomes a truecolour PNG with *stored*
 * (uncompressed) deflate blocks, wrapped in a Blob and shown by an <img>.
 *
 * Everything that does not change between frames (signature, IHDR, chunk
 * lengths, deflate block headers, IEND) is written once by `create`; `encodeBgra`
 * only copies pixels, then computes the Adler-32 of the raw stream and the
 * CRC-32 of the IDAT chunk. The output buffer is reused: the returned view is
 * only valid until the next call.
 *
 * Input pixel order is BGRA (the doom.wasm frame buffer); output is RGB. A
 * `step` > 1 keeps every step-th pixel of every step-th row: doom.wasm hands out
 * 640x400 that is 320x200 with every pixel doubled, so step 2 loses nothing and
 * quarters the work for the encoder and for the engine's decoder.
 */
const ACEDoomPng = (function () {

    const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
    const CHUNK_OVERHEAD = 12;        // length (4) + type (4) + crc (4)
    const IHDR_LENGTH = 13;
    const BIT_DEPTH = 8;
    const COLOR_TYPE_RGB = 2;
    const IN_BYTES_PER_PIXEL = 4;     // BGRA in
    const OUT_BYTES_PER_PIXEL = 3;    // RGB out
    const FILTER_NONE = 0;
    const ZLIB_HEADER = [0x78, 0x01]; // deflate, fastest, no dictionary
    const ZLIB_HEADER_BYTES = 2;
    const ZLIB_TRAILER_BYTES = 4;     // Adler-32
    const STORED_BLOCK_HEADER = 5;    // BFINAL/BTYPE byte + LEN + NLEN
    const STORED_BLOCK_MAX = 65535;
    const ADLER_BASE = 65521;
    const ADLER_NMAX = 5552;          // bytes between modulo reductions (zlib's NMAX)
    const BYTE_MASK = 0xff;
    const CRC_INIT = 0xffffffff;
    const CRC_POLY = 0xedb88320;
    const BYTE_VALUES = 256;
    const BITS_PER_BYTE = 8;
    const SHIFT_16 = 16;
    const SHIFT_24 = 24;

    const crcTable = (function () {
        const table = new Int32Array(BYTE_VALUES);

        for (let n = 0; n < BYTE_VALUES; n += 1) {
            let c = n;

            for (let k = 0; k < BITS_PER_BYTE; k += 1) {
                c = (c & 1) ? (CRC_POLY ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c;
        }

        return table;
    }());

    const writeUint32 = function (out, pos, value) {
        out[pos] = (value >>> SHIFT_24) & BYTE_MASK;
        out[pos + 1] = (value >>> SHIFT_16) & BYTE_MASK;
        out[pos + 2] = (value >>> BITS_PER_BYTE) & BYTE_MASK;
        out[pos + 3] = value & BYTE_MASK;
    };

    const writeType = function (out, pos, type) {
        for (let i = 0; i < type.length; i += 1) {
            out[pos + i] = type.charCodeAt(i);
        }
    };

    /** CRC-32 of out[start, end). */
    const crc32 = function (out, start, end) {
        let c = CRC_INIT;

        for (let i = start; i < end; i += 1) {
            c = crcTable[(c ^ out[i]) & BYTE_MASK] ^ (c >>> BITS_PER_BYTE);
        }

        return (c ^ CRC_INIT) >>> 0;
    };

    /** Adler-32 of raw[0, length). */
    const adler32 = function (raw, length) {
        let a = 1;
        let b = 0;
        let i = 0;

        while (i < length) {
            const stop = Math.min(length, i + ADLER_NMAX);

            for (; i < stop; i += 1) {
                a += raw[i];
                b += a;
            }
            a %= ADLER_BASE;
            b %= ADLER_BASE;
        }

        return ((b << SHIFT_16) | a) >>> 0;
    };

    /** Write a whole chunk (length, type, data, crc) at pos; returns the position after it. */
    const writeChunk = function (out, pos, type, data) {
        writeUint32(out, pos, data.length);
        writeType(out, pos + 4, type);
        out.set(data, pos + 8);
        writeUint32(out, pos + 8 + data.length, crc32(out, pos + 4, pos + 8 + data.length));

        return pos + CHUNK_OVERHEAD + data.length;
    };

    /**
     * An encoder for sourceWidth x sourceHeight frames sampled every `step` pixels
     * (default 1): the output buffer with all constant bytes in place, the raw
     * (filtered) scanline buffer and the offsets the per frame pass needs.
     */
    const create = function (sourceWidth, sourceHeight, step) {
        const stride = step || 1;
        const width = Math.floor(sourceWidth / stride);
        const height = Math.floor(sourceHeight / stride);
        const rowBytes = 1 + width * OUT_BYTES_PER_PIXEL;
        const rawLength = rowBytes * height;
        const blocks = Math.ceil(rawLength / STORED_BLOCK_MAX);
        const zlibLength = ZLIB_HEADER_BYTES + blocks * STORED_BLOCK_HEADER + rawLength + ZLIB_TRAILER_BYTES;
        const total = SIGNATURE.length + CHUNK_OVERHEAD + IHDR_LENGTH + CHUNK_OVERHEAD + zlibLength + CHUNK_OVERHEAD;
        const out = new Uint8Array(total);
        const raw = new Uint8Array(rawLength);
        const ihdr = new Uint8Array(IHDR_LENGTH);
        let pos = 0;

        out.set(SIGNATURE, pos);
        pos += SIGNATURE.length;

        writeUint32(ihdr, 0, width);
        writeUint32(ihdr, 4, height);
        ihdr[8] = BIT_DEPTH;
        ihdr[9] = COLOR_TYPE_RGB;
        pos = writeChunk(out, pos, "IHDR", ihdr);

        const idatStart = pos;          // the length field
        writeUint32(out, pos, zlibLength);
        writeType(out, pos + 4, "IDAT");
        pos += 8;
        const zlibStart = pos;
        out.set(ZLIB_HEADER, pos);
        pos += ZLIB_HEADER_BYTES;

        // stored block headers at fixed positions; the payload slots follow each header
        const slots = [];
        let remaining = rawLength;
        let rawOffset = 0;

        while (remaining > 0) {
            const length = Math.min(remaining, STORED_BLOCK_MAX);
            const last = remaining === length;

            out[pos] = last ? 1 : 0;
            out[pos + 1] = length & BYTE_MASK;
            out[pos + 2] = (length >>> BITS_PER_BYTE) & BYTE_MASK;
            out[pos + 3] = (~length) & BYTE_MASK;
            out[pos + 4] = ((~length) >>> BITS_PER_BYTE) & BYTE_MASK;
            pos += STORED_BLOCK_HEADER;
            slots.push({ out: pos, raw: rawOffset, length: length });
            pos += length;
            rawOffset += length;
            remaining -= length;
        }

        const adlerAt = pos;
        pos += ZLIB_TRAILER_BYTES;
        const idatCrcAt = pos;
        pos += 4;
        pos = writeChunk(out, pos, "IEND", new Uint8Array(0));

        // filter bytes never change
        for (let y = 0; y < height; y += 1) {
            raw[y * rowBytes] = FILTER_NONE;
        }

        return {
            width: width,
            height: height,
            sourceWidth: sourceWidth,
            step: stride,
            rowBytes: rowBytes,
            out: out,
            raw: raw,
            slots: slots,
            idatTypeAt: idatStart + 4,
            adlerAt: adlerAt,
            idatCrcAt: idatCrcAt,
            zlibStart: zlibStart,
            length: pos
        };
    };

    /**
     * Encode one BGRA frame (a Uint8Array of sourceWidth*sourceHeight*4 bytes) and
     * return the PNG as a Uint8Array view into the encoder's buffer.
     */
    const encodeBgra = function (enc, bgra) {
        const raw = enc.raw;
        const width = enc.width;
        const srcStep = enc.step * IN_BYTES_PER_PIXEL;
        const srcRow = enc.step * enc.sourceWidth * IN_BYTES_PER_PIXEL;

        for (let y = 0; y < enc.height; y += 1) {
            let dst = y * enc.rowBytes + 1;
            let src = y * srcRow;

            for (let x = 0; x < width; x += 1) {
                raw[dst] = bgra[src + 2];
                raw[dst + 1] = bgra[src + 1];
                raw[dst + 2] = bgra[src];
                dst += OUT_BYTES_PER_PIXEL;
                src += srcStep;
            }
        }

        for (let i = 0; i < enc.slots.length; i += 1) {
            const slot = enc.slots[i];

            enc.out.set(raw.subarray(slot.raw, slot.raw + slot.length), slot.out);
        }

        writeUint32(enc.out, enc.adlerAt, adler32(raw, raw.length));
        writeUint32(enc.out, enc.idatCrcAt, crc32(enc.out, enc.idatTypeAt, enc.idatCrcAt));

        return enc.out.subarray(0, enc.length);
    };

    return {
        STORED_BLOCK_MAX: STORED_BLOCK_MAX,
        crc32: crc32,
        adler32: adler32,
        create: create,
        encodeBgra: encodeBgra
    };
}());
