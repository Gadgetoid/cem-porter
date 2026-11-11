const BLOCK_MAGIC_HIGH = 0x314159;
const BLOCK_MAGIC_LOW = 0x265359;
const END_MAGIC_HIGH = 0x177245;
const END_MAGIC_LOW = 0x385090;
const NSIS_BLOCK = 0x31;
const NSIS_END = 0x17;
const BLOCK_SIZE_STEP = 100000;
const GROUP_SIZE = 50;
const MAX_CODE_LENGTH = 20;
const RUN_LENGTH_LIMIT = 4;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
    let crc = index << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    CRC_TABLE[index] = crc >>> 0;
}

class BitReader {
    constructor(data, position) {
        this.data = data;
        this.position = position;
        this.buffer = 0;
        this.count = 0;
    }

    bits(count) {
        while (this.count < count) {
            if (this.position >= this.data.length) throw new Error("bzip2 data is truncated");
            this.buffer = ((this.buffer << 8) | this.data[this.position++]) >>> 0;
            this.count += 8;
        }
        this.count -= count;
        const value = (this.buffer >>> this.count) & ((1 << count) - 1);
        this.buffer &= (1 << this.count) - 1;
        return value;
    }

    bit() {
        return this.bits(1);
    }

    align() {
        this.count -= this.count & 7;
        this.buffer &= (1 << this.count) - 1;
    }

    atEnd() {
        return this.count < 8 && this.position >= this.data.length;
    }
}

class Output {
    constructor(size) {
        this.data = new Uint8Array(size);
        this.length = 0;
    }

    reserve(count) {
        if (this.length + count <= this.data.length) return;
        const grown = new Uint8Array(Math.max(this.data.length * 2, this.length + count));
        grown.set(this.data.subarray(0, this.length));
        this.data = grown;
    }
}

function buildCode(lengths) {
    const counts = new Uint16Array(MAX_CODE_LENGTH + 1);
    for (const length of lengths) counts[length]++;
    const offsets = new Uint16Array(MAX_CODE_LENGTH + 2);
    for (let length = 1; length <= MAX_CODE_LENGTH; length++) offsets[length + 1] = offsets[length] + counts[length];
    const symbols = new Uint16Array(lengths.length);
    lengths.forEach((length, symbol) => (symbols[offsets[length]++] = symbol));
    return { counts, symbols };
}

function decodeSymbol(reader, code) {
    let value = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
        value |= reader.bit();
        const count = code.counts[length];
        if (value - count < first) return code.symbols[index + value - first];
        index += count;
        first = (first + count) << 1;
        value <<= 1;
    }
    throw new Error("bad bzip2 Huffman code");
}

function readCodes(reader, alphabetSize) {
    const groupCount = reader.bits(3);
    if (groupCount < 2 || groupCount > 6) throw new Error("bad bzip2 table count");
    const selectorCount = reader.bits(15);
    if (!selectorCount) throw new Error("bzip2 block has no selectors");
    const order = Array.from({ length: groupCount }, (_, index) => index);
    const selectors = new Uint8Array(selectorCount);
    for (let index = 0; index < selectorCount; index++) {
        let position = 0;
        while (reader.bit()) {
            if (++position >= groupCount) throw new Error("bad bzip2 selector");
        }
        const group = order[position];
        order.splice(position, 1);
        order.unshift(group);
        selectors[index] = group;
    }
    const codes = [];
    for (let group = 0; group < groupCount; group++) {
        const lengths = new Uint8Array(alphabetSize);
        let length = reader.bits(5);
        for (let symbol = 0; symbol < alphabetSize; symbol++) {
            for (;;) {
                if (length < 1 || length > MAX_CODE_LENGTH) throw new Error("bad bzip2 code length");
                if (!reader.bit()) break;
                length += reader.bit() ? -1 : 1;
            }
            lengths[symbol] = length;
        }
        codes.push(buildCode(lengths));
    }
    return { codes, selectors };
}

function readSymbolMap(reader) {
    const used = reader.bits(16);
    const symbols = [];
    for (let high = 0; high < 16; high++) {
        if (!(used & (0x8000 >> high))) continue;
        const bits = reader.bits(16);
        for (let low = 0; low < 16; low++) {
            if (bits & (0x8000 >> low)) symbols.push(high * 16 + low);
        }
    }
    if (!symbols.length) throw new Error("bzip2 block uses no symbols");
    return symbols;
}

function decodeBlock(reader, blockSize, output) {
    const origin = reader.bits(24);
    const symbolMap = readSymbolMap(reader);
    const endOfBlock = symbolMap.length + 1;
    const { codes, selectors } = readCodes(reader, symbolMap.length + 2);
    const transform = new Uint32Array(blockSize);
    const byteCounts = new Uint32Array(256);
    const moveToFront = Uint8Array.from(symbolMap, (_, index) => index);
    let count = 0;
    let run = 0;
    let runBit = 1;
    let selectorIndex = 0;
    let groupLeft = 0;
    let code = null;
    for (;;) {
        if (!groupLeft) {
            if (selectorIndex >= selectors.length) throw new Error("bzip2 block runs past its selectors");
            code = codes[selectors[selectorIndex++]];
            groupLeft = GROUP_SIZE;
        }
        groupLeft--;
        const symbol = decodeSymbol(reader, code);
        if (symbol <= 1) {
            run += runBit << symbol;
            runBit <<= 1;
            if (run > blockSize) throw new Error("bzip2 run is longer than the block");
            continue;
        }
        if (run) {
            if (count + run > blockSize) throw new Error("bzip2 block is longer than its size");
            const byte = symbolMap[moveToFront[0]];
            byteCounts[byte] += run;
            transform.fill(byte, count, count + run);
            count += run;
            run = 0;
            runBit = 1;
        }
        if (symbol === endOfBlock) break;
        if (count >= blockSize) throw new Error("bzip2 block is longer than its size");
        const position = symbol - 1;
        const value = moveToFront[position];
        moveToFront.copyWithin(1, 0, position);
        moveToFront[0] = value;
        const byte = symbolMap[value];
        byteCounts[byte]++;
        transform[count++] = byte;
    }
    if (origin >= count) throw new Error("bzip2 block origin is outside the block");
    const starts = new Uint32Array(256);
    for (let byte = 1; byte < 256; byte++) starts[byte] = starts[byte - 1] + byteCounts[byte - 1];
    for (let index = 0; index < count; index++) transform[starts[transform[index] & 0xff]++] |= index << 8;
    const start = output.length;
    output.reserve(count);
    let position = transform[origin] >>> 8;
    let previous = -1;
    let repeats = 0;
    for (let index = 0; index < count; index++) {
        const entry = transform[position];
        const byte = entry & 0xff;
        position = entry >>> 8;
        if (repeats === RUN_LENGTH_LIMIT) {
            output.reserve(byte + count - index);
            output.data.fill(previous, output.length, output.length + byte);
            output.length += byte;
            repeats = 0;
            continue;
        }
        if (byte === previous) {
            repeats++;
        } else {
            previous = byte;
            repeats = 1;
        }
        output.data[output.length++] = byte;
    }
    return output.data.subarray(start, output.length);
}

function blockCrc(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]) >>> 0;
    return ~crc >>> 0;
}

export function isBzip2(data, offset = 0) {
    return data[offset] === 0x42 && data[offset + 1] === 0x5a && data[offset + 2] === 0x68 && data[offset + 3] >= 0x31 && data[offset + 3] <= 0x39;
}

export function bzip2Decode(data, sizeHint = data.length * 4) {
    const output = new Output(sizeHint);
    const reader = new BitReader(data, 0);
    while (!reader.atEnd()) {
        if (reader.bits(8) !== 0x42 || reader.bits(8) !== 0x5a || reader.bits(8) !== 0x68) {
            if (output.length) break;
            throw new Error("not a bzip2 stream");
        }
        const level = reader.bits(8) - 0x30;
        if (level < 1 || level > 9) throw new Error("bad bzip2 block size");
        for (;;) {
            const high = reader.bits(24);
            const low = reader.bits(24);
            if (high === END_MAGIC_HIGH && low === END_MAGIC_LOW) {
                reader.bits(32);
                reader.align();
                break;
            }
            if (high !== BLOCK_MAGIC_HIGH || low !== BLOCK_MAGIC_LOW) throw new Error("bad bzip2 block signature");
            const crc = (reader.bits(16) * 0x10000 + reader.bits(16)) >>> 0;
            if (reader.bit()) throw new Error("randomised bzip2 blocks aren't supported");
            const block = decodeBlock(reader, level * BLOCK_SIZE_STEP, output);
            if (blockCrc(block) !== crc) throw new Error("bzip2 block CRC doesn't match");
        }
    }
    return output.data.subarray(0, output.length);
}

export function nsisBzip2Decode(data, start = 0, end = data.length, sizeHint = (end - start) * 4) {
    const output = new Output(sizeHint);
    const reader = new BitReader(data.subarray(start, end), 0);
    for (;;) {
        const signature = reader.bits(8);
        if (signature === NSIS_END) break;
        if (signature !== NSIS_BLOCK) throw new Error("bad NSIS bzip2 block signature");
        decodeBlock(reader, 9 * BLOCK_SIZE_STEP, output);
    }
    return output.data.subarray(0, output.length);
}
