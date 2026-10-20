import { inflateSync } from "../vendor/fflate.js";
import { decompressLzx } from "./lzx.js";
import { u16, u32 } from "./pe.js";

const HEADER_SIZE = 36;
const FLAG_PREVIOUS_CABINET = 0x0001;
const FLAG_NEXT_CABINET = 0x0002;
const FLAG_RESERVE_PRESENT = 0x0004;
const ATTRIBUTE_NAME_IS_UTF = 0x80;
const COMPRESSION_NONE = 0;
const COMPRESSION_MSZIP = 1;
const COMPRESSION_QUANTUM = 2;
const COMPRESSION_LZX = 3;
const FOLDER_CONTINUED_FROM_PREVIOUS = 0xfffd;
const WINDOW_SIZE = 0x8000;

function decodeLatin1(bytes) {
    let text = "";
    for (let position = 0; position < bytes.length; position += 0x2000) {
        text += String.fromCharCode(...bytes.subarray(position, position + 0x2000));
    }
    return text;
}

const utf8 = new TextDecoder("utf-8");

function isSignature(data, offset) {
    return data[offset] === 0x4d && data[offset + 1] === 0x53 && data[offset + 2] === 0x43 && data[offset + 3] === 0x46;
}

function asBytes(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function ensureAvailable(data, offset, size) {
    if (offset + size > data.length) throw new RangeError("Cabinet is truncated");
}

function readName(data, offset) {
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    if (end >= data.length) throw new RangeError("Cabinet is truncated");
    return { bytes: data.subarray(offset, end), next: end + 1 };
}

function readHeader(data) {
    ensureAvailable(data, 0, HEADER_SIZE);
    if (!isSignature(data, 0)) throw new Error("Not a cabinet");
    const header = {
        size: u32(data, 8),
        filesOffset: u32(data, 16),
        versionMinor: data[24],
        versionMajor: data[25],
        folderCount: u16(data, 26),
        fileCount: u16(data, 28),
        flags: u16(data, 30),
        setIdentifier: u16(data, 32),
        cabinetIndex: u16(data, 34),
        headerReserve: 0,
        folderReserve: 0,
        dataReserve: 0,
    };
    let position = HEADER_SIZE;
    if (header.flags & FLAG_RESERVE_PRESENT) {
        ensureAvailable(data, position, 4);
        header.headerReserve = u16(data, position);
        header.folderReserve = data[position + 2];
        header.dataReserve = data[position + 3];
        position += 4 + header.headerReserve;
    }
    if (header.flags & FLAG_PREVIOUS_CABINET) {
        position = readName(data, position).next;
        position = readName(data, position).next;
    }
    if (header.flags & FLAG_NEXT_CABINET) {
        position = readName(data, position).next;
        position = readName(data, position).next;
    }
    header.foldersOffset = position;
    return header;
}

function readFolders(data, header) {
    const folders = [];
    let position = header.foldersOffset;
    for (let index = 0; index < header.folderCount; index++) {
        ensureAvailable(data, position, 8);
        folders.push({
            dataOffset: u32(data, position),
            blockCount: u16(data, position + 4),
            compression: u16(data, position + 6),
        });
        position += 8 + header.folderReserve;
    }
    return folders;
}

function readFiles(data, header) {
    const files = [];
    let position = header.filesOffset;
    for (let index = 0; index < header.fileCount; index++) {
        ensureAvailable(data, position, 16);
        const attributes = u16(data, position + 14);
        const name = readName(data, position + 16);
        files.push({
            name: attributes & ATTRIBUTE_NAME_IS_UTF ? utf8.decode(name.bytes) : decodeLatin1(name.bytes),
            size: u32(data, position),
            folderOffset: u32(data, position + 4),
            folder: u16(data, position + 8),
            date: u16(data, position + 10),
            time: u16(data, position + 12),
            attributes,
        });
        position = name.next;
    }
    return files;
}

function concatenate(chunks, length) {
    const output = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) {
        output.set(chunk, position);
        position += chunk.length;
    }
    return output;
}

function inflateBlock(compressed, uncompressedSize, history) {
    if (compressed[0] !== 0x43 || compressed[1] !== 0x4b) throw new Error("MSZIP block is missing its CK signature");
    const options = history.length ? { dictionary: history } : {};
    const block = inflateSync(compressed.subarray(2), options);
    if (block.length !== uncompressedSize) throw new Error("MSZIP block decompressed to the wrong size");
    return block;
}

function slideWindow(history, block) {
    if (block.length >= WINDOW_SIZE) return block.slice(block.length - WINDOW_SIZE);
    const keep = Math.min(history.length, WINDOW_SIZE - block.length);
    const window = new Uint8Array(keep + block.length);
    window.set(history.subarray(history.length - keep));
    window.set(block, keep);
    return window;
}

function readFolder(data, header, folder) {
    const method = folder.compression & 0x000f;
    if (method === COMPRESSION_QUANTUM) throw new Error("Quantum compression isn't supported");
    if (method !== COMPRESSION_NONE && method !== COMPRESSION_MSZIP && method !== COMPRESSION_LZX) throw new Error(`Unknown compression type ${method}`);
    const blocks = [];
    let total = 0;
    let history = new Uint8Array(0);
    let position = folder.dataOffset;
    let uncompressedTotal = 0;
    for (let index = 0; index < folder.blockCount; index++) {
        ensureAvailable(data, position, 8);
        const compressedSize = u16(data, position + 4);
        const uncompressedSize = u16(data, position + 6);
        const start = position + 8 + header.dataReserve;
        ensureAvailable(data, start, compressedSize);
        const compressed = data.subarray(start, start + compressedSize);
        let block;
        if (method === COMPRESSION_LZX) {
            block = compressed;
            uncompressedTotal += uncompressedSize;
        } else if (method === COMPRESSION_NONE) {
            block = compressed;
        } else {
            block = inflateBlock(compressed, uncompressedSize, history);
            history = slideWindow(history, block);
        }
        blocks.push(block);
        total += block.length;
        position = start + compressedSize;
    }
    if (method === COMPRESSION_LZX) return decompressLzx(concatenate(blocks, total), (folder.compression >>> 8) & 0x1f, uncompressedTotal);
    return concatenate(blocks, total);
}

export function listCabinet(data) {
    data = asBytes(data);
    const header = readHeader(data);
    return { header, folders: readFolders(data, header), files: readFiles(data, header) };
}

export function readCabinet(data) {
    data = asBytes(data);
    const { header, folders, files } = listCabinet(data);
    const contents = new Map();
    const members = [];
    for (const file of files) {
        if (file.folder >= FOLDER_CONTINUED_FROM_PREVIOUS || file.folder >= folders.length) {
            throw new Error(`${file.name} spans cabinets, which isn't supported`);
        }
        if (!contents.has(file.folder)) contents.set(file.folder, readFolder(data, header, folders[file.folder]));
        const folderData = contents.get(file.folder);
        if (file.folderOffset + file.size > folderData.length) throw new RangeError(`${file.name} runs past the end of its folder`);
        members.push({ name: file.name, data: folderData.slice(file.folderOffset, file.folderOffset + file.size) });
    }
    return members;
}

function isPlausibleHeader(data, offset) {
    if (offset + HEADER_SIZE > data.length) return false;
    if (u32(data, offset + 4) !== 0) return false;
    const size = u32(data, offset + 8);
    const filesOffset = u32(data, offset + 16);
    const folderCount = u16(data, offset + 26);
    const fileCount = u16(data, offset + 28);
    if (size < HEADER_SIZE || offset + size > data.length) return false;
    if (filesOffset < HEADER_SIZE || filesOffset >= size) return false;
    if (data[offset + 25] !== 1 || data[offset + 24] !== 3) return false;
    return folderCount > 0 && fileCount > 0;
}

export function findCabinets(data) {
    data = asBytes(data);
    const found = [];
    let offset = 0;
    while (offset + HEADER_SIZE <= data.length) {
        const next = data.indexOf(0x4d, offset);
        if (next === -1) break;
        if (isSignature(data, next) && isPlausibleHeader(data, next)) {
            const size = u32(data, next + 8);
            found.push({ offset: next, size, data: data.subarray(next, next + size) });
            offset = next + size;
        } else {
            offset = next + 1;
        }
    }
    return found;
}
