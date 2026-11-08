import { u16, u32 } from "../pe/pe.js";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE = 512;
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_SIZE = 128;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const STREAM = 2;
const ROOT = 5;
const STREAM_NAME_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._";
const PACKED_PAIR_START = 0x3800;
const PACKED_SINGLE_START = 0x4800;
const TABLE_PREFIX = 0x4840;

function ensureAvailable(data, offset, size) {
    if (offset < 0 || offset + size > data.length) throw new RangeError("Compound file is truncated");
}

export function isCompoundFile(data) {
    return data.length >= HEADER_SIZE && SIGNATURE.every((byte, index) => data[index] === byte);
}

export function decodeStreamName(name) {
    let out = "";
    for (const character of name) {
        const code = character.charCodeAt(0);
        if (code >= PACKED_PAIR_START && code < PACKED_SINGLE_START) {
            const packed = code - PACKED_PAIR_START;
            out += STREAM_NAME_ALPHABET[packed & 0x3f] + STREAM_NAME_ALPHABET[(packed >>> 6) & 0x3f];
        } else if (code >= PACKED_SINGLE_START && code < TABLE_PREFIX) {
            out += STREAM_NAME_ALPHABET[code - PACKED_SINGLE_START];
        } else if (code === TABLE_PREFIX) {
            out += "!";
        } else {
            out += character;
        }
    }
    return out;
}

function chain(table, start, limit) {
    const sectors = [];
    for (let sector = start; sector !== END_OF_CHAIN && sector !== FREE_SECTOR; sector = table[sector]) {
        if (sector >= table.length || sectors.length > limit) throw new RangeError("Compound file has a broken sector chain");
        sectors.push(sector);
    }
    return sectors;
}

export function readCompoundStreams(data) {
    if (!isCompoundFile(data)) return null;
    const sectorSize = 1 << u16(data, 0x1e);
    const miniSectorSize = 1 << u16(data, 0x20);
    const fatSectorCount = u32(data, 0x2c);
    const directoryStart = u32(data, 0x30);
    const miniCutoff = u32(data, 0x38);
    const miniFatStart = u32(data, 0x3c);
    let difatSector = u32(data, 0x44);
    const sectorCount = Math.ceil((data.length - HEADER_SIZE) / sectorSize);
    const sectorOffset = (sector) => HEADER_SIZE + sector * sectorSize;

    const fatSectors = [];
    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index++) fatSectors.push(u32(data, 0x4c + index * 4));
    const perDifat = sectorSize / 4 - 1;
    while (difatSector !== END_OF_CHAIN && difatSector !== FREE_SECTOR && fatSectors.length < fatSectorCount + perDifat) {
        ensureAvailable(data, sectorOffset(difatSector), sectorSize);
        for (let index = 0; index < perDifat; index++) fatSectors.push(u32(data, sectorOffset(difatSector) + index * 4));
        difatSector = u32(data, sectorOffset(difatSector) + perDifat * 4);
    }

    const fat = [];
    for (const sector of fatSectors.slice(0, fatSectorCount)) {
        ensureAvailable(data, sectorOffset(sector), sectorSize);
        for (let index = 0; index < sectorSize / 4; index++) fat.push(u32(data, sectorOffset(sector) + index * 4));
    }

    const readChain = (start, size) => {
        const out = new Uint8Array(size);
        let filled = 0;
        for (const sector of chain(fat, start, sectorCount)) {
            if (filled >= size) break;
            const count = Math.min(sectorSize, size - filled);
            ensureAvailable(data, sectorOffset(sector), count);
            out.set(data.subarray(sectorOffset(sector), sectorOffset(sector) + count), filled);
            filled += count;
        }
        if (filled < size) throw new RangeError("Compound file stream is truncated");
        return out;
    };

    const directorySectors = chain(fat, directoryStart, sectorCount);
    const directory = readChain(directoryStart, directorySectors.length * sectorSize);
    const entries = [];
    for (let offset = 0; offset + DIRECTORY_ENTRY_SIZE <= directory.length; offset += DIRECTORY_ENTRY_SIZE) {
        const type = directory[offset + 66];
        if (type !== STREAM && type !== ROOT) continue;
        const nameLength = Math.max(0, u16(directory, offset + 64) - 2);
        let name = "";
        for (let index = 0; index < nameLength; index += 2) name += String.fromCharCode(u16(directory, offset + index));
        entries.push({ name, type, start: u32(directory, offset + 116), size: u32(directory, offset + 120) });
    }

    const root = entries.find((entry) => entry.type === ROOT);
    const miniStream = root && root.size ? readChain(root.start, root.size) : new Uint8Array(0);
    const miniFat = [];
    if (miniFatStart !== END_OF_CHAIN && miniFatStart !== FREE_SECTOR) {
        for (const sector of chain(fat, miniFatStart, sectorCount)) {
            for (let index = 0; index < sectorSize / 4; index++) miniFat.push(u32(data, sectorOffset(sector) + index * 4));
        }
    }
    const readMiniChain = (start, size) => {
        const out = new Uint8Array(size);
        let filled = 0;
        for (const sector of chain(miniFat, start, miniStream.length / miniSectorSize)) {
            if (filled >= size) break;
            const count = Math.min(miniSectorSize, size - filled);
            out.set(miniStream.subarray(sector * miniSectorSize, sector * miniSectorSize + count), filled);
            filled += count;
        }
        if (filled < size) throw new RangeError("Compound file stream is truncated");
        return out;
    };

    return entries.filter((entry) => entry.type === STREAM).map((entry) => ({
        name: decodeStreamName(entry.name),
        data: entry.size < miniCutoff ? readMiniChain(entry.start, entry.size) : readChain(entry.start, entry.size),
    }));
}
