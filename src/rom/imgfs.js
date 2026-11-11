import { u16, u32 } from "../pe/pe.js";
import { xpressDecode, xpressHuffmanDecode } from "./romlz.js";
import { decompressLzx } from "../archive/lzx.js";

const SIGNATURE = [0xf8, 0xac, 0x2c, 0x9d, 0xe3, 0xd4, 0x2b, 0x4d, 0xbd, 0x30, 0x91, 0x6e, 0xd8, 0x4f, 0x31, 0xdc];
const DIRENT_SIZE = 0x34;
const PAGE = 0x1000;
const ERASE_BLOCK = 0x10000;
const DATA_PAGES = 15;
const FTL_PROBE_BLOCKS = 8;
const LIVE_FLAGS = 0xfff00000;
const DIRECTORY_MAGIC = 0x2f5314ce;
const DIRECTORY_HEADER = 8;
const ENTRY_MODULE = 0xfffffefe;
const ENTRY_FILE = 0xfffff6fe;
const ENTRY_NAME = 0xfffffefb;
const ENTRY_SECTION = 0xfffff6fd;
const ENTRY_MODULE_SECTION = 0xfffffefd;
const NAME_IN_DIRENT = 0x02;
const INLINE_NAME_LENGTH = 4;
const E32_UNITS = 0x24;
const E32_SIZE = 0x70;
const O32_SIZE = 24;
const E32_SUBSYSTEM = 0x6c;
const WINDOWS_CE_SUBSYSTEM = 9;
const UNIT_COUNT = 9;
const EXPORT_DIRECTORY_SIZE = 40;
const MAX_EXPORTS = 0x10000;
const COMPRESSION_TAG = 0x2c;
const LZX_TAG = 0x00585a4c;
const XPRESS_HUFFMAN_TAG = 0x00485058;
const LZX_CHUNK_HEADER = 8;
const LZX_WINDOW_BITS = 16;
const utf16 = new TextDecoder("utf-16le");

function isSuperblock(data, offset) {
    if (offset + 0x28 > data.length || !SIGNATURE.every((byte, index) => data[offset + index] === byte)) return false;
    const blockSize = u32(data, offset + 0x24);
    return u32(data, offset + 0x1c) === DIRENT_SIZE && blockSize >= 0x200 && blockSize <= 0x10000;
}

export function findImgfs(data) {
    for (let offset = 0; offset + 0x28 <= data.length; offset += PAGE) {
        if (isSuperblock(data, offset)) return offset;
    }
    return -1;
}

class Volume {
    constructor(data, base) {
        this.data = data;
        this.base = base;
        this.blockSize = u32(data, base + 0x24);
        this.lzx = u32(data, base + COMPRESSION_TAG) === LZX_TAG;
        this.huffman = u32(data, base + COMPRESSION_TAG) === XPRESS_HUFFMAN_TAG;
        this.map = null;
        const blocks = Math.floor((data.length - base) / ERASE_BLOCK);
        let live = 0;
        let total = 0;
        for (let block = 0; block < Math.min(FTL_PROBE_BLOCKS, blocks); block++) {
            for (let entry = 0; entry < DATA_PAGES; entry++, total++) if (this.isLive(block, entry)) live++;
        }
        if (total && live * 10 >= total * 4) {
            this.map = new Map();
            for (let block = 0; block < blocks; block++) {
                for (let entry = 0; entry < DATA_PAGES; entry++) {
                    if (this.isLive(block, entry)) this.map.set(u32(data, this.mapEntry(block, entry)), block * 16 + entry);
                }
            }
            this.baseSector = [...this.map].find(([, page]) => page === 0)?.[0] ?? 0;
        }
    }

    mapEntry(block, entry) {
        return this.base + block * ERASE_BLOCK + DATA_PAGES * PAGE + entry * 8;
    }

    isLive(block, entry) {
        const offset = this.mapEntry(block, entry);
        return u32(this.data, offset) !== 0xffffffff && (u32(this.data, offset + 4) & LIVE_FLAGS) >>> 0 === LIVE_FLAGS;
    }

    translate(address) {
        if (!address) return -1;
        if (!this.map) return this.base + address;
        const page = this.map.get(Math.floor(address / PAGE) + this.baseSector);
        return page === undefined ? -1 : this.base + page * PAGE + (address % PAGE);
    }

    read(address, length) {
        const output = new Uint8Array(length);
        for (let done = 0; done < length;) {
            const offset = this.translate(address + done);
            if (offset < 0 || offset >= this.data.length) break;
            const count = Math.min(length - done, PAGE - ((address + done) % PAGE), this.data.length - offset);
            output.set(this.data.subarray(offset, offset + count), done);
            done += count;
        }
        return output;
    }

    readIndexed(pointer, indexSize, size) {
        const index = this.read(pointer, indexSize);
        const chunks = [];
        let total = 0;
        for (let position = 0; position + 8 <= index.length && total < size; position += 8) {
            const stored = u16(index, position);
            const full = u16(index, position + 2);
            const address = u32(index, position + 4);
            if (!stored && !full && !address) break;
            let chunk;
            if (!address) {
                chunk = new Uint8Array(full);
            } else if (stored === full) {
                chunk = this.read(address, stored);
            } else {
                chunk = new Uint8Array(full);
                try {
                    const raw = this.read(address, stored);
                    chunk.set(this.lzx ? decompressLzx(raw.subarray(LZX_CHUNK_HEADER), LZX_WINDOW_BITS, full) : this.huffman ? xpressHuffmanDecode(raw, full) : xpressDecode(raw, full, { partial: true }));
                } catch {
                    chunk.fill(0);
                }
            }
            chunks.push(chunk);
            total += chunk.length;
        }
        const output = new Uint8Array(size);
        let position = 0;
        for (const chunk of chunks) {
            if (position >= size) break;
            output.set(chunk.subarray(0, size - position), position);
            position += chunk.length;
        }
        return output;
    }

    name(dirent) {
        const length = u16(this.data, dirent + 0x0c);
        const flags = u16(this.data, dirent + 0x0e);
        if (!length) return "";
        if (length <= INLINE_NAME_LENGTH) return utf16.decode(this.data.subarray(dirent + 0x10, dirent + 0x10 + length * 2));
        const address = u32(this.data, dirent + 0x14);
        if (flags & NAME_IN_DIRENT) {
            const entry = this.read(address, DIRENT_SIZE);
            if (u32(entry, 0) !== ENTRY_NAME) return "";
            return utf16.decode(entry.subarray(4, 4 + Math.min(length * 2, DIRENT_SIZE - 4))).split("\0")[0];
        }
        return utf16.decode(this.read(address, length * 2));
    }

    dirents() {
        const entries = [];
        for (let block = this.base; block + this.blockSize <= this.data.length; block += this.blockSize) {
            if (u32(this.data, block) !== DIRECTORY_MAGIC) continue;
            for (let dirent = block + DIRECTORY_HEADER; dirent + DIRENT_SIZE <= block + this.blockSize; dirent += DIRENT_SIZE) entries.push(dirent);
        }
        return entries;
    }
}

function parseHeader(raw) {
    const sectionCount = u16(raw, 0);
    const units = Array.from({ length: UNIT_COUNT }, (_, index) => [u32(raw, E32_UNITS + 8 * index), u32(raw, E32_UNITS + 4 + 8 * index)]);
    const sections = Array.from({ length: sectionCount }, (_, index) => {
        const entry = E32_SIZE + O32_SIZE * index;
        return { virtualSize: u32(raw, entry), rva: u32(raw, entry + 4), storedSize: u32(raw, entry + 8), flags: u32(raw, entry + 20) };
    });
    return { sectionCount, flags: u16(raw, 2), entry: u32(raw, 4), imageBase: u32(raw, 8), version: [u16(raw, 12), u16(raw, 14)], imageSize: u32(raw, 0x14), subsystem: u16(raw, E32_SUBSYSTEM) || WINDOWS_CE_SUBSYSTEM, units, sections };
}

function sectionLocation(locations, section, index) {
    const named = locations.filter((location) => location.name === `S${String(index).padStart(3, "0")}`);
    if (!named.length) return locations[index];
    const wanted = section.storedSize || section.virtualSize;
    return named.reduce((best, location) => (Math.abs(location.size - wanted) < Math.abs(best.size - wanted) ? location : best));
}

export class Imgfs {
    constructor(data, base) {
        this.volume = new Volume(data, base);
        this.modules = [];
        this.files = [];
        const entries = this.volume.dirents();
        const common = (dirent) => ({ name: this.volume.name(dirent), size: u32(data, dirent + 0x18), attributes: u32(data, dirent + 0x1c), time: [u32(data, dirent + 0x20), u32(data, dirent + 0x24)], index: [u32(data, dirent + 0x2c), u32(data, dirent + 0x30)] });
        for (let index = 0; index < entries.length; index++) {
            const dirent = entries[index];
            const magic = u32(data, dirent);
            if (magic === ENTRY_FILE) {
                const file = common(dirent);
                if (file.name) this.files.push(file);
                continue;
            }
            if (magic !== ENTRY_MODULE) continue;
            const module = { ...common(dirent), sectionIndexes: [] };
            for (let next = index + 1; next < entries.length; next++) {
                const nextMagic = u32(data, entries[next]);
                if (nextMagic === ENTRY_NAME) continue;
                if (nextMagic !== ENTRY_SECTION && nextMagic !== ENTRY_MODULE_SECTION) break;
                module.sectionIndexes.push({ name: this.volume.name(entries[next]), index: [u32(data, entries[next] + 0x1c), u32(data, entries[next] + 0x20)], size: u32(data, entries[next] + 0x18) });
            }
            if (module.name) this.modules.push(module);
        }
    }

    fileData(file) {
        return this.volume.readIndexed(file.index[0], file.index[1], file.size);
    }

    sectionData(module, index) {
        const section = this.header(module).sections[index];
        const location = sectionLocation(module.sectionIndexes, section, index);
        return location ? this.volume.readIndexed(location.index[0], location.index[1], location.size) : new Uint8Array(0);
    }

    header(module) {
        if (!module.header) {
            const raw = this.volume.readIndexed(module.index[0], module.index[1], Math.max(module.size, E32_SIZE));
            module.header = parseHeader(raw);
        }
        return module.header;
    }

    image(module) {
        const header = this.header(module);
        const end = Math.max(header.imageSize, ...header.sections.map((section) => section.rva + section.virtualSize));
        const image = new Uint8Array(end);
        header.sections.forEach((section, index) => {
            const body = this.sectionData(module, index);
            image.set(body.subarray(0, Math.min(body.length, end - section.rva)), section.rva);
        });
        return image;
    }

    exports(module) {
        const [rva, size] = this.header(module).units[0];
        if (!rva || !size) return [];
        const image = this.image(module);
        if (rva + EXPORT_DIRECTORY_SIZE > image.length) return [];
        const base = u32(image, rva + 16);
        const functionCount = u32(image, rva + 20);
        const nameCount = u32(image, rva + 24);
        const functions = u32(image, rva + 28);
        const names = u32(image, rva + 32);
        const ordinals = u32(image, rva + 36);
        if (functionCount > MAX_EXPORTS || nameCount > functionCount || functions + 4 * functionCount > image.length || names + 4 * nameCount > image.length || ordinals + 2 * nameCount > image.length) return [];
        const named = new Map();
        for (let index = 0; index < nameCount; index++) {
            const nameRva = u32(image, names + 4 * index);
            const end = image.indexOf(0, nameRva);
            named.set(u16(image, ordinals + 2 * index), String.fromCharCode(...image.subarray(nameRva, end < 0 ? nameRva : end)));
        }
        return Array.from({ length: functionCount }, (_, index) => ({ ordinal: base + index, name: named.get(index) ?? null, rva: u32(image, functions + 4 * index) })).filter((entry) => entry.rva);
    }
}

export function openImgfs(data) {
    const base = findImgfs(data);
    return base < 0 ? null : new Imgfs(data, base);
}
