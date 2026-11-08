import { latin1Decode, u32 } from "../pe/pe.js";

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
const ROOT_RECORD_SIZE = 34;
const DIRECTORY_FLAG = 0x02;
const MAX_DEPTH = 32;
const FILE_READ_CHUNK = 4 * 1024 * 1024;

export const DISC_HEAD_SIZE = (DESCRIPTOR_SECTOR + 1) * RAW_SECTOR_SIZE;

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

export function isRawCd(data, size = data.length) {
    if (size < DISC_HEAD_SIZE || data.length < DISC_HEAD_SIZE || !hasSync(data, 0) || !hasSync(data, DESCRIPTOR_SECTOR * RAW_SECTOR_SIZE)) return false;
    const offset = rawDataOffset(data);
    return offset !== undefined && hasIdentifier(data, DESCRIPTOR_SECTOR * RAW_SECTOR_SIZE + offset);
}

export function isIso(data, size = data.length) {
    const needed = (DESCRIPTOR_SECTOR + 1) * SECTOR_SIZE;
    return size >= needed && data.length >= needed && hasIdentifier(data, DESCRIPTOR_SECTOR * SECTOR_SIZE);
}

function discLayout(head, size) {
    if (isRawCd(head, size)) return { raw: true, dataOffset: rawDataOffset(head), size: Math.floor(size / RAW_SECTOR_SIZE) * SECTOR_SIZE };
    if (isIso(head, size)) return { raw: false, dataOffset: 0, size };
    return null;
}

function rawSpans(layout, offset, length) {
    const spans = [];
    let position = offset;
    const end = Math.min(offset + length, layout.size);
    while (position < end) {
        const sector = Math.floor(position / SECTOR_SIZE);
        const within = position % SECTOR_SIZE;
        const take = Math.min(SECTOR_SIZE - within, end - position);
        spans.push({ physical: sector * RAW_SECTOR_SIZE + layout.dataOffset + within, length: take });
        position += take;
    }
    return spans;
}

function readFromBytes(data, layout, offset, length) {
    if (!layout.raw) return data.subarray(Math.min(offset, data.length), Math.min(offset + length, data.length));
    const spans = rawSpans(layout, offset, length);
    const output = new Uint8Array(spans.reduce((total, span) => total + span.length, 0));
    let written = 0;
    for (const span of spans) {
        output.set(data.subarray(span.physical, span.physical + span.length), written);
        written += span.length;
    }
    return output;
}

async function readFromFile(file, layout, offset, length) {
    const end = Math.min(offset + length, layout.size);
    if (!layout.raw) return new Uint8Array(await file.slice(offset, Math.max(offset, end)).arrayBuffer());
    const output = new Uint8Array(Math.max(0, end - offset));
    let written = 0;
    for (let chunkStart = offset; chunkStart < end; chunkStart += FILE_READ_CHUNK) {
        const spans = rawSpans(layout, chunkStart, Math.min(FILE_READ_CHUNK, end - chunkStart));
        const physicalStart = spans[0].physical;
        const last = spans[spans.length - 1];
        const physical = new Uint8Array(await file.slice(physicalStart, last.physical + last.length).arrayBuffer());
        for (const span of spans) {
            output.set(physical.subarray(span.physical - physicalStart, span.physical - physicalStart + span.length), written);
            written += span.length;
        }
    }
    return output;
}

function isJoliet(data, offset) {
    const escape = latin1Decode(data.subarray(offset + 88, offset + 91));
    return JOLIET_ESCAPES.includes(escape);
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

function* rootRecord() {
    let primary = null;
    let joliet = null;
    for (let sector = DESCRIPTOR_SECTOR; sector < DESCRIPTOR_SECTOR + DESCRIPTOR_LIMIT; sector++) {
        const descriptor = yield { offset: sector * SECTOR_SIZE, length: SECTOR_SIZE };
        if (descriptor.length < SECTOR_SIZE || !hasIdentifier(descriptor, 0)) break;
        const type = descriptor[0];
        if (type === TERMINATOR_DESCRIPTOR) break;
        const root = descriptor.slice(ROOT_RECORD_OFFSET, ROOT_RECORD_OFFSET + ROOT_RECORD_SIZE);
        if (type === PRIMARY_DESCRIPTOR && !primary) primary = root;
        if (type === SUPPLEMENTARY_DESCRIPTOR && !joliet && isJoliet(descriptor, 0)) joliet = root;
    }
    if (!joliet && !primary) throw new Error("No ISO 9660 volume descriptor");
    return { record: joliet ?? primary, joliet: Boolean(joliet) };
}

function* walk(record, path, joliet, members, visited, depth) {
    if (depth > MAX_DEPTH || visited.has(record.extent)) return;
    visited.add(record.extent);
    const directory = yield { offset: record.extent * SECTOR_SIZE, length: record.size };
    let position = 0;
    while (position < directory.length) {
        const length = directory[position];
        if (!length) {
            position = (Math.floor(position / SECTOR_SIZE) + 1) * SECTOR_SIZE;
            continue;
        }
        if (position + 33 > directory.length) break;
        const child = readRecord(directory, position, joliet);
        position += length;
        if (child.special || !child.name) continue;
        const childPath = path ? `${path}/${child.name}` : child.name;
        if (child.directory) yield* walk(child, childPath, joliet, members, visited, depth + 1);
        else members.push({ name: childPath, offset: child.extent * SECTOR_SIZE, size: child.size });
    }
}

function* listing() {
    const root = yield* rootRecord();
    const members = [];
    yield* walk(readRecord(root.record, 0, root.joliet), "", root.joliet, members, new Set(), 0);
    return { members, joliet: root.joliet };
}

function clampMember(layout, member) {
    const offset = Math.min(member.offset, layout.size);
    return { ...member, offset, size: Math.min(member.size, layout.size - offset) };
}

export function readIso(data) {
    const layout = discLayout(data, data.length);
    if (!layout) throw new Error("No ISO 9660 volume descriptor");
    const steps = listing();
    let step = steps.next();
    while (!step.done) step = steps.next(readFromBytes(data, layout, step.value.offset, step.value.length));
    const members = step.value.members.map((member) => clampMember(layout, member)).map((member) => ({ name: member.name, data: readFromBytes(data, layout, member.offset, member.size) }));
    return { members, joliet: step.value.joliet, raw: layout.raw };
}

export async function readIsoFile(file) {
    const head = new Uint8Array(await file.slice(0, DISC_HEAD_SIZE).arrayBuffer());
    const layout = discLayout(head, file.size);
    if (!layout) return null;
    const steps = listing();
    let step = steps.next();
    while (!step.done) step = steps.next(await readFromFile(file, layout, step.value.offset, step.value.length));
    const members = step.value.members.map((member) => clampMember(layout, member)).map((member) => ({
        name: member.name,
        size: member.size,
        read: (start = 0, length = member.size - start) => readFromFile(file, layout, member.offset + start, Math.max(0, Math.min(length, member.size - start))),
    }));
    return { members, joliet: step.value.joliet, raw: layout.raw };
}
