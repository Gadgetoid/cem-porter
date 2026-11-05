import { latin1Decode, u32 } from "./pe.js";

const SECTOR_SIZE = 2048;
const RAW_SECTOR_SIZE = 2352;
const RAW_SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
const RAW_MODE_OFFSET = 15;
const RAW_DATA_OFFSETS = { 1: 16, 2: 24 };
const DESCRIPTOR_SECTOR = 16;
const DESCRIPTOR_LIMIT = 64;
const STANDARD_IDENTIFIER = [0x43, 0x44, 0x30, 0x30, 0x31];
const PRIMARY_DESCRIPTOR = 1;
const SUPPLEMENTARY_DESCRIPTOR = 2;
const TERMINATOR_DESCRIPTOR = 255;
const JOLIET_ESCAPES = ["%/@", "%/C", "%/E"];
const ROOT_RECORD_OFFSET = 156;
const DIRECTORY_FLAG = 0x02;
const MAX_DEPTH = 32;

const utf16be = new TextDecoder("utf-16be");

function hasSync(data, offset) {
    return RAW_SYNC.every((byte, index) => data[offset + index] === byte);
}

function hasIdentifier(data, offset) {
    return STANDARD_IDENTIFIER.every((byte, index) => data[offset + 1 + index] === byte);
}

function rawDataOffset(data) {
    return RAW_DATA_OFFSETS[data[DESCRIPTOR_SECTOR * RAW_SECTOR_SIZE + RAW_MODE_OFFSET]];
}

export function isRawCd(data) {
    if (data.length < (DESCRIPTOR_SECTOR + 1) * RAW_SECTOR_SIZE || !hasSync(data, 0) || !hasSync(data, DESCRIPTOR_SECTOR * RAW_SECTOR_SIZE)) return false;
    const offset = rawDataOffset(data);
    return offset !== undefined && hasIdentifier(data, DESCRIPTOR_SECTOR * RAW_SECTOR_SIZE + offset);
}

export function rawCdToIso(data) {
    const offset = rawDataOffset(data);
    const sectors = Math.floor(data.length / RAW_SECTOR_SIZE);
    const output = new Uint8Array(sectors * SECTOR_SIZE);
    for (let sector = 0; sector < sectors; sector++) {
        const start = sector * RAW_SECTOR_SIZE + offset;
        output.set(data.subarray(start, start + SECTOR_SIZE), sector * SECTOR_SIZE);
    }
    return output;
}

export function isIso(data) {
    return data.length >= (DESCRIPTOR_SECTOR + 1) * SECTOR_SIZE && hasIdentifier(data, DESCRIPTOR_SECTOR * SECTOR_SIZE);
}

function isJoliet(data, offset) {
    const escape = latin1Decode(data.subarray(offset + 88, offset + 91));
    return JOLIET_ESCAPES.includes(escape);
}

function rootRecords(data) {
    let primary = null;
    let joliet = null;
    for (let sector = DESCRIPTOR_SECTOR; sector < DESCRIPTOR_SECTOR + DESCRIPTOR_LIMIT; sector++) {
        const offset = sector * SECTOR_SIZE;
        if (offset + SECTOR_SIZE > data.length || !hasIdentifier(data, offset)) break;
        const type = data[offset];
        if (type === TERMINATOR_DESCRIPTOR) break;
        if (type === PRIMARY_DESCRIPTOR && !primary) primary = offset + ROOT_RECORD_OFFSET;
        if (type === SUPPLEMENTARY_DESCRIPTOR && !joliet && isJoliet(data, offset)) joliet = offset + ROOT_RECORD_OFFSET;
    }
    return { primary, joliet };
}

function recordName(data, offset, joliet) {
    const length = data[offset + 32];
    const bytes = data.subarray(offset + 33, offset + 33 + length);
    const name = joliet ? utf16be.decode(bytes) : latin1Decode(bytes);
    return name.replace(/;\d*$/, "").replace(/\.$/, "");
}

function readRecord(data, offset, joliet) {
    return {
        extent: u32(data, offset + 2),
        size: u32(data, offset + 10),
        directory: Boolean(data[offset + 25] & DIRECTORY_FLAG),
        name: recordName(data, offset, joliet),
        special: data[offset + 32] === 1 && data[offset + 33] <= 1,
    };
}

function walk(data, record, path, joliet, members, visited, depth) {
    if (depth > MAX_DEPTH || visited.has(record.extent)) return;
    visited.add(record.extent);
    const start = record.extent * SECTOR_SIZE;
    const end = Math.min(start + record.size, data.length);
    let position = start;
    while (position < end) {
        const length = data[position];
        if (!length) {
            position = (Math.floor((position - start) / SECTOR_SIZE) + 1) * SECTOR_SIZE + start;
            continue;
        }
        if (position + 33 > end) break;
        const child = readRecord(data, position, joliet);
        position += length;
        if (child.special || !child.name) continue;
        const childPath = path ? `${path}/${child.name}` : child.name;
        if (child.directory) {
            walk(data, child, childPath, joliet, members, visited, depth + 1);
        } else {
            const offset = child.extent * SECTOR_SIZE;
            members.push({ name: childPath, data: data.subarray(Math.min(offset, data.length), Math.min(offset + child.size, data.length)) });
        }
    }
}

export function readIso(data) {
    const { primary, joliet } = rootRecords(data);
    const root = joliet ?? primary;
    if (root === null) throw new Error("No ISO 9660 volume descriptor");
    const members = [];
    walk(data, readRecord(data, root, joliet !== null), "", joliet !== null, members, new Set(), 0);
    return { members, joliet: joliet !== null };
}
