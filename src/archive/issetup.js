import { u16, u32 } from "../pe/pe.js";

const SIGNATURE = [0x49, 0x6e, 0x73, 0x74, 0x61, 0x6c, 0x6c, 0x53, 0x68, 0x69, 0x65, 0x6c, 0x64, 0x00];
const HEADER_SIZE = 0x2e;
const ENTRY_SIZE = 312;
const NAME_SIZE = 260;
const ENCODED = 0x02;
const ENCODED_IN_BLOCKS = 0x04;
const BLOCK_SIZE = 1024;
const KEY_MAGIC = [0x13, 0x35, 0x86, 0x07];

function ensureAvailable(data, offset, size) {
    if (offset + size > data.length) throw new RangeError("InstallShield setup stream is truncated");
}

function decode(data, name, inBlocks) {
    const key = Uint8Array.from(name, (character, index) =>
        (character.charCodeAt(0) & 0xff) ^ KEY_MAGIC[index % KEY_MAGIC.length]);
    const out = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) {
        const position = inBlocks ? index % BLOCK_SIZE : index;
        const byte = data[index];
        out[index] = ~(key[position % key.length] ^ ((byte << 4) | (byte >>> 4))) & 0xff;
    }
    return out;
}

export function isIsSetup(data, offset) {
    return offset + HEADER_SIZE <= data.length && SIGNATURE.every((byte, index) => data[offset + index] === byte);
}

export function readIsSetup(data, offset) {
    if (!isIsSetup(data, offset)) return null;
    const count = u16(data, offset + SIGNATURE.length);
    let position = offset + HEADER_SIZE;
    const members = [];
    for (let index = 0; index < count; index++) {
        ensureAvailable(data, position, ENTRY_SIZE);
        const field = data.subarray(position, position + NAME_SIZE);
        const end = field.indexOf(0);
        const name = String.fromCharCode(...field.subarray(0, end < 0 ? NAME_SIZE : end));
        const flags = u32(data, position + NAME_SIZE);
        const length = u32(data, position + NAME_SIZE + 8);
        position += ENTRY_SIZE;
        ensureAvailable(data, position, length);
        const stored = data.subarray(position, position + length);
        position += length;
        const encoded = flags & (ENCODED | ENCODED_IN_BLOCKS);
        members.push({ name, data: encoded ? decode(stored, name, (flags & ENCODED_IN_BLOCKS) !== 0) : stored.slice() });
    }
    return members;
}
