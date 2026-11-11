import fs from "node:fs";

export function isSec(path) {
    const descriptor = fs.openSync(path, "r");
    const header = Buffer.alloc(4);
    fs.readSync(descriptor, header, 0, 4, 0);
    fs.closeSync(descriptor);
    return header.readUInt32LE(0) === 0x400d400d;
}

export function openSec(path) {
    const fd = fs.openSync(path, "r");
    const header = Buffer.alloc(0x40);
    fs.readSync(fd, header, 0, 0x40, 0);
    if (header.readUInt32LE(0) !== 0x400d400d) throw new Error("not a .sec");
    const payload = header.readUInt32LE(0x24);
    const stride = header.readUInt32LE(0x28);
    const dataPerChunk = stride - 0x40;
    const flash = (offset, length) => {
        const output = new Uint8Array(length);
        for (let done = 0; done < length;) {
            const current = offset + done;
            const take = Math.min(dataPerChunk - (current % dataPerChunk), length - done);
            const got = fs.readSync(fd, output, done, take, payload + Math.floor(current / dataPerChunk) * stride + 0x40 + (current % dataPerChunk));
            if (!got) break;
            done += got;
        }
        return output;
    };
    const config = Buffer.from(flash(0, 0x60 + 0x30 * 16));
    const modules = [];
    let next = 0x5000;
    for (let index = 0; index < 16; index++) {
        const record = 0x60 + index * 0x30;
        if (config.readUInt32LE(record) !== 0xc001c000) break;
        const id = config.readUInt32LE(record + 4);
        if (id === 0xff) break;
        const size = config.readUInt32LE(record + 0xc);
        modules.push(id === 0 ? { id, offset: 0, size: 0x5000 } : { id, offset: next, size });
        if (id) next += size;
    }
    return { fd, flash, modules, module: (id) => modules.find((module) => module.id === id) };
}

const PAGE_SIZE = 1024 * 1024;
const CACHED_PAGES = 64;

export function pagedBytes(length, readAt) {
    const pages = new Map();
    const page = (number) => {
        let bytes = pages.get(number);
        if (bytes) {
            pages.delete(number);
            pages.set(number, bytes);
            return bytes;
        }
        bytes = readAt(number * PAGE_SIZE, Math.min(PAGE_SIZE, length - number * PAGE_SIZE));
        pages.set(number, bytes);
        if (pages.size > CACHED_PAGES) pages.delete(pages.keys().next().value);
        return bytes;
    };
    const byteAt = (offset) => (offset >= 0 && offset < length ? page(Math.floor(offset / PAGE_SIZE))[offset % PAGE_SIZE] : undefined);
    const subarray = (start = 0, end = length) => {
        start = Math.max(0, Math.min(length, start));
        end = Math.max(start, Math.min(length, end));
        const output = new Uint8Array(end - start);
        for (let done = 0; done < output.length;) {
            const offset = start + done;
            const bytes = page(Math.floor(offset / PAGE_SIZE));
            const within = offset % PAGE_SIZE;
            const count = Math.min(output.length - done, bytes.length - within);
            output.set(bytes.subarray(within, within + count), done);
            done += count;
        }
        return output;
    };
    return new Proxy({}, {
        get(target, key) {
            if (key === "length") return length;
            if (key === "subarray" || key === "slice") return subarray;
            if (typeof key === "string" && /^\d+$/.test(key)) return byteAt(Number(key));
            return undefined;
        },
    });
}

const SECTOR_SIZE = 0x1000;
const SECTOR_RECORD = 0x1008;
const RECORDS_PER_READ = 1024;

export function sectorMap(sec, module, firstRecord = 0) {
    const records = Math.floor(module.size / SECTOR_RECORD);
    const map = new Map();
    for (let first = firstRecord; first < records; first += RECORDS_PER_READ) {
        const count = Math.min(RECORDS_PER_READ, records - first);
        const bytes = sec.flash(module.offset + first * SECTOR_RECORD, count * SECTOR_RECORD);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < count; index++) {
            const sector = view.getUint32(index * SECTOR_RECORD + SECTOR_SIZE, true);
            if (sector !== 0xffffffff) map.set(sector, first + index);
        }
    }
    return map;
}

export function sectorBytes(sec, module, map, firstSector) {
    const lastSector = Math.max(...map.keys());
    const length = (lastSector - firstSector + 1) * SECTOR_SIZE;
    return pagedBytes(length, (offset, size) => {
        const output = new Uint8Array(size).fill(0xff);
        for (let done = 0; done < size;) {
            const logical = offset + done;
            const within = logical % SECTOR_SIZE;
            const count = Math.min(size - done, SECTOR_SIZE - within);
            const record = map.get(firstSector + Math.floor(logical / SECTOR_SIZE));
            if (record !== undefined) output.set(sec.flash(module.offset + record * SECTOR_RECORD + within, count), done);
            done += count;
        }
        return output;
    });
}

const SEC_NK_MODULE = 7;
const SEC_OS_MODULE = 6;
const IMGFS_SIGNATURE = [0xf8, 0xac, 0x2c, 0x9d, 0xe3, 0xd4, 0x2b, 0x4d, 0xbd, 0x30, 0x91, 0x6e, 0xd8, 0x4f, 0x31, 0xdc];

function findSuperblockRecord(sec, module) {
    const records = Math.floor(module.size / SECTOR_RECORD);
    for (let record = 0; record < records; record++) {
        const head = sec.flash(module.offset + record * SECTOR_RECORD, 16);
        if (IMGFS_SIGNATURE.every((byte, index) => head[index] === byte)) return record;
    }
    return -1;
}

export function secImages(path) {
    const sec = openSec(path);
    const nk = sec.module(SEC_NK_MODULE);
    const os = sec.module(SEC_OS_MODULE);
    if (!nk) throw new Error("no NK module in the .sec");
    const result = { xip: sec.flash(nk.offset, nk.size), imgfs: null };
    if (!os) return result;
    const superblockRecord = findSuperblockRecord(sec, os);
    if (superblockRecord < 0) return result;
    const map = sectorMap(sec, os, superblockRecord);
    const firstSector = new DataView(sec.flash(os.offset + superblockRecord * SECTOR_RECORD + SECTOR_SIZE, 4).buffer).getUint32(0, true);
    result.imgfs = sectorBytes(sec, os, map, firstSector);
    return result;
}
