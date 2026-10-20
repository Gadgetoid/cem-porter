export const MACHINE_MIPS = 0x166;
export const MACHINE_SH3 = 0x1a2;
export const MACHINE_NAMES = { 0x166: "MIPS", 0x1a2: "SH3", 0x1a6: "SH4", 0x1c0: "ARM", 0x14c: "x86" };


export function u16(data, offset) {
    return data[offset] | (data[offset + 1] << 8);
}

export function u32(data, offset) {
    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

export function setU16(data, offset, value) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
}

export function setU32(data, offset, value) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
    data[offset + 3] = (value >>> 24) & 0xff;
}

export function latin1Decode(bytes) {
    let text = "";
    for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return text;
}

export function cString(data, offset) {
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    return latin1Decode(data.subarray(offset, end));
}

export function align(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

export function rvaToOffset(sections, rva) {
    for (const section of sections) {
        if (section.virtualAddress <= rva && rva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)) {
            return section.rawOffset + rva - section.virtualAddress;
        }
    }
    return null;
}

export function isPe(data) {
    if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) return false;
    const header = u32(data, 0x3c);
    return header + 4 <= data.length && data[header] === 0x50 && data[header + 1] === 0x45 && data[header + 2] === 0 && data[header + 3] === 0;
}

export function readSections(data) {
    const header = u32(data, 0x3c);
    const count = u16(data, header + 6);
    const table = header + 24 + u16(data, header + 20);
    const sections = [];
    for (let index = 0; index < count; index++) {
        const entry = table + 40 * index;
        sections.push({
            name: cString(data.subarray(entry, entry + 8), 0),
            virtualSize: u32(data, entry + 8),
            virtualAddress: u32(data, entry + 12),
            rawSize: u32(data, entry + 16),
            rawOffset: u32(data, entry + 20),
            characteristics: u32(data, entry + 36),
            entry,
        });
    }
    return sections;
}

export function parsePe(data) {
    if (!isPe(data)) return null;
    const header = u32(data, 0x3c);
    const machine = u16(data, header + 4);
    const characteristics = u16(data, header + 22);
    const optional = header + 24;
    const directoryCount = u32(data, optional + 92);
    const directories = [];
    for (let index = 0; index < Math.min(directoryCount, 16); index++) {
        directories.push([u32(data, optional + 96 + 8 * index), u32(data, optional + 100 + 8 * index)]);
    }
    const sections = readSections(data);
    const imports = {};
    if (directories.length > 1 && directories[1][0]) {
        let offset = rvaToOffset(sections, directories[1][0]);
        while (offset !== null && offset + 20 <= data.length) {
            const originalThunk = u32(data, offset);
            const nameRva = u32(data, offset + 12);
            const firstThunk = u32(data, offset + 16);
            if (!nameRva) break;
            const dll = cString(data, rvaToOffset(sections, nameRva)).toLowerCase();
            const functions = imports[dll] ?? (imports[dll] = []);
            let thunkOffset = rvaToOffset(sections, originalThunk || firstThunk);
            while (thunkOffset !== null && thunkOffset + 4 <= data.length) {
                const thunk = u32(data, thunkOffset);
                if (!thunk) break;
                if (thunk & 0x80000000) {
                    functions.push(thunk & 0xffff);
                } else {
                    const hintOffset = rvaToOffset(sections, thunk);
                    if (hintOffset === null) break;
                    functions.push(cString(data, hintOffset + 2));
                }
                thunkOffset += 4;
            }
            offset += 20;
        }
    }
    return {
        machine,
        dll: Boolean(characteristics & 0x2000),
        relocsStripped: Boolean(characteristics & 0x0001),
        hasReloc: Boolean(directories.length > 5 && directories[5][0]),
        imageBase: u32(data, optional + 28),
        sectionAlignment: u32(data, optional + 32),
        fileAlignment: u32(data, optional + 36),
        osVersion: `${u16(data, optional + 40)}.${u16(data, optional + 42)}`,
        subsystem: u16(data, optional + 68),
        subsystemVersion: `${u16(data, optional + 48)}.${u16(data, optional + 50)}`,
        sections: sections.map((section) => section.name),
        imports,
    };
}

export class Image {
    constructor(data) {
        this.data = new Uint8Array(data);
        this.pe = u32(this.data, 0x3c);
        this.sectionCount = u16(this.data, this.pe + 6);
        this.optional = this.pe + 24;
        this.sectionTable = this.optional + u16(this.data, this.pe + 20);
        this.sectionAlignment = u32(this.data, this.optional + 32);
        this.fileAlignment = u32(this.data, this.optional + 36);
        this.headersSize = u32(this.data, this.optional + 60);
        this.imageBase = u32(this.data, this.optional + 28);
        this.sections = readSections(this.data);
    }

    offset(rva) {
        const found = rvaToOffset(this.sections, rva);
        if (found === null) throw new Error(`rva ${rva.toString(16)} not in a section`);
        return found;
    }

    word(rva) {
        return u32(this.data, this.offset(rva));
    }

    setWord(rva, value) {
        setU32(this.data, this.offset(rva), value);
    }

    cString(rva) {
        return cString(this.data, this.offset(rva));
    }

    directory(index) {
        return [u32(this.data, this.optional + 96 + 8 * index), u32(this.data, this.optional + 100 + 8 * index)];
    }
}
