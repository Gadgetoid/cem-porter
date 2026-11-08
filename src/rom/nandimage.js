import { lzssDecode } from "./romlz.js";
import { u32 } from "../pe/pe.js";

const SECTOR = 512;
const TABLE_ENTRIES = 4;
const ENTRY_SIZE = 16;
const ENTRY_TAG_SIZE = 8;
const SIGNATURE = "B000FF\n";
const SIGNATURE_BYTES = [0x42, 0x30, 0x30, 0x30, 0x46, 0x46, 0x0a];
const PROBE_BYTES = 0x400;

function blankTag(data, offset) {
    for (let index = 0; index < ENTRY_TAG_SIZE; index++) {
        if (data[offset + index] !== 0xff) return false;
    }
    return true;
}

function startsWithSignature(data) {
    if (data.length < SIGNATURE_BYTES.length) return false;
    return SIGNATURE_BYTES.every((byte, index) => data[index] === byte);
}

export function splitNandPartitions(data) {
    if (data.length % SECTOR || data.length < TABLE_ENTRIES * ENTRY_SIZE) return null;
    const sectors = data.length / SECTOR;
    const partitions = [];
    let next = 0;
    for (let index = 0; index < TABLE_ENTRIES; index++) {
        const offset = index * ENTRY_SIZE;
        if (!blankTag(data, offset)) return null;
        const start = u32(data, offset + ENTRY_TAG_SIZE);
        const count = u32(data, offset + ENTRY_TAG_SIZE + 4);
        if (start !== next || !count || start + count > sectors) return null;
        partitions.push({ index, start, count, data: data.subarray(start * SECTOR, (start + count) * SECTOR) });
        next = start + count;
    }
    if (next !== sectors) return null;
    return partitions;
}

export function nandBinImages(data) {
    const partitions = splitNandPartitions(data);
    if (!partitions) return null;
    const images = [];
    for (const partition of partitions) {
        if (startsWithSignature(partition.data)) {
            images.push({ partition, data: partition.data, compressed: false });
            continue;
        }
        if (!startsWithSignature(lzssDecode(partition.data.subarray(0, PROBE_BYTES), SIGNATURE.length))) continue;
        images.push({ partition, data: lzssDecode(partition.data), compressed: true });
    }
    return images.length ? images : null;
}
