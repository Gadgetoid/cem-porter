const MAX_BITS = 15;
const INITIAL_OUTPUT_LIMIT = 1 << 22;
const MAX_LENGTH_CODES = 286;
const MAX_DISTANCE_CODES = 30;
const FIXED_LENGTH_CODES = 288;
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class InflateFailure {
    constructor(message) {
        this.message = message;
    }
}

const OUT_OF_INPUT = Symbol("out of input");
const OUTPUT_FULL = Symbol("output full");

class Huffman {
    constructor(lengths) {
        this.counts = new Uint16Array(MAX_BITS + 1);
        this.symbols = new Uint16Array(lengths.length);
        for (const length of lengths) this.counts[length]++;
        this.complete = true;
        this.oversubscribed = false;
        if (this.counts[0] === lengths.length) {
            this.empty = true;
            return;
        }
        this.empty = false;
        let left = 1;
        for (let length = 1; length <= MAX_BITS; length++) {
            left = left * 2 - this.counts[length];
            if (left < 0) {
                this.oversubscribed = true;
                return;
            }
        }
        this.complete = left === 0;
        const offsets = new Uint16Array(MAX_BITS + 1);
        for (let length = 1; length < MAX_BITS; length++) offsets[length + 1] = offsets[length] + this.counts[length];
        lengths.forEach((length, symbol) => {
            if (length) this.symbols[offsets[length]++] = symbol;
        });
    }

    isSingleShortCode() {
        return this.counts[1] === 1 && this.counts.slice(2).every((count) => count === 0);
    }
}

function buildFixedTables() {
    const lengths = new Array(FIXED_LENGTH_CODES);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    return { lengthCode: new Huffman(lengths), distanceCode: new Huffman(new Array(MAX_DISTANCE_CODES + 2).fill(5)) };
}

let fixedTables = null;

class Inflater {
    constructor(data, start, end, maxOutput) {
        this.data = data;
        this.position = start;
        this.end = end;
        this.bitBuffer = 0;
        this.bitCount = 0;
        this.maxOutput = maxOutput;
        this.output = new Uint8Array(Math.min(Math.max(1024, (end - start) * 2), INITIAL_OUTPUT_LIMIT, Math.max(maxOutput, 1)));
        this.length = 0;
    }

    bits(needed) {
        let value = this.bitBuffer;
        while (this.bitCount < needed) {
            if (this.position >= this.end) throw OUT_OF_INPUT;
            value |= this.data[this.position++] << this.bitCount;
            this.bitCount += 8;
        }
        this.bitBuffer = value >>> needed;
        this.bitCount -= needed;
        return value & ((1 << needed) - 1);
    }

    ensureCapacity(extra) {
        if (this.length + extra <= this.output.length) return;
        const larger = new Uint8Array(Math.max(this.output.length * 2, this.length + extra));
        larger.set(this.output.subarray(0, this.length));
        this.output = larger;
    }

    emit(byte) {
        if (this.length >= this.maxOutput) throw OUTPUT_FULL;
        this.ensureCapacity(1);
        this.output[this.length++] = byte;
    }

    decode(huffman) {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length <= MAX_BITS; length++) {
            code |= this.bits(1);
            const count = huffman.counts[length];
            if (code - count < first) return huffman.symbols[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        return -1;
    }

    stored() {
        this.bitBuffer = 0;
        this.bitCount = 0;
        if (this.position + 4 > this.end) throw OUT_OF_INPUT;
        const length = this.data[this.position] | (this.data[this.position + 1] << 8);
        const complement = this.data[this.position + 2] | (this.data[this.position + 3] << 8);
        if (length !== (~complement & 0xffff)) throw new InflateFailure("invalid stored block lengths");
        this.position += 4;
        const available = Math.min(length, this.end - this.position);
        const copied = Math.min(available, this.maxOutput - this.length);
        this.ensureCapacity(copied);
        this.output.set(this.data.subarray(this.position, this.position + copied), this.length);
        this.length += copied;
        this.position += copied;
        if (copied < length) throw copied < available ? OUTPUT_FULL : OUT_OF_INPUT;
    }

    codes(lengthCode, distanceCode) {
        while (true) {
            let symbol = this.decode(lengthCode);
            if (symbol < 0 || symbol >= MAX_LENGTH_CODES) throw new InflateFailure("invalid literal/length code");
            if (symbol < 256) {
                this.emit(symbol);
                continue;
            }
            if (symbol === 256) return;
            symbol -= 257;
            const length = LENGTH_BASE[symbol] + this.bits(LENGTH_EXTRA_BITS[symbol]);
            const distanceSymbol = this.decode(distanceCode);
            if (distanceSymbol < 0 || distanceSymbol >= MAX_DISTANCE_CODES) throw new InflateFailure("invalid distance code");
            const distance = DISTANCE_BASE[distanceSymbol] + this.bits(DISTANCE_EXTRA_BITS[distanceSymbol]);
            if (this.length >= this.maxOutput) throw OUTPUT_FULL;
            if (distance > this.length) throw new InflateFailure("invalid distance too far back");
            for (let index = 0; index < length; index++) this.emit(this.output[this.length - distance]);
        }
    }

    fixed() {
        if (!fixedTables) fixedTables = buildFixedTables();
        this.codes(fixedTables.lengthCode, fixedTables.distanceCode);
    }

    dynamic() {
        const lengthCount = this.bits(5) + 257;
        const distanceCount = this.bits(5) + 1;
        const codeLengthCount = this.bits(4) + 4;
        if (lengthCount > MAX_LENGTH_CODES || distanceCount > MAX_DISTANCE_CODES) throw new InflateFailure("too many length or distance symbols");
        const codeLengths = new Array(19).fill(0);
        for (let index = 0; index < codeLengthCount; index++) codeLengths[CODE_LENGTH_ORDER[index]] = this.bits(3);
        const codeLengthCode = new Huffman(codeLengths);
        if (codeLengthCode.empty || codeLengthCode.oversubscribed || !codeLengthCode.complete) throw new InflateFailure("invalid code lengths set");
        const lengths = new Array(lengthCount + distanceCount).fill(0);
        let index = 0;
        while (index < lengthCount + distanceCount) {
            const symbol = this.decode(codeLengthCode);
            if (symbol < 0) throw new InflateFailure("invalid code lengths set");
            if (symbol < 16) {
                lengths[index++] = symbol;
                continue;
            }
            let repeatValue = 0;
            let repeatCount;
            if (symbol === 16) {
                if (index === 0) throw new InflateFailure("invalid bit length repeat");
                repeatValue = lengths[index - 1];
                repeatCount = 3 + this.bits(2);
            } else if (symbol === 17) {
                repeatCount = 3 + this.bits(3);
            } else {
                repeatCount = 11 + this.bits(7);
            }
            if (index + repeatCount > lengthCount + distanceCount) throw new InflateFailure("invalid bit length repeat");
            while (repeatCount--) lengths[index++] = repeatValue;
        }
        if (lengths[256] === 0) throw new InflateFailure("invalid code -- missing end-of-block");
        const lengthCode = new Huffman(lengths.slice(0, lengthCount));
        if (lengthCode.oversubscribed || (!lengthCode.complete && !lengthCode.isSingleShortCode())) throw new InflateFailure("invalid literal/lengths set");
        const distanceCode = new Huffman(lengths.slice(lengthCount));
        if (distanceCode.oversubscribed || (!distanceCode.empty && !distanceCode.complete && !distanceCode.isSingleShortCode())) throw new InflateFailure("invalid distances set");
        this.codes(lengthCode, distanceCode);
    }

    run() {
        let last = 0;
        try {
            do {
                last = this.bits(1);
                const type = this.bits(2);
                if (type === 0) this.stored();
                else if (type === 1) this.fixed();
                else if (type === 2) this.dynamic();
                else throw new InflateFailure("invalid block type");
            } while (!last);
        } catch (error) {
            if (error === OUT_OF_INPUT || error === OUTPUT_FULL) return { output: this.result(), end: this.position, finished: false, error: null };
            if (error instanceof InflateFailure) return { output: this.result(), end: this.position, finished: false, error: error.message };
            throw error;
        }
        return { output: this.result(), end: this.position, finished: true, error: null };
    }

    result() {
        return this.output.slice(0, this.length);
    }
}

export function inflateRaw(data, { start = 0, end = data.length, maxOutput = Infinity } = {}) {
    return new Inflater(data, start, Math.min(end, data.length), maxOutput).run();
}
