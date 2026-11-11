import { u16, u32 } from "../pe/pe.js";
import { xpressDecode } from "./romlz.js";

const AXIM_HEADER_SIZE = 0x80;
const AXIM_KEY_SIZE = 64;
const AXIM_KEY_SAMPLE = 1024 * 1024;
const AXIM_PLAIN_HEADER = [0x5c, 0x80];
const AXIM_SIGNATURE = [0x44, 0x65, 0x6c, 0x6c, 0x20, 0x41, 0x78, 0x69, 0x6d];

const NBF_SECTOR_SIZE = 0x200;
const NBF_PAGE_SIZE = 0x208;
const NBF_UNMAPPED = 0xffffffff;
const NBF_BANNER_SIZE = 0x20;
const NBF_LENGTH_OFFSET = 0x22;
const NBF_HEADER_LIMIT = 0x100;
const NBF_PAGED_SEARCH = 0x10000;
const MBR_SIGNATURE_OFFSET = 0x1fe;
const MBR_PARTITIONS = 0x1be;
const MBR_SECTOR = 0x200;
const PARTITION_LOADER_XIP = 0x20;
const PARTITION_OS_XIP = 0x23;
const PARTITION_IMGFS = 0x25;

const XPRS_SIGNATURE = 0x58505253;
const XPRS_HEADER_SIZE = 0x34;
const XPRS_CHUNK_COUNT = 0x38;
const XPRS_CHUNK_SIZE = 0x3c;
const XPRS_SIGNATURE_OFFSET = 0x40;
const XPRS_TABLE = 0x44;

const UPDATE_RECORD_START = 0x34;
const UPDATE_RECORD_SIZE = 0xd8;
const UPDATE_RECORD_LIMIT = 8;
const UPDATE_RECORD_MAGIC = 0xab0f59ff;
const UPDATE_OS_TYPE = 0x50;
const MSFLSH = [0x4d, 0x53, 0x46, 0x4c, 0x53, 0x48];
const MSFLSH_OFFSET = 0x200;
const CAP_SAMPLE = 4 * 1024 * 1024;
const CAP_SEARCH = 4 * 1024 * 1024;
const CAP_HEADER = 0x0409;

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_LOCAL_HEADER = 30;
const WMSTORE_SUPERBLOCK = 0x200;
const WMSTORE_PARTITIONS = 0x400;
const WMSTORE_PARTITION_SIZE = 0x200;
const WMSTORE_SECTOR = 512;
const utf16 = new TextDecoder("utf-16le");

function latin1(bytes) {
    return String.fromCharCode(...bytes);
}

function aximKey(data) {
    const counts = new Map();
    let best = null;
    let bestCount = 0;
    for (let position = AXIM_HEADER_SIZE; position + AXIM_KEY_SIZE <= Math.min(data.length, AXIM_HEADER_SIZE + AXIM_KEY_SAMPLE); position += AXIM_KEY_SIZE) {
        const block = latin1(data.subarray(position, position + AXIM_KEY_SIZE));
        const count = (counts.get(block) ?? 0) + 1;
        counts.set(block, count);
        if (count > bestCount) {
            best = block;
            bestCount = count;
        }
    }
    return Uint8Array.from(best ?? "", (character) => character.charCodeAt(0));
}

function looksLikeAxim(data) {
    const body = data.length - AXIM_HEADER_SIZE;
    return body > 0 && (body & (body - 1)) === 0 && data.subarray(...AXIM_PLAIN_HEADER).every((byte) => byte === 0);
}

function axim(data) {
    if (!looksLikeAxim(data)) return null;
    const key = aximKey(data);
    if (key.length !== AXIM_KEY_SIZE || !AXIM_SIGNATURE.every((byte, index) => (data[index] ^ key[index]) === byte)) return null;
    const label = latin1(Array.from(data.subarray(0, NBF_BANNER_SIZE), (byte, index) => byte ^ key[index])).replace(/\0.*$/s, "").trim();
    const image = new Uint8Array(data.length - AXIM_HEADER_SIZE);
    for (let index = 0; index < image.length; index++) image[index] = data[AXIM_HEADER_SIZE + index] ^ key[(AXIM_HEADER_SIZE + index) % AXIM_KEY_SIZE];
    return { kind: `Dell Axim update image (${label})`, image };
}

function isXprs(data) {
    return data.length >= XPRS_TABLE && u32(data, XPRS_SIGNATURE_OFFSET) === XPRS_SIGNATURE;
}

function decodeXprs(data) {
    const count = u32(data, XPRS_CHUNK_COUNT);
    const chunkSize = u32(data, XPRS_CHUNK_SIZE);
    let position = u32(data, XPRS_HEADER_SIZE);
    const output = new Uint8Array(count * chunkSize);
    for (let index = 0; index < count; index++) {
        const stored = u16(data, XPRS_TABLE + 2 * index);
        const chunk = data.subarray(position, position + stored);
        if (stored >= chunkSize) output.set(chunk.subarray(0, chunkSize), index * chunkSize);
        else if (stored) output.set(xpressDecode(chunk, chunkSize, { partial: true }), index * chunkSize);
        position += stored;
    }
    return output;
}

function flashPartitions(image) {
    if (image[MBR_SIGNATURE_OFFSET] !== 0x55 || image[MBR_SIGNATURE_OFFSET + 1] !== 0xaa) return {};
    const partitions = new Map();
    for (let index = 0; index < 4; index++) {
        const entry = MBR_PARTITIONS + 16 * index;
        const start = u32(image, entry + 8) * MBR_SECTOR;
        const size = u32(image, entry + 12) * MBR_SECTOR;
        if (image[entry + 4] && start + size <= image.length) partitions.set(image[entry + 4], image.subarray(start, start + size));
    }
    const osXip = partitions.get(PARTITION_OS_XIP);
    const xip = osXip ? (isXprs(osXip) ? decodeXprs(osXip) : osXip) : partitions.get(PARTITION_LOADER_XIP) ?? null;
    return xip ? { xip, imgfs: partitions.get(PARTITION_IMGFS) ?? null } : {};
}

function nbfBannerSize(data) {
    if (data.length < NBF_LENGTH_OFFSET + 4 || !/^(hp|HP) iPAQ /.test(latin1(data.subarray(0, NBF_BANNER_SIZE)))) return -1;
    const size = data.length - u32(data, NBF_LENGTH_OFFSET);
    return size >= NBF_LENGTH_OFFSET + 4 && size <= NBF_HEADER_LIMIT ? size : -1;
}

function nbfPagedStart(data) {
    for (let start = NBF_BANNER_SIZE; start < Math.min(data.length, NBF_PAGED_SEARCH); start += 2) {
        if ((data.length - start) % NBF_PAGE_SIZE) continue;
        if (data[start + MBR_SIGNATURE_OFFSET] !== 0x55 || data[start + MBR_SIGNATURE_OFFSET + 1] !== 0xaa) continue;
        if (u32(data, start + NBF_SECTOR_SIZE) !== 0 || u32(data, start + NBF_PAGE_SIZE + NBF_SECTOR_SIZE) !== 1) continue;
        return start;
    }
    return -1;
}

function unpageNbf(data, start) {
    const pages = (data.length - start) / NBF_PAGE_SIZE;
    let last = -1;
    for (let page = 0; page < pages; page++) {
        const sector = u32(data, start + page * NBF_PAGE_SIZE + NBF_SECTOR_SIZE);
        if (sector !== NBF_UNMAPPED && sector > last) last = sector;
    }
    const flat = new Uint8Array((last + 1) * NBF_SECTOR_SIZE).fill(0xff);
    for (let page = 0; page < pages; page++) {
        const offset = start + page * NBF_PAGE_SIZE;
        const sector = u32(data, offset + NBF_SECTOR_SIZE);
        if (sector !== NBF_UNMAPPED) flat.set(data.subarray(offset, offset + NBF_SECTOR_SIZE), sector * NBF_SECTOR_SIZE);
    }
    return flat;
}

function hpNbf(data) {
    const bannerSize = nbfBannerSize(data);
    if (bannerSize >= 0) return { kind: "HP iPAQ .nbf", image: data.subarray(bannerSize) };
    const start = nbfPagedStart(data);
    if (start < 0) return null;
    const flat = unpageNbf(data, start);
    return { kind: "HP iPAQ .nbf, 512-byte sectors with 8-byte tags", image: flat, ...flashPartitions(flat) };
}

function hasMsflsh(data, offset) {
    return MSFLSH.every((byte, index) => data[offset + index] === byte);
}

function asusUpdateImage(data) {
    const records = [];
    for (let index = 0; index < UPDATE_RECORD_LIMIT; index++) {
        const offset = UPDATE_RECORD_START + UPDATE_RECORD_SIZE * index;
        if (offset + 0x1c > data.length || u32(data, offset + 0x10) !== UPDATE_RECORD_MAGIC) break;
        records.push({ type: u32(data, offset), start: u32(data, offset + 4), size: u32(data, offset + 8), index: u32(data, offset + 0x14), key: data[offset + 0x18] });
    }
    const record = records.find((candidate) => candidate.type === UPDATE_OS_TYPE && candidate.index === 0);
    if (!record || record.start + record.size > data.length) return null;
    const image = data.slice(record.start, record.start + record.size);
    for (let index = 0; index < image.length; index++) image[index] ^= record.key;
    return hasMsflsh(image, MSFLSH_OFFSET) ? { kind: "ASUS update image", image, ...flashPartitions(image) } : null;
}

function capKey(data) {
    const counts = new Map();
    for (let offset = 0; offset + 4 <= Math.min(data.length, CAP_SAMPLE); offset += 4) {
        const word = u32(data, offset);
        counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const [word] = [...counts].sort((left, right) => right[1] - left[1])[0] ?? [0];
    return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24];
}

function asusCap(data, name) {
    if (!/\.cap$/i.test(name) || data.length < CAP_SAMPLE) return null;
    const key = capKey(data);
    if (((data[0] ^ key[0]) | ((data[1] ^ key[1]) << 8) | ((data[2] ^ key[2]) << 16) | ((data[3] ^ key[3]) << 24)) !== CAP_HEADER) return null;
    const decoded = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) decoded[index] = data[index] ^ key[index & 3];
    for (let offset = MSFLSH_OFFSET; offset + MSFLSH.length <= Math.min(decoded.length, CAP_SEARCH); offset += 4) {
        if (!hasMsflsh(decoded, offset)) continue;
        const image = decoded.subarray(offset - MSFLSH_OFFSET);
        return { kind: "ASUS .cap image", image, ...flashPartitions(image) };
    }
    return null;
}

function wmstore(data) {
    if (data.length < ZIP_LOCAL_HEADER || u32(data, 0) !== ZIP_LOCAL_SIGNATURE || u16(data, 8) !== 0) return null;
    const payload = ZIP_LOCAL_HEADER + u16(data, 26) + u16(data, 28);
    const payloadEnd = Math.min(data.length, payload + u32(data, 18));
    if (latin1(data.subarray(payload + WMSTORE_SUPERBLOCK, payload + WMSTORE_SUPERBLOCK + 8)) !== "_wmstore") return null;
    const partitions = new Map();
    for (let entry = payload + WMSTORE_PARTITIONS; entry + WMSTORE_PARTITION_SIZE <= payloadEnd; entry += WMSTORE_PARTITION_SIZE) {
        if (latin1(data.subarray(entry, entry + 8)) !== "_wmpart_") break;
        const name = utf16.decode(data.subarray(entry + 8, entry + 0x48)).split("\0")[0];
        const start = payload + u32(data, entry + 0x4c) * WMSTORE_SECTOR;
        const length = Math.max(0, Math.min(u32(data, entry + 0x54) * WMSTORE_SECTOR, payloadEnd - start));
        partitions.set(name, data.subarray(start, start + length));
    }
    if (!partitions.has("NK")) return null;
    return { kind: "Windows Phone _wmstore package", image: partitions.get("NK"), xip: partitions.get("NK"), imgfs: partitions.get("IMGFS") ?? null };
}

export function unwrapContainer(data, name = "") {
    return wmstore(data) ?? hpNbf(data) ?? asusUpdateImage(data) ?? asusCap(data, name) ?? axim(data);
}
