const FRAME_SIZE = 0x8000;
const LITERAL_COUNT = 256;
const PRIMARY_LENGTH_MASK = 7;
const MINIMUM_MATCH = 2;
const LENGTH_SYMBOL_COUNT = 249;
const PRETREE_SYMBOL_COUNT = 20;
const ALIGNED_SYMBOL_COUNT = 8;
const MAXIMUM_CODE_LENGTH = 16;
const LOOKUP_BITS = 10;
const LENGTH_TABLE_SAFETY = 64;
const BLOCK_VERBATIM = 1;
const BLOCK_ALIGNED = 2;
const BLOCK_UNCOMPRESSED = 3;
const CALL_OPCODE = 0xe8;
const CALL_TRAILER = 10;
const TRANSLATED_FRAME_LIMIT = 32768;
const POSITION_SLOTS = { 15: 30, 16: 32, 17: 34, 18: 36, 19: 38, 20: 42, 21: 50 };
const MAXIMUM_POSITION_SLOTS = 51;
const MAXIMUM_EXTRA_BITS = 17;

const EXTRA_BITS = new Uint8Array(MAXIMUM_POSITION_SLOTS);
const POSITION_BASE = new Uint32Array(MAXIMUM_POSITION_SLOTS);

function buildPositionTables() {
    let extra = 0;
    for (let slot = 0; slot < MAXIMUM_POSITION_SLOTS; slot++) {
        EXTRA_BITS[slot] = extra;
        if (slot % 2 === 1 && slot > 1 && extra < MAXIMUM_EXTRA_BITS) extra++;
    }
    let base = 0;
    for (let slot = 0; slot < MAXIMUM_POSITION_SLOTS; slot++) {
        POSITION_BASE[slot] = base;
        base += 1 << EXTRA_BITS[slot];
    }
}

buildPositionTables();

class HuffmanCode {
    constructor(symbolCount) {
        this.symbolCount = symbolCount;
        this.lengths = new Uint8Array(symbolCount + LENGTH_TABLE_SAFETY);
        this.counts = new Uint16Array(MAXIMUM_CODE_LENGTH + 1);
        this.symbols = new Uint16Array(symbolCount);
        this.lookup = new Uint32Array(1 << LOOKUP_BITS);
    }

    build() {
        const { counts, lengths, lookup, symbols } = this;
        counts.fill(0);
        lookup.fill(0);
        for (let symbol = 0; symbol < this.symbolCount; symbol++) counts[lengths[symbol]]++;
        let available = 1;
        for (let length = 1; length <= MAXIMUM_CODE_LENGTH; length++) {
            available = available * 2 - counts[length];
            if (available < 0) throw new Error("LZX Huffman code is oversubscribed");
        }
        const offsets = new Uint16Array(MAXIMUM_CODE_LENGTH + 2);
        const nextCode = new Uint32Array(MAXIMUM_CODE_LENGTH + 2);
        for (let length = 1; length <= MAXIMUM_CODE_LENGTH; length++) {
            offsets[length + 1] = offsets[length] + counts[length];
            nextCode[length + 1] = (nextCode[length] + counts[length]) << 1;
        }
        for (let symbol = 0; symbol < this.symbolCount; symbol++) {
            const length = lengths[symbol];
            if (!length) continue;
            symbols[offsets[length]++] = symbol;
            const code = nextCode[length]++;
            if (length > LOOKUP_BITS) continue;
            const spread = LOOKUP_BITS - length;
            const first = code << spread;
            lookup.fill((symbol << 5) | length, first, first + (1 << spread));
        }
    }
}

function lengthFromDelta(previous, delta) {
    return (previous - delta + 17) % 17;
}

class LzxDecoder {
    constructor(input, windowBits) {
        if (!(windowBits in POSITION_SLOTS)) throw new Error(`LZX window size 2^${windowBits} isn't valid`);
        this.input = input;
        this.inputPosition = 0;
        this.bitBuffer = 0;
        this.bitCount = 0;
        this.mainCode = new HuffmanCode(LITERAL_COUNT + POSITION_SLOTS[windowBits] * 8);
        this.lengthCode = new HuffmanCode(LENGTH_SYMBOL_COUNT);
        this.alignedCode = new HuffmanCode(ALIGNED_SYMBOL_COUNT);
        this.pretreeCode = new HuffmanCode(PRETREE_SYMBOL_COUNT);
        this.recentOffsets = [1, 1, 1];
        this.blockType = 0;
        this.blockLength = 0;
        this.blockRemaining = 0;
        this.callTranslationStarted = false;
        this.callTranslationSize = 0;
        this.window = null;
        this.position = 0;
    }

    ensureBits(count) {
        while (this.bitCount < count) {
            const word = this.input[this.inputPosition] | (this.input[this.inputPosition + 1] << 8);
            this.inputPosition += 2;
            this.bitBuffer = (this.bitBuffer << 16) | word;
            this.bitCount += 16;
        }
    }

    peekBits(count) {
        return (this.bitBuffer >>> (this.bitCount - count)) & ((1 << count) - 1);
    }

    removeBits(count) {
        this.bitCount -= count;
        this.bitBuffer &= (1 << this.bitCount) - 1;
    }

    readBits(count) {
        this.ensureBits(count);
        const value = this.peekBits(count);
        this.removeBits(count);
        return value;
    }

    readWideBits(count) {
        if (count <= 16) return this.readBits(count);
        const high = this.readBits(count - 16);
        return high * 0x10000 + this.readBits(16);
    }

    resetBits() {
        this.bitBuffer = 0;
        this.bitCount = 0;
    }

    alignToWord() {
        if (this.bitCount > 0) this.ensureBits(16);
        this.removeBits(this.bitCount & 15);
    }

    readSymbol(code) {
        this.ensureBits(MAXIMUM_CODE_LENGTH);
        const upcoming = this.peekBits(MAXIMUM_CODE_LENGTH);
        const entry = code.lookup[upcoming >>> (MAXIMUM_CODE_LENGTH - LOOKUP_BITS)];
        if (entry) {
            this.removeBits(entry & 31);
            return entry >>> 5;
        }
        return this.readLongSymbol(code, upcoming);
    }

    readLongSymbol(code, upcoming) {
        let candidate = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length <= MAXIMUM_CODE_LENGTH; length++) {
            candidate |= (upcoming >>> (MAXIMUM_CODE_LENGTH - length)) & 1;
            const count = code.counts[length];
            if (candidate - first < count) {
                this.removeBits(length);
                return code.symbols[index + candidate - first];
            }
            index += count;
            first = (first + count) << 1;
            candidate <<= 1;
        }
        throw new Error("Invalid LZX Huffman code");
    }

    readLengths(code, first, last) {
        const pretree = this.pretreeCode;
        for (let symbol = 0; symbol < PRETREE_SYMBOL_COUNT; symbol++) pretree.lengths[symbol] = this.readBits(4);
        pretree.build();
        const lengths = code.lengths;
        let index = first;
        while (index < last) {
            const symbol = this.readSymbol(pretree);
            if (symbol === 17) {
                let run = this.readBits(4) + 4;
                while (run--) lengths[index++] = 0;
            } else if (symbol === 18) {
                let run = this.readBits(5) + 20;
                while (run--) lengths[index++] = 0;
            } else if (symbol === 19) {
                let run = this.readBits(1) + 4;
                const length = lengthFromDelta(lengths[index], this.readSymbol(pretree));
                while (run--) lengths[index++] = length;
            } else {
                lengths[index] = lengthFromDelta(lengths[index], symbol);
                index++;
            }
        }
    }

    readStoredOffsets() {
        const input = this.input;
        const start = this.inputPosition;
        if (start + 12 > input.length) throw new RangeError("LZX data is truncated");
        for (let index = 0; index < 3; index++) {
            const offset = start + index * 4;
            this.recentOffsets[index] = (input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
        }
        this.inputPosition += 12;
    }

    readBlockHeader() {
        if (this.blockType === BLOCK_UNCOMPRESSED) {
            if (this.blockLength & 1) this.inputPosition++;
            this.resetBits();
        }
        this.blockType = this.readBits(3);
        const high = this.readBits(16);
        this.blockLength = (high << 8) | this.readBits(8);
        this.blockRemaining = this.blockLength;
        if (this.blockType === BLOCK_ALIGNED) {
            for (let symbol = 0; symbol < ALIGNED_SYMBOL_COUNT; symbol++) this.alignedCode.lengths[symbol] = this.readBits(3);
            this.alignedCode.build();
        }
        if (this.blockType === BLOCK_VERBATIM || this.blockType === BLOCK_ALIGNED) {
            this.readLengths(this.mainCode, 0, LITERAL_COUNT);
            this.readLengths(this.mainCode, LITERAL_COUNT, this.mainCode.symbolCount);
            this.mainCode.build();
            if (this.mainCode.lengths[CALL_OPCODE]) this.callTranslationStarted = true;
            this.readLengths(this.lengthCode, 0, LENGTH_SYMBOL_COUNT);
            this.lengthCode.build();
        } else if (this.blockType === BLOCK_UNCOMPRESSED) {
            this.callTranslationStarted = true;
            if (this.bitCount === 0) this.ensureBits(16);
            this.resetBits();
            this.readStoredOffsets();
        } else {
            throw new Error(`Unknown LZX block type ${this.blockType}`);
        }
    }

    readVerbatimOffset(slot) {
        return POSITION_BASE[slot] - 2 + this.readWideBits(EXTRA_BITS[slot]);
    }

    readAlignedOffset(slot) {
        const extra = EXTRA_BITS[slot];
        const base = POSITION_BASE[slot] - 2;
        if (extra < 3) return base + this.readBits(extra);
        return base + this.readBits(extra - 3) * 8 + this.readSymbol(this.alignedCode);
    }

    readMatchOffset(slot) {
        const recent = this.recentOffsets;
        if (slot === 0) return recent[0];
        let offset;
        if (slot === 1 || slot === 2) {
            offset = recent[slot];
            recent[slot] = recent[0];
        } else {
            offset = this.blockType === BLOCK_ALIGNED ? this.readAlignedOffset(slot) : this.readVerbatimOffset(slot);
            recent[2] = recent[1];
            recent[1] = recent[0];
        }
        recent[0] = offset;
        return offset;
    }

    decodeCompressed(limit) {
        const window = this.window;
        let position = this.position;
        while (position < limit) {
            const element = this.readSymbol(this.mainCode);
            if (element < LITERAL_COUNT) {
                window[position++] = element;
                continue;
            }
            const matchElement = element - LITERAL_COUNT;
            let length = matchElement & PRIMARY_LENGTH_MASK;
            if (length === PRIMARY_LENGTH_MASK) length += this.readSymbol(this.lengthCode);
            length += MINIMUM_MATCH;
            const offset = this.readMatchOffset(matchElement >>> 3);
            if (offset > position) throw new Error("LZX match refers to data before the start of the folder");
            if (position + length > window.length) throw new Error("LZX match runs past the end of the folder");
            let source = position - offset;
            const end = position + length;
            while (position < end) window[position++] = window[source++];
        }
        this.position = position;
    }

    copyStored(count) {
        const start = this.inputPosition;
        if (start + count > this.input.length) throw new RangeError("LZX data is truncated");
        this.window.set(this.input.subarray(start, start + count), this.position);
        this.inputPosition += count;
        this.position += count;
    }

    readTranslationHeader() {
        if (!this.readBits(1)) return;
        const high = this.readBits(16);
        this.callTranslationSize = (high << 16) | this.readBits(16);
    }

    translateCalls(output, frameStart, frameEnd) {
        const fileSize = this.callTranslationSize;
        const end = frameEnd - CALL_TRAILER;
        let position = frameStart;
        while (position < end) {
            if (output[position] !== CALL_OPCODE) {
                position++;
                continue;
            }
            const operand = position + 1;
            const absolute = output[operand] | (output[operand + 1] << 8) | (output[operand + 2] << 16) | (output[operand + 3] << 24);
            if (absolute >= -position && absolute < fileSize) {
                const relative = absolute >= 0 ? absolute - position : absolute + fileSize;
                output[operand] = relative & 0xff;
                output[operand + 1] = (relative >>> 8) & 0xff;
                output[operand + 2] = (relative >>> 16) & 0xff;
                output[operand + 3] = (relative >>> 24) & 0xff;
            }
            position += 5;
        }
    }

    decompress(outputLength) {
        this.window = new Uint8Array(outputLength);
        const output = new Uint8Array(outputLength);
        if (!outputLength) return output;
        this.readTranslationHeader();
        for (let frame = 0, frameStart = 0; frameStart < outputLength; frame++, frameStart += FRAME_SIZE) {
            const frameEnd = Math.min(frameStart + FRAME_SIZE, outputLength);
            while (this.position < frameEnd) {
                if (this.blockRemaining === 0) this.readBlockHeader();
                const start = this.position;
                const run = Math.min(this.blockRemaining, frameEnd - start);
                if (this.blockType === BLOCK_UNCOMPRESSED) {
                    this.copyStored(run);
                } else {
                    this.decodeCompressed(start + run);
                }
                const decoded = this.position - start;
                if (decoded > this.blockRemaining) throw new Error("LZX match runs past the end of its block");
                this.blockRemaining -= decoded;
            }
            if (this.position !== frameEnd) throw new Error("LZX match crosses a frame boundary");
            output.set(this.window.subarray(frameStart, frameEnd), frameStart);
            const translate = this.callTranslationStarted && this.callTranslationSize && frame < TRANSLATED_FRAME_LIMIT;
            if (translate && frameEnd - frameStart > CALL_TRAILER) this.translateCalls(output, frameStart, frameEnd);
            this.alignToWord();
        }
        if (this.inputPosition - this.bitCount / 8 > this.input.length) throw new RangeError("LZX data is truncated");
        return output;
    }
}

export function decompressLzx(input, windowBits, outputLength) {
    return new LzxDecoder(input, windowBits).decompress(outputLength);
}
