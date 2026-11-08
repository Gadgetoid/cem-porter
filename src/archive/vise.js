import { inflateRaw } from "./inflate.js";
import { latin1Decode, u16, u32 } from "../pe/pe.js";

const SIGNATURE = [0x45, 0x53, 0x49, 0x56];
const TRAILER_SIZE = 8;
const RECORD_FIELDS_SIZE = 20;
const MAX_NAME_LENGTH = 255;

function hasSignature(data, offset) {
    return offset >= 0 && SIGNATURE.every((byte, index) => data[offset + index] === byte);
}

function archiveStart(data) {
    if (data.length < TRAILER_SIZE || !hasSignature(data, data.length - TRAILER_SIZE)) return -1;
    const start = u32(data, data.length - 4);
    return start < data.length - TRAILER_SIZE && hasSignature(data, start) ? start : -1;
}

export function isVise(data) {
    return archiveStart(data) >= 0;
}

function isNameByte(byte) {
    return byte >= 0x20 && byte < 0x7f;
}

function recordAt(data, start, position) {
    const nameLength = u16(data, position);
    if (!nameLength || nameLength > MAX_NAME_LENGTH) return null;
    const fields = position + 2 + nameLength;
    if (fields + RECORD_FIELDS_SIZE > data.length) return null;
    for (let index = position + 2; index < fields; index++) if (!isNameByte(data[index])) return null;
    if (u32(data, fields) !== 0) return null;
    const size = u32(data, fields + 4);
    const compressedSize = u32(data, fields + 8);
    const offset = start + u32(data, fields + 16);
    if (!size || !compressedSize || offset + compressedSize > data.length - TRAILER_SIZE) return null;
    return { name: latin1Decode(data.subarray(position + 2, fields)), size, compressedSize, offset };
}

function wordSwapped(data, offset, length) {
    const swapped = data.slice(offset, offset + length + (length % 2));
    for (let index = 1; index < swapped.length; index += 2) {
        const first = swapped[index - 1];
        swapped[index - 1] = swapped[index];
        swapped[index] = first;
    }
    return swapped;
}

function expand(data, record) {
    const result = inflateRaw(wordSwapped(data, record.offset, record.compressedSize), { maxOutput: record.size, wordAligned: true });
    return result.finished && result.output.length === record.size ? result.output : null;
}

export function readVise(data) {
    const start = archiveStart(data);
    if (start < 0) throw new Error("Not an Installer VISE archive");
    const members = [];
    const seen = new Set();
    for (let position = start; position + 2 + RECORD_FIELDS_SIZE < data.length; position++) {
        const record = recordAt(data, start, position);
        if (!record || seen.has(record.offset)) continue;
        const expanded = expand(data, record);
        if (!expanded) continue;
        seen.add(record.offset);
        members.push({ name: record.name, data: expanded });
    }
    return members;
}
