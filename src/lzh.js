import { latin1Decode, u16, u32 } from "./pe.js";

const METHODS = {
    "-lh0-": 0,
    "-lh5-": 13,
    "-lh6-": 15,
    "-lh7-": 16,
};
const DIRECTORY_METHOD = "-lhd-";
const LITERAL_SYMBOLS = 510;
const LITERAL_COUNT_BITS = 9;
const PRELUDE_SYMBOLS = 19;
const PRELUDE_COUNT_BITS = 5;
const MATCH_OFFSET = 253;
const PATH_SEPARATOR = 0xff;
const EXTENDED_COMMON = 0x00;
const EXTENDED_FILENAME = 0x01;
const EXTENDED_DIRECTORY = 0x02;
const EXTENDED_CODEPAGE = 0x46;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const shiftJis = new TextDecoder("shift_jis");

class BitReader {
    constructor(data) {
        this.data = data;
        this.position = 0;
        this.buffer = 0;
        this.count = 0;
    }

    fill(needed) {
        while (this.count < needed) {
            const byte = this.position < this.data.length ? this.data[this.position] : 0;
            this.position++;
            this.buffer = ((this.buffer << 8) | byte) >>> 0;
            this.count += 8;
        }
        if (this.position > this.data.length + 4) throw new RangeError("LHA data is truncated");
    }

    peek(needed) {
        this.fill(needed);
        return (this.buffer >>> (this.count - needed)) & ((1 << needed) - 1);
    }

    skip(count) {
        this.fill(count);
        this.count -= count;
        this.buffer &= this.count ? (2 ** this.count - 1) : 0;
    }

    bits(needed) {
        if (needed === 0) return 0;
        const value = this.peek(needed);
        this.skip(needed);
        return value;
    }
}

class HuffmanTable {
    constructor(lengths) {
        this.single = null;
        this.maxLength = Math.max(0, ...lengths);
        if (this.maxLength === 0) throw new Error("LHA Huffman table is empty");
        let used = 0;
        for (const length of lengths) if (length) used += 2 ** (16 - length);
        if (used !== 65536) throw new Error("LHA Huffman table is invalid");
        this.symbols = new Uint16Array(1 << this.maxLength);
        this.lengths = new Uint8Array(1 << this.maxLength);
        let code = 0;
        for (let length = 1; length <= this.maxLength; length++) {
            for (let symbol = 0; symbol < lengths.length; symbol++) {
                if (lengths[symbol] !== length) continue;
                const span = 1 << (this.maxLength - length);
                const start = code << (this.maxLength - length);
                this.symbols.fill(symbol, start, start + span);
                this.lengths.fill(length, start, start + span);
                code++;
            }
            code <<= 1;
        }
    }

    static constant(symbol) {
        const table = Object.create(HuffmanTable.prototype);
        table.single = symbol;
        return table;
    }

    decode(reader) {
        if (this.single !== null) return this.single;
        const index = reader.peek(this.maxLength);
        reader.skip(this.lengths[index]);
        return this.symbols[index];
    }
}

function readPreludeLengths(reader, symbolCount, countBits, specialIndex) {
    const count = reader.bits(countBits);
    if (count === 0) return HuffmanTable.constant(reader.bits(countBits));
    if (count > symbolCount) throw new Error("LHA table has too many symbols");
    const lengths = new Array(symbolCount).fill(0);
    let index = 0;
    while (index < count) {
        let length = reader.bits(3);
        if (length === 7) {
            while (reader.bits(1)) {
                length++;
                if (length > 16) throw new Error("LHA code length is too long");
            }
        }
        lengths[index++] = length;
        if (index === specialIndex) {
            let zeros = reader.bits(2);
            while (zeros-- > 0 && index < symbolCount) lengths[index++] = 0;
        }
    }
    return new HuffmanTable(lengths);
}

function readLiteralLengths(reader, preludeTable) {
    const count = reader.bits(LITERAL_COUNT_BITS);
    if (count === 0) return HuffmanTable.constant(reader.bits(LITERAL_COUNT_BITS));
    if (count > LITERAL_SYMBOLS) throw new Error("LHA table has too many symbols");
    const lengths = new Array(LITERAL_SYMBOLS).fill(0);
    let index = 0;
    while (index < count) {
        const code = preludeTable.decode(reader);
        if (code <= 2) {
            let zeros = 1;
            if (code === 1) zeros = reader.bits(4) + 3;
            if (code === 2) zeros = reader.bits(LITERAL_COUNT_BITS) + 20;
            if (index + zeros > LITERAL_SYMBOLS) throw new Error("LHA zero run is too long");
            while (zeros-- > 0) lengths[index++] = 0;
        } else {
            lengths[index++] = code - 2;
        }
    }
    return new HuffmanTable(lengths);
}

function decodeLzhuf(data, size, dictionaryBits) {
    const reader = new BitReader(data);
    const offsetSymbols = dictionaryBits + 1;
    const offsetCountBits = dictionaryBits >= 15 ? 5 : 4;
    const output = new Uint8Array(size);
    let written = 0;
    let blockRemaining = 0;
    let literalTable = null;
    let offsetTable = null;
    while (written < size) {
        if (blockRemaining === 0) {
            blockRemaining = reader.bits(16);
            if (blockRemaining === 0) throw new Error("LHA block is empty");
            const preludeTable = readPreludeLengths(reader, PRELUDE_SYMBOLS, PRELUDE_COUNT_BITS, 3);
            literalTable = readLiteralLengths(reader, preludeTable);
            offsetTable = readPreludeLengths(reader, offsetSymbols, offsetCountBits, -1);
        }
        blockRemaining--;
        const symbol = literalTable.decode(reader);
        if (symbol < 256) {
            output[written++] = symbol;
            continue;
        }
        const length = symbol - MATCH_OFFSET;
        let distance = offsetTable.decode(reader);
        if (distance > 0) distance = (1 << (distance - 1)) + reader.bits(distance - 1);
        const source = written - distance - 1;
        for (let index = 0; index < length && written < size; index++) {
            const from = source + index;
            output[written++] = from >= 0 ? output[from] : 0x20;
        }
    }
    return output;
}

function readExtendedHeaders(data, position, end, entry) {
    let total = 0;
    while (true) {
        if (position + 2 > end) throw new RangeError("LHA extended header is truncated");
        const size = u16(data, position);
        if (size === 0) return total + 2;
        if (size < 3 || position + size > end) throw new RangeError("LHA extended header is invalid");
        const type = data[position + 2];
        const body = data.subarray(position + 3, position + size);
        if (type === EXTENDED_FILENAME) entry.nameBytes = body.slice();
        if (type === EXTENDED_DIRECTORY) entry.directoryBytes = body.slice();
        if (type === EXTENDED_CODEPAGE && body.length >= 4) entry.codepage = u32(body, 0);
        total += size;
        position += size;
    }
}

function readHeader(data, position) {
    if (position >= data.length || data[position] === 0) return null;
    if (position + 21 > data.length) throw new RangeError("LHA header is truncated");
    const level = data[position + 20];
    const entry = {
        method: latin1Decode(data.subarray(position + 2, position + 7)),
        packedSize: u32(data, position + 7),
        size: u32(data, position + 11),
        nameBytes: new Uint8Array(0),
        directoryBytes: null,
        codepage: null,
    };
    if (level === 0 || level === 1) {
        const headerSize = data[position] + 2;
        const nameLength = data[position + 21];
        if (position + headerSize > data.length || 22 + nameLength > headerSize) throw new RangeError("LHA header is truncated");
        let checksum = 0;
        for (let index = position + 2; index < position + headerSize; index++) checksum += data[index];
        if ((checksum & 0xff) !== data[position + 1]) throw new Error("LHA header checksum is wrong");
        entry.nameBytes = data.slice(position + 22, position + 22 + nameLength);
        if (level === 0) {
            entry.dataOffset = position + headerSize;
            entry.compressedSize = entry.packedSize;
        } else {
            const extendedSize = readExtendedHeaders(data, position + headerSize - 2, data.length, entry) - 2;
            entry.dataOffset = position + headerSize + extendedSize;
            entry.compressedSize = entry.packedSize - extendedSize;
        }
    } else if (level === 2) {
        const headerSize = u16(data, position);
        if (position + headerSize > data.length || headerSize < 26) throw new RangeError("LHA header is truncated");
        readExtendedHeaders(data, position + 24, position + headerSize, entry);
        entry.dataOffset = position + headerSize;
        entry.compressedSize = entry.packedSize;
    } else {
        throw new Error(`LHA header level ${level} isn't supported`);
    }
    if (entry.compressedSize < 0) throw new RangeError("LHA entry size is invalid");
    return entry;
}

function joinNameBytes(entry) {
    const parts = [];
    if (entry.directoryBytes && entry.directoryBytes.length) {
        parts.push(...entry.directoryBytes);
        if (entry.directoryBytes[entry.directoryBytes.length - 1] !== PATH_SEPARATOR) parts.push(PATH_SEPARATOR);
    }
    parts.push(...entry.nameBytes);
    return Uint8Array.from(parts, (byte) => (byte === PATH_SEPARATOR ? 0x2f : byte));
}

export function decodeLzhName(bytes) {
    try {
        return utf8.decode(bytes);
    } catch {
        return shiftJis.decode(bytes);
    }
}

export function isLzh(data) {
    return data.length > 7 && data[2] === 0x2d && data[3] === 0x6c && data[6] === 0x2d;
}

export function scanLzh(data) {
    const members = [];
    let position = 0;
    try {
        while (true) {
            const entry = readHeader(data, position);
            if (!entry) break;
            const nameBytes = joinNameBytes(entry);
            const isDirectory = entry.method === DIRECTORY_METHOD || nameBytes.length === 0 || nameBytes[nameBytes.length - 1] === 0x2f;
            const compressed = data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
            position = entry.dataOffset + entry.compressedSize;
            if (isDirectory) continue;
            if (!(entry.method in METHODS)) throw new Error(`LHA method ${entry.method} isn't supported`);
            const dictionaryBits = METHODS[entry.method];
            const content = dictionaryBits ? decodeLzhuf(compressed, entry.size, dictionaryBits) : compressed.slice();
            members.push({ name: decodeLzhName(nameBytes), nameBytes, codepage: entry.codepage, data: content });
        }
    } catch (error) {
        return { members, error };
    }
    return { members, error: null };
}

export function readLzh(data) {
    const { members, error } = scanLzh(data);
    if (error) throw error;
    return members;
}
