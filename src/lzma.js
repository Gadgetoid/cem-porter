const PROBABILITY_BITS = 11;
const PROBABILITY_INITIAL = 1 << (PROBABILITY_BITS - 1);
const MOVE_BITS = 5;
const TOP = 1 << 24;
const STATES = 12;
const POSITION_STATES_MAX = 16;
const LENGTH_TO_POSITION_STATES = 4;
const END_POSITION_MODEL_INDEX = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const MATCH_MIN_LENGTH = 2;

class RangeDecoder {
    constructor(data, start, end) {
        this.data = data;
        this.position = start + 1;
        this.end = end;
        this.range = 0xffffffff;
        this.code = 0;
        for (let index = 0; index < 4; index++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    }

    byte() {
        if (this.position >= this.end) throw new Error("LZMA data is truncated");
        return this.data[this.position++];
    }

    normalize() {
        if (this.range < TOP) {
            this.range = (this.range << 8) >>> 0;
            this.code = ((this.code << 8) | this.byte()) >>> 0;
        }
    }

    bit(probabilities, index) {
        const probability = probabilities[index];
        const bound = (this.range >>> PROBABILITY_BITS) * probability;
        let bit;
        if (this.code < bound) {
            this.range = bound;
            probabilities[index] = probability + (((1 << PROBABILITY_BITS) - probability) >>> MOVE_BITS);
            bit = 0;
        } else {
            this.range = (this.range - bound) >>> 0;
            this.code = (this.code - bound) >>> 0;
            probabilities[index] = probability - (probability >>> MOVE_BITS);
            bit = 1;
        }
        this.normalize();
        return bit;
    }

    direct(count) {
        let result = 0;
        for (let index = 0; index < count; index++) {
            this.range >>>= 1;
            let bit = 0;
            if (this.code >= this.range) {
                this.code = (this.code - this.range) >>> 0;
                bit = 1;
            }
            result = ((result << 1) | bit) >>> 0;
            this.normalize();
        }
        return result;
    }

    tree(probabilities, offset, bits) {
        let index = 1;
        for (let bit = 0; bit < bits; bit++) index = (index << 1) | this.bit(probabilities, offset + index);
        return index - (1 << bits);
    }

    reverseTree(probabilities, offset, bits) {
        let index = 1;
        let result = 0;
        for (let bit = 0; bit < bits; bit++) {
            const value = this.bit(probabilities, offset + index);
            index = (index << 1) | value;
            result |= value << bit;
        }
        return result;
    }
}

class LengthDecoder {
    constructor() {
        this.choice = new Uint16Array(2);
        this.low = new Uint16Array(POSITION_STATES_MAX << 3);
        this.mid = new Uint16Array(POSITION_STATES_MAX << 3);
        this.high = new Uint16Array(256);
        this.reset();
    }

    reset() {
        for (const table of [this.choice, this.low, this.mid, this.high]) table.fill(PROBABILITY_INITIAL);
    }

    decode(range, positionState) {
        if (!range.bit(this.choice, 0)) return range.tree(this.low, positionState << 3, 3);
        if (!range.bit(this.choice, 1)) return 8 + range.tree(this.mid, positionState << 3, 3);
        return 16 + range.tree(this.high, 0, 8);
    }
}

export class LzmaDecoder {
    constructor(output) {
        this.output = output;
        this.position = 0;
        this.dictionaryStart = 0;
        this.isMatch = new Uint16Array(STATES << 4);
        this.isRep = new Uint16Array(STATES);
        this.isRepG0 = new Uint16Array(STATES);
        this.isRepG1 = new Uint16Array(STATES);
        this.isRepG2 = new Uint16Array(STATES);
        this.isRep0Long = new Uint16Array(STATES << 4);
        this.positionSlot = new Uint16Array(LENGTH_TO_POSITION_STATES << 6);
        this.positionSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POSITION_MODEL_INDEX);
        this.align = new Uint16Array(1 << ALIGN_BITS);
        this.length = new LengthDecoder();
        this.repLength = new LengthDecoder();
        this.literal = null;
    }

    setProperties(byte) {
        if (byte >= 9 * 5 * 5) throw new Error("bad LZMA properties");
        this.lc = byte % 9;
        this.lp = Math.floor(byte / 9) % 5;
        this.pb = Math.floor(byte / 45);
        const size = 0x300 << (this.lc + this.lp);
        if (!this.literal || this.literal.length !== size) this.literal = new Uint16Array(size);
    }

    resetState() {
        for (const table of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.positionSlot, this.positionSpecial, this.align, this.literal]) table.fill(PROBABILITY_INITIAL);
        this.length.reset();
        this.repLength.reset();
        this.state = 0;
        this.reps = [0, 0, 0, 0];
    }

    resetDictionary() {
        this.dictionaryStart = this.position;
    }

    decodeLiteral(range) {
        const output = this.output;
        const processed = this.position - this.dictionaryStart;
        const previous = processed > 0 ? output[this.position - 1] : 0;
        const base = 0x300 * (((processed & ((1 << this.lp) - 1)) << this.lc) + (previous >> (8 - this.lc)));
        const probabilities = this.literal;
        let symbol = 1;
        if (this.state >= 7) {
            let matchByte = output[this.position - this.reps[0] - 1];
            while (symbol < 0x100) {
                const matchBit = (matchByte >> 7) & 1;
                matchByte <<= 1;
                const bit = range.bit(probabilities, base + ((1 + matchBit) << 8) + symbol);
                symbol = (symbol << 1) | bit;
                if (matchBit !== bit) break;
            }
        }
        while (symbol < 0x100) symbol = (symbol << 1) | range.bit(probabilities, base + symbol);
        output[this.position++] = symbol & 0xff;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
    }

    decodeDistance(range, length) {
        const lengthState = Math.min(length, LENGTH_TO_POSITION_STATES - 1);
        const slot = range.tree(this.positionSlot, lengthState << 6, 6);
        if (slot < 4) return slot;
        const directBits = (slot >> 1) - 1;
        let distance = ((2 | (slot & 1)) << directBits) >>> 0;
        if (slot < END_POSITION_MODEL_INDEX) return (distance + range.reverseTree(this.positionSpecial, distance - slot, directBits)) >>> 0;
        distance = (distance + (range.direct(directBits - ALIGN_BITS) << ALIGN_BITS)) >>> 0;
        return (distance + range.reverseTree(this.align, 0, ALIGN_BITS)) >>> 0;
    }

    copy(distance, length) {
        const output = this.output;
        if (distance >= this.position - this.dictionaryStart) throw new Error("LZMA distance is outside the dictionary");
        const end = Math.min(this.position + length, output.length);
        for (let source = this.position - distance - 1; this.position < end; source++) output[this.position++] = output[source];
    }

    decode(data, start, end, outputEnd) {
        const range = new RangeDecoder(data, start, end);
        const positionMask = (1 << this.pb) - 1;
        while (this.position < outputEnd) {
            const positionState = (this.position - this.dictionaryStart) & positionMask;
            const state = this.state;
            if (!range.bit(this.isMatch, (state << 4) + positionState)) {
                this.decodeLiteral(range);
                continue;
            }
            let length;
            if (range.bit(this.isRep, state)) {
                if (!range.bit(this.isRepG0, state)) {
                    if (!range.bit(this.isRep0Long, (state << 4) + positionState)) {
                        this.state = state < 7 ? 9 : 11;
                        this.copy(this.reps[0], 1);
                        continue;
                    }
                } else {
                    let distance;
                    if (!range.bit(this.isRepG1, state)) {
                        distance = this.reps[1];
                    } else {
                        if (!range.bit(this.isRepG2, state)) {
                            distance = this.reps[2];
                        } else {
                            distance = this.reps[3];
                            this.reps[3] = this.reps[2];
                        }
                        this.reps[2] = this.reps[1];
                    }
                    this.reps[1] = this.reps[0];
                    this.reps[0] = distance;
                }
                length = this.repLength.decode(range, positionState);
                this.state = state < 7 ? 8 : 11;
            } else {
                this.reps[3] = this.reps[2];
                this.reps[2] = this.reps[1];
                this.reps[1] = this.reps[0];
                length = this.length.decode(range, positionState);
                this.state = state < 7 ? 7 : 10;
                const distance = this.decodeDistance(range, length);
                if (distance === 0xffffffff) break;
                this.reps[0] = distance;
            }
            this.copy(this.reps[0], length + MATCH_MIN_LENGTH);
        }
        return range.position;
    }
}

export function lzmaDecode(properties, data, size) {
    const output = new Uint8Array(size);
    const decoder = new LzmaDecoder(output);
    decoder.setProperties(properties[0]);
    decoder.resetState();
    decoder.decode(data, 0, data.length, size);
    return output;
}

export function lzma2Decode(data, size) {
    const output = new Uint8Array(size);
    const decoder = new LzmaDecoder(output);
    let position = 0;
    let needProperties = true;
    while (position < data.length) {
        const control = data[position++];
        if (control === 0) break;
        if (control === 1 || control === 2) {
            const length = ((data[position] << 8) | data[position + 1]) + 1;
            position += 2;
            if (control === 1) decoder.resetDictionary();
            output.set(data.subarray(position, position + length), decoder.position);
            decoder.position += length;
            position += length;
            continue;
        }
        if (control < 0x80) throw new Error("bad LZMA2 control byte");
        const unpacked = ((control & 0x1f) << 16) + ((data[position] << 8) | data[position + 1]) + 1;
        const packed = ((data[position + 2] << 8) | data[position + 3]) + 1;
        position += 4;
        const reset = (control >> 5) & 3;
        if (reset === 3) decoder.resetDictionary();
        if (reset >= 2) {
            decoder.setProperties(data[position++]);
            needProperties = false;
        } else if (needProperties) {
            throw new Error("LZMA2 chunk has no properties");
        }
        if (reset >= 1) decoder.resetState();
        decoder.decode(data, position, position + packed, Math.min(size, decoder.position + unpacked));
        position += packed;
    }
    return output.subarray(0, decoder.position);
}

export function bcj2Decode(main, call, jump, coded, size) {
    const output = new Uint8Array(size);
    const probabilities = new Uint16Array(258).fill(PROBABILITY_INITIAL);
    const range = new RangeDecoder(coded, 0, coded.length);
    let input = 0;
    let position = 0;
    let callPosition = 0;
    let jumpPosition = 0;
    let previous = 0;
    const isJump = (first, second) => (second & 0xfe) === 0xe8 || (first === 0x0f && (second & 0xf0) === 0x80);
    while (position < size) {
        let found = false;
        while (input < main.length && position < size) {
            const byte = main[input];
            output[position++] = byte;
            if (isJump(previous, byte)) {
                found = true;
                break;
            }
            input++;
            previous = byte;
        }
        if (!found || position === size) break;
        const byte = main[input++];
        const index = byte === 0xe8 ? previous : byte === 0xe9 ? 256 : 257;
        if (!range.bit(probabilities, index)) {
            previous = byte;
            continue;
        }
        let source;
        if (byte === 0xe8) {
            if (callPosition + 4 > call.length) throw new Error("BCJ2 call stream is truncated");
            source = call.subarray(callPosition, callPosition + 4);
            callPosition += 4;
        } else {
            if (jumpPosition + 4 > jump.length) throw new Error("BCJ2 jump stream is truncated");
            source = jump.subarray(jumpPosition, jumpPosition + 4);
            jumpPosition += 4;
        }
        const destination = ((((source[0] << 24) | (source[1] << 16) | (source[2] << 8) | source[3]) >>> 0) - (position + 4)) >>> 0;
        for (let shift = 0; shift < 32 && position < size; shift += 8) output[position++] = (destination >>> shift) & 0xff;
        previous = (destination >>> 24) & 0xff;
    }
    if (position !== size) throw new Error("BCJ2 stream ended early");
    return output;
}

function isX86Edge(byte) {
    return byte === 0 || byte === 0xff;
}

export function bcjX86Decode(buffer) {
    const allowed = [true, true, true, false, true, false, false, false];
    const bitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
    let previousMask = 0;
    let previousPosition = -5;
    for (let position = 0; position + 5 <= buffer.length;) {
        const opcode = buffer[position];
        if (opcode !== 0xe8 && opcode !== 0xe9) {
            position++;
            continue;
        }
        const offset = position - previousPosition;
        previousPosition = position;
        if (offset > 5) {
            previousMask = 0;
        } else {
            for (let index = 0; index < offset; index++) {
                previousMask &= 0x77;
                previousMask <<= 1;
            }
        }
        let high = buffer[position + 4];
        if (isX86Edge(high) && allowed[(previousMask >> 1) & 7] && (previousMask >> 1) < 0x10) {
            let source = ((high << 24) | (buffer[position + 3] << 16) | (buffer[position + 2] << 8) | buffer[position + 1]) >>> 0;
            let destination;
            for (;;) {
                destination = (source - (position + 5)) >>> 0;
                if (!previousMask) break;
                const shift = bitNumber[previousMask >> 1] * 8;
                high = (destination >>> (24 - shift)) & 0xff;
                if (!isX86Edge(high)) break;
                source = (destination ^ ((2 ** (32 - shift)) - 1)) >>> 0;
            }
            buffer[position + 4] = ~(((destination >>> 24) & 1) - 1) & 0xff;
            buffer[position + 3] = (destination >>> 16) & 0xff;
            buffer[position + 2] = (destination >>> 8) & 0xff;
            buffer[position + 1] = destination & 0xff;
            position += 5;
            previousMask = 0;
        } else {
            position++;
            previousMask |= 1;
            if (isX86Edge(high)) previousMask |= 0x10;
        }
    }
    return buffer;
}

export function bcjArmDecode(buffer) {
    for (let position = 0; position + 4 <= buffer.length; position += 4) {
        if (buffer[position + 3] !== 0xeb) continue;
        const source = ((buffer[position + 2] << 16) | (buffer[position + 1] << 8) | buffer[position]) << 2;
        const destination = ((source - (position + 8)) >>> 2) & 0xffffff;
        buffer[position + 2] = (destination >>> 16) & 0xff;
        buffer[position + 1] = (destination >>> 8) & 0xff;
        buffer[position] = destination & 0xff;
    }
    return buffer;
}

export function deltaDecode(buffer, distance) {
    for (let position = distance; position < buffer.length; position++) buffer[position] = (buffer[position] + buffer[position - distance]) & 0xff;
    return buffer;
}
