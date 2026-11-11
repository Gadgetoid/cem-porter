import { nsisBzip2Decode } from "./bzip2.js";
import { inflateRaw } from "./inflate.js";
import { bcjX86Decode, lzmaDecodeUnsized } from "./lzma.js";
import { u32 } from "../pe/pe.js";

const SIGNATURE = 0xdeadbeef;
const MAGIC = [0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74];
const FIRST_HEADER_SIZE = 28;
const COMPRESSED = 0x80000000;
const LZMA_PROPERTIES = 0x5d;
const MIN_DICTIONARY = 1 << 12;
const BZIP2_BLOCK = 0x31;
const ALIGNMENT = 512;
const BLOCK_ENTRIES = 2;
const BLOCK_STRINGS = 3;
const ENTRY_SIZE = 28;
const EW_EXTRACTFILE = 20;
const SKIP_CODE = 0xfc;
const FIRST_CODE = 0xfd;

function isFirstHeader(data, offset) {
    return offset + FIRST_HEADER_SIZE <= data.length
        && u32(data, offset + 4) === SIGNATURE
        && MAGIC.every((byte, index) => data[offset + 8 + index] === byte);
}

export function findNsis(data, start) {
    for (let offset = Math.ceil(start / ALIGNMENT) * ALIGNMENT; offset + FIRST_HEADER_SIZE <= data.length; offset += ALIGNMENT) {
        if (isFirstHeader(data, offset)) return offset;
    }
    return -1;
}

function isLzma(data, offset) {
    const dictionary = u32(data, offset + 1);
    return data[offset] === LZMA_PROPERTIES && dictionary >= MIN_DICTIONARY && (dictionary & (dictionary - 1)) === 0;
}

function detectMethod(data, offset) {
    if (offset + 6 > data.length) return null;
    if (isLzma(data, offset)) return { name: "LZMA", filter: false };
    if (data[offset] <= 1 && isLzma(data, offset + 1)) return { name: "LZMA", filter: true };
    if (data[offset] === BZIP2_BLOCK && data[offset + 1] < 14) return { name: "bzip2" };
    return null;
}

function decompress(data, start, end, method) {
    if (method.name === "LZMA") {
        const output = lzmaDecodeUnsized(data, start + (method.filter ? 1 : 0), end);
        return method.filter && data[start] ? bcjX86Decode(Uint8Array.from(output)) : output;
    }
    if (method.name === "bzip2") return nsisBzip2Decode(data, start, end);
    const result = inflateRaw(data, { start, end, nsisStored: true });
    if (result.error) throw new Error(`NSIS block: ${result.error}`);
    return result.output;
}

function readBlock(data, position, end, method) {
    if (position + 4 > end) return null;
    const word = u32(data, position);
    const length = word & ~COMPRESSED;
    const start = position + 4;
    if (start + length > end) return null;
    if (!(word & COMPRESSED)) return { data: data.slice(start, start + length), next: start + length };
    return { data: decompress(data, start, start + length, method), next: start + length };
}

function readStoredBlock(data, position) {
    if (position + 4 > data.length) return null;
    const length = u32(data, position);
    const start = position + 4;
    if (start + length > data.length) return null;
    return { data: data.subarray(start, start + length), next: start + length };
}

function nsisString(header, offset) {
    let text = "";
    for (let position = offset; position < header.length && header[position]; position++) {
        const byte = header[position];
        if (byte === SKIP_CODE) {
            text += String.fromCharCode(header[++position]);
        } else if (byte >= FIRST_CODE) {
            text += "\\";
            position += 2;
        } else {
            text += String.fromCharCode(byte);
        }
    }
    return text;
}

function extractedNames(header) {
    const names = new Map();
    const entriesOffset = u32(header, 4 + BLOCK_ENTRIES * 8);
    const entryCount = u32(header, 4 + BLOCK_ENTRIES * 8 + 4);
    const stringsOffset = u32(header, 4 + BLOCK_STRINGS * 8);
    for (let index = 0; index < entryCount; index++) {
        const entry = entriesOffset + index * ENTRY_SIZE;
        if (entry + ENTRY_SIZE > header.length) break;
        if (u32(header, entry) !== EW_EXTRACTFILE) continue;
        const name = nsisString(header, stringsOffset + u32(header, entry + 8)).replace(/"/g, "").split("\\").pop();
        const dataOffset = u32(header, entry + 12);
        if (name && !names.has(dataOffset)) names.set(dataOffset, name);
    }
    return names;
}

function tryExtractedNames(header) {
    try {
        return extractedNames(header);
    } catch {
        return new Map();
    }
}

function readSolid(data, start, end, headerLength, method) {
    let stream;
    try {
        stream = decompress(data, start, end, method);
    } catch {
        return null;
    }
    const header = readStoredBlock(stream, 0);
    if (!header || header.data.length !== headerLength) return null;
    return { header: header.data, dataStart: header.next, readBlock: (position) => readStoredBlock(stream, position) };
}

function readSeparate(data, start, end, headerLength) {
    const method = (u32(data, start) & COMPRESSED && detectMethod(data, start + 4)) || { name: "Deflate" };
    const header = readBlock(data, start, end, method);
    if (!header || header.data.length !== headerLength) return null;
    return { header: header.data, dataStart: header.next, readBlock: (position) => readBlock(data, position, end, method) };
}

export function readNsis(data, offset) {
    if (!isFirstHeader(data, offset)) return null;
    const headerLength = u32(data, offset + 20);
    const end = Math.min(data.length, offset + u32(data, offset + 24));
    const start = offset + FIRST_HEADER_SIZE;
    const word = u32(data, start);
    const solidMethod = word === headerLength ? null : detectMethod(data, start);
    const archive = (solidMethod && readSolid(data, start, end, headerLength, solidMethod))
        || readSeparate(data, start, end, headerLength)
        || (word === headerLength ? null : readSolid(data, start, end, headerLength, { name: "Deflate" }));
    if (!archive) return null;
    const names = tryExtractedNames(archive.header);
    const members = [];
    for (let position = archive.dataStart; ;) {
        const block = archive.readBlock(position);
        if (!block) break;
        const dataOffset = position - archive.dataStart;
        members.push({ name: names.get(dataOffset) || `block at 0x${dataOffset.toString(16)}`, data: block.data });
        position = block.next;
    }
    return members;
}
