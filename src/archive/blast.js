const LITERAL_LENGTHS = [
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
    44, 173,
];
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAX_CODE_LENGTH = 13;
const END_OF_STREAM_LENGTH = 519;

function buildCode(compact) {
    const lengths = [];
    for (const byte of compact) {
        const repeat = (byte >> 4) + 1;
        for (let index = 0; index < repeat; index++) lengths.push(byte & 15);
    }
    const counts = new Array(14).fill(0);
    for (const length of lengths) counts[length]++;
    const offsets = new Array(14).fill(0);
    for (let length = 1; length < 13; length++) offsets[length + 1] = offsets[length] + counts[length];
    const symbols = new Array(lengths.length).fill(0);
    lengths.forEach((length, symbol) => {
        if (length) {
            symbols[offsets[length]] = symbol;
            offsets[length]++;
        }
    });
    return { counts, symbols };
}

const LITERAL_CODE = buildCode(LITERAL_LENGTHS);
const LENGTH_CODE = buildCode(LENGTH_LENGTHS);
const DISTANCE_CODE = buildCode(DISTANCE_LENGTHS);

class BitReader {
    constructor(data) {
        this.data = data;
        this.position = 0;
        this.buffer = 0;
        this.count = 0;
    }

    bits(needed) {
        while (this.count < needed) {
            if (this.position >= this.data.length) throw new RangeError("PKWARE DCL stream is truncated");
            this.buffer |= this.data[this.position] << this.count;
            this.position++;
            this.count += 8;
        }
        const value = this.buffer & ((1 << needed) - 1);
        this.buffer >>>= needed;
        this.count -= needed;
        return value;
    }

    decode(codeTable) {
        const { counts, symbols } = codeTable;
        let code = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
            code |= this.bits(1) ^ 1;
            const count = counts[length];
            if (code < first + count) return symbols[index + code - first];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error("PKWARE DCL stream has a bad code");
    }
}

class GrowingBuffer {
    constructor(capacity) {
        this.bytes = new Uint8Array(Math.max(capacity, 1024));
        this.length = 0;
    }

    push(byte) {
        if (this.length === this.bytes.length) {
            const larger = new Uint8Array(this.bytes.length * 2);
            larger.set(this.bytes);
            this.bytes = larger;
        }
        this.bytes[this.length++] = byte;
    }

    result() {
        return this.bytes.slice(0, this.length);
    }
}

export function blast(data) {
    const reader = new BitReader(data);
    const codedLiterals = reader.bits(8);
    const dictionaryBits = reader.bits(8);
    const output = new GrowingBuffer(data.length * 4);
    while (true) {
        if (reader.bits(1)) {
            const symbol = reader.decode(LENGTH_CODE);
            const length = LENGTH_BASE[symbol] + reader.bits(LENGTH_EXTRA_BITS[symbol]);
            if (length === END_OF_STREAM_LENGTH) return output.result();
            const shift = length === 2 ? 2 : dictionaryBits;
            const distance = (reader.decode(DISTANCE_CODE) << shift) + reader.bits(shift) + 1;
            if (distance > output.length) throw new RangeError("PKWARE DCL distance is too far back");
            for (let index = 0; index < length; index++) output.push(output.bytes[output.length - distance]);
        } else {
            output.push(codedLiterals ? reader.decode(LITERAL_CODE) : reader.bits(8));
        }
    }
}
