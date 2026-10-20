import { Image, align, u32, setU16, setU32 } from "./pe.js";

export const SHIM_DLL = "VELOSHIM.DLL";

export const RENAMES = {
    FindResourceW: "FindResource",
    CeOpenDatabase: "PegOpenDatabase",
    CeOidGetInfo: "PegOidGetInfo",
};

export const SHIMMED = new Set([
    "MultiByteToWideChar", "WideCharToMultiByte", "IsDBCSLeadByte", "towlower", "towupper", "GetDiskFreeSpaceExW",
    "ImmGetContext", "ImmReleaseContext", "ImmSetOpenStatus", "ImmSimulateHotKey", "ImmAssociateContext",
    "CreateFileMappingW", "MapViewOfFile",
]);

const utf8 = new TextEncoder();

export function readDescriptors(image) {
    const [importRva] = image.directory(1);
    const descriptors = [];
    if (!importRva) return descriptors;
    let position = importRva;
    while (true) {
        const offset = image.offset(position);
        const descriptor = [0, 4, 8, 12, 16].map((field) => u32(image.data, offset + field));
        if (!descriptor[3]) break;
        descriptors.push(descriptor);
        position += 20;
    }
    return descriptors;
}

export class ImportSection {
    constructor(image, descriptorCount) {
        this.image = image;
        const sectionEnds = image.sections.map((section) => section.virtualAddress + Math.max(section.virtualSize, section.rawSize));
        this.sectionVa = align(Math.max(...sectionEnds), image.sectionAlignment);
        this.descriptorArea = 20 * (descriptorCount + 1);
        this.strings = [];
    }

    nextRva() {
        return this.sectionVa + this.descriptorArea + this.strings.length;
    }

    padStrings(multiple) {
        while (this.strings.length % multiple) this.strings.push(0);
    }

    hintName(name) {
        const rva = this.nextRva();
        this.strings.push(0, 0, ...utf8.encode(name), 0);
        this.padStrings(2);
        return rva;
    }

    dllName(name) {
        const rva = this.nextRva();
        this.strings.push(...utf8.encode(name), 0);
        this.padStrings(4);
        return rva;
    }

    finish(descriptors, dll, redirects) {
        const image = this.image;
        const newDescriptors = [];
        const lookupArea = [];
        if (redirects.length) {
            const dllNameRva = this.dllName(dll);
            const hintRvas = redirects.map(([name, slot]) => [this.hintName(name), slot]);
            this.padStrings(4);
            const lookupStart = this.nextRva();
            for (const [hintRva, slot] of hintRvas) {
                const lookupRva = lookupStart + 4 * lookupArea.length;
                lookupArea.push(hintRva, 0);
                newDescriptors.push([lookupRva, 0, 0, dllNameRva, slot]);
            }
        }
        const allDescriptors = [...descriptors, ...newDescriptors];
        const contents = new Uint8Array(this.descriptorArea + this.strings.length + 4 * lookupArea.length);
        allDescriptors.forEach((descriptor, index) => {
            descriptor.forEach((value, field) => setU32(contents, 20 * index + 4 * field, value));
        });
        contents.set(this.strings, this.descriptorArea);
        lookupArea.forEach((value, index) => setU32(contents, this.descriptorArea + this.strings.length + 4 * index, value));

        const tableEnd = image.sectionTable + 40 * image.sectionCount;
        const rawOffsets = image.sections.map((section) => section.rawOffset).filter((rawOffset) => rawOffset);
        if (!rawOffsets.length) throw new Error("no section with raw data");
        if (tableEnd + 40 > image.headersSize || tableEnd + 40 > Math.min(...rawOffsets)) {
            throw new Error("no room for another section header");
        }
        const rawOffset = align(image.data.length, image.fileAlignment);
        const rawSize = align(contents.length, image.fileAlignment);
        const output = new Uint8Array(rawOffset + rawSize);
        output.set(image.data);
        output.set(contents, rawOffset);

        output.fill(0, tableEnd, tableEnd + 40);
        output.set(utf8.encode(".vshim"), tableEnd);
        setU32(output, tableEnd + 8, contents.length);
        setU32(output, tableEnd + 12, this.sectionVa);
        setU32(output, tableEnd + 16, rawSize);
        setU32(output, tableEnd + 20, rawOffset);
        setU32(output, tableEnd + 36, 0x40000040);
        setU16(output, image.pe + 6, image.sectionCount + 1);
        setU32(output, image.optional + 56, align(this.sectionVa + contents.length, image.sectionAlignment));
        setU32(output, image.optional + 64, 0);
        setU32(output, image.optional + 104, this.sectionVa);
        setU32(output, image.optional + 108, 20 * allDescriptors.length);
        return output;
    }
}

export function shim(data) {
    const image = new Image(data);
    const descriptors = readDescriptors(image);
    if (!descriptors.length) return { data: null, changes: [] };
    const renames = [];
    const redirects = [];
    for (const [originalThunk, , , nameRva, firstThunk] of descriptors) {
        if (image.cString(nameRva).toLowerCase() !== "coredll.dll") continue;
        const namesRva = originalThunk || firstThunk;
        for (let index = 0; ; index++) {
            const entry = image.word(namesRva + 4 * index);
            if (!entry) break;
            if (entry & 0x80000000) continue;
            const name = image.cString(entry + 2);
            if (Object.hasOwn(RENAMES, name)) {
                const boundSlot = originalThunk ? firstThunk + 4 * index : null;
                renames.push({ name, lookupSlot: namesRva + 4 * index, boundSlot });
            } else if (SHIMMED.has(name)) {
                redirects.push([name, firstThunk + 4 * index]);
            }
        }
    }
    if (!renames.length && !redirects.length) return { data: null, changes: [] };
    const section = new ImportSection(image, descriptors.length + redirects.length);
    for (const { name, lookupSlot, boundSlot } of renames) {
        const newRva = section.hintName(RENAMES[name]);
        image.setWord(lookupSlot, newRva);
        if (boundSlot !== null) image.setWord(boundSlot, newRva);
    }
    const patched = section.finish(descriptors, SHIM_DLL, redirects);
    const changes = [
        ...renames.map(({ name }) => [name, RENAMES[name]]),
        ...redirects.map(([name]) => [name, SHIM_DLL]),
    ];
    return { data: patched, changes };
}

export function redirect(data, dll, redirects) {
    if (!redirects.length) return null;
    const image = new Image(data);
    const descriptors = readDescriptors(image);
    return new ImportSection(image, descriptors.length + redirects.length).finish(descriptors, dll, redirects);
}
