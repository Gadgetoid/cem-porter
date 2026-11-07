import { u32 } from "./pe.js";

const HEADER_SIZE = 0x100;
const PLATFORM_OFFSET = 8;
const PLATFORM_LIMIT = 0x40;
const ENTRY_FIXED = 9;

const TYPE_INF = 1;
const TYPE_BINARY = 2;
const TYPE_TEXT = 3;

export function memberType(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".inf")) return TYPE_INF;
    if (lower.endsWith(".txt")) return TYPE_TEXT;
    return TYPE_BINARY;
}

function writeU32(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

const ARCHIVE_INFO = [[0, 393472], [136, 4], [140, 15], [148, 3221225472], [152, 276], [156, 3], [164, 126], [168, 3], [180, 1], [184, 4096], [188, 65536], [192, 2147483647], [196, 1], [200, 1], [204, 4000], [208, 65536], [212, 209715204], [220, 3]];

const DESTINATION_OFFSET = 0xdc;
export const PLACE_MAIN_ONLY = 1;
export const PLACE_ALTERNATIVE = 3;

export function cbeaHeader(platform, template, place = PLACE_ALTERNATIVE) {
    const header = new Uint8Array(HEADER_SIZE);
    if (template && template.length >= HEADER_SIZE) {
        header.set(template.subarray(0, HEADER_SIZE));
    } else {
        for (const [offset, value] of ARCHIVE_INFO) writeU32(header, offset, value);
        writeU32(header, DESTINATION_OFFSET, place);
    }
    for (let offset = PLATFORM_OFFSET; offset < PLATFORM_LIMIT; offset++) header[offset] = 0;
    let offset = PLATFORM_OFFSET;
    for (const character of platform) {
        if (offset + 1 >= PLATFORM_LIMIT) break;
        const code = character.charCodeAt(0);
        header[offset] = code & 0xff;
        header[offset + 1] = (code >>> 8) & 0xff;
        offset += 2;
    }
    return header;
}

export function encodeMember(name, data, type) {
    const nameBytes = [];
    for (const character of name) nameBytes.push(character.charCodeAt(0) & 0xff);
    const size = nameBytes.length + ENTRY_FIXED + data.length;
    const entry = new Uint8Array(4 + size);
    writeU32(entry, 0, size);
    entry[4] = 0;
    entry[5] = 0;
    entry[6] = type === undefined ? memberType(name) : type;
    entry[7] = nameBytes.length;
    entry.set(nameBytes, 8);
    entry[8 + nameBytes.length] = 0;
    writeU32(entry, 8 + nameBytes.length + 1, data.length);
    entry.set(data, 8 + nameBytes.length + 1 + 4);
    return entry;
}

export function writeCbea({ platform, template, members, place }) {
    const header = cbeaHeader(platform || "Casio Jx740 CE3.00", template, place);
    const encoded = members.map((member) =>
        encodeMember(member.name, member.data, member.type));
    let total = HEADER_SIZE + 1;
    for (const entry of encoded) total += entry.length;
    const output = new Uint8Array(total);
    output.set(header, 0);
    let position = HEADER_SIZE;
    for (const entry of encoded) {
        output.set(entry, position);
        position += entry.length;
    }
    let check = 0;
    for (let index = 0; index < position; index++) check ^= output[index];
    output[position] = check;
    return output;
}

export function rebuildCbea(original, members) {
    return writeCbea({
        platform: platformOf(original),
        template: original,
        members,
    });
}

function platformOf(data) {
    let text = "";
    for (let offset = PLATFORM_OFFSET; offset + 1 < PLATFORM_LIMIT; offset += 2) {
        const code = u32 && (data[offset] | (data[offset + 1] << 8));
        if (!code) break;
        text += String.fromCharCode(code);
    }
    return text;
}
