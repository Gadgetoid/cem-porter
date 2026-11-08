import { u32 } from "../pe/pe.js";

const SIGNATURE = [0x43, 0x41, 0x53, 0x49, 0x4f, 0x2e, 0x24, 0x26, 0x25, 0x2d, 0x5a];
const HEADER_SIZE = 0x34;
const ATTRIBUTES_OFFSET = 0x0c;
const SIZE_OFFSET = 0x2c;
const COUNT_OFFSET = 0x30;
const BLOCK_UNIT = 512;
const STORED = 0;
const RUN_FIRST = 1;
const RUN_LAST = 8;
const DICTIONARY_FIRST = 9;
const DICTIONARY_LAST = 16;

export function isCpk(data) {
    if (data.length < HEADER_SIZE) return false;
    return SIGNATURE.every((byte, index) => data[index] === byte);
}

export function cpkName(name) {
    return /\.cpk$/i.test(name) ? name.slice(0, -4) : name;
}

function expandRuns(source, size, span) {
    const output = new Uint8Array(size);
    let written = 0;
    let read = 0;
    let previous = -1;
    let run = 0;
    while (written < size) {
        const byte = source[read++];
        output[written++] = byte;
        if (previous !== byte) run = 0;
        run++;
        if (run === span) {
            let repeat = source[read++];
            while (repeat-- > 0 && written < size) output[written++] = byte;
            run = 0;
        }
        previous = byte;
    }
    return output;
}

function expandDictionary(source, size, bits) {
    const codes = 1 << bits;
    const escape = codes - 1;
    const output = new Uint8Array(size);
    let literal = codes + ((size * bits + 7) >> 3) - 1;
    let position = (codes - 1) * 8;
    for (let index = 0; index < size; index++) {
        const offset = position >> 3;
        const word = source[offset] | (source[offset + 1] << 8);
        const code = (word >> (position & 7)) & escape;
        output[index] = code === escape ? source[literal++] : source[code];
        position += bits;
    }
    return output;
}

function expandBlock(source, size, method) {
    if (method === STORED) return source.subarray(0, size);
    if (method >= RUN_FIRST && method <= RUN_LAST) return expandRuns(source, size, method + 1);
    if (method >= DICTIONARY_FIRST && method <= DICTIONARY_LAST) return expandDictionary(source, size, method - DICTIONARY_FIRST + 1);
    throw new Error(`unknown .cpk block method ${method}`);
}

export function expandCpk(data) {
    if (!isCpk(data)) throw new Error("not a .cpk file");
    const size = u32(data, SIZE_OFFSET);
    const word = u32(data, COUNT_OFFSET);
    const count = word & 0xffffff;
    const blockSize = (data[COUNT_OFFSET + 3] || 1) * BLOCK_UNIT;
    const table = [];
    for (let index = 0; index < count; index++) table.push(u32(data, HEADER_SIZE + index * 4));
    const start = HEADER_SIZE + count * 4;
    const output = new Uint8Array(size);
    let written = 0;
    for (let index = 0; index < count && written < size; index++) {
        const offset = table[index] & 0xffffff;
        const method = table[index] >>> 24;
        const end = index + 1 < count ? (table[index + 1] & 0xffffff) : data.length - start;
        const source = new Uint8Array(end - offset + blockSize);
        source.set(data.subarray(start + offset, start + end));
        const expanded = expandBlock(source, Math.min(blockSize, size - written), method);
        output.set(expanded, written);
        written += expanded.length;
    }
    return { data: output, attributes: u32(data, ATTRIBUTES_OFFSET) };
}
