import { inflateRaw } from "./inflate.js";
import { u32 } from "../pe/pe.js";

const SIGNATURE = 0xdeadbeef;
const MAGIC = [0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74];
const FIRST_HEADER_SIZE = 28;
const COMPRESSED = 0x80000000;
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

function readBlock(data, position, end) {
    if (position + 4 > end) return null;
    const word = u32(data, position);
    const length = word & ~COMPRESSED;
    const start = position + 4;
    if (start + length > end) return null;
    if (!(word & COMPRESSED)) return { data: data.slice(start, start + length), next: start + length };
    const result = inflateRaw(data, { start, end: start + length, nsisStored: true });
    if (result.error) throw new Error(`NSIS block: ${result.error}`);
    return { data: result.output, next: start + length };
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

export function readNsis(data, offset) {
    if (!isFirstHeader(data, offset)) return null;
    const headerLength = u32(data, offset + 20);
    const end = Math.min(data.length, offset + u32(data, offset + 24));
    const header = readBlock(data, offset + FIRST_HEADER_SIZE, end);
    if (!header || header.data.length !== headerLength) return null;
    const names = tryExtractedNames(header.data);
    const members = [];
    const dataStart = header.next;
    for (let position = dataStart; ;) {
        const block = readBlock(data, position, end);
        if (!block) break;
        const dataOffset = position - dataStart;
        members.push({ name: names.get(dataOffset) || `block at 0x${dataOffset.toString(16)}`, data: block.data });
        position = block.next;
    }
    return members;
}
