const MAX_ORDER = 64;
const UNIT_SIZE = 12;
const MAX_FREQ = 124;
const TOP_VALUE = 1 << 24;
const INT_BITS = 7;
const PERIOD_BITS = 7;
const BIN_SCALE = 1 << (INT_BITS + PERIOD_BITS);
const NUM_INDEXES = 4 + 4 + 4 + 26;
const DUMMY_SEE = 25 * 16;
const INIT_BIN_ESC = [0x3cdd, 0x1f3f, 0x59bf, 0x48f3, 0x64a1, 0x5abc, 0x6632, 0x6051];
const EXP_ESCAPE = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2];
const STATE_SIZE = 6;

function getMean(summ) {
    return (summ + (1 << (PERIOD_BITS - 2))) >>> PERIOD_BITS;
}

export class RarRangeDecoder {
    constructor(readByte) {
        this.readByte = readByte;
        this.range = 0;
        this.code = 0;
        this.low = 0;
        this.bottom = 0;
    }

    init() {
        this.low = 0;
        this.range = 0xffffffff;
        this.code = 0;
        for (let index = 0; index < 4; index++) this.code = ((this.code << 8) | this.readByte()) >>> 0;
        this.bottom = 0x8000;
        return this.code < 0xffffffff;
    }

    getThreshold(total) {
        this.range = Math.floor(this.range / total) >>> 0;
        return Math.floor(((this.code - this.low) >>> 0) / this.range);
    }

    decode(start, size) {
        this.low = (this.low + Math.imul(start, this.range)) >>> 0;
        this.range = Math.imul(this.range, size) >>> 0;
        this.normalize();
    }

    decodeBit(size0) {
        if (this.getThreshold(BIN_SCALE) < size0) {
            this.decode(0, size0);
            return 0;
        }
        this.decode(size0, BIN_SCALE - size0);
        return 1;
    }

    normalize() {
        for (;;) {
            if (((this.low ^ ((this.low + this.range) >>> 0)) >>> 0) >= TOP_VALUE) {
                if (this.range >= this.bottom) break;
                this.range = (-this.low >>> 0) & (this.bottom - 1);
            }
            this.code = ((this.code << 8) | this.readByte()) >>> 0;
            this.range = (this.range << 8) >>> 0;
            this.low = (this.low << 8) >>> 0;
        }
    }
}

export class Ppmd7 {
    constructor() {
        this.indx2Units = new Uint8Array(NUM_INDEXES);
        this.units2Indx = new Uint8Array(128);
        this.ns2Indx = new Uint8Array(256);
        this.ns2BSIndx = new Uint8Array(256);
        this.hb2Flag = new Uint8Array(256);
        this.freeList = new Uint32Array(NUM_INDEXES);
        this.seeSumm = new Uint16Array(DUMMY_SEE + 1);
        this.seeShift = new Uint8Array(DUMMY_SEE + 1);
        this.seeCount = new Uint8Array(DUMMY_SEE + 1);
        this.binSumm = new Uint16Array(128 * 64);
        this.charMask = new Int8Array(256);
        this.ps = new Uint32Array(256);
        this.memory = null;
        this.view = null;
        this.size = 0;
        this.initEsc = 0;
        for (let i = 0, k = 0; i < NUM_INDEXES; i++) {
            let step = i >= 12 ? 4 : (i >>> 2) + 1;
            do {
                this.units2Indx[k++] = i;
            } while (--step);
            this.indx2Units[i] = k;
        }
        this.ns2BSIndx[0] = 0 << 1;
        this.ns2BSIndx[1] = 1 << 1;
        this.ns2BSIndx.fill(2 << 1, 2, 11);
        this.ns2BSIndx.fill(3 << 1, 11, 256);
        let i = 0;
        for (; i < 3; i++) this.ns2Indx[i] = i;
        for (let m = i, k = 1; i < 256; i++) {
            this.ns2Indx[i] = m;
            if (--k === 0) k = (++m) - 2;
        }
        this.hb2Flag.fill(0, 0, 0x40);
        this.hb2Flag.fill(8, 0x40, 0x100);
    }

    alloc(size) {
        if (this.memory && this.size === size) return;
        this.alignOffset = 4 - (size & 3);
        this.memory = new Uint8Array(this.alignOffset + size + UNIT_SIZE);
        this.view = new DataView(this.memory.buffer);
        this.size = size;
    }

    u16(offset) {
        return this.view.getUint16(offset, true);
    }

    setU16(offset, value) {
        this.view.setUint16(offset, value, true);
    }

    u32(offset) {
        return this.view.getUint32(offset, true);
    }

    setU32(offset, value) {
        this.view.setUint32(offset, value >>> 0, true);
    }

    numStats(context) {
        return this.u16(context);
    }

    setNumStats(context, value) {
        this.setU16(context, value);
    }

    summFreq(context) {
        return this.u16(context + 2);
    }

    setSummFreq(context, value) {
        this.setU16(context + 2, value & 0xffff);
    }

    stats(context) {
        return this.u32(context + 4);
    }

    setStats(context, value) {
        this.setU32(context + 4, value);
    }

    suffix(context) {
        return this.u32(context + 8);
    }

    setSuffix(context, value) {
        this.setU32(context + 8, value);
    }

    symbol(state) {
        return this.memory[state];
    }

    freq(state) {
        return this.memory[state + 1];
    }

    setFreq(state, value) {
        this.memory[state + 1] = value;
    }

    successor(state) {
        return this.u32(state + 2);
    }

    setSuccessor(state, value) {
        this.setU32(state + 2, value);
    }

    copyState(destination, source) {
        this.memory.copyWithin(destination, source, source + STATE_SIZE);
    }

    swapStates(first, second) {
        const memory = this.memory;
        for (let index = 0; index < STATE_SIZE; index++) {
            const value = memory[first + index];
            memory[first + index] = memory[second + index];
            memory[second + index] = value;
        }
    }

    insertNode(node, index) {
        this.setU32(node, this.freeList[index]);
        this.freeList[index] = node;
    }

    removeNode(index) {
        const node = this.freeList[index];
        this.freeList[index] = this.u32(node);
        return node;
    }

    splitBlock(pointer, oldIndex, newIndex) {
        const nu = this.indx2Units[oldIndex] - this.indx2Units[newIndex];
        pointer += this.indx2Units[newIndex] * UNIT_SIZE;
        let i = this.units2Indx[nu - 1];
        if (this.indx2Units[i] !== nu) {
            const k = this.indx2Units[--i];
            this.insertNode(pointer + k * UNIT_SIZE, nu - k - 1);
        }
        this.insertNode(pointer, i);
    }

    glueFreeBlocks() {
        const head = this.alignOffset + this.size;
        let n = head;
        this.glueCount = 255;
        for (let i = 0; i < NUM_INDEXES; i++) {
            const nu = this.indx2Units[i];
            let next = this.freeList[i];
            this.freeList[i] = 0;
            while (next !== 0) {
                const node = next;
                this.setU32(node + 4, n);
                this.setU32(n + 8, next);
                n = next;
                next = this.u32(node);
                this.setU16(node, 0);
                this.setU16(node + 2, nu);
            }
        }
        this.setU16(head, 1);
        this.setU32(head + 4, n);
        this.setU32(n + 8, head);
        if (this.loUnit !== this.hiUnit) this.setU16(this.loUnit, 1);
        while (n !== head) {
            const node = n;
            let nu = this.u16(node + 2);
            for (;;) {
                const node2 = node + nu * UNIT_SIZE;
                nu += this.u16(node2 + 2);
                if (this.u16(node2) !== 0 || nu >= 0x10000) break;
                this.setU32(this.u32(node2 + 8) + 4, this.u32(node2 + 4));
                this.setU32(this.u32(node2 + 4) + 8, this.u32(node2 + 8));
                this.setU16(node + 2, nu);
            }
            n = this.u32(node + 4);
        }
        for (n = this.u32(head + 4); n !== head;) {
            let node = n;
            const next = this.u32(node + 4);
            let nu = this.u16(node + 2);
            for (; nu > 128; nu -= 128, node += 128 * UNIT_SIZE) this.insertNode(node, NUM_INDEXES - 1);
            let i = this.units2Indx[nu - 1];
            if (this.indx2Units[i] !== nu) {
                const k = this.indx2Units[--i];
                this.insertNode(node + k * UNIT_SIZE, nu - k - 1);
            }
            this.insertNode(node, i);
            n = next;
        }
    }

    allocUnitsRare(index) {
        if (this.glueCount === 0) {
            this.glueFreeBlocks();
            if (this.freeList[index] !== 0) return this.removeNode(index);
        }
        let i = index;
        do {
            if (++i === NUM_INDEXES) {
                const numBytes = this.indx2Units[index] * UNIT_SIZE;
                this.glueCount--;
                if (this.unitsStart - this.text > numBytes) {
                    this.unitsStart -= numBytes;
                    return this.unitsStart;
                }
                return 0;
            }
        } while (this.freeList[i] === 0);
        const block = this.removeNode(i);
        this.splitBlock(block, i, index);
        return block;
    }

    allocUnits(index) {
        if (this.freeList[index] !== 0) return this.removeNode(index);
        const numBytes = this.indx2Units[index] * UNIT_SIZE;
        if (numBytes <= this.hiUnit - this.loUnit) {
            const block = this.loUnit;
            this.loUnit += numBytes;
            return block;
        }
        return this.allocUnitsRare(index);
    }

    shrinkUnits(oldPointer, oldNU, newNU) {
        const i0 = this.units2Indx[oldNU - 1];
        const i1 = this.units2Indx[newNU - 1];
        if (i0 === i1) return oldPointer;
        if (this.freeList[i1] !== 0) {
            const block = this.removeNode(i1);
            this.memory.copyWithin(block, oldPointer, oldPointer + newNU * UNIT_SIZE);
            this.insertNode(oldPointer, i0);
            return block;
        }
        this.splitBlock(oldPointer, i0, i1);
        return oldPointer;
    }

    restartModel() {
        this.freeList.fill(0);
        this.text = this.alignOffset;
        this.hiUnit = this.text + this.size;
        this.loUnit = this.unitsStart = this.hiUnit - Math.floor(this.size / 8 / UNIT_SIZE) * 7 * UNIT_SIZE;
        this.glueCount = 0;
        this.orderFall = this.maxOrder;
        this.runLength = this.initRL = -(this.maxOrder < 12 ? this.maxOrder : 12) - 1;
        this.prevSuccess = 0;
        this.hiUnit -= UNIT_SIZE;
        this.minContext = this.maxContext = this.hiUnit;
        this.setSuffix(this.minContext, 0);
        this.setNumStats(this.minContext, 256);
        this.setSummFreq(this.minContext, 256 + 1);
        this.foundState = this.loUnit;
        this.setStats(this.minContext, this.foundState);
        for (let i = 0; i < 256; i++) {
            const state = this.foundState + i * STATE_SIZE;
            this.memory[state] = i;
            this.memory[state + 1] = 1;
            this.setSuccessor(state, 0);
        }
        this.loUnit += (256 / 2) * UNIT_SIZE;
        for (let i = 0; i < 128; i++) {
            for (let k = 0; k < 8; k++) {
                const value = BIN_SCALE - Math.floor(INIT_BIN_ESC[k] / (i + 2));
                for (let m = 0; m < 64; m += 8) this.binSumm[i * 64 + k + m] = value;
            }
        }
        for (let i = 0; i < 25; i++) {
            for (let k = 0; k < 16; k++) {
                const see = i * 16 + k;
                this.seeShift[see] = PERIOD_BITS - 4;
                this.seeSumm[see] = (5 * i + 10) << this.seeShift[see];
                this.seeCount[see] = 4;
            }
        }
    }

    init(maxOrder) {
        this.maxOrder = maxOrder;
        this.restartModel();
        this.seeShift[DUMMY_SEE] = PERIOD_BITS;
        this.seeSumm[DUMMY_SEE] = 0;
        this.seeCount[DUMMY_SEE] = 64;
    }

    createSuccessors(skip) {
        let c = this.minContext;
        const upBranch = this.successor(this.foundState);
        const ps = new Uint32Array(MAX_ORDER);
        let numPs = 0;
        if (!skip) ps[numPs++] = this.foundState;
        const foundSymbol = this.symbol(this.foundState);
        while (this.suffix(c)) {
            c = this.suffix(c);
            let s;
            if (this.numStats(c) !== 1) {
                for (s = this.stats(c); this.symbol(s) !== foundSymbol; s += STATE_SIZE);
            } else {
                s = c + 2;
            }
            const successor = this.successor(s);
            if (successor !== upBranch) {
                c = successor;
                if (numPs === 0) return c;
                break;
            }
            ps[numPs++] = s;
        }
        const upSymbol = this.memory[upBranch];
        const upSuccessor = upBranch + 1;
        let upFreq;
        if (this.numStats(c) === 1) {
            upFreq = this.freq(c + 2);
        } else {
            let s;
            for (s = this.stats(c); this.symbol(s) !== upSymbol; s += STATE_SIZE);
            const cf = this.freq(s) - 1;
            const s0 = this.summFreq(c) - this.numStats(c) - cf;
            upFreq = 1 + ((2 * cf <= s0) ? (5 * cf > s0 ? 1 : 0) : Math.floor((2 * cf + 3 * s0 - 1) / (2 * s0)));
        }
        while (numPs !== 0) {
            let c1;
            if (this.hiUnit !== this.loUnit) {
                this.hiUnit -= UNIT_SIZE;
                c1 = this.hiUnit;
            } else if (this.freeList[0] !== 0) {
                c1 = this.removeNode(0);
            } else {
                c1 = this.allocUnitsRare(0);
                if (!c1) return 0;
            }
            this.setNumStats(c1, 1);
            this.memory[c1 + 2] = upSymbol;
            this.memory[c1 + 3] = upFreq & 0xff;
            this.setSuccessor(c1 + 2, upSuccessor);
            this.setSuffix(c1, c);
            this.setSuccessor(ps[--numPs], c1);
            c = c1;
        }
        return c;
    }

    updateModel() {
        let fSuccessor = this.successor(this.foundState);
        const foundSymbol = this.symbol(this.foundState);
        const foundFreq = this.freq(this.foundState);
        if (foundFreq < MAX_FREQ / 4 && this.suffix(this.minContext) !== 0) {
            const c = this.suffix(this.minContext);
            if (this.numStats(c) === 1) {
                const s = c + 2;
                if (this.freq(s) < 32) this.setFreq(s, this.freq(s) + 1);
            } else {
                let s = this.stats(c);
                if (this.symbol(s) !== foundSymbol) {
                    do {
                        s += STATE_SIZE;
                    } while (this.symbol(s) !== foundSymbol);
                    if (this.freq(s) >= this.freq(s - STATE_SIZE)) {
                        this.swapStates(s, s - STATE_SIZE);
                        s -= STATE_SIZE;
                    }
                }
                if (this.freq(s) < MAX_FREQ - 9) {
                    this.setFreq(s, this.freq(s) + 2);
                    this.setSummFreq(c, this.summFreq(c) + 2);
                }
            }
        }
        if (this.orderFall === 0) {
            this.minContext = this.maxContext = this.createSuccessors(true);
            if (this.minContext === 0) {
                this.restartModel();
                return;
            }
            this.setSuccessor(this.foundState, this.minContext);
            return;
        }
        this.memory[this.text++] = foundSymbol;
        let successor = this.text;
        if (this.text >= this.unitsStart) {
            this.restartModel();
            return;
        }
        if (fSuccessor) {
            if (fSuccessor <= successor) {
                const cs = this.createSuccessors(false);
                if (cs === 0) {
                    this.restartModel();
                    return;
                }
                fSuccessor = cs;
            }
            if (--this.orderFall === 0) {
                successor = fSuccessor;
                if (this.maxContext !== this.minContext) this.text--;
            }
        } else {
            this.setSuccessor(this.foundState, successor);
            fSuccessor = this.minContext;
        }
        const ns = this.numStats(this.minContext);
        const s0 = this.summFreq(this.minContext) - ns - (this.freq(this.foundState) - 1);
        for (let c = this.maxContext; c !== this.minContext; c = this.suffix(c)) {
            const ns1 = this.numStats(c);
            if (ns1 !== 1) {
                if ((ns1 & 1) === 0) {
                    const oldNU = ns1 >>> 1;
                    const i = this.units2Indx[oldNU - 1];
                    if (i !== this.units2Indx[oldNU]) {
                        const block = this.allocUnits(i + 1);
                        if (!block) {
                            this.restartModel();
                            return;
                        }
                        const oldBlock = this.stats(c);
                        this.memory.copyWithin(block, oldBlock, oldBlock + oldNU * UNIT_SIZE);
                        this.insertNode(oldBlock, i);
                        this.setStats(c, block);
                    }
                }
                const summ = this.summFreq(c);
                this.setSummFreq(c, summ + (2 * ns1 < ns ? 1 : 0) + 2 * ((4 * ns1 <= ns ? 1 : 0) & (summ <= 8 * ns1 ? 1 : 0)));
            } else {
                const s = this.allocUnits(0);
                if (!s) {
                    this.restartModel();
                    return;
                }
                this.copyState(s, c + 2);
                this.setStats(c, s);
                let freq = this.freq(s);
                freq = freq < MAX_FREQ / 4 - 1 ? freq << 1 : MAX_FREQ - 4;
                this.setFreq(s, freq);
                this.setSummFreq(c, freq + this.initEsc + (ns > 3 ? 1 : 0));
            }
            let cf = 2 * this.freq(this.foundState) * (this.summFreq(c) + 6);
            const sf = s0 + this.summFreq(c);
            if (cf < 6 * sf) {
                cf = 1 + (cf > sf ? 1 : 0) + (cf >= 4 * sf ? 1 : 0);
                this.setSummFreq(c, this.summFreq(c) + 3);
            } else {
                cf = 4 + (cf >= 9 * sf ? 1 : 0) + (cf >= 12 * sf ? 1 : 0) + (cf >= 15 * sf ? 1 : 0);
                this.setSummFreq(c, this.summFreq(c) + cf);
            }
            const s = this.stats(c) + ns1 * STATE_SIZE;
            this.setSuccessor(s, successor);
            this.memory[s] = foundSymbol;
            this.memory[s + 1] = cf;
            this.setNumStats(c, ns1 + 1);
        }
        this.maxContext = this.minContext = fSuccessor;
    }

    rescale() {
        const stats = this.stats(this.minContext);
        let s = this.foundState;
        const saved = this.memory.slice(s, s + STATE_SIZE);
        for (; s !== stats; s -= STATE_SIZE) this.copyState(s, s - STATE_SIZE);
        this.memory.set(saved, s);
        let escFreq = this.summFreq(this.minContext) - this.freq(s);
        const adder = this.orderFall !== 0 ? 1 : 0;
        this.setFreq(s, (this.freq(s) + 4 + adder) >>> 1);
        let sumFreq = this.freq(s);
        let i = this.numStats(this.minContext) - 1;
        do {
            s += STATE_SIZE;
            escFreq -= this.freq(s);
            this.setFreq(s, (this.freq(s) + adder) >>> 1);
            sumFreq += this.freq(s);
            if (this.freq(s) > this.freq(s - STATE_SIZE)) {
                let s1 = s;
                const temp = this.memory.slice(s1, s1 + STATE_SIZE);
                do {
                    this.copyState(s1, s1 - STATE_SIZE);
                    s1 -= STATE_SIZE;
                } while (s1 !== stats && temp[1] > this.freq(s1 - STATE_SIZE));
                this.memory.set(temp, s1);
            }
        } while (--i);
        if (this.freq(s) === 0) {
            const numStats = this.numStats(this.minContext);
            do {
                i++;
                s -= STATE_SIZE;
            } while (this.freq(s) === 0);
            escFreq += i;
            this.setNumStats(this.minContext, this.numStats(this.minContext) - i);
            if (this.numStats(this.minContext) === 1) {
                const temp = this.memory.slice(stats, stats + STATE_SIZE);
                do {
                    temp[1] = temp[1] - (temp[1] >>> 1);
                    escFreq >>>= 1;
                } while (escFreq > 1);
                this.insertNode(stats, this.units2Indx[((numStats + 1) >>> 1) - 1]);
                this.foundState = this.minContext + 2;
                this.memory.set(temp, this.foundState);
                return;
            }
            const n0 = (numStats + 1) >>> 1;
            const n1 = (this.numStats(this.minContext) + 1) >>> 1;
            if (n0 !== n1) this.setStats(this.minContext, this.shrinkUnits(stats, n0, n1));
        }
        this.setSummFreq(this.minContext, sumFreq + escFreq - (escFreq >>> 1));
        this.foundState = this.stats(this.minContext);
    }

    makeEscFreq(numMasked) {
        const numStats = this.numStats(this.minContext);
        const nonMasked = numStats - numMasked;
        if (numStats !== 256) {
            const see = this.ns2Indx[nonMasked - 1] * 16
                + (nonMasked < ((this.numStats(this.suffix(this.minContext)) - numStats) >>> 0) ? 1 : 0)
                + 2 * (this.summFreq(this.minContext) < 11 * numStats ? 1 : 0)
                + 4 * (numMasked > nonMasked ? 1 : 0)
                + this.hiBitsFlag;
            const r = this.seeSumm[see] >>> this.seeShift[see];
            this.seeSumm[see] = this.seeSumm[see] - r;
            this.escFreq = r + (r === 0 ? 1 : 0);
            return see;
        }
        this.escFreq = 1;
        return DUMMY_SEE;
    }

    seeUpdate(see) {
        if (this.seeShift[see] < PERIOD_BITS && --this.seeCount[see] === 0) {
            this.seeSumm[see] = this.seeSumm[see] << 1;
            this.seeCount[see] = 3 << this.seeShift[see]++;
        }
    }

    nextContext() {
        const c = this.successor(this.foundState);
        if (this.orderFall === 0 && c > this.text) {
            this.minContext = this.maxContext = c;
        } else {
            this.updateModel();
        }
    }

    update1() {
        let s = this.foundState;
        this.setFreq(s, this.freq(s) + 4);
        this.setSummFreq(this.minContext, this.summFreq(this.minContext) + 4);
        if (this.freq(s) > this.freq(s - STATE_SIZE)) {
            this.swapStates(s, s - STATE_SIZE);
            this.foundState = s -= STATE_SIZE;
            if (this.freq(s) > MAX_FREQ) this.rescale();
        }
        this.nextContext();
    }

    update1First() {
        this.prevSuccess = 2 * this.freq(this.foundState) > this.summFreq(this.minContext) ? 1 : 0;
        this.runLength += this.prevSuccess;
        this.setSummFreq(this.minContext, this.summFreq(this.minContext) + 4);
        this.setFreq(this.foundState, this.freq(this.foundState) + 4);
        if (this.freq(this.foundState) > MAX_FREQ) this.rescale();
        this.nextContext();
    }

    updateBin() {
        const freq = this.freq(this.foundState);
        this.setFreq(this.foundState, freq + (freq < 128 ? 1 : 0));
        this.prevSuccess = 1;
        this.runLength++;
        this.nextContext();
    }

    update2() {
        this.setSummFreq(this.minContext, this.summFreq(this.minContext) + 4);
        this.setFreq(this.foundState, this.freq(this.foundState) + 4);
        if (this.freq(this.foundState) > MAX_FREQ) this.rescale();
        this.runLength = this.initRL;
        this.updateModel();
    }

    binSummIndex() {
        const one = this.minContext + 2;
        this.hiBitsFlag = this.hb2Flag[this.symbol(this.foundState)];
        return (this.freq(one) - 1) * 64
            + this.prevSuccess
            + this.ns2BSIndx[this.numStats(this.suffix(this.minContext)) - 1]
            + this.hiBitsFlag
            + 2 * this.hb2Flag[this.symbol(one)]
            + ((this.runLength >> 26) & 0x20);
    }

    decodeSymbol(rc) {
        const mask = this.charMask;
        if (this.numStats(this.minContext) !== 1) {
            let s = this.stats(this.minContext);
            const count = rc.getThreshold(this.summFreq(this.minContext));
            let hiCnt = this.freq(s);
            if (count < hiCnt) {
                rc.decode(0, hiCnt);
                this.foundState = s;
                const symbol = this.symbol(s);
                this.update1First();
                return symbol;
            }
            this.prevSuccess = 0;
            let i = this.numStats(this.minContext) - 1;
            do {
                s += STATE_SIZE;
                if ((hiCnt += this.freq(s)) > count) {
                    rc.decode(hiCnt - this.freq(s), this.freq(s));
                    this.foundState = s;
                    const symbol = this.symbol(s);
                    this.update1();
                    return symbol;
                }
            } while (--i);
            if (count >= this.summFreq(this.minContext)) return -2;
            this.hiBitsFlag = this.hb2Flag[this.symbol(this.foundState)];
            rc.decode(hiCnt, this.summFreq(this.minContext) - hiCnt);
            mask.fill(-1);
            mask[this.symbol(s)] = 0;
            i = this.numStats(this.minContext) - 1;
            do {
                s -= STATE_SIZE;
                mask[this.symbol(s)] = 0;
            } while (--i);
        } else {
            const index = this.binSummIndex();
            const probability = this.binSumm[index];
            if (rc.decodeBit(probability) === 0) {
                this.binSumm[index] = probability + (1 << INT_BITS) - getMean(probability);
                this.foundState = this.minContext + 2;
                const symbol = this.symbol(this.foundState);
                this.updateBin();
                return symbol;
            }
            this.binSumm[index] = probability - getMean(probability);
            this.initEsc = EXP_ESCAPE[this.binSumm[index] >>> 10];
            mask.fill(-1);
            mask[this.symbol(this.minContext + 2)] = 0;
            this.prevSuccess = 0;
        }
        const ps = this.ps;
        for (;;) {
            const numMasked = this.numStats(this.minContext);
            do {
                this.orderFall++;
                if (!this.suffix(this.minContext)) return -1;
                this.minContext = this.suffix(this.minContext);
            } while (this.numStats(this.minContext) === numMasked);
            let hiCnt = 0;
            let s = this.stats(this.minContext);
            let i = 0;
            const num = this.numStats(this.minContext) - numMasked;
            do {
                const k = mask[this.symbol(s)];
                hiCnt += this.freq(s) & k;
                ps[i] = s;
                s += STATE_SIZE;
                i -= k;
            } while (i !== num);
            const see = this.makeEscFreq(numMasked);
            const freqSum = this.escFreq + hiCnt;
            const count = rc.getThreshold(freqSum);
            if (count < hiCnt) {
                let index = 0;
                hiCnt = 0;
                while ((hiCnt += this.freq(ps[index])) <= count) index++;
                s = ps[index];
                rc.decode(hiCnt - this.freq(s), this.freq(s));
                this.seeUpdate(see);
                this.foundState = s;
                const symbol = this.symbol(s);
                this.update2();
                return symbol;
            }
            if (count >= freqSum) return -2;
            rc.decode(hiCnt, freqSum - hiCnt);
            this.seeSumm[see] = this.seeSumm[see] + freqSum;
            do {
                mask[this.symbol(ps[--i])] = 0;
            } while (i !== 0);
        }
    }
}
