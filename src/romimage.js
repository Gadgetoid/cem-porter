import { latin1Decode, u16, u32 } from "./pe.js";
import { lzDecode, lzwDecode, lzwFileDecode, lzxBlocksDecode } from "./romlz.js";

const HEADER_SIZE = 0x54;
const HEADER_FIELDS = ["dllFirst", "dllLast", "physFirst", "physLast", "moduleCount", "ramStart", "ramFree", "ramEnd", "copyEntries", "copyOffset", "profileLength", "profileOffset", "fileCount", "kernelFlags", "fsRamPercent", "driverGlobalsStart", "driverGlobalsLength"];
const MODULE_ENTRY = 32;
const FILE_ENTRY = 28;
const CE1_MODULE_ENTRY = 0x130;
const CE1_FILE_ENTRY = 0x12c;
const CE1_NAME_SIZE = 260;
const ROM_SECTION_ENTRY = 24;
const PE_SECTION_ENTRY = 40;
const UNIT_NAMES = ["export", "import", "resource", "exception", "security", "fixup", "debug", "description", "machine"];
const UNIT_OFFSETS = [24, 28, 32, 36, 40];
const SCN_CNT_CODE = 0x20;
const SCN_CNT_INITIALIZED_DATA = 0x40;
const SCN_CNT_UNINITIALIZED_DATA = 0x80;
const SCN_COMPRESSED = 0x2000;
const SCN_MEM_WRITE = 0x80000000;
const FILE_ATTRIBUTE_COMPRESSED = 0x800;
const PE32_MAGIC = 0x10b;
const OPTIONAL_HEADER_SIZE = 0xe0;
const DIRECTORY_COUNT = 16;
const LZ_BLOCK = 1024;
const LZ_BLOCK_CE212 = 4096;
const DOS_HEADER_SIZE = 0x80;
const SECTION_ALIGNMENT = 0x1000;
const PE_SECTION_ALIGNMENT = 0x400;
const FILE_ALIGNMENT = 0x200;
const ADDRESS_MASK = 0x1fffffff;
const PAGE = 0x1000;
const MAX_IMAGE_SIZE = 0x4000000;
const FILETIME_UNIX_EPOCH_MS = 11644473600000n;

export const MACHINE_NAMES = {
    0x14c: "x86", 0x162: "MIPS R3000", 0x166: "MIPS R4000", 0x168: "MIPS R10000", 0x169: "MIPS (WCE v2)", 0x266: "MIPS16", 0x366: "MIPS FPU",
    0x1a2: "SH3", 0x1a3: "SH3 DSP", 0x1a4: "SH3E", 0x1a6: "SH4", 0x1a8: "SH5", 0x1c0: "ARM", 0x1c2: "ARM with Thumb (ARMV4I)", 0x1c4: "ARMv7", 0x1f0: "PowerPC",
};
const MACHINE_MIPS = 0x166;
const MACHINE_SH3 = 0x1a2;
const MACHINE_ARM = 0x1c0;
const MACHINE_X86 = 0x14c;

export const ATTRIBUTE_NAMES = { 0x1: "Read-only", 0x2: "Hidden", 0x4: "System", 0x20: "Archive", 0x40: "In ROM", 0x800: "Compressed", 0x2000: "ROM module" };

function masked(address) {
    return (address & ADDRESS_MASK) >>> 0;
}

function nameEnd(data, start, limit = 64) {
    const end = Math.min(data.length, start + limit);
    for (let index = start; index < end; index++) if (!data[index]) return index;
    return -1;
}

function isPrintable(data, start, end) {
    if (end <= start) return false;
    for (let index = start; index < end; index++) if (data[index] < 32 || data[index] > 126) return false;
    return true;
}

function align(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

export function filetimeDate(low, high) {
    const ticks = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    if (!ticks) return null;
    const date = new Date(Number(ticks / 10000n - FILETIME_UNIX_EPOCH_MS));
    return Number.isNaN(date.getTime()) ? null : date;
}

function unixTime(date) {
    return date ? Math.max(0, Math.floor(date.getTime() / 1000)) >>> 0 : 0;
}

function unpackBin(data) {
    if (data.length < 15) throw new Error("truncated CE BIN header");
    const base = u32(data, 7);
    const size = u32(data, 11);
    const image = new Uint8Array(size);
    const problems = [];
    let position = 15;
    let records = 0;
    while (position + 12 <= data.length) {
        const address = u32(data, position);
        const length = u32(data, position + 4);
        const checksum = u32(data, position + 8);
        position += 12;
        if (address === 0 && checksum === 0) return { image, base, records, problems, entry: length };
        if (position + length > data.length) throw new Error("truncated CE BIN record");
        const payload = data.subarray(position, position + length);
        let sum = 0;
        for (const byte of payload) sum = (sum + byte) >>> 0;
        const offset = address - base;
        if (sum !== checksum) problems.push(`bad checksum in the record at ${hex(address)}`);
        if (offset < 0 || offset + length > size) problems.push(`record at ${hex(address)} is outside the image`);
        else image.set(payload, offset);
        records++;
        position += length;
    }
    throw new Error("CE BIN image has no entry record");
}

export function hex(value, digits = 8) {
    return (value >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

class RomRegion {
    constructor(data, base, headerOffset, layout) {
        this.data = data;
        this.base = base;
        this.headerOffset = headerOffset;
        this.layout = layout;
        const words = Array.from({ length: HEADER_FIELDS.length }, (_, index) => u32(data, headerOffset + 4 * index));
        this.header = Object.fromEntries(HEADER_FIELDS.map((name, index) => [name, words[index]]));
        this.header.cpuType = u16(data, headerOffset + 0x44);
        this.header.miscFlags = u16(data, headerOffset + 0x46);
        this.header.extensions = u32(data, headerOffset + 0x48);
        this.header.trackingStart = u32(data, headerOffset + 0x4c);
        this.header.trackingLength = u32(data, headerOffset + 0x50);
        this.headerAddress = (this.header.physFirst - masked(this.header.physFirst) + masked(base) + headerOffset) >>> 0;
        this.modules = layout === "ce1" ? this.readCe1Modules() : this.readModules();
        this.files = layout === "ce1" ? this.readCe1Files() : this.readFiles();
        for (const item of [...this.modules, ...this.files]) item.region = this;
        this.version = this.kernelVersion();
        this.compression = this.layout === "ce2" ? this.detectCompression() : "lzw";
        if (layout === "ce2") {
            this.unitsOffset = this.findUnitsOffset();
            for (const module of this.modules) this.readModuleHeader(module);
        }
        this.machine = this.detectMachine();
    }

    decompress(stored, size, scheme = this.compression) {
        if (scheme === "lzx") return lzxBlocksDecode(stored, size);
        return lzDecode(stored, size, scheme === "lz4k" ? LZ_BLOCK_CE212 : LZ_BLOCK);
    }

    detectCompression() {
        const fallback = this.version && (this.version[0] > 2 || (this.version[0] === 2 && this.version[1] >= 12)) ? "lz4k" : "lz1k";
        const samples = this.files.filter((file) => file.storedSize < file.size).slice(0, 24);
        const scores = new Map([["lz1k", 0], ["lz4k", 0], ["lzx", 0]]);
        for (const file of samples) {
            for (const scheme of scores.keys()) {
                try {
                    if (this.decompress(this.read(file.load, file.storedSize), file.size + 1, scheme).length === file.size) scores.set(scheme, scores.get(scheme) + 1);
                } catch {
                    continue;
                }
            }
        }
        const best = Math.max(...scores.values());
        if (!best) return fallback;
        const leaders = [...scores].filter(([, score]) => score === best).map(([scheme]) => scheme);
        if (leaders.includes("lzx")) return "lzx";
        return leaders.includes(fallback) ? fallback : leaders[0];
    }

    offset(address, check = true) {
        const offset = masked(address) - masked(this.base);
        if (check && (offset < 0 || offset >= this.data.length)) throw new RangeError(`${hex(address)} is outside the image`);
        return offset;
    }

    contains(address, length = 1) {
        const offset = masked(address) - masked(this.base);
        return offset >= 0 && offset + length <= this.data.length;
    }

    read(address, length) {
        const start = this.offset(address);
        if (start + length > this.data.length) throw new RangeError(`${hex(address)}+${length} is outside the image`);
        return this.data.subarray(start, start + length);
    }

    word(address) {
        return u32(this.data, this.offset(address));
    }

    string(address) {
        const start = this.offset(address);
        const end = this.data.indexOf(0, start);
        return latin1Decode(this.data.subarray(start, end < 0 ? this.data.length : end));
    }

    get physicalSize() {
        return masked(this.header.physLast) - masked(this.header.physFirst);
    }

    readModules() {
        const table = this.headerAddress + HEADER_SIZE;
        return Array.from({ length: this.header.moduleCount }, (_, index) => {
            const entry = this.offset(table + MODULE_ENTRY * index);
            const field = (number) => u32(this.data, entry + 4 * number);
            return { kind: "module", index, name: this.string(field(4)), attributes: field(0), time: filetimeDate(field(1), field(2)), size: field(3), e32: field(5), o32: field(6), load: field(7) };
        });
    }

    readFiles() {
        const table = this.headerAddress + HEADER_SIZE + MODULE_ENTRY * this.header.moduleCount;
        return Array.from({ length: this.header.fileCount }, (_, index) => {
            const entry = this.offset(table + FILE_ENTRY * index);
            const field = (number) => u32(this.data, entry + 4 * number);
            return { kind: "file", index, name: this.string(field(5)), attributes: field(0), time: filetimeDate(field(1), field(2)), size: field(3), storedSize: field(4), load: field(6) };
        });
    }

    readCe1Modules() {
        const table = this.headerAddress + HEADER_SIZE;
        return Array.from({ length: this.header.moduleCount }, (_, index) => {
            const entry = this.offset(table + CE1_MODULE_ENTRY * index);
            const name = inlineName(this.data, entry + 0x10);
            const e32 = u32(this.data, entry + CE1_MODULE_ENTRY - 12);
            const o32 = u32(this.data, entry + CE1_MODULE_ENTRY - 8);
            const module = { kind: "module", index, name, attributes: u32(this.data, entry), time: filetimeDate(u32(this.data, entry + 4), u32(this.data, entry + 8)), size: u32(this.data, entry + 12), e32, o32, load: u32(this.data, entry + CE1_MODULE_ENTRY - 4) };
            this.readCe1ModuleHeader(module);
            return module;
        });
    }

    readCe1Files() {
        const table = this.headerAddress + HEADER_SIZE + CE1_MODULE_ENTRY * this.header.moduleCount;
        return Array.from({ length: this.header.fileCount }, (_, index) => {
            const entry = this.offset(table + CE1_FILE_ENTRY * index);
            return { kind: "file", index, name: inlineName(this.data, entry + 0x14), attributes: u32(this.data, entry), time: filetimeDate(u32(this.data, entry + 4), u32(this.data, entry + 8)), size: u32(this.data, entry + 12), storedSize: u32(this.data, entry + 16), load: u32(this.data, entry + CE1_FILE_ENTRY - 4) };
        });
    }

    readCe1ModuleHeader(module) {
        const pe = this.offset(module.e32);
        const optional = pe + 24;
        const sectionCount = u16(this.data, pe + 6);
        module.header = {
            machine: u16(this.data, pe + 4),
            sectionCount,
            flags: u16(this.data, pe + 22),
            optionalSize: u16(this.data, pe + 20),
            entry: u32(this.data, optional + 16),
            imageBase: u32(this.data, optional + 28),
            version: [u16(this.data, optional + 48), u16(this.data, optional + 50)],
            imageSize: u32(this.data, optional + 56),
            subsystem: u16(this.data, optional + 68),
            units: Object.fromEntries(UNIT_NAMES.map((name, index) => [name, [u32(this.data, optional + 96 + 8 * index), u32(this.data, optional + 100 + 8 * index)]])),
        };
        module.sections = Array.from({ length: sectionCount }, (_, index) => {
            const entry = this.offset(module.o32 + PE_SECTION_ENTRY * index);
            return { name: inlineName(this.data, entry, 8), virtualSize: u32(this.data, entry + 8), rva: u32(this.data, entry + 12), storedSize: u32(this.data, entry + 16), pointer: u32(this.data, entry + 20), realAddress: 0, flags: u32(this.data, entry + 36), entry };
        });
    }

    kernelVersion() {
        const kernel = this.modules.find((module) => module.name.toLowerCase() === "nk.exe") ?? this.modules[0];
        if (!kernel) return null;
        if (this.layout === "ce1") return kernel.header.version;
        try {
            const raw = this.read(kernel.e32 + 12, 4);
            return [u16(raw, 0), u16(raw, 2)];
        } catch {
            return null;
        }
    }

    unitsAt(module, unitsOffset) {
        const raw = this.read(module.e32, unitsOffset + 8 * UNIT_NAMES.length + 4);
        return Object.fromEntries(UNIT_NAMES.map((name, index) => [name, [u32(raw, unitsOffset + 8 * index), u32(raw, unitsOffset + 4 + 8 * index)]]));
    }

    romSections(module) {
        const count = u16(this.read(module.e32, 2), 0);
        return Array.from({ length: count }, (_, index) => {
            const raw = this.read(module.o32 + ROM_SECTION_ENTRY * index, ROM_SECTION_ENTRY);
            return { virtualSize: u32(raw, 0), rva: u32(raw, 4), storedSize: u32(raw, 8), pointer: u32(raw, 12), realAddress: u32(raw, 16), flags: u32(raw, 20) };
        });
    }

    exportName(module, sections, units) {
        const [rva, size] = units.export;
        if (!rva || !size) return null;
        const section = sections.find((candidate) => candidate.rva <= rva && rva + 40 <= candidate.rva + Math.max(candidate.virtualSize, candidate.storedSize));
        if (!section || section.flags & SCN_COMPRESSED) return null;
        const nameRva = u32(this.read(section.pointer + rva - section.rva + 12, 4), 0);
        const nameSection = sections.find((candidate) => candidate.rva <= nameRva && nameRva < candidate.rva + candidate.storedSize);
        if (!nameSection || nameSection.flags & SCN_COMPRESSED) return null;
        try {
            return this.string(nameSection.pointer + nameRva - nameSection.rva);
        } catch {
            return null;
        }
    }

    findUnitsOffset() {
        const scores = new Map(UNIT_OFFSETS.map((offset) => [offset, 0]));
        for (const module of this.modules.slice(0, 40)) {
            let sections;
            try {
                sections = this.romSections(module);
            } catch {
                continue;
            }
            for (const offset of UNIT_OFFSETS) {
                try {
                    const name = this.exportName(module, sections, this.unitsAt(module, offset));
                    if (name && name.toLowerCase() === module.name.toLowerCase()) scores.set(offset, scores.get(offset) + 1);
                } catch {
                    continue;
                }
            }
        }
        const [best, score] = [...scores].sort((left, right) => right[1] - left[1])[0];
        if (score) return best;
        if (!this.version) return 24;
        if (this.version[0] >= 3) return 32;
        return this.version[0] === 2 && this.version[1] >= 10 ? 28 : 24;
    }

    readModuleHeader(module) {
        try {
            const raw = this.read(module.e32, this.unitsOffset + 8 * UNIT_NAMES.length + 2);
            const units = this.unitsAt(module, this.unitsOffset);
            const sections = this.romSections(module).map((section) => ({ ...section, name: sectionName(section, units) }));
            const before = u32(raw, this.unitsOffset - 4);
            const after = u16(raw, this.unitsOffset + 8 * UNIT_NAMES.length);
            const end = Math.max(0, ...sections.map((section) => section.rva + section.virtualSize));
            const recorded = u32(raw, this.unitsOffset - 8);
            module.header = {
                sectionCount: u16(raw, 0),
                flags: u16(raw, 2),
                entry: u32(raw, 4),
                imageBase: u32(raw, 8),
                version: [u16(raw, 12), u16(raw, 14)],
                imageSize: recorded >= end && recorded <= MAX_IMAGE_SIZE ? recorded : align(end, SECTION_ALIGNMENT),
                subsystem: before >= 1 && before <= 16 ? before : after >= 1 && after <= 16 ? after : 9,
                units,
            };
            module.sections = sections;
        } catch (error) {
            module.header = null;
            module.sections = [];
            module.problem = error.message;
        }
    }

    detectMachine() {
        if (MACHINE_NAMES[this.header.cpuType]) return this.header.cpuType;
        const kernel = this.modules.find((module) => module.name.toLowerCase() === "nk.exe") ?? this.modules[0];
        if (this.layout === "ce1" && kernel?.header?.machine) return kernel.header.machine;
        const code = kernel?.sections?.find((section) => section.flags & SCN_CNT_CODE);
        if (!code) return 0;
        let text;
        try {
            text = this.sectionData(code);
        } catch {
            return 0;
        }
        const entry = kernel.header.entry - code.rva;
        if (entry >= 0 && text[entry] === 0xfa && text[entry + 1] === 0xe9) return MACHINE_X86;
        let mips = 0;
        let arm = 0;
        let sh = 0;
        for (let offset = 0; offset + 4 <= text.length; offset += 4) {
            const word = u32(text, offset);
            if (word === 0x03e00008) mips++;
            if (word === 0xe1a0f00e || word === 0xe12fff1e || (word & 0xffff0000) === 0xe8bd0000) arm++;
            if ((word & 0xffff) === 0x000b) sh++;
            if (word >>> 16 === 0x000b) sh++;
        }
        const ranked = [[MACHINE_MIPS, mips], [MACHINE_ARM, arm], [MACHINE_SH3, sh / 2]].sort((left, right) => right[1] - left[1]);
        return ranked[0][1] ? ranked[0][0] : 0;
    }

    sectionData(section) {
        if (!section.storedSize) return new Uint8Array(0);
        const stored = this.read(section.pointer, section.storedSize);
        if (!(section.flags & SCN_COMPRESSED)) return stored;
        if (this.layout === "ce1") return lzwDecode(stored, section.virtualSize);
        return this.decompress(stored, section.virtualSize);
    }

    moduleData(module) {
        if (module.cached) return module.cached;
        module.cached = this.layout === "ce1" ? this.rebuildCe1(module) : this.rebuild(module);
        return module.cached;
    }

    fileData(file) {
        const stored = this.read(file.load, file.storedSize);
        if (this.layout === "ce1") return file.attributes & FILE_ATTRIBUTE_COMPRESSED || file.storedSize < file.size ? lzwFileDecode(stored, file.size) : stored.slice(0, file.size);
        if (file.storedSize !== file.size) return this.decompress(stored, file.size);
        return stored.slice();
    }

    rebuild(module) {
        const { header, sections } = module;
        if (!header) throw new Error(module.problem ?? "unreadable module header");
        const headersSize = DOS_HEADER_SIZE + 24 + OPTIONAL_HEADER_SIZE + PE_SECTION_ENTRY * sections.length;
        const position = align(headersSize, FILE_ALIGNMENT);
        const bodies = sections.map((section) => this.sectionData(section));
        const total = position + bodies.reduce((sum, body) => sum + (body.length ? align(body.length, FILE_ALIGNMENT) : 0), 0);
        const output = new Uint8Array(total);
        const view = new DataView(output.buffer);
        output[0] = 0x4d;
        output[1] = 0x5a;
        view.setUint32(0x3c, DOS_HEADER_SIZE, true);
        const pe = DOS_HEADER_SIZE;
        output.set([0x50, 0x45, 0, 0], pe);
        view.setUint16(pe + 4, this.machine || MACHINE_SH3, true);
        view.setUint16(pe + 6, sections.length, true);
        view.setUint32(pe + 8, unixTime(module.time), true);
        view.setUint16(pe + 20, OPTIONAL_HEADER_SIZE, true);
        view.setUint16(pe + 22, header.flags, true);
        const optional = pe + 24;
        const code = sections.filter((section) => section.flags & SCN_CNT_CODE);
        const data = sections.filter((section) => !(section.flags & SCN_CNT_CODE));
        const sum = (list) => list.reduce((total, section) => total + section.virtualSize, 0);
        const [major, minor] = header.version;
        view.setUint16(optional, PE32_MAGIC, true);
        view.setUint32(optional + 4, sum(code), true);
        view.setUint32(optional + 8, sum(sections.filter((section) => section.flags & SCN_CNT_INITIALIZED_DATA)), true);
        view.setUint32(optional + 12, sum(sections.filter((section) => section.flags & SCN_CNT_UNINITIALIZED_DATA)), true);
        view.setUint32(optional + 16, header.entry, true);
        view.setUint32(optional + 20, code[0]?.rva ?? 0, true);
        view.setUint32(optional + 24, data[0]?.rva ?? 0, true);
        view.setUint32(optional + 28, header.imageBase, true);
        view.setUint32(optional + 32, PE_SECTION_ALIGNMENT, true);
        view.setUint32(optional + 36, FILE_ALIGNMENT, true);
        view.setUint16(optional + 40, major, true);
        view.setUint16(optional + 42, minor, true);
        view.setUint16(optional + 48, major, true);
        view.setUint16(optional + 50, minor, true);
        view.setUint32(optional + 56, header.imageSize, true);
        view.setUint32(optional + 60, position, true);
        view.setUint16(optional + 68, header.subsystem, true);
        view.setUint32(optional + 92, DIRECTORY_COUNT, true);
        UNIT_NAMES.forEach((name, index) => {
            const [rva, size] = header.units[name];
            if (sections.some((section) => section.rva <= rva && rva < section.rva + section.virtualSize)) {
                view.setUint32(optional + 96 + 8 * index, rva, true);
                view.setUint32(optional + 100 + 8 * index, size, true);
            }
        });
        let table = optional + OPTIONAL_HEADER_SIZE;
        let pointer = position;
        sections.forEach((section, index) => {
            const body = bodies[index];
            const stored = body.length ? align(body.length, FILE_ALIGNMENT) : 0;
            output.set(new TextEncoder().encode(section.name).subarray(0, 8), table);
            view.setUint32(table + 8, section.virtualSize, true);
            view.setUint32(table + 12, section.rva, true);
            view.setUint32(table + 16, stored, true);
            view.setUint32(table + 20, body.length ? pointer : 0, true);
            view.setUint32(table + 36, (section.flags & ~SCN_COMPRESSED) >>> 0, true);
            output.set(body, pointer);
            pointer += stored;
            table += PE_SECTION_ENTRY;
        });
        return output;
    }

    rebuildCe1(module) {
        const { header, sections } = module;
        const peSize = 24 + header.optionalSize;
        const position = align(DOS_HEADER_SIZE + peSize + PE_SECTION_ENTRY * sections.length, FILE_ALIGNMENT);
        const bodies = sections.map((section) => this.sectionData(section));
        const total = position + bodies.reduce((sum, body) => sum + (body.length ? align(body.length, FILE_ALIGNMENT) : 0), 0);
        const output = new Uint8Array(total);
        const view = new DataView(output.buffer);
        output[0] = 0x4d;
        output[1] = 0x5a;
        view.setUint32(0x3c, DOS_HEADER_SIZE, true);
        output.set(this.read(module.e32, peSize), DOS_HEADER_SIZE);
        view.setUint32(DOS_HEADER_SIZE + 24 + 36, FILE_ALIGNMENT, true);
        view.setUint32(DOS_HEADER_SIZE + 24 + 60, position, true);
        const directories = DOS_HEADER_SIZE + 24 + 96;
        const directoryCount = Math.min(DIRECTORY_COUNT, Math.max(0, (header.optionalSize - 96) / 8));
        for (let index = 0; index < directoryCount; index++) {
            const rva = view.getUint32(directories + 8 * index, true);
            if (rva && !sections.some((section) => section.rva <= rva && rva < section.rva + Math.max(section.virtualSize, section.storedSize))) {
                view.setUint32(directories + 8 * index, 0, true);
                view.setUint32(directories + 8 * index + 4, 0, true);
            }
        }
        let table = DOS_HEADER_SIZE + peSize;
        let pointer = position;
        sections.forEach((section, index) => {
            const body = bodies[index];
            output.set(this.data.subarray(section.entry, section.entry + PE_SECTION_ENTRY), table);
            view.setUint32(table + 16, body.length ? align(body.length, FILE_ALIGNMENT) : 0, true);
            view.setUint32(table + 20, body.length ? pointer : 0, true);
            view.setUint32(table + 36, (section.flags & ~SCN_COMPRESSED) >>> 0, true);
            if (body.length) {
                output.set(body, pointer);
                pointer += align(body.length, FILE_ALIGNMENT);
            }
            table += PE_SECTION_ENTRY;
        });
        return output;
    }

    copyEntries() {
        return Array.from({ length: this.header.copyEntries }, (_, index) => {
            const raw = this.read(this.header.copyOffset + 16 * index, 16);
            return { source: u32(raw, 0), destination: u32(raw, 4), copyLength: u32(raw, 8), destinationLength: u32(raw, 12) };
        });
    }
}

function inlineName(data, offset, size = CE1_NAME_SIZE) {
    const end = data.indexOf(0, offset);
    return latin1Decode(data.subarray(offset, end < 0 || end > offset + size ? offset + size : end));
}

function sectionName(section, units) {
    for (const [unit, name] of [["resource", ".rsrc"], ["exception", ".pdata"], ["fixup", ".reloc"]]) {
        if (units[unit][0] === section.rva && units[unit][1]) return name;
    }
    if (section.flags & SCN_CNT_CODE) return ".text";
    if (section.flags & SCN_MEM_WRITE) return ".data";
    return ".rdata";
}

function plausibleHeader(data, offset) {
    const physFirst = masked(u32(data, offset + 8));
    const physLast = masked(u32(data, offset + 12));
    const moduleCount = u32(data, offset + 16);
    const ramStart = u32(data, offset + 20);
    const ramFree = u32(data, offset + 24);
    const ramEnd = u32(data, offset + 28);
    if (physFirst & 0x3ff || physFirst >= physLast || moduleCount < 1 || moduleCount > 1000) return null;
    if (!(ramStart <= ramFree && ramFree <= ramEnd)) return null;
    return { physFirst, physLast, moduleCount, fileCount: u32(data, offset + 48) };
}

function validCe2Table(data, fileOffset, headerOffset, fields) {
    const delta = fields.physFirst - fileOffset;
    const resolve = (address) => masked(address) - delta;
    for (let index = 0; index < fields.moduleCount; index++) {
        const entry = headerOffset + HEADER_SIZE + MODULE_ENTRY * index;
        if (entry + MODULE_ENTRY > data.length) return false;
        const name = resolve(u32(data, entry + 16));
        if (name < 0 || name >= data.length) return false;
        const end = nameEnd(data, name);
        if (end < 0 || !isPrintable(data, name, end)) return false;
        const e32 = resolve(u32(data, entry + 20));
        if (e32 < 0 || e32 >= data.length) return false;
    }
    return true;
}

function validCe1Table(data, fileOffset, headerOffset, fields) {
    const delta = fields.physFirst - fileOffset;
    for (let index = 0; index < fields.moduleCount; index++) {
        const entry = headerOffset + HEADER_SIZE + CE1_MODULE_ENTRY * index;
        if (entry + CE1_MODULE_ENTRY > data.length) return false;
        const end = nameEnd(data, entry + 0x10);
        if (end < 0 || !isPrintable(data, entry + 0x10, end)) return false;
        const e32 = masked(u32(data, entry + CE1_MODULE_ENTRY - 12)) - delta;
        if (e32 < 0 || e32 + 4 > data.length || u32(data, e32) !== 0x4550) return false;
    }
    return true;
}

function candidateStarts(data, headerOffset, fields, signatureStarts, knownBase) {
    const span = fields.physLast - fields.physFirst;
    if (knownBase !== null) return [fields.physFirst - masked(knownBase)];
    const starts = [0, ...signatureStarts];
    for (let start = Math.max(0, headerOffset - span) & ~(PAGE - 1); start <= headerOffset; start += PAGE) starts.push(start);
    return [...new Set(starts)].filter((start) => start <= headerOffset && headerOffset < start + span);
}

function findRegions(data, knownBase) {
    const signatureStarts = [];
    for (let position = data.indexOf(0x45); position >= 0; position = data.indexOf(0x45, position + 1)) {
        if (position >= 0x40 && data[position + 1] === 0x43 && data[position + 2] === 0x45 && data[position + 3] === 0x43 && !((position - 0x40) & 3)) signatureStarts.push(position - 0x40);
    }
    const regions = [];
    for (let offset = 0; offset + HEADER_SIZE <= data.length; offset += 4) {
        const fields = plausibleHeader(data, offset);
        if (!fields || (knownBase === null && fields.physLast - fields.physFirst > data.length)) continue;
        for (const start of candidateStarts(data, offset, fields, signatureStarts, knownBase)) {
            const layout = validCe2Table(data, start, offset, fields) ? "ce2" : validCe1Table(data, start, offset, fields) ? "ce1" : null;
            if (!layout) continue;
            regions.push({ start, offset, layout });
            break;
        }
    }
    return regions;
}

const FORMAT_SIGNATURES = [
    [[0x4d, 0x5a], "a Windows program or DLL, not a ROM image (CEM Porter can port programs)"],
    [[0x7f, 0x45, 0x4c, 0x46], "an ELF executable"],
    [[0x1f, 0x8b], "gzip-compressed data"],
    [[0x42, 0x5a, 0x68], "bzip2-compressed data"],
    [[0xfd, 0x37, 0x7a, 0x58, 0x5a], "xz-compressed data"],
    [[0x52, 0x61, 0x72, 0x21], "a RAR archive, which can't be opened here"],
    [[0x25, 0x50, 0x44, 0x46], "a PDF document"],
    [[0x4d, 0x53, 0x43, 0x46], "a Microsoft CAB file"],
];
const CE_NAMES = ["nk.exe", "coredll.dll", "filesys.exe", "gwes.exe"];

function entropy(data, start, length) {
    const counts = new Uint32Array(256);
    for (let index = start; index < start + length; index++) counts[data[index]]++;
    let bits = 0;
    for (const count of counts) if (count) bits -= (count / length) * Math.log2(count / length);
    return bits;
}

function containsText(data, text) {
    const bytes = Array.from(text, (character) => character.charCodeAt(0));
    for (let position = data.indexOf(bytes[0]); position >= 0; position = data.indexOf(bytes[0], position + 1)) {
        if (bytes.every((byte, index) => data[position + index] === byte)) return true;
    }
    return false;
}

export function describeUnreadable(data) {
    if (!data.length) return "The file is empty.";
    const known = FORMAT_SIGNATURES.find(([signature]) => signature.every((byte, index) => data[index] === byte));
    if (known) return `This looks like ${known[1]}.`;
    let blank = 0;
    let first = data[0];
    let uniform = true;
    for (const byte of data) {
        if (byte === 0xff || byte === 0) blank++;
        if (byte !== first) uniform = false;
    }
    if (uniform) return `Every byte is 0x${first.toString(16).toUpperCase().padStart(2, "0")}, so the dump is blank or failed.`;
    const blankShare = blank / data.length;
    if (blankShare > 0.98) return `The file is ${Math.round(blankShare * 100)}% 0xFF or 0x00, so the dump is probably blank or incomplete.`;
    const chunk = Math.min(data.length, 65536);
    const samples = Math.min(16, Math.max(1, Math.floor(data.length / chunk)));
    let total = 0;
    for (let index = 0; index < samples; index++) total += entropy(data, Math.floor((index * (data.length - chunk)) / Math.max(1, samples - 1)), chunk);
    const names = CE_NAMES.filter((name) => containsText(data, name));
    if (names.length) return `It names Windows CE files (${names.join(", ")}) but has no readable ROM table, so the OS may be stored compressed, in another format, or only partly dumped.`;
    if (total / samples > 7.9) return "It looks compressed or encrypted throughout, and doesn't mention Windows CE's kernel files.";
    return "Nothing in it looks like a Windows CE ROM: no ROM table and no mention of CE's kernel files.";
}

function misalignedShifts(data) {
    const shifts = new Set();
    for (let position = data.indexOf(0x45); position >= 0 && shifts.size < 3; position = data.indexOf(0x45, position + 1)) {
        if (position >= 0x40 && data[position + 1] === 0x43 && data[position + 2] === 0x45 && data[position + 3] === 0x43 && (position - 0x40) & 3) shifts.add((position - 0x40) & 3);
    }
    return [...shifts];
}

function validWrappedTable(data, start, offset, fields) {
    const length = data.length;
    const at = (index) => data[((index % length) + length) % length];
    const word = (index) => (at(index) | (at(index + 1) << 8) | (at(index + 2) << 16) | (at(index + 3) << 24)) >>> 0;
    for (let index = 0; index < fields.moduleCount; index++) {
        const entry = offset + HEADER_SIZE + MODULE_ENTRY * index;
        const name = masked(word(entry + 16)) - fields.physFirst;
        if (name < 0 || name >= length) return false;
        let size = 0;
        while (size < 64 && at(start + name + size)) {
            const byte = at(start + name + size);
            if (byte < 32 || byte > 126) return false;
            size++;
        }
        if (!size || size >= 64) return false;
        const e32 = masked(word(entry + 20)) - fields.physFirst;
        if (e32 < 0 || e32 >= length) return false;
    }
    return true;
}

function* wrappedRegions(data) {
    const length = data.length;
    for (let offset = 0; offset + HEADER_SIZE <= length; offset += 4) {
        const fields = plausibleHeader(data, offset);
        if (!fields) continue;
        const span = fields.physLast - fields.physFirst;
        if (span > length) continue;
        for (let start = (offset + PAGE) & ~(PAGE - 1); start < length; start += PAGE) {
            const rotatedOffset = offset - start + length;
            if (rotatedOffset >= span || !validWrappedTable(data, start, offset, fields)) continue;
            const rotated = new Uint8Array(length);
            rotated.set(data.subarray(start));
            rotated.set(data.subarray(0, start), length - start);
            yield { data: rotated, start, offset: rotatedOffset };
        }
    }
}

function buildRegions(data, found) {
    return found.map((region) => {
        const physFirst = u32(data, region.offset + 8);
        const base = (physFirst - region.start) >>> 0;
        try {
            return new RomRegion(data, base, region.offset, region.layout);
        } catch (error) {
            return { failed: error.message, offset: region.offset };
        }
    }).filter((region) => !region.failed);
}

function moduleNames(regions) {
    return new Set(regions.flatMap((region) => region.modules.filter((module) => module.header).map((module) => module.name.toLowerCase())));
}

function isCompleteOs(regions) {
    const names = moduleNames(regions);
    return names.has("nk.exe") && names.has("coredll.dll");
}

function hasKernel(region) {
    return Number(isCompleteOs([region]));
}

function groupRegions(regions) {
    const groups = [];
    const used = new Set();
    for (const region of regions) {
        if (used.has(region)) continue;
        const chain = region.header.extensions ? regions.filter((other) => !used.has(other) && other.header.extensions === region.header.extensions) : [region];
        chain.forEach((member) => used.add(member));
        groups.push(chain);
    }
    for (const group of groups) {
        if (isCompleteOs(group) || !moduleNames(group).has("coredll.dll")) continue;
        const kernel = groups.find((other) => other !== group && other.length === 1 && moduleNames(other).has("nk.exe") && !moduleNames(other).has("coredll.dll"));
        if (kernel) {
            group.push(...kernel);
            groups.splice(groups.indexOf(kernel), 1);
        }
    }
    const size = (group) => group.reduce((total, region) => total + region.modules.length + region.files.length, 0);
    return groups.sort((left, right) => Number(isCompleteOs(right)) - Number(isCompleteOs(left)) || size(right) - size(left));
}

export function openRom(input, name = "") {
    let data = input instanceof Uint8Array ? input : new Uint8Array(input);
    let format = "Flat image";
    let bin = null;
    if (data.length >= 7 && latin1Decode(data.subarray(0, 7)) === "B000FF\n") {
        bin = unpackBin(data);
        data = bin.image;
        format = "CE BIN (B000FF)";
    }
    const regions = buildRegions(data, findRegions(data, bin ? bin.base : null));
    if (!bin && !isCompleteOs(regions)) {
        for (const shift of misalignedShifts(data)) {
            const shifted = data.subarray(shift);
            const found = buildRegions(shifted, findRegions(shifted, null));
            if (isCompleteOs(found)) {
                regions.push(...found);
                format = `Flat image, starting ${shift} byte${shift === 1 ? "" : "s"} into the file`;
                break;
            }
        }
    }
    if (!bin && !isCompleteOs(regions)) {
        for (const wrapped of wrappedRegions(data)) {
            const found = buildRegions(wrapped.data, [{ start: 0, offset: wrapped.offset, layout: "ce2" }]);
            if (isCompleteOs(found)) {
                regions.push(...found);
                format = `Flat image, wrapping round the end of the file from ${hex(wrapped.start, 6)}`;
                break;
            }
        }
    }
    if (!regions.length) throw new Error(`No Windows CE ROM found. ${describeUnreadable(data)}`);
    regions.sort((left, right) => hasKernel(right) - hasKernel(left) || right.physicalSize - left.physicalSize || right.modules.length - left.modules.length);
    const groups = groupRegions(regions);
    return { name, format, size: input.length, bin, regions, groups, primary: groups[0].find((region) => moduleNames([region]).has("coredll.dll")) ?? groups[0][0] };
}
