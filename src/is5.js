import { inflateRaw } from "./inflate.js";
import { u16, u32 } from "./pe.js";

const IS5_SIGNATURE = [0x49, 0x53, 0x63, 0x28];

const COMMON_HEADER_SIZE = 20;
const VOLUME_HEADER_SIZE_V5 = 40;
const VOLUME_HEADER_SIZE_V6 = 64;
const FILE_DESCRIPTOR_SIZE_V6 = 0x57;
const FILE_GROUP_OFFSETS = 0x3e;
const MAX_FILE_GROUP_COUNT = 71;
const FILE_SPLIT = 0x01;
const FILE_OBFUSCATED = 0x02;
const FILE_COMPRESSED = 0x04;
const FILE_INVALID = 0x08;
const LINK_PREVIOUS = 0x01;

function ensureAvailable(data, offset, size) {
    if (offset < 0 || offset + size > data.length) throw new RangeError("InstallShield cabinet is truncated");
}

function u64(data, offset) {
    const high = u32(data, offset + 4);
    if (high) throw new RangeError("InstallShield cabinet is too large");
    return u32(data, offset);
}

function cString(data, offset) {
    ensureAvailable(data, offset, 1);
    const end = data.indexOf(0, offset);
    return data.subarray(offset, end < 0 ? data.length : end);
}

export function isIs5(data) {
    return data.length >= COMMON_HEADER_SIZE && IS5_SIGNATURE.every((byte, index) => data[index] === byte);
}

function majorVersion(data) {
    const version = u32(data, 4);
    if (version >>> 24 === 1) return (version >>> 12) & 0xf;
    if (version >>> 24 === 2 || version >>> 24 === 4) return Math.floor((version & 0xffff) / 100);
    return 0;
}

function readHeader(data) {
    ensureAvailable(data, 0, COMMON_HEADER_SIZE);
    const major = majorVersion(data);
    if (major >= 17) throw new Error("InstallShield cabinets from version 17 are not supported");
    const descriptor = u32(data, 12);
    if (!u32(data, 16)) throw new Error("InstallShield cabinet has no descriptor");
    ensureAvailable(data, descriptor, 0x30);
    const fileTableOffset = u32(data, descriptor + 0x0c);
    const directoryCount = u32(data, descriptor + 0x1c);
    const fileCount = u32(data, descriptor + 0x28);
    const fileTableOffset2 = u32(data, descriptor + 0x2c);
    const tableStart = descriptor + fileTableOffset;
    ensureAvailable(data, tableStart, 4 * (directoryCount + fileCount));
    const table = Array.from({ length: directoryCount + fileCount }, (_, index) => u32(data, tableStart + 4 * index));
    const files = [];
    for (let index = 0; index < fileCount; index++) {
        const file = major <= 5 ? readDescriptorV5(data, tableStart + table[directoryCount + index]) : readDescriptorV6(data, tableStart + fileTableOffset2 + index * FILE_DESCRIPTOR_SIZE_V6);
        if (file.directoryIndex >= directoryCount) throw new RangeError("InstallShield file has no directory");
        files.push(file);
    }
    const groups = readFileGroups(data, descriptor, major);
    const nameOf = (file, index) => joinedName([
        groups.find((group) => group.firstFile <= index && index <= group.lastFile)?.nameBytes,
        cString(data, tableStart + table[file.directoryIndex]),
        cString(data, tableStart + file.nameOffset),
    ]);
    return { major, files, nameOf };
}

function readFileGroups(data, descriptor, major) {
    const groups = [];
    try {
        ensureAvailable(data, descriptor + FILE_GROUP_OFFSETS, 4 * MAX_FILE_GROUP_COUNT);
        for (let slot = 0; slot < MAX_FILE_GROUP_COUNT; slot++) {
            const seen = new Set();
            let next = u32(data, descriptor + FILE_GROUP_OFFSETS + 4 * slot);
            while (next && !seen.has(next)) {
                seen.add(next);
                ensureAvailable(data, descriptor + next, 12);
                const groupDescriptor = descriptor + u32(data, descriptor + next + 4);
                next = u32(data, descriptor + next + 8);
                const range = groupDescriptor + 4 + (major <= 5 ? 0x48 : 0x12);
                ensureAvailable(data, range, 8);
                const firstFile = u32(data, range) | 0;
                if (firstFile === -1) continue;
                groups.push({ nameBytes: cString(data, descriptor + u32(data, groupDescriptor)), firstFile, lastFile: u32(data, range + 4) | 0 });
            }
        }
    } catch {
        return [];
    }
    return groups;
}

function readDescriptorV5(data, position) {
    ensureAvailable(data, position, 0x2a);
    return {
        nameOffset: u32(data, position),
        directoryIndex: u16(data, position + 4),
        flags: u16(data, position + 8),
        expandedSize: u32(data, position + 0x0a),
        compressedSize: u32(data, position + 0x0e),
        dataOffset: u32(data, position + 0x26),
        volume: 1,
        linkFlags: 0,
    };
}

function readDescriptorV6(data, position) {
    ensureAvailable(data, position, FILE_DESCRIPTOR_SIZE_V6);
    return {
        flags: u16(data, position),
        expandedSize: u64(data, position + 2),
        compressedSize: u64(data, position + 0x0a),
        dataOffset: u64(data, position + 0x12),
        nameOffset: u32(data, position + 0x3a),
        directoryIndex: u16(data, position + 0x3e),
        linkPrevious: u32(data, position + 0x4c),
        linkFlags: data[position + 0x54],
        volume: u16(data, position + 0x55),
    };
}

function readVolumeHeader(data, major) {
    ensureAvailable(data, COMMON_HEADER_SIZE, major <= 5 ? VOLUME_HEADER_SIZE_V5 : VOLUME_HEADER_SIZE_V6);
    const field = (index) => u32(data, COMMON_HEADER_SIZE + 4 * index);
    if (major <= 5) {
        return {
            firstFileIndex: field(2),
            lastFileIndex: field(3),
            firstFileOffset: field(4),
            firstFileExpanded: field(5),
            firstFileCompressed: field(6),
            lastFileOffset: field(7) || 0x7fffffff,
            lastFileExpanded: field(8),
            lastFileCompressed: field(9),
        };
    }
    return {
        firstFileIndex: field(2),
        lastFileIndex: field(3),
        firstFileOffset: field(4),
        firstFileExpanded: field(6),
        firstFileCompressed: field(8),
        lastFileOffset: field(10),
        lastFileExpanded: field(12),
        lastFileCompressed: field(14),
    };
}

function deobfuscate(bytes) {
    for (let index = 0; index < bytes.length; index++) {
        const mixed = bytes[index] ^ 0xd5;
        const rotated = ((mixed >>> 2) | (mixed << 6)) & 0xff;
        bytes[index] = (rotated - (index % 0x47)) & 0xff;
    }
}

class VolumeReader {
    constructor(volumes, major, file, index, fileCount) {
        this.volumes = volumes;
        this.major = major;
        this.file = file;
        this.index = index;
        this.fileCount = fileCount;
        this.split = Boolean(file.flags & FILE_SPLIT);
        let volume = file.volume;
        this.open(volume);
        while (major <= 5 && index > this.header.lastFileIndex) this.open(++volume);
    }

    open(number) {
        const data = this.volumes.get(number);
        if (!data || !isIs5(data)) throw new Error(`InstallShield volume ${number} is missing`);
        this.number = number;
        this.data = data;
        this.header = readVolumeHeader(data, this.major);
        const { header, file, index } = this;
        if (this.major === 5) {
            if (index < this.fileCount - 1 && index === header.lastFileIndex && header.lastFileCompressed !== file.compressedSize) this.split = true;
            else if (index > 0 && index === header.firstFileIndex && header.firstFileCompressed !== file.compressedSize) this.split = true;
        }
        let offset = file.dataOffset;
        let expanded = file.expandedSize;
        let compressed = file.compressedSize;
        if (this.split) {
            if (index === header.lastFileIndex && header.lastFileOffset !== 0x7fffffff) {
                [offset, expanded, compressed] = [header.lastFileOffset, header.lastFileExpanded, header.lastFileCompressed];
            } else if (index === header.firstFileIndex) {
                [offset, expanded, compressed] = [header.firstFileOffset, header.firstFileExpanded, header.firstFileCompressed];
            } else {
                [offset, expanded, compressed] = [0, 0, 0];
            }
        }
        this.position = offset;
        this.left = file.flags & FILE_COMPRESSED ? compressed : expanded;
    }

    read(size) {
        const output = new Uint8Array(size);
        let written = 0;
        while (written < size) {
            const count = Math.min(size - written, this.left);
            if (count === 0) {
                this.open(this.number + 1);
                continue;
            }
            ensureAvailable(this.data, this.position, count);
            output.set(this.data.subarray(this.position, this.position + count), written);
            this.position += count;
            this.left -= count;
            written += count;
        }
        return output;
    }
}

function readStream(volumes, major, file, index, fileCount) {
    const size = file.flags & FILE_COMPRESSED ? file.compressedSize : file.expandedSize;
    const stream = new VolumeReader(volumes, major, file, index, fileCount).read(size);
    if (file.flags & FILE_OBFUSCATED) deobfuscate(stream);
    return stream;
}

function expandChunks(stream, expandedSize) {
    const output = new Uint8Array(expandedSize);
    let written = 0;
    let position = 0;
    while (position < stream.length) {
        ensureAvailable(stream, position, 2);
        const length = u16(stream, position);
        position += 2;
        if (!length) throw new Error("InstallShield chunk is empty");
        ensureAvailable(stream, position, length);
        const { output: chunk, finished, error } = inflateRaw(stream, { start: position, end: position + length });
        if (error || !finished) throw new Error(`InstallShield chunk does not inflate: ${error ?? "truncated"}`);
        if (written + chunk.length > expandedSize) throw new Error("InstallShield file is larger than its descriptor");
        output.set(chunk, written);
        written += chunk.length;
        position += length;
    }
    if (written !== expandedSize) throw new Error(`InstallShield file expanded to ${written}, not ${expandedSize}`);
    return output;
}

function expandWhole(stream, expandedSize) {
    const { output, error } = inflateRaw(stream, { maxOutput: expandedSize });
    if (error || output.length !== expandedSize) throw new Error("InstallShield file does not inflate");
    return output;
}

function expand(stream, expandedSize) {
    try {
        return expandChunks(stream, expandedSize);
    } catch {
        return expandWhole(stream, expandedSize);
    }
}

function joinedName(parts) {
    const present = parts.filter((part) => part?.length);
    const joined = new Uint8Array(Math.max(0, present.reduce((total, part) => total + part.length, present.length - 1)));
    let position = 0;
    for (const part of present) {
        if (position) joined[position++] = 0x5c;
        joined.set(part, position);
        position += part.length;
    }
    return joined;
}

export function extractIs5(header, volumes) {
    const { major, files, nameOf } = readHeader(header);
    const members = [];
    let failed = false;
    files.forEach((file, index) => {
        if (file.flags & FILE_INVALID || !file.dataOffset || !file.nameOffset) return;
        let source = file;
        let sourceIndex = index;
        if (file.linkFlags & LINK_PREVIOUS) {
            sourceIndex = file.linkPrevious;
            source = files[sourceIndex];
            if (!source) return;
        }
        try {
            const stream = readStream(volumes, major, source, sourceIndex, files.length);
            const data = source.flags & FILE_COMPRESSED ? expand(stream, source.expandedSize) : stream;
            members.push({ nameBytes: nameOf(file, index), data });
        } catch {
            failed = true;
        }
    });
    return { members, failed };
}
