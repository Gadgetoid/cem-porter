import { inflateSync } from "../vendor/fflate.js";
import { inflateRaw } from "./inflate.js";
import { latin1Decode, u16, u32 } from "./pe.js";

const LOCAL_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;
const MAX_EXTRACT_VERSION = 63;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_COMPRESSED_PATCH = 0x0020;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;

const CP437_HIGH = [
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
    0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
    0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
    0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
    0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];
const CP437_ENCODE = new Map(CP437_HIGH.map((codePoint, index) => [codePoint, 0x80 + index]));
const CP932_SINGLE_BYTES = { 0x80: 0x0080, 0xa0: 0xf8f0, 0xfd: 0xf8f1, 0xfe: 0xf8f2, 0xff: 0xf8f3 };

const utf8 = new TextDecoder("utf-8", { fatal: true });
const shiftJis = new TextDecoder("shift_jis", { fatal: true });

export class BadZipFile extends Error {}

export class UnsupportedZip extends Error {}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();

export function crc32(data) {
    let crc = 0xffffffff;
    for (let index = 0; index < data.length; index++) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

export function decodeCp437(bytes) {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte < 0x80 ? byte : CP437_HIGH[byte - 0x80]);
    return text;
}

function encodeCp437(text) {
    const bytes = [];
    for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint < 0x80) bytes.push(codePoint);
        else if (CP437_ENCODE.has(codePoint)) bytes.push(CP437_ENCODE.get(codePoint));
        else return null;
    }
    return Uint8Array.from(bytes);
}

function isShiftJisLead(byte) {
    return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

export function decodeCp932(bytes) {
    let text = "";
    let index = 0;
    while (index < bytes.length) {
        const byte = bytes[index];
        if (byte in CP932_SINGLE_BYTES) {
            text += String.fromCharCode(CP932_SINGLE_BYTES[byte]);
            index++;
        } else if (isShiftJisLead(byte)) {
            text += shiftJis.decode(bytes.subarray(index, index + 2));
            index += 2;
        } else {
            text += shiftJis.decode(bytes.subarray(index, index + 1));
            index++;
        }
    }
    return text;
}

export function tryDecodeCp932(bytes) {
    try {
        return decodeCp932(bytes);
    } catch {
        return null;
    }
}

function matchesAt(data, offset, signature) {
    return signature.every((byte, index) => data[offset + index] === byte);
}

export function findBytes(data, signature, start = 0, end = data.length) {
    let position = Math.max(start, 0);
    const last = end - signature.length;
    while (position <= last) {
        position = data.indexOf(signature[0], position);
        if (position < 0 || position > last) return -1;
        if (matchesAt(data, position, signature)) return position;
        position++;
    }
    return -1;
}

function findLastBytes(data, signature, start, end) {
    for (let position = end - signature.length; position >= start; position--) {
        if (matchesAt(data, position, signature)) return position;
    }
    return -1;
}

export function hasEndRecordNearEnd(data) {
    return findBytes(data, END_SIGNATURE, Math.max(data.length - 65536, 0)) >= 0;
}

function readEndRecord(data) {
    const size = data.length;
    if (size >= END_RECORD_SIZE) {
        const offset = size - END_RECORD_SIZE;
        if (matchesAt(data, offset, END_SIGNATURE) && data[size - 2] === 0 && data[size - 1] === 0) return offset;
    }
    const searchStart = Math.max(size - MAX_COMMENT_SIZE - END_RECORD_SIZE, 0);
    const found = findLastBytes(data, END_SIGNATURE, searchStart, size);
    if (found >= 0 && found + END_RECORD_SIZE <= size) return found;
    throw new BadZipFile("File is not a zip file");
}

function decodeName(bytes, flags) {
    if (flags & FLAG_UTF8) return utf8.decode(bytes);
    return decodeCp437(bytes);
}

function sanitizeName(name) {
    const nullIndex = name.indexOf("\0");
    return nullIndex >= 0 ? name.slice(0, nullIndex) : name;
}

function applyExtra(entry, extra, nameCrc) {
    let position = 0;
    while (extra.length - position >= 4) {
        const type = u16(extra, position);
        const length = u16(extra, position + 2);
        if (position + length + 4 > extra.length) throw new BadZipFile(`Corrupt extra field ${type.toString(16)}`);
        const body = extra.subarray(position + 4, position + 4 + length);
        if (type === EXTRA_ZIP64) {
            let cursor = 0;
            const readSize = () => {
                if (cursor + 8 > body.length) throw new BadZipFile("Corrupt zip64 extra field");
                const value = u32(body, cursor) + u32(body, cursor + 4) * 2 ** 32;
                cursor += 8;
                return value;
            };
            if (entry.size === 0xffffffff) entry.size = readSize();
            if (entry.compressedSize === 0xffffffff) entry.compressedSize = readSize();
            if (entry.headerOffset === 0xffffffff) entry.headerOffset = readSize();
        } else if (type === EXTRA_UNICODE_PATH) {
            if (body.length < 5) throw new BadZipFile("Corrupt unicode path extra field (0x7075)");
            if (body[0] === 1 && u32(body, 1) === nameCrc) {
                let unicodeName;
                try {
                    unicodeName = utf8.decode(body.subarray(5));
                } catch {
                    throw new BadZipFile("Corrupt unicode path extra field (0x7075): invalid utf-8 bytes");
                }
                if (unicodeName) entry.filename = sanitizeName(unicodeName);
            }
        }
        position += length + 4;
    }
}

function readCentralDirectory(data) {
    const endOffset = readEndRecord(data);
    const centralSize = u32(data, endOffset + 12);
    const centralOffset = u32(data, endOffset + 16);
    const concatenated = endOffset - centralSize - centralOffset;
    const start = centralOffset + concatenated;
    if (start < 0) throw new BadZipFile("Bad offset for central directory");
    const directory = data.subarray(start, start + centralSize);
    const entries = [];
    let position = 0;
    while (position < centralSize) {
        if (position + CENTRAL_HEADER_SIZE > directory.length) throw new BadZipFile("Truncated central directory");
        if (u32(directory, position) !== CENTRAL_SIGNATURE) throw new BadZipFile("Bad magic number for central directory");
        const nameLength = u16(directory, position + 28);
        const extraLength = u16(directory, position + 30);
        const commentLength = u16(directory, position + 32);
        const nameStart = position + CENTRAL_HEADER_SIZE;
        const nameBytes = directory.slice(nameStart, nameStart + nameLength);
        const flags = u16(directory, position + 8);
        const originalName = decodeName(nameBytes, flags);
        const entry = {
            nameBytes,
            originalName,
            filename: sanitizeName(originalName),
            flags,
            extractVersion: directory[position + 6],
            method: u16(directory, position + 10),
            crc: u32(directory, position + 16),
            compressedSize: u32(directory, position + 20),
            size: u32(directory, position + 24),
            headerOffset: u32(directory, position + 42),
        };
        if (entry.extractVersion > MAX_EXTRACT_VERSION) throw new UnsupportedZip(`zip file version ${entry.extractVersion / 10}`);
        const extraStart = nameStart + nameLength;
        applyExtra(entry, directory.subarray(extraStart, extraStart + extraLength), crc32(nameBytes));
        entry.headerOffset += concatenated;
        entries.push(entry);
        position += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    }
    const byOffset = entries.map((entry, index) => ({ entry, index })).sort((first, second) => first.entry.headerOffset - second.entry.headerOffset || first.index - second.index);
    let endBoundary = start;
    for (let index = byOffset.length - 1; index >= 0; index--) {
        byOffset[index].entry.endOffset = endBoundary;
        endBoundary = byOffset[index].entry.headerOffset;
    }
    return entries;
}

function inflateWithFflate(compressed) {
    try {
        return inflateSync(compressed);
    } catch {
        return null;
    }
}

function inflateMember(compressed, entry) {
    const fast = inflateWithFflate(compressed);
    if (fast && crc32(fast.subarray(0, entry.size)) === entry.crc) return fast.subarray(0, entry.size);
    const { output, error } = inflateRaw(compressed);
    if (error) throw new BadZipFile(error);
    return output.subarray(0, entry.size);
}

function readMember(data, entry) {
    const offset = entry.headerOffset;
    if (offset < 0 || offset + LOCAL_HEADER_SIZE > data.length) throw new BadZipFile("Truncated file header");
    if (!matchesAt(data, offset, LOCAL_SIGNATURE)) throw new BadZipFile("Bad magic number for file header");
    const localFlags = u16(data, offset + 6);
    const nameLength = u16(data, offset + 26);
    const extraLength = u16(data, offset + 28);
    const localName = data.subarray(offset + LOCAL_HEADER_SIZE, offset + LOCAL_HEADER_SIZE + nameLength);
    if (entry.flags & FLAG_COMPRESSED_PATCH) throw new UnsupportedZip("compressed patched data (flag bit 5)");
    if (entry.flags & FLAG_STRONG_ENCRYPTION) throw new UnsupportedZip("strong encryption (flag bit 6)");
    if (decodeName(localName, localFlags) !== entry.originalName) throw new BadZipFile("File name in directory and header differ");
    const payload = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
    if (payload + entry.compressedSize > entry.endOffset && entry.endOffset !== entry.headerOffset) throw new BadZipFile("Overlapped entries");
    if (entry.flags & FLAG_ENCRYPTED) throw new UnsupportedZip("File is encrypted, password required for extraction");
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) throw new UnsupportedZip("That compression method is not supported");
    if (payload + entry.compressedSize > data.length && entry.compressedSize > 0) throw new BadZipFile("Truncated member");
    const compressed = data.subarray(payload, payload + entry.compressedSize);
    const content = entry.method === METHOD_STORED ? compressed.slice(0, entry.size) : inflateMember(compressed, entry);
    if (crc32(content) !== entry.crc) throw new BadZipFile(`Bad CRC-32 for file ${entry.filename}`);
    return content;
}

function memberName(entry) {
    if (entry.flags & FLAG_UTF8) return entry.filename;
    const bytes = encodeCp437(entry.filename);
    if (!bytes) return entry.filename;
    return tryDecodeCp932(bytes) ?? entry.filename;
}

export function readZip(data) {
    const members = [];
    for (const entry of readCentralDirectory(data)) {
        if (entry.filename.endsWith("/")) continue;
        members.push({ name: memberName(entry), data: readMember(data, entry) });
    }
    return members;
}

export function readLocalEntries(data, start = 0) {
    const members = [];
    let position = findBytes(data, LOCAL_SIGNATURE, start);
    while (position >= 0 && position + LOCAL_HEADER_SIZE <= data.length) {
        const flags = u16(data, position + 6);
        const method = u16(data, position + 8);
        const compressedSize = u32(data, position + 18);
        const nameLength = u16(data, position + 26);
        const extraLength = u16(data, position + 28);
        const nameBytes = data.subarray(position + LOCAL_HEADER_SIZE, position + LOCAL_HEADER_SIZE + nameLength);
        const payload = position + LOCAL_HEADER_SIZE + nameLength + extraLength;
        let content = null;
        let end = payload + compressedSize;
        if (method === METHOD_STORED && !(flags & FLAG_DATA_DESCRIPTOR)) {
            content = data.slice(payload, end);
        } else if (method === METHOD_DEFLATED) {
            const sizeKnown = compressedSize && !(flags & FLAG_DATA_DESCRIPTOR);
            const result = inflateRaw(data, { start: payload, end: sizeKnown ? payload + compressedSize : data.length });
            if (!result.error) {
                content = result.output;
                if (!sizeKnown) end = result.finished ? result.end : data.length;
            }
        }
        if (content !== null && nameBytes.length && nameBytes[nameBytes.length - 1] !== 0x2f) {
            const name = tryDecodeCp932(nameBytes) ?? latin1Decode(nameBytes);
            members.push({ name, data: content });
        }
        position = findBytes(data, LOCAL_SIGNATURE, Math.max(end, position + 4));
    }
    return members;
}

function padTo(content, size) {
    if (content.length >= size) return content;
    const padded = new Uint8Array(size);
    padded.set(content);
    return padded;
}

function readLenientContent(data, method, payload, compressedSize, size) {
    if (method === METHOD_STORED) return { content: data.slice(payload, payload + compressedSize).subarray(0, size), end: payload + compressedSize, complete: true };
    if (method === METHOD_DEFLATED) {
        const result = inflateRaw(data, { start: payload, end: compressedSize ? payload + compressedSize : data.length });
        if (result.finished) return { content: result.output, end: result.end, complete: true };
        return { content: padTo(result.output, size), end: data.length, complete: false };
    }
    return { content: new Uint8Array(size), end: payload + compressedSize, complete: false };
}

function lenientMember(nameBytes, flags, content) {
    const isUtf8 = Boolean(flags & FLAG_UTF8);
    return { name: isUtf8 ? decodeName(nameBytes, flags) : null, nameBytes, data: content };
}

function readCentralLeniently(data, entries) {
    const members = [];
    let error = null;
    for (const entry of entries) {
        if (entry.filename.endsWith("/")) continue;
        const offset = entry.headerOffset;
        if (!matchesAt(data, offset, LOCAL_SIGNATURE)) {
            error = new BadZipFile("Bad magic number for file header");
            continue;
        }
        const payload = offset + LOCAL_HEADER_SIZE + u16(data, offset + 26) + u16(data, offset + 28);
        const { content, complete } = readLenientContent(data, entry.method, payload, entry.compressedSize, entry.size);
        if (!complete) error = new BadZipFile(`${entry.filename} could not be fully extracted`);
        members.push(lenientMember(entry.nameBytes, entry.flags, content));
    }
    return { members, error };
}

function readStreamingLeniently(data) {
    const members = [];
    let position = 0;
    while (matchesAt(data, position, LOCAL_SIGNATURE) && position + LOCAL_HEADER_SIZE <= data.length) {
        const flags = u16(data, position + 6);
        const method = u16(data, position + 8);
        const compressedSize = flags & FLAG_DATA_DESCRIPTOR ? 0 : u32(data, position + 18);
        const size = u32(data, position + 22);
        const nameLength = u16(data, position + 26);
        const nameBytes = data.slice(position + LOCAL_HEADER_SIZE, position + LOCAL_HEADER_SIZE + nameLength);
        const payload = position + LOCAL_HEADER_SIZE + nameLength + u16(data, position + 28);
        const result = readLenientContent(data, method, payload, compressedSize, size);
        if (nameBytes.length && nameBytes[nameBytes.length - 1] !== 0x2f) members.push(lenientMember(nameBytes, flags, result.content));
        if (!result.complete) return { members, error: new BadZipFile("Zip entry is truncated") };
        position = result.end;
        if (flags & FLAG_DATA_DESCRIPTOR) position += u32(data, position) === 0x08074b50 ? 16 : 12;
    }
    return { members, error: null };
}

export function readZipLeniently(data) {
    let entries;
    try {
        entries = readCentralDirectory(data);
    } catch {
        return readStreamingLeniently(data);
    }
    return readCentralLeniently(data, entries);
}
