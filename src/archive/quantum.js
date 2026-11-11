const POSITION_BASE = [
    0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192,
    256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152,
    65536, 98304, 131072, 196608, 262144, 393216, 524288, 786432, 1048576, 1572864,
];
const POSITION_EXTRA_BITS = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14,
    15, 15, 16, 16, 17, 17, 18, 18, 19, 19,
];
const LENGTH_BASE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 18, 22, 26, 30, 38, 46, 54, 62, 78, 94, 110, 126, 158, 190, 222, 254];
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const MIN_WINDOW_BITS = 10;
const MAX_WINDOW_BITS = 21;
const FREQUENCY_STEP = 8;
const FREQUENCY_LIMIT = 3800;
const SHIFTS_BEFORE_SORT = 50;
const SHORT_MATCH_LENGTH = 3;
const MEDIUM_MATCH_LENGTH = 4;
const LONG_MATCH_MIN_LENGTH = 5;

class Model {
    constructor(first, count) {
        this.count = count;
        this.shiftsLeft = 4;
        this.symbols = Uint16Array.from({ length: count + 1 }, (_, index) => first + index);
        this.frequencies = Uint16Array.from({ length: count + 1 }, (_, index) => count - index);
    }

    update() {
        const { symbols, frequencies, count } = this;
        if (--this.shiftsLeft) {
            for (let index = count - 1; index >= 0; index--) {
                frequencies[index] >>= 1;
                if (frequencies[index] <= frequencies[index + 1]) frequencies[index] = frequencies[index + 1] + 1;
            }
            return;
        }
        this.shiftsLeft = SHIFTS_BEFORE_SORT;
        for (let index = 0; index < count; index++) frequencies[index] = (frequencies[index] - frequencies[index + 1] + 1) >> 1;
        for (let index = 0; index < count - 1; index++) {
            for (let other = index + 1; other < count; other++) {
                if (frequencies[index] >= frequencies[other]) continue;
                [frequencies[index], frequencies[other]] = [frequencies[other], frequencies[index]];
                [symbols[index], symbols[other]] = [symbols[other], symbols[index]];
            }
        }
        for (let index = count - 1; index >= 0; index--) frequencies[index] += frequencies[index + 1];
    }
}

class Decoder {
    constructor(data) {
        this.data = data;
        this.position = 0;
        this.buffer = 0;
        this.count = 0;
        this.low = 0;
        this.high = 0xffff;
        this.code = this.bits(16);
    }

    bits(count) {
        while (this.count < count) {
            this.buffer = ((this.buffer << 8) | (this.position < this.data.length ? this.data[this.position++] : 0)) >>> 0;
            this.count += 8;
        }
        this.count -= count;
        const value = (this.buffer >>> this.count) & ((1 << count) - 1);
        this.buffer &= (1 << this.count) - 1;
        return value;
    }

    symbol(model) {
        const { symbols, frequencies } = model;
        const total = frequencies[0];
        const scaled = Math.floor(((this.code - this.low + 1) * total - 1) / (((this.high - this.low) & 0xffff) + 1)) & 0xffff;
        let index = 1;
        while (index < model.count && frequencies[index] > scaled) index++;
        const symbol = symbols[index - 1];
        const range = this.high - this.low + 1;
        this.high = (this.low + Math.floor((frequencies[index - 1] * range) / total) - 1) & 0xffff;
        this.low = (this.low + Math.floor((frequencies[index] * range) / total)) & 0xffff;
        for (let entry = index - 1; entry >= 0; entry--) frequencies[entry] += FREQUENCY_STEP;
        if (frequencies[0] > FREQUENCY_LIMIT) model.update();
        for (;;) {
            if ((this.low & 0x8000) !== (this.high & 0x8000)) {
                if (!(this.low & 0x4000) || this.high & 0x4000) break;
                this.code ^= 0x4000;
                this.low &= 0x3fff;
                this.high |= 0x4000;
            }
            this.low = (this.low << 1) & 0xffff;
            this.high = ((this.high << 1) | 1) & 0xffff;
            this.code = ((this.code << 1) | this.bits(1)) & 0xffff;
        }
        return symbol;
    }
}

export function decompressQuantum(blocks, windowBits) {
    if (windowBits < MIN_WINDOW_BITS || windowBits > MAX_WINDOW_BITS) throw new Error(`bad Quantum window size ${windowBits}`);
    const positionSlots = windowBits * 2;
    const literals = [new Model(0, 64), new Model(64, 64), new Model(128, 64), new Model(192, 64)];
    const shortMatch = new Model(0, Math.min(positionSlots, 24));
    const mediumMatch = new Model(0, Math.min(positionSlots, 36));
    const longMatch = new Model(0, positionSlots);
    const longLength = new Model(0, 27);
    const selectors = new Model(0, 7);
    const output = new Uint8Array(blocks.reduce((sum, block) => sum + block.size, 0));
    let position = 0;
    for (const block of blocks) {
        const decoder = new Decoder(block.data);
        const end = position + block.size;
        while (position < end) {
            const selector = decoder.symbol(selectors);
            if (selector < 4) {
                output[position++] = decoder.symbol(literals[selector]);
                continue;
            }
            let length;
            let slot;
            if (selector === 4) {
                slot = decoder.symbol(shortMatch);
                length = SHORT_MATCH_LENGTH;
            } else if (selector === 5) {
                slot = decoder.symbol(mediumMatch);
                length = MEDIUM_MATCH_LENGTH;
            } else {
                const lengthSlot = decoder.symbol(longLength);
                length = LENGTH_BASE[lengthSlot] + decoder.bits(LENGTH_EXTRA_BITS[lengthSlot]) + LONG_MATCH_MIN_LENGTH;
                slot = decoder.symbol(longMatch);
            }
            const distance = POSITION_BASE[slot] + decoder.bits(POSITION_EXTRA_BITS[slot]) + 1;
            if (distance > position) throw new Error("Quantum match is outside the window");
            if (position + length > end) throw new Error("Quantum match runs past its block");
            for (let source = position - distance; length > 0; length--) output[position++] = output[source++];
        }
    }
    return output;
}
