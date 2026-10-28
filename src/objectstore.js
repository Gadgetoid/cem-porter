import { u16, u32 } from "./pe.js";
import { filetimeDate } from "./romimage.js";
import { lzDecode, lzwDecode } from "./romlz.js";

const LOG_ALIGN = 0x400;
const LOG_SIGNATURE = "EKIMEKIM";
const LOG_SECTIONS = 0x10;
const LOG_REGISTRY_ROOTS = 0x9a;
const HEAP_OFFSET = 0x100;
const HANDLES_PER_BLOCK = 1024;
const MAX_HANDLE_BLOCKS = 64;
const CHUNK_SIZE = 4096;
const LZ_BLOCK_SIZES = [1024, 4096];
const LIST_MAX = 65536;
const DEPTH_MAX = 64;
const CE1_REGISTRY_FILES = ["Pegreg.reg", "CEreg.reg"];
const CE1_BLOCK_SIZE = 0x1000;
const CE1_BLOCK_HEADER = 0x18;
const CE1_ROOT_MARKER = 0x08;
const CE1_KEY = 4;
const CE1_VALUE = 5;

export const OBJECT_NAMES = { 2: "Handle blocks", 3: "File info", 4: "Folders", 5: "Files", 6: "File data chunks", 7: "Databases", 8: "Database records", 0xa: "Database lists", 0xb: "Registry roots", 0xc: "Registry keys", 0xd: "Registry values" };
const ROOT_KEYS = ["HKEY_CLASSES_ROOT", "HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE", "HKEY_USERS"];
export const REGISTRY_TYPES = { 0: "REG_NONE", 1: "REG_SZ", 2: "REG_EXPAND_SZ", 3: "REG_BINARY", 4: "REG_DWORD", 5: "REG_DWORD_BIG_ENDIAN", 6: "REG_LINK", 7: "REG_MULTI_SZ" };

const utf16 = new TextDecoder("utf-16le");

function text(data, offset, units) {
    return utf16.decode(data.subarray(offset, offset + 2 * units)).replace(/\0[\s\S]*$/, "");
}

function filetime(data, offset) {
    const low = u32(data, offset);
    const high = u32(data, offset + 4);
    return low || high ? filetimeDate(low, high) : null;
}

function read24(data, offset) {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function lzBlockSize(payload) {
    const total = read24(payload, 0);
    return LZ_BLOCK_SIZES.find((size) => {
        const blocks = Math.floor(total / size) + 1;
        let previous = 3 + 3 * blocks;
        for (let index = 0; index < blocks; index++) {
            const end = read24(payload, 3 + 3 * index);
            if (end < previous || end > payload.length) return false;
            previous = end;
        }
        return previous === payload.length;
    });
}

function decodeCe2Chunk(payload) {
    const blockSize = payload.length >= 6 ? lzBlockSize(payload) : null;
    if (!blockSize) throw new Error("a compressed chunk has an unreadable header");
    return lzDecode(payload, CHUNK_SIZE, blockSize);
}

function findLog(regions) {
    const main = regions[0];
    for (let offset = 0; offset + LOG_ALIGN <= main.data.length; offset += LOG_ALIGN) {
        if (u32(main.data, offset) !== 1) continue;
        let match = true;
        for (let index = 0; index < LOG_SIGNATURE.length && match; index++) match = main.data[offset + 4 + index] === LOG_SIGNATURE.charCodeAt(index);
        if (match) return { address: main.pa + offset, data: main.data.subarray(offset, offset + LOG_ALIGN) };
    }
    return null;
}

class ObjectStore {
    constructor(state, log) {
        this.state = state;
        this.logAddress = log.address;
        this.sections = [0, 1].map((index) => ({ va: u32(log.data, LOG_SECTIONS + 16 * index), size: u32(log.data, LOG_SECTIONS + 16 * index + 4) })).filter((section) => section.size);
        this.size = this.sections.reduce((total, section) => total + section.size, 0);
        if (!this.sections.length) throw new Error("the object store has no memory");
        const header = this.read(0, 4 * MAX_HANDLE_BLOCKS);
        if (!header) throw new Error("the object store is outside the saved memory");
        this.handleBlocks = [0];
        for (let index = 1; index < MAX_HANDLE_BLOCKS && u32(header, 4 * index); index++) this.handleBlocks.push(u32(header, 4 * index));
        this.registryRoots = u16(log.data, LOG_REGISTRY_ROOTS);
        this.ce2 = this.object(this.registryRoots)?.type === 0xb;
    }

    read(offset, length) {
        const output = new Uint8Array(length);
        let written = 0;
        for (const section of this.sections) {
            if (written === length) break;
            if (offset >= section.size) {
                offset -= section.size;
                continue;
            }
            const take = Math.min(section.size - offset, length - written);
            const bytes = this.state.read(section.va + offset, take);
            if (!bytes) return null;
            output.set(bytes, written);
            written += take;
            offset = 0;
        }
        return written === length ? output : null;
    }

    handle(id) {
        const block = Math.floor(id / HANDLES_PER_BLOCK);
        if (block >= this.handleBlocks.length || (!id && block)) return null;
        const entry = this.read(HEAP_OFFSET + this.handleBlocks[block] + 8 + 4 * (id % HANDLES_PER_BLOCK), 4);
        return entry && u32(entry, 0) & 1 ? u32(entry, 0) : null;
    }

    object(id) {
        const handle = this.handle(id);
        if (handle === null) return null;
        const offset = HEAP_OFFSET + (handle & 0xfffffc);
        const header = this.read(offset, 4);
        if (!header) return null;
        const size = u16(header, 0);
        const data = this.read(offset + 4, size);
        return data ? { type: header[3] & 0x0f, size, data } : null;
    }

    counts() {
        const counts = new Map();
        for (let block = 0; block < this.handleBlocks.length; block++) {
            for (let slot = 0; slot < HANDLES_PER_BLOCK; slot++) {
                const handle = this.handle(block * HANDLES_PER_BLOCK + slot);
                if (handle === null) continue;
                const header = this.read(HEAP_OFFSET + (handle & 0xfffffc), 4);
                if (!header) continue;
                const type = header[3] & 0x0f;
                counts.set(type, (counts.get(type) ?? 0) + 1);
            }
        }
        return counts;
    }

    entry(id) {
        const record = this.object(id);
        if (!record || (record.type !== 4 && record.type !== 5) || record.size < 20) return null;
        const data = record.data;
        const units = Math.min(u16(data, 18), (record.size - 20) >> 1);
        return {
            kind: record.type === 4 ? "folder" : "file",
            id: u16(data, 0),
            parent: u16(data, 2),
            sibling: u16(data, 4),
            child: u16(data, 6),
            time: filetime(data, 8),
            attributes: u16(data, 16),
            name: text(data, 20, units),
        };
    }

    fileInfo(entry) {
        if (!entry.child) return { size: 0, chunks: [] };
        const record = this.object(entry.child);
        if (!record || record.type !== 3 || record.size < 8) return null;
        const size = ((u16(record.data, 2) << 12) | u16(record.data, 4)) + 1;
        const count = u16(record.data, 2) + 1;
        const chunks = [];
        for (let index = 0; index < count && 8 + 2 * index + 2 <= record.size; index++) chunks.push(u16(record.data, 8 + 2 * index));
        return { size, chunks };
    }

    tree() {
        const rootEntry = this.entry(0);
        if (!rootEntry || rootEntry.kind !== "folder") throw new Error("the object store has no root folder");
        const root = { kind: "folder", name: "", parent: null, children: [], item: rootEntry };
        const seen = new Set([0]);
        const problems = [];
        const walk = (folder, depth) => {
            if (depth > DEPTH_MAX) return;
            let steps = 0;
            for (let id = folder.item.child; id && steps < LIST_MAX; steps++) {
                if (seen.has(id)) {
                    problems.push(`a loop in ${folder.name || "\\"}`);
                    break;
                }
                seen.add(id);
                const entry = this.entry(id);
                if (!entry) {
                    problems.push(`object ${id} in ${folder.name || "\\"} is missing`);
                    break;
                }
                if (entry.kind === "folder") {
                    const node = { kind: "folder", name: entry.name, parent: folder, children: [], item: entry };
                    folder.children.push(node);
                    walk(node, depth + 1);
                } else {
                    const info = this.fileInfo(entry);
                    entry.size = info?.size ?? 0;
                    entry.chunks = info?.chunks ?? [];
                    entry.damaged = !info;
                    entry.storedSize = entry.chunks.reduce((total, chunk) => total + (this.object(chunk)?.size ?? 0), 0);
                    folder.children.push({ kind: "file", name: entry.name, parent: folder, item: entry });
                }
                id = entry.sibling;
            }
        };
        walk(root, 0);
        return { root, problems };
    }

    fileData(entry) {
        if (entry.damaged) throw new Error("its file information is missing");
        const output = new Uint8Array(entry.size);
        entry.chunks.forEach((id, index) => {
            const start = index * CHUNK_SIZE;
            const length = Math.min(CHUNK_SIZE, entry.size - start);
            if (length <= 0 || !id) return;
            const record = this.object(id);
            if (!record || record.type !== 6 || record.size < 4) throw new Error(`data chunk ${index + 1} is missing`);
            const flags = u16(record.data, 2);
            const padding = flags >> 12 <= record.size - 4 ? flags >> 12 : 0;
            const payload = record.data.subarray(4, record.size - padding);
            const compressed = (flags & 0xff) === 1;
            const bytes = !compressed ? payload : this.ce2 ? decodeCe2Chunk(payload) : lzwDecode(payload, CHUNK_SIZE);
            output.set(bytes.subarray(0, length), start);
        });
        return output;
    }

    compressedChunks(entry) {
        return entry.chunks.filter((id) => id && (u16(this.object(id)?.data ?? new Uint8Array(4), 2) & 0xff) === 1).length;
    }

    registry(tree) {
        return this.ce2 ? this.registryCe2() : this.registryCe1(tree);
    }

    registryCe2() {
        const roots = this.object(this.registryRoots);
        const result = [];
        for (let index = 0; index < ROOT_KEYS.length; index++) {
            if (2 + 2 * (index + 1) > roots.size) break;
            const key = { name: ROOT_KEYS[index], className: "", parent: null, keys: [], values: [] };
            const firstValue = 10 + 2 * (index + 1) <= roots.size ? u16(roots.data, 10 + 2 * index) : 0;
            this.fillKeyCe2(key, u16(roots.data, 2 + 2 * index), firstValue, 0);
            result.push(key);
        }
        return { source: "the object store", roots: result };
    }

    fillKeyCe2(key, firstChild, firstValue, depth) {
        let steps = 0;
        for (let id = firstValue; id && steps < LIST_MAX; steps++) {
            const record = this.object(id);
            if (!record || record.type !== 0xd || record.size < 10) {
                key.damaged = true;
                break;
            }
            const data = record.data;
            const units = u16(data, 6);
            const length = u16(data, 8);
            if (10 + 2 * units + length > record.size) {
                key.damaged = true;
                break;
            }
            key.values.push({ name: text(data, 10, units), type: u16(data, 4), data: data.slice(10 + 2 * units, 10 + 2 * units + length) });
            id = u16(data, 2);
        }
        if (depth > DEPTH_MAX) return;
        steps = 0;
        for (let id = firstChild; id && steps < LIST_MAX; steps++) {
            const record = this.object(id);
            if (!record || record.type !== 0xc || record.size < 10) {
                key.damaged = true;
                break;
            }
            const data = record.data;
            const nameUnits = Math.min(data[8], (record.size - 10) >> 1);
            const classUnits = Math.min(data[9], (record.size - 10 - 2 * nameUnits) >> 1);
            const child = { name: text(data, 10, nameUnits), className: text(data, 10 + 2 * nameUnits, classUnits), parent: key, keys: [], values: [] };
            key.keys.push(child);
            this.fillKeyCe2(child, u16(data, 4), u16(data, 6), depth + 1);
            id = u16(data, 2);
        }
    }

    registryCe1(tree) {
        const windows = tree.children.find((child) => child.kind === "folder" && child.name.toLowerCase() === "windows");
        const node = windows?.children.find((child) => child.kind === "file" && CE1_REGISTRY_FILES.some((name) => name.toLowerCase() === child.name.toLowerCase()));
        if (!node) return { source: null, roots: [] };
        const file = this.fileData(node.item);
        const record = (offset, type, minimum) => {
            if (!offset || offset + 4 > file.length) return null;
            const size = u16(file, offset);
            if (file[offset + 2] !== type || size < minimum || offset + size > file.length) return null;
            return { offset, size };
        };
        const fill = (key, firstChild, firstValue, depth) => {
            let steps = 0;
            for (let offset = firstValue; offset && steps < LIST_MAX; steps++) {
                const value = record(offset, CE1_VALUE, 12);
                if (!value || 12 + file[offset + 8] + u16(file, offset + 10) > value.size) {
                    key.damaged = true;
                    break;
                }
                const nameBytes = file[offset + 8];
                const start = offset + 12 + nameBytes;
                key.values.push({ name: text(file, offset + 12, nameBytes >> 1), type: file[offset + 9], data: file.slice(start, start + u16(file, offset + 10)) });
                offset = u32(file, offset + 4);
            }
            if (depth > DEPTH_MAX) return;
            steps = 0;
            for (let offset = firstChild; offset && steps < LIST_MAX; steps++) {
                const found = record(offset, CE1_KEY, 24);
                if (!found) {
                    key.damaged = true;
                    break;
                }
                const nameBytes = Math.min(file[offset + 20], found.size - 24);
                const classBytes = Math.min(file[offset + 21], found.size - 24 - nameBytes);
                const child = { name: text(file, offset + 24, nameBytes >> 1), className: text(file, offset + 24 + nameBytes, classBytes >> 1), parent: key, keys: [], values: [] };
                key.keys.push(child);
                fill(child, u32(file, offset + 4), u32(file, offset + 12), depth + 1);
                offset = u32(file, offset + 8);
            }
        };
        const roots = [];
        ROOT_KEYS.forEach((name, index) => {
            for (let offset = CE1_BLOCK_HEADER; offset + 4 <= Math.min(CE1_BLOCK_SIZE, file.length); ) {
                const size = u16(file, offset);
                if (!size) break;
                if (record(offset, CE1_KEY, 24) && file[offset + 19] === CE1_ROOT_MARKER && file[offset + 16] === index) {
                    const key = { name, className: "", parent: null, keys: [], values: [] };
                    fill(key, u32(file, offset + 4), u32(file, offset + 12), 0);
                    roots.push(key);
                    break;
                }
                offset += size;
            }
        });
        return { source: `\\Windows\\${node.name}`, roots };
    }
}

export function openObjectStore(state) {
    const log = findLog(state.regions);
    if (!log) throw new Error("no Windows CE object store in this state's memory; it may not have booted far enough to make one");
    return new ObjectStore(state, log);
}

export function formatValue(value) {
    const { type, data } = value;
    if ((type === 4 || type === 5) && data.length >= 4) {
        const number = type === 4 ? u32(data, 0) : new DataView(data.buffer, data.byteOffset).getUint32(0, false);
        return `0x${number.toString(16).padStart(8, "0")} (${number})`;
    }
    if (type === 1 || type === 2) return text(data, 0, data.length >> 1);
    if (type === 7) return utf16.decode(data.subarray(0, data.length & ~1)).replace(/\0+$/, "").split("\0").join(" | ");
    return [...data.subarray(0, 256)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ") + (data.length > 256 ? " ..." : "");
}

function regString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function regHex(data) {
    return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join(",");
}

function regValue(value) {
    const name = value.name ? `"${regString(value.name)}"` : "@";
    if (value.type === 1) return `${name}="${regString(text(value.data, 0, value.data.length >> 1))}"`;
    if (value.type === 4 && value.data.length === 4) return `${name}=dword:${u32(value.data, 0).toString(16).padStart(8, "0")}`;
    if (value.type === 3) return `${name}=hex:${regHex(value.data)}`;
    return `${name}=hex(${value.type.toString(16)}):${regHex(value.data)}`;
}

export function keyPath(key) {
    const parts = [];
    for (let current = key; current; current = current.parent) parts.unshift(current.name);
    return parts.join("\\");
}

export function registryText(roots) {
    const lines = ["REGEDIT4", ""];
    const walk = (key) => {
        lines.push(`[${keyPath(key)}]`, ...key.values.map(regValue), "");
        key.keys.forEach(walk);
    };
    roots.forEach(walk);
    return lines.join("\r\n");
}
