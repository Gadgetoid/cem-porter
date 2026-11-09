import { unrarBytes } from "../../vendor/bitjs/archive/unrar.js";
import { crc32 } from "./zip.js";

const MARKER = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const DIRECTORY = 0xe0;
const ENCRYPTED = 0x04;
const SPLIT = 0x03;

function markerAt(data, offset) {
    return MARKER.every((byte, index) => data[offset + index] === byte);
}

export function isRar(data) {
    return data.length >= MARKER.length && markerAt(data, 0);
}

export function findRar(data, start = 0) {
    for (let offset = data.indexOf(MARKER[0], start); offset >= 0; offset = data.indexOf(MARKER[0], offset + 1)) {
        if (markerAt(data, offset)) return offset;
    }
    return -1;
}

export function readRar(data, offset = 0) {
    const { files, messages } = unrarBytes(data.subarray(offset));
    const members = [];
    const failures = [];
    for (const file of files) {
        if ((file.flags & DIRECTORY) === DIRECTORY) continue;
        if (file.flags & ENCRYPTED) {
            failures.push({ name: file.name, reason: "encrypted" });
        } else if (file.flags & SPLIT) {
            failures.push({ name: file.name, reason: "split across volumes" });
        } else if (!file.data || file.data.length !== file.size || crc32(file.data) !== file.crc) {
            failures.push({ name: file.name, reason: `could not be decoded (RAR ${file.version / 10} method ${file.method - 0x30})` });
        } else {
            members.push({ name: file.name, data: file.data });
        }
    }
    return { members, failures, messages };
}
