import { align, readSections, rvaToOffset, setU16, setU32, u16, u32 } from "../pe/pe.js";

export const MACHINE_MIPS16 = 0x266;
export const MIPS16_EXTENSION = ".m16";

const MACHINE_MIPS = 0x166;
const RELOCATION_JUMP16 = 9;
const STUB_COUNT = 64;
const SECTION_HEADER_SIZE = 40;
const EXPORT_DIRECTORY_SIZE = 40;

function headers(data) {
    const pe = u32(data, 0x3c);
    const optional = pe + 24;
    return { pe, optional, sections: readSections(data) };
}

function directory(data, index) {
    const { optional } = headers(data);
    return [u32(data, optional + 96 + 8 * index), u32(data, optional + 100 + 8 * index)];
}

export function isMips16(data) {
    return data.length > 0x40 && data[0] === 0x4d && data[1] === 0x5a && u16(data, u32(data, 0x3c) + 4) === MACHINE_MIPS16;
}

export function patchMips16Machine(data) {
    const copy = new Uint8Array(data);
    if (isMips16(copy)) setU16(copy, u32(copy, 0x3c) + 4, MACHINE_MIPS);
    return copy;
}

export function hasMips16Jumps(data) {
    const { sections } = headers(data);
    const [rva, size] = directory(data, 5);
    if (!rva) return false;
    const start = rvaToOffset(sections, rva);
    for (let block = start; block + 8 <= start + size;) {
        const blockSize = u32(data, block + 4);
        if (blockSize < 8) break;
        for (let entry = block + 8; entry < block + blockSize; entry += 2) {
            if (u16(data, entry) >> 12 === RELOCATION_JUMP16) return true;
        }
        block += blockSize;
    }
    return false;
}

export function needsMips16Loader(data) {
    if (!isMips16(data)) return false;
    const { pe } = headers(data);
    return (u16(data, pe + 22) & 0x2000) !== 0 && hasMips16Jumps(data);
}

function readExports(data) {
    const { sections } = headers(data);
    const [rva] = directory(data, 0);
    if (!rva) return null;
    const at = rvaToOffset(sections, rva);
    const offset = (value) => rvaToOffset(sections, value);
    const text = (value) => {
        let result = "";
        for (let position = offset(value); data[position]; position++) result += String.fromCharCode(data[position]);
        return result;
    };
    const base = u32(data, at + 16);
    const functions = u32(data, at + 20);
    const namedCount = u32(data, at + 24);
    const functionTable = offset(u32(data, at + 28));
    const nameTable = offset(u32(data, at + 32));
    const ordinalTable = offset(u32(data, at + 36));
    const names = [];
    for (let index = 0; index < namedCount; index++) {
        names.push({ name: text(u32(data, nameTable + 4 * index)), index: u16(data, ordinalTable + 2 * index) });
    }
    const addresses = [];
    for (let index = 0; index < functions; index++) addresses.push(u32(data, functionTable + 4 * index));
    return { dllName: text(u32(data, at + 12)), base, addresses, names };
}

function encode(text) {
    return Uint8Array.from([...text].map((character) => character.charCodeAt(0) & 0xff).concat([0]));
}

export function mips16StandIn(loader, dll) {
    const real = readExports(dll);
    if (!real) throw new Error("the MIPS16 DLL has no exports");
    if (real.addresses.length > STUB_COUNT) throw new Error(`the MIPS16 DLL has ${real.addresses.length} exports, the loader forwards at most ${STUB_COUNT}`);
    const stubs = readExports(loader);
    const { pe, optional, sections } = headers(loader);
    const sectionAlignment = u32(loader, optional + 32);
    const fileAlignment = u32(loader, optional + 36);
    const headerEnd = u32(loader, optional + 60);
    const tableEnd = pe + 24 + u16(loader, pe + 20) + SECTION_HEADER_SIZE * sections.length;
    if (tableEnd + SECTION_HEADER_SIZE > headerEnd) throw new Error("no room for another section header in the loader");

    const virtualAddress = align(Math.max(...sections.map((section) => section.virtualAddress + Math.max(section.virtualSize, section.rawSize))), sectionAlignment);
    const named = [...real.names].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const functionsAt = EXPORT_DIRECTORY_SIZE;
    const namesAt = functionsAt + 4 * real.addresses.length;
    const ordinalsAt = namesAt + 4 * named.length;
    const stringsAt = align(ordinalsAt + 2 * named.length, 4);
    const strings = [encode(real.dllName), ...named.map((entry) => encode(entry.name))];
    const stringOffsets = [];
    let size = stringsAt;
    for (const string of strings) {
        stringOffsets.push(size);
        size += string.length;
    }
    const contents = new Uint8Array(size);
    setU32(contents, 12, virtualAddress + stringOffsets[0]);
    setU32(contents, 16, real.base);
    setU32(contents, 20, real.addresses.length);
    setU32(contents, 24, named.length);
    setU32(contents, 28, virtualAddress + functionsAt);
    setU32(contents, 32, virtualAddress + namesAt);
    setU32(contents, 36, virtualAddress + ordinalsAt);
    real.addresses.forEach((address, index) => setU32(contents, functionsAt + 4 * index, address ? stubs.addresses[index] : 0));
    named.forEach((entry, index) => {
        setU32(contents, namesAt + 4 * index, virtualAddress + stringOffsets[index + 1]);
        setU16(contents, ordinalsAt + 2 * index, entry.index);
    });
    strings.forEach((string, index) => contents.set(string, stringOffsets[index]));

    const rawOffset = align(loader.length, fileAlignment);
    const rawSize = align(contents.length, fileAlignment);
    const output = new Uint8Array(rawOffset + rawSize);
    output.set(loader);
    output.set(contents, rawOffset);
    output.fill(0, tableEnd, tableEnd + SECTION_HEADER_SIZE);
    output.set(encode(".edata16").subarray(0, 8), tableEnd);
    setU32(output, tableEnd + 8, contents.length);
    setU32(output, tableEnd + 12, virtualAddress);
    setU32(output, tableEnd + 16, rawSize);
    setU32(output, tableEnd + 20, rawOffset);
    setU32(output, tableEnd + 36, 0x40000040);
    setU16(output, pe + 6, sections.length + 1);
    setU32(output, optional + 56, align(virtualAddress + contents.length, sectionAlignment));
    setU32(output, optional + 64, 0);
    setU32(output, optional + 96, virtualAddress);
    setU32(output, optional + 100, contents.length);
    return output;
}
