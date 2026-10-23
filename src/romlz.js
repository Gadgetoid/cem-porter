import { u32 } from "./pe.js";

const LZ_BLOCK = 1024;
const LZW_CODES = 4096;
const LZW_CLEAR = 256;
const LZW_FIRST = 257;
const FILE_BLOCK = 4096;
const RAW_BLOCK = 0x80000000;

function read24(data, offset) {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

class Output {
    constructor(capacity) {
        this.bytes = new Uint8Array(Math.max(capacity, 16));
        this.length = 0;
    }

    reserve(extra) {
        if (this.length + extra <= this.bytes.length) return;
        const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
        grown.set(this.bytes.subarray(0, this.length));
        this.bytes = grown;
    }

    push(byte) {
        this.reserve(1);
        this.bytes[this.length++] = byte;
    }

    append(chunk) {
        this.reserve(chunk.length);
        this.bytes.set(chunk, this.length);
        this.length += chunk.length;
    }

    result(size = this.length) {
        const output = new Uint8Array(size);
        output.set(this.bytes.subarray(0, Math.min(size, this.length)));
        return output;
    }
}

function lzDecodeBlock(data, blockSize) {
    const output = new Output(blockSize);
    let position = 0;
    while (position < data.length) {
        const flags = data[position++];
        for (let bit = 0; bit < 8; bit++) {
            if (position >= data.length) break;
            if (!(flags & (1 << bit))) {
                output.push(data[position++]);
                continue;
            }
            const token = data[position++];
            const low = token & 15;
            const high = token >> 4;
            let length;
            let source;
            if (low === 1) {
                length = 2;
                source = output.length - high - 2;
            } else {
                source = high | (data[position++] << 4);
                if (low === 0) length = data[position++] + 17;
                else length = low + 1;
            }
            for (let index = 0; index < length; index++) output.push(output.bytes[source + index]);
        }
    }
    return output.result();
}

export function lzDecode(data, size, blockSize = LZ_BLOCK) {
    if (data.length < 3) return new Uint8Array(size);
    const blockCount = Math.floor(read24(data, 0) / blockSize) + 1;
    const output = new Output(size);
    let start = 3 * (blockCount + 1);
    for (let index = 1; index <= blockCount; index++) {
        const end = read24(data, 3 * index);
        output.append(lzDecodeBlock(data.subarray(start, end), blockSize));
        start = end;
    }
    return output.result(Math.min(size, output.length));
}

export function lzwDecode(data, size) {
    const prefixes = new Int32Array(LZW_CODES);
    const suffixes = new Uint8Array(LZW_CODES);
    const lengths = new Int32Array(LZW_CODES);
    for (let code = 0; code < 256; code++) {
        suffixes[code] = code;
        lengths[code] = 1;
        prefixes[code] = -1;
    }
    const output = new Output(size);
    const totalBits = data.length * 8;
    let bit = 0;
    let nextCode = LZW_FIRST;
    let width = 9;
    let previous = -1;
    const emit = (code) => {
        const length = lengths[code];
        output.reserve(length);
        let position = output.length + length - 1;
        for (let current = code; current >= 0; current = prefixes[current]) output.bytes[position--] = suffixes[current];
        output.length += length;
        return output.bytes[output.length - length];
    };
    while (bit + width <= totalBits && output.length < size) {
        let code = 0;
        for (let index = 0; index < width; index++) {
            const position = bit + index;
            if (data[position >> 3] & (1 << (position & 7))) code |= 1 << index;
        }
        bit += width;
        if (code === LZW_CLEAR) {
            nextCode = LZW_FIRST;
            width = 9;
            previous = -1;
            continue;
        }
        let first;
        if (code < nextCode && lengths[code]) {
            first = emit(code);
        } else if (code === nextCode && previous >= 0) {
            const previousFirst = emit(previous);
            output.push(previousFirst);
            first = previousFirst;
        } else {
            throw new Error(`bad LZW code ${code}`);
        }
        if (previous >= 0 && nextCode < LZW_CODES) {
            prefixes[nextCode] = previous;
            suffixes[nextCode] = first;
            lengths[nextCode] = lengths[previous] + 1;
            nextCode++;
        }
        previous = code;
        if (nextCode >= (1 << width) && width < 12) width++;
    }
    return output.result(Math.min(size, output.length));
}

export function lzwFileDecode(data, size) {
    const count = Math.ceil(size / FILE_BLOCK);
    const starts = Array.from({ length: count }, (_, index) => u32(data, 4 * index));
    const output = new Output(size);
    starts.forEach((start, index) => {
        const end = index + 1 < count ? (starts[index + 1] & ~RAW_BLOCK) >>> 0 : data.length;
        const chunk = data.subarray((start & ~RAW_BLOCK) >>> 0, end);
        const length = Math.min(FILE_BLOCK, size - FILE_BLOCK * index);
        output.append(start & RAW_BLOCK ? chunk.subarray(0, length) : lzwDecode(chunk, length));
    });
    return output.result(size);
}
