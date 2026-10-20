import { u16, u32, setU32, cString, align } from "./pe.js";

export const PAGE = 0x1000;

export const REL_ABSOLUTE = 0;
export const REL_HIGH = 1;
export const REL_LOW = 2;
export const REL_HIGHLOW = 3;
export const REL_HIGHADJ = 4;
export const REL_JMPADDR = 5;

export function sign16(value) {
    return value & 0x8000 ? value - 0x10000 : value;
}

function hex(value) {
    return value.toString(16);
}

function checkedU32(data, offset) {
    if (offset < 0 || offset + 4 > data.length) throw new Error(`read of 4 bytes at ${offset} outside ${data.length} byte buffer`);
    return u32(data, offset);
}

function checkedSetU32(data, offset, value) {
    if (offset < 0 || offset + 4 > data.length) throw new Error(`write of 4 bytes at ${offset} outside ${data.length} byte buffer`);
    setU32(data, offset, value);
}

export class RealignImage {
    constructor(data) {
        this.data = new Uint8Array(data);
        this.pe = u32(this.data, 0x3c);
        this.optional = this.pe + 24;
        this.sectionCount = u16(this.data, this.pe + 6);
        this.sectionTable = this.optional + u16(this.data, this.pe + 20);
        this.imageBase = u32(this.data, this.optional + 28);
        this.directoryCount = u32(this.data, this.optional + 92);
        this.sections = [];
        for (let index = 0; index < this.sectionCount; index++) {
            const header = this.sectionTable + 40 * index;
            this.sections.push({
                header,
                name: cString(this.data.subarray(header, header + 8), 0),
                virtualSize: u32(this.data, header + 8),
                oldVa: u32(this.data, header + 12),
                rawSize: u32(this.data, header + 16),
                rawPointer: u32(this.data, header + 20),
            });
        }
    }

    directory(index) {
        if (index >= this.directoryCount) return [0, 0];
        const entry = this.optional + 96 + 8 * index;
        return [checkedU32(this.data, entry), checkedU32(this.data, entry + 4)];
    }

    setDirectory(index, rva, size) {
        const entry = this.optional + 96 + 8 * index;
        checkedSetU32(this.data, entry, rva);
        checkedSetU32(this.data, entry + 4, size);
    }

    sectionForOld(rva) {
        for (let index = 0; index < this.sections.length; index++) {
            const section = this.sections[index];
            const next = this.sections[index + 1];
            const end = next ? next.oldVa : section.oldVa + align(section.virtualSize, PAGE);
            if (section.oldVa <= rva && rva < end) return section;
        }
        return null;
    }

    offset(oldRva) {
        const section = this.sectionForOld(oldRva);
        if (section === null || oldRva - section.oldVa >= section.rawSize) {
            throw new Error(`rva ${hex(oldRva)} has no file data`);
        }
        return section.rawPointer + oldRva - section.oldVa;
    }

    mapRva(oldRva) {
        if (oldRva < this.sections[0].oldVa) return oldRva;
        const section = this.sectionForOld(oldRva);
        if (section === null) throw new Error(`rva ${hex(oldRva)} outside the image`);
        return oldRva - section.oldVa + section.newVa;
    }

    mapVa(oldVa) {
        return this.mapRva(oldVa - this.imageBase) + this.imageBase;
    }

    read32(oldRva) {
        return checkedU32(this.data, this.offset(oldRva));
    }

    write32(oldRva, value) {
        checkedSetU32(this.data, this.offset(oldRva), value);
    }

    mapField(oldRva) {
        const value = this.read32(oldRva);
        if (value) this.write32(oldRva, this.mapRva(value));
    }
}

export function readRelocations(image) {
    const [rva, size] = image.directory(5);
    if (!rva || !size) return [];
    let position = image.offset(rva);
    const end = position + size;
    const relocations = [];
    while (position < end) {
        const page = checkedU32(image.data, position);
        const blockSize = checkedU32(image.data, position + 4);
        if (blockSize === 0) break;
        const entryCount = Math.floor((blockSize - 8) / 2);
        if (position + 8 + 2 * entryCount > image.data.length) {
            throw new Error(`relocation block at ${position} runs past the end of the file`);
        }
        const entries = [];
        for (let index = 0; index < entryCount; index++) entries.push(u16(image.data, position + 8 + 2 * index));
        let index = 0;
        while (index < entries.length) {
            const kind = entries[index] >> 12;
            const site = page + (entries[index] & 0xfff);
            if (kind === REL_HIGHADJ) {
                index++;
                relocations.push({ kind, site, parameter: entries[index] });
            } else if (kind !== REL_ABSOLUTE) {
                relocations.push({ kind, site, parameter: null });
            }
            index++;
        }
        position += blockSize;
    }
    return relocations;
}

function pairLows(image, relocations) {
    const highSites = relocations.filter((relocation) => relocation.kind === REL_HIGHADJ);
    let highs = null;
    const pairs = new Map();
    for (const { kind, site } of relocations) {
        if (kind !== REL_LOW) continue;
        const instruction = image.read32(site);
        const baseRegister = (instruction >>> 21) & 31;
        const immediate = instruction & 0xffff;
        if (highs === null) {
            highs = highSites.map(({ site: highSite, parameter }) => ({
                highSite,
                parameter,
                register: (image.read32(highSite) >>> 16) & 31,
            }));
        }
        let best = null;
        for (const { highSite, parameter, register } of highs) {
            if (register !== baseRegister) continue;
            const mismatch = parameter !== immediate ? 1 : 0;
            const distance = Math.abs(site - highSite);
            if (best === null || mismatch < best.mismatch || (mismatch === best.mismatch && distance < best.distance)) {
                best = { mismatch, distance, highSite };
            }
        }
        if (best === null) throw new Error(`no lui for low relocation at ${hex(site)}`);
        pairs.set(site, best.highSite);
    }
    return pairs;
}

function applyRelocations(image, relocations) {
    const pairs = pairLows(image, relocations);
    const originals = new Map();
    for (const { site } of relocations) originals.set(site, image.read32(site));
    const highDelta = new Map();
    const newRelocations = [];
    for (const { kind, site, parameter } of relocations) {
        if (kind !== REL_HIGHADJ) continue;
        const lui = originals.get(site);
        const target = (lui & 0xffff) * 0x10000 + sign16(parameter);
        const newTarget = image.mapVa(target >>> 0);
        highDelta.set(site, newTarget - target);
        image.write32(site, ((lui & 0xffff0000) | (((newTarget + 0x8000) >>> 16) & 0xffff)) >>> 0);
        newRelocations.push({ kind, site: image.mapRva(site), parameter: newTarget & 0xffff });
    }
    for (const { kind, site } of relocations) {
        const instruction = originals.get(site);
        if (kind === REL_HIGHLOW) {
            image.write32(site, image.mapVa(instruction));
        } else if (kind === REL_JMPADDR) {
            const siteVa = image.imageBase + site;
            const target = (((siteVa + 4) & 0xf0000000) | ((instruction & 0x03ffffff) << 2)) >>> 0;
            const newTarget = image.mapVa(target);
            const newSiteVa = image.imageBase + image.mapRva(site);
            if ((newTarget ^ (newSiteVa + 4)) & 0xf0000000) {
                throw new Error(`jump at ${hex(site)} leaves its 256 MB region`);
            }
            image.write32(site, ((instruction & 0xfc000000) | ((newTarget >>> 2) & 0x03ffffff)) >>> 0);
        } else if (kind === REL_LOW) {
            const highSite = pairs.get(site);
            const delta = highDelta.get(highSite);
            const oldHigh = originals.get(highSite) & 0xffff;
            const newHigh = image.read32(highSite) & 0xffff;
            const immediate = instruction & 0xffff;
            const oldFull = oldHigh * 0x10000 + sign16(immediate);
            const newImmediate = (immediate + delta) & 0xffff;
            if ((newHigh * 0x10000 + sign16(newImmediate) - (oldFull + delta)) >>> 0) {
                throw new Error(`low at ${hex(site)} does not fit its lui at ${hex(highSite)}`);
            }
            image.write32(site, ((instruction & 0xffff0000) | newImmediate) >>> 0);
        } else if (kind === REL_HIGHADJ) {
            continue;
        } else {
            throw new Error(`relocation type ${kind} at ${hex(site)}`);
        }
        newRelocations.push({ kind, site: image.mapRva(site), parameter: null });
    }
    return newRelocations;
}

function compareEntries(left, right) {
    if (left.site !== right.site) return left.site - right.site;
    if (left.kind !== right.kind) return left.kind - right.kind;
    if (left.parameter === right.parameter) return 0;
    if (left.parameter === null) return -1;
    if (right.parameter === null) return 1;
    return left.parameter - right.parameter;
}

function encodeRelocations(relocations) {
    const pages = new Map();
    for (const relocation of relocations) {
        const page = relocation.site - (relocation.site % PAGE);
        if (!pages.has(page)) pages.set(page, []);
        pages.get(page).push(relocation);
    }
    const blocks = [];
    let totalSize = 0;
    for (const page of [...pages.keys()].sort((left, right) => left - right)) {
        const entries = [];
        for (const { site, kind, parameter } of pages.get(page).sort(compareEntries)) {
            entries.push((kind << 12) | (site - page));
            if (kind === REL_HIGHADJ) entries.push(parameter);
        }
        if (entries.length % 2) entries.push(0);
        const block = new Uint8Array(8 + 2 * entries.length);
        setU32(block, 0, page);
        setU32(block, 4, block.length);
        entries.forEach((entry, index) => {
            block[8 + 2 * index] = entry & 0xff;
            block[9 + 2 * index] = (entry >>> 8) & 0xff;
        });
        blocks.push(block);
        totalSize += block.length;
    }
    const output = new Uint8Array(totalSize);
    let position = 0;
    for (const block of blocks) {
        output.set(block, position);
        position += block.length;
    }
    return output;
}

function fixImports(image) {
    const [rva] = image.directory(1);
    if (!rva) return;
    let descriptor = rva;
    while (true) {
        const offset = image.offset(descriptor);
        const lookup = checkedU32(image.data, offset);
        const name = checkedU32(image.data, offset + 12);
        const address = checkedU32(image.data, offset + 16);
        if (!name) break;
        for (const table of new Set([lookup, address].filter((table) => table !== 0))) {
            let entry = table;
            while (true) {
                const value = image.read32(entry);
                if (!value) break;
                if (!(value & 0x80000000)) image.write32(entry, image.mapRva(value));
                entry += 4;
            }
        }
        for (const field of [0, 12, 16]) image.mapField(descriptor + field);
        descriptor += 20;
    }
}

function fixExports(image) {
    const [rva] = image.directory(0);
    if (!rva) return;
    const offset = image.offset(rva) + 20;
    const functionCount = checkedU32(image.data, offset);
    const nameCount = checkedU32(image.data, offset + 4);
    const functions = checkedU32(image.data, offset + 8);
    const names = checkedU32(image.data, offset + 12);
    for (let index = 0; index < functionCount; index++) image.mapField(functions + 4 * index);
    for (let index = 0; index < nameCount; index++) image.mapField(names + 4 * index);
    for (const field of [12, 28, 32, 36]) image.mapField(rva + field);
}

function fixResources(image) {
    const [rva] = image.directory(2);
    if (!rva) return;
    const walk = (directory) => {
        const header = image.offset(rva + directory) + 12;
        const named = u16(image.data, header);
        const numbered = u16(image.data, header + 2);
        for (let index = 0; index < named + numbered; index++) {
            const entry = image.offset(rva + directory) + 16 + 8 * index;
            const target = checkedU32(image.data, entry + 4);
            if (target & 0x80000000) {
                walk(target & 0x7fffffff);
            } else {
                image.mapField(rva + target);
            }
        }
    };
    walk(0);
}

export function realign(data) {
    const image = new RealignImage(data);
    const optional = image.optional;
    const sectionAlignment = checkedU32(image.data, optional + 32);
    if (sectionAlignment >= PAGE) return null;
    let nextVa = align(image.sections[0].oldVa, PAGE);
    for (const section of image.sections) {
        section.newVa = nextVa;
        nextVa = align(section.newVa + Math.max(section.virtualSize, section.rawSize), PAGE);
    }
    let sizeOfImage = nextVa;

    if (!image.directory(5)[0]) throw new Error("relocations stripped: sections can't be moved to 4 KB pages");
    const relocSection = image.sectionForOld(image.directory(5)[0]);
    const relocations = readRelocations(image);
    const newRelocations = applyRelocations(image, relocations);
    fixImports(image);
    fixExports(image);
    fixResources(image);

    for (const field of [16, 20, 24]) {
        const value = checkedU32(image.data, optional + field);
        if (value) checkedSetU32(image.data, optional + field, image.mapRva(value));
    }
    for (let index = 0; index < image.directoryCount; index++) {
        const [rva, size] = image.directory(index);
        if (rva && index !== 4) image.setDirectory(index, image.mapRva(rva), size);
    }
    checkedSetU32(image.data, optional + 32, PAGE);
    checkedSetU32(image.data, optional + 56, sizeOfImage);
    checkedSetU32(image.data, optional + 64, 0);

    const encoded = encodeRelocations(newRelocations);
    const fileAlignment = checkedU32(image.data, optional + 36);
    const rawSize = align(encoded.length, fileAlignment);
    if (relocSection !== image.sections[image.sections.length - 1]) throw new Error(".reloc is not the last section");
    const kept = Math.min(relocSection.rawPointer, image.data.length);
    const output = new Uint8Array(kept + rawSize);
    output.set(image.data.subarray(0, kept));
    output.set(encoded, kept);
    image.data = output;
    relocSection.virtualSize = encoded.length;
    relocSection.rawSize = rawSize;
    image.setDirectory(5, relocSection.newVa, encoded.length);
    sizeOfImage = align(relocSection.newVa + encoded.length, PAGE);
    checkedSetU32(image.data, optional + 56, sizeOfImage);

    for (const section of image.sections) {
        checkedSetU32(image.data, section.header + 8, section.virtualSize);
        checkedSetU32(image.data, section.header + 12, section.newVa);
        checkedSetU32(image.data, section.header + 16, section.rawSize);
    }
    return image.data;
}

function virtualWords(image, key) {
    const memory = new Map();
    for (const section of image.sections) {
        if (section.name === ".reloc") continue;
        const base = section[key];
        const start = Math.min(section.rawPointer, image.data.length);
        const end = Math.min(section.rawPointer + section.rawSize, image.data.length);
        const length = end - start;
        for (let offset = 0; offset < length - 3; offset += 4) memory.set(base + offset, u32(image.data, start + offset));
    }
    return memory;
}

function rewrittenRanges(image) {
    const ranges = [];
    for (const index of [0, 1, 2, 12]) {
        const [rva, size] = image.directory(index);
        if (rva) ranges.push([rva, rva + size]);
    }
    const [importRva] = image.directory(1);
    if (importRva) {
        let descriptor = importRva;
        while (true) {
            const offset = image.offset(descriptor);
            const originalThunk = checkedU32(image.data, offset);
            const nameRva = checkedU32(image.data, offset + 12);
            const firstThunk = checkedU32(image.data, offset + 16);
            if (!nameRva) break;
            for (const thunk of [originalThunk, firstThunk]) {
                if (!thunk) continue;
                let end = thunk;
                while (checkedU32(image.data, image.offset(end))) end += 4;
                ranges.push([thunk, end + 4]);
            }
            descriptor += 20;
        }
    }
    return ranges;
}

export function verifyRealign(oldData, newData) {
    const old = new RealignImage(oldData);
    const updated = new RealignImage(newData);
    const pairedCount = Math.min(old.sections.length, updated.sections.length);
    for (let index = 0; index < pairedCount; index++) old.sections[index].newVa = updated.sections[index].oldVa;
    const relocations = readRelocations(old);
    const sites = new Set(relocations.map((relocation) => relocation.site));
    const oldMemory = virtualWords(old, "oldVa");
    const newMemory = virtualWords(updated, "oldVa");
    const newAdjust = new Map();
    for (const { kind, site, parameter } of readRelocations(updated)) {
        if (kind === REL_HIGHADJ) newAdjust.set(site, parameter);
    }
    let bad = 0;
    for (const { kind, site, parameter } of relocations) {
        const newSite = old.mapRva(site);
        const before = oldMemory.get(site);
        const after = newMemory.get(newSite);
        if (before === undefined || after === undefined) continue;
        if (kind === REL_HIGHLOW && after !== old.mapVa(before)) bad++;
        if (kind === REL_HIGHADJ) {
            const newTarget = (after & 0xffff) * 0x10000 + sign16(newAdjust.get(newSite) ?? 0);
            const oldTarget = (before & 0xffff) * 0x10000 + sign16(parameter);
            if (newTarget !== old.mapVa(oldTarget)) bad++;
        }
        if (kind === REL_JMPADDR) {
            const newTarget = (((old.imageBase + newSite + 4) & 0xf0000000) | ((after & 0x3ffffff) << 2)) >>> 0;
            const oldTarget = (((old.imageBase + site + 4) & 0xf0000000) | ((before & 0x3ffffff) << 2)) >>> 0;
            if (newTarget !== old.mapVa(oldTarget)) bad++;
        }
    }
    const allowed = rewrittenRanges(old);
    let changedOutside = 0;
    for (const [rva, value] of oldMemory) {
        if (sites.has(rva)) continue;
        const section = old.sectionForOld(rva);
        if (section && [".idata", ".rsrc", ".edata"].includes(section.name)) continue;
        if (allowed.some(([start, end]) => start <= rva && rva < end)) continue;
        if (newMemory.get(old.mapRva(rva)) !== value) changedOutside++;
    }
    return { bad, changedOutside, relocations: relocations.length };
}

export function tryRealign(data, parsedPe) {
    if (parsedPe.relocsStripped || !parsedPe.hasReloc) {
        return { ok: false, message: "no base relocations, realign.py cannot move sections" };
    }
    let result;
    try {
        result = realign(data);
    } catch (error) {
        return { ok: false, message: `realign.py failed: ${error.message}` };
    }
    if (result === null) return { ok: true, message: "already aligned" };
    let verification;
    try {
        verification = verifyRealign(data, result);
    } catch (error) {
        return { ok: false, message: `realign verification failed: ${error.message}` };
    }
    const { bad, changedOutside, relocations } = verification;
    if (bad || changedOutside) {
        return { ok: false, message: `realign verification: ${bad} bad relocations, ${changedOutside} unexpected word changes` };
    }
    return { ok: true, message: `realign.py verified (${relocations} relocations)` };
}
