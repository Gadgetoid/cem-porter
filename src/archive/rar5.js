import { crc32 } from "./zip.js";

export const RAR5_MARKER = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

const HEADER_MAIN = 1;
const HEADER_FILE = 2;
const HEADER_ENCRYPTION = 4;
const HEADER_END = 5;
const FLAG_EXTRA = 0x01;
const FLAG_DATA = 0x02;
const FLAG_SPLIT_BEFORE = 0x08;
const FLAG_SPLIT_AFTER = 0x10;
const FILE_DIRECTORY = 0x01;
const FILE_TIME = 0x02;
const FILE_CRC = 0x04;
const EXTRA_ENCRYPTION = 0x01;
const COMPRESSION_SOLID = 0x40;
const MAIN_VOLUME_NUMBER = 0x02;

const BIT_LENGTH_SIZE = 20;
const MAIN_SIZE = 306;
const DISTANCE_SIZE = 64;
const DISTANCE_SIZE_V7 = 80;
const LOW_DISTANCE_SIZE = 16;
const REPEAT_SIZE = 44;
const MAX_CODE_LENGTH = 15;
const QUICK_BITS = 10;
const MAX_FILTER_SIZE = 0x400000;
const FILTER_DELTA = 0;
const FILTER_E8 = 1;
const FILTER_E8E9 = 2;
const FILTER_ARM = 3;
const E8_FILE_SIZE = 0x1000000;

const utf8 = new TextDecoder("utf-8");

class HeaderReader {
    constructor(data, position) {
        this.data = data;
        this.position = position;
    }

    number() {
        let value = 0;
        for (let shift = 0; shift < 70; shift += 7) {
            if (this.position >= this.data.length) throw new Error("RAR header is truncated");
            const byte = this.data[this.position++];
            value += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) return value;
        }
        throw new Error("bad RAR number");
    }

    u32() {
        const { data, position } = this;
        if (position + 4 > data.length) throw new Error("RAR header is truncated");
        this.position += 4;
        return (data[position] | (data[position + 1] << 8) | (data[position + 2] << 16) | (data[position + 3] << 24)) >>> 0;
    }

    bytes(count) {
        if (this.position + count > this.data.length) throw new Error("RAR header is truncated");
        this.position += count;
        return this.data.subarray(this.position - count, this.position);
    }
}

class BitReader {
    constructor(data, start, end) {
        this.data = data;
        this.position = start * 8;
        this.end = end;
    }

    peek(count) {
        const { data } = this;
        const byte = this.position >>> 3;
        const word = ((data[byte] << 24) | (data[byte + 1] << 16) | (data[byte + 2] << 8) | data[byte + 3]) >>> 0;
        return ((word << (this.position & 7)) >>> 0) >>> (32 - count);
    }

    skip(count) {
        this.position += count;
    }

    bits(count) {
        if (!count) return 0;
        if (count > 24) {
            const high = this.bits(count - 16);
            return high * 0x10000 + this.bits(16);
        }
        const value = this.peek(count);
        this.position += count;
        return value;
    }

    align() {
        this.position = (this.position + 7) & ~7;
    }

    get bytePosition() {
        return this.position >>> 3;
    }
}

function buildCode(lengths, offset, size) {
    const counts = new Uint16Array(16);
    for (let index = 0; index < size; index++) counts[lengths[offset + index] & 0xf]++;
    counts[0] = 0;
    const limits = new Uint32Array(16);
    const positions = new Uint16Array(16);
    let upper = 0;
    for (let length = 1; length < 16; length++) {
        upper += counts[length];
        limits[length] = upper << (16 - length);
        upper *= 2;
        positions[length] = positions[length - 1] + counts[length - 1];
    }
    const symbols = new Uint16Array(size);
    const next = positions.slice();
    for (let index = 0; index < size; index++) {
        const length = lengths[offset + index] & 0xf;
        if (length) symbols[next[length]++] = index;
    }
    const code = { limits, positions, symbols, size, quick: new Uint32Array(1 << QUICK_BITS) };
    for (let index = 0; index < 1 << QUICK_BITS; index++) {
        const field = index << (16 - QUICK_BITS);
        let length = 1;
        while (length <= QUICK_BITS && field >= limits[length]) length++;
        if (length > QUICK_BITS) continue;
        code.quick[index] = (length << 16) | lookup(code, field, length);
    }
    return code;
}

function lookup(code, field, length) {
    const position = code.positions[length] + ((field - code.limits[length - 1]) >>> (16 - length));
    return position < code.size ? code.symbols[position] : 0;
}

function decodeSymbol(reader, code) {
    const field = reader.peek(16) & 0xfffe;
    const quick = code.quick[field >>> (16 - QUICK_BITS)];
    if (quick) {
        reader.skip(quick >>> 16);
        return quick & 0xffff;
    }
    let length = QUICK_BITS + 1;
    while (length < MAX_CODE_LENGTH && field >= code.limits[length]) length++;
    reader.skip(length);
    return lookup(code, field, length);
}

function readTables(reader, distanceSize) {
    const bitLengths = new Uint8Array(BIT_LENGTH_SIZE);
    for (let index = 0; index < BIT_LENGTH_SIZE; index++) {
        const length = reader.bits(4);
        if (length !== 15) {
            bitLengths[index] = length;
            continue;
        }
        const zeros = reader.bits(4);
        if (!zeros) {
            bitLengths[index] = 15;
            continue;
        }
        for (let count = zeros + 2; count > 0 && index < BIT_LENGTH_SIZE; count--) bitLengths[index++] = 0;
        index--;
    }
    const bitCode = buildCode(bitLengths, 0, BIT_LENGTH_SIZE);
    const tableSize = MAIN_SIZE + distanceSize + LOW_DISTANCE_SIZE + REPEAT_SIZE;
    const lengths = new Uint8Array(tableSize);
    for (let index = 0; index < tableSize;) {
        const number = decodeSymbol(reader, bitCode);
        if (number < 16) {
            lengths[index++] = number;
            continue;
        }
        const count = number & 1 ? reader.bits(7) + 11 : reader.bits(3) + 3;
        if (number < 18) {
            if (!index) throw new Error("RAR table repeats before its first length");
            for (let left = count; left > 0 && index < tableSize; left--, index++) lengths[index] = lengths[index - 1];
        } else {
            for (let left = count; left > 0 && index < tableSize; left--) lengths[index++] = 0;
        }
    }
    return {
        main: buildCode(lengths, 0, MAIN_SIZE),
        distance: buildCode(lengths, MAIN_SIZE, distanceSize),
        lowDistance: buildCode(lengths, MAIN_SIZE + distanceSize, LOW_DISTANCE_SIZE),
        repeat: buildCode(lengths, MAIN_SIZE + distanceSize + LOW_DISTANCE_SIZE, REPEAT_SIZE),
    };
}

function slotToLength(reader, slot) {
    if (slot < 8) return 2 + slot;
    const bits = (slot >>> 2) - 1;
    return 2 + ((4 | (slot & 3)) << bits) + reader.bits(bits);
}

function readFilterNumber(reader) {
    const count = reader.bits(2) + 1;
    let value = 0;
    for (let index = 0; index < count; index++) value += reader.bits(8) * 2 ** (index * 8);
    return value;
}

function applyFilter(output, source, filter) {
    const { start, length } = filter;
    if (filter.type === FILTER_DELTA) {
        let from = start;
        for (let channel = 0; channel < filter.channels; channel++) {
            let previous = 0;
            for (let position = channel; position < length; position += filter.channels) {
                previous = (previous - source[from++]) & 0xff;
                output[start + position] = previous;
            }
        }
        return;
    }
    if (filter.type === FILTER_E8 || filter.type === FILTER_E8E9) {
        const second = filter.type === FILTER_E8E9 ? 0xe9 : 0xe8;
        for (let position = 0; position + 4 < length;) {
            const byte = output[start + position++];
            if (byte !== 0xe8 && byte !== second) continue;
            const offset = (start + position) % E8_FILE_SIZE;
            const at = start + position;
            const address = (output[at] | (output[at + 1] << 8) | (output[at + 2] << 16) | (output[at + 3] << 24)) >>> 0;
            let value = null;
            if (address & 0x80000000) {
                if (!((address + offset) & 0x80000000)) value = address + E8_FILE_SIZE;
            } else if ((address - E8_FILE_SIZE) & 0x80000000) {
                value = address - offset;
            }
            if (value !== null) {
                output[at] = value;
                output[at + 1] = value >>> 8;
                output[at + 2] = value >>> 16;
                output[at + 3] = value >>> 24;
            }
            position += 4;
        }
        return;
    }
    if (filter.type === FILTER_ARM) {
        for (let position = 0; position + 3 < length; position += 4) {
            const at = start + position;
            if (output[at + 3] !== 0xeb) continue;
            const offset = (output[at] | (output[at + 1] << 8) | (output[at + 2] << 16)) - ((start + position) >>> 2);
            output[at] = offset;
            output[at + 1] = offset >>> 8;
            output[at + 2] = offset >>> 16;
        }
    }
}

class Decoder {
    constructor() {
        this.window = new Uint8Array(0);
        this.length = 0;
        this.tables = null;
        this.distances = [0, 0, 0, 0];
        this.lastLength = 0;
    }

    reserve(count) {
        if (this.length + count <= this.window.length) return;
        const grown = new Uint8Array(Math.max(this.window.length * 2, this.length + count));
        grown.set(this.window.subarray(0, this.length));
        this.window = grown;
    }

    copy(length, distance) {
        if (distance > this.length) throw new Error("RAR match is outside the window");
        this.reserve(length);
        const { window } = this;
        for (let source = this.length - distance; length > 0; length--) window[this.length++] = window[source++];
    }

    decodeBlock(reader, end, filters) {
        const tables = this.tables;
        while (reader.position < end) {
            const slot = decodeSymbol(reader, tables.main);
            if (slot < 256) {
                if (this.length >= this.window.length) this.reserve(1);
                this.window[this.length++] = slot;
                continue;
            }
            if (slot >= 262) {
                let length = slotToLength(reader, slot - 262);
                const distanceSlot = decodeSymbol(reader, tables.distance);
                let distance = 1;
                let bits = 0;
                if (distanceSlot < 4) {
                    distance += distanceSlot;
                } else {
                    bits = (distanceSlot >>> 1) - 1;
                    distance += (2 | (distanceSlot & 1)) * 2 ** bits;
                }
                if (bits >= 4) {
                    distance += reader.bits(bits - 4) * 16;
                    distance += decodeSymbol(reader, tables.lowDistance);
                } else if (bits) {
                    distance += reader.bits(bits);
                }
                if (distance > 0x100) {
                    length++;
                    if (distance > 0x2000) {
                        length++;
                        if (distance > 0x40000) length++;
                    }
                }
                this.distances.unshift(distance);
                this.distances.length = 4;
                this.lastLength = length;
                this.copy(length, distance);
                continue;
            }
            if (slot === 256) {
                const start = readFilterNumber(reader);
                const length = readFilterNumber(reader);
                const type = reader.bits(3);
                const channels = type === FILTER_DELTA ? reader.bits(5) + 1 : 0;
                if (length <= MAX_FILTER_SIZE && type <= FILTER_ARM) filters.push({ start: this.length + start, length, type, channels });
                continue;
            }
            if (slot === 257) {
                if (this.lastLength) this.copy(this.lastLength, this.distances[0]);
                continue;
            }
            const index = slot - 258;
            const distance = this.distances[index];
            this.distances.splice(index, 1);
            this.distances.unshift(distance);
            const length = slotToLength(reader, decodeSymbol(reader, tables.repeat));
            this.lastLength = length;
            this.copy(length, distance);
        }
    }

    decodeFile(data, start, end, size, version) {
        const fileStart = this.length;
        const filters = [];
        const distanceSize = version ? DISTANCE_SIZE_V7 : DISTANCE_SIZE;
        this.reserve(size);
        const reader = new BitReader(data, start, end);
        for (;;) {
            reader.align();
            if (reader.bytePosition + 3 > end) throw new Error("RAR data is truncated");
            const flags = reader.bits(8);
            const checksum = reader.bits(8);
            const sizeBytes = ((flags >>> 3) & 3) + 1;
            if (sizeBytes === 4) throw new Error("bad RAR block header");
            let blockSize = 0;
            for (let index = 0; index < sizeBytes; index++) blockSize += reader.bits(8) << (index * 8);
            if (((0x5a ^ flags ^ blockSize ^ (blockSize >>> 8) ^ (blockSize >>> 16)) & 0xff) !== checksum) throw new Error("bad RAR block checksum");
            const blockStart = reader.bytePosition;
            if (blockStart + blockSize > end) throw new Error("RAR data is truncated");
            const blockEnd = (blockStart + blockSize - 1) * 8 + (flags & 7) + 1;
            if (flags & 0x80) this.tables = readTables(reader, distanceSize);
            if (!this.tables) throw new Error("RAR block has no tables");
            this.decodeBlock(reader, blockEnd, filters);
            if (flags & 0x40) break;
            reader.position = (blockStart + blockSize) * 8;
        }
        if (this.length - fileStart < size) throw new Error("RAR data ended early");
        const source = this.window.subarray(fileStart, fileStart + size);
        const output = source.slice();
        for (const filter of filters) {
            const start = filter.start - fileStart;
            if (start + filter.length <= size) applyFilter(output, source, { ...filter, start });
        }
        this.length = fileStart + size;
        return output;
    }
}

function readFileHeader(reader, extraSize, headerEnd) {
    const flags = reader.number();
    const size = reader.number();
    reader.number();
    if (flags & FILE_TIME) reader.u32();
    const crc = flags & FILE_CRC ? reader.u32() : null;
    const compression = reader.number();
    reader.number();
    const name = utf8.decode(reader.bytes(reader.number()));
    let encrypted = false;
    for (let position = headerEnd - extraSize; position < headerEnd;) {
        const extra = new HeaderReader(reader.data, position);
        const recordSize = extra.number();
        const next = extra.position + recordSize;
        if (extra.number() === EXTRA_ENCRYPTION) encrypted = true;
        position = next;
    }
    return {
        name,
        size,
        crc,
        directory: Boolean(flags & FILE_DIRECTORY),
        encrypted,
        version: compression & 0x3f,
        solid: Boolean(compression & COMPRESSION_SOLID),
        method: (compression >>> 7) & 7,
    };
}

export function isRar5(data, offset = 0) {
    return RAR5_MARKER.every((byte, index) => data[offset + index] === byte);
}

export function readRar5(data, offset = 0) {
    const members = [];
    const failures = [];
    let decoder = new Decoder();
    let position = offset + RAR5_MARKER.length;
    while (position < data.length) {
        const reader = new HeaderReader(data, position + 4);
        const headerSize = reader.number();
        const headerEnd = reader.position + headerSize;
        if (headerEnd > data.length) throw new Error("RAR header is truncated");
        if (crc32(data.subarray(position + 4, headerEnd)) !== new HeaderReader(data, position).u32()) throw new Error("RAR header CRC doesn't match");
        const type = reader.number();
        const flags = reader.number();
        const extraSize = flags & FLAG_EXTRA ? reader.number() : 0;
        const dataSize = flags & FLAG_DATA ? reader.number() : 0;
        const dataStart = headerEnd;
        position = headerEnd + dataSize;
        if (type === HEADER_END) break;
        if (type === HEADER_ENCRYPTION) throw new Error("RAR archive headers are encrypted");
        if (type === HEADER_MAIN) {
            if (reader.number() & MAIN_VOLUME_NUMBER) reader.number();
            continue;
        }
        if (type !== HEADER_FILE) continue;
        const file = readFileHeader(reader, extraSize, headerEnd);
        if (file.directory) continue;
        if (!file.solid) decoder = new Decoder();
        if (file.encrypted) {
            failures.push({ name: file.name, reason: "encrypted" });
            decoder = null;
            continue;
        }
        if (flags & (FLAG_SPLIT_BEFORE | FLAG_SPLIT_AFTER)) {
            failures.push({ name: file.name, reason: "split across volumes" });
            decoder = null;
            continue;
        }
        if (dataStart + dataSize > data.length) {
            failures.push({ name: file.name, reason: "truncated" });
            break;
        }
        try {
            if (!decoder) throw new Error("an earlier file in its solid stream could not be decoded");
            let content;
            if (file.method === 0) {
                content = data.slice(dataStart, dataStart + file.size);
            } else {
                content = decoder.decodeFile(data, dataStart, dataStart + dataSize, file.size, file.version);
            }
            if (file.crc !== null && crc32(content) !== file.crc) throw new Error("CRC doesn't match");
            members.push({ name: file.name, data: content });
        } catch (error) {
            failures.push({ name: file.name, reason: error.message });
            decoder = null;
        }
    }
    return { members, failures, messages: [] };
}
