import { cpkName, expandCpk, isCpk } from "./cpk.js";
import { u16, u32 } from "./pe.js";

const HEADER_SIZE = 0x100;
const PLATFORM_OFFSET = 8;
const PLATFORM_LIMIT = 0x40;
const ENTRY_FIXED = 9;
const MINIMUM_ENTRY = 12;

function platformName(data) {
    let text = "";
    for (let offset = PLATFORM_OFFSET; offset + 1 < PLATFORM_LIMIT; offset += 2) {
        const code = u16(data, offset);
        if (!code) break;
        text += String.fromCharCode(code);
    }
    return text;
}

export function looksLikeCbea(data) {
    return data.length >= HEADER_SIZE && /^Casio /.test(platformName(data));
}

export function isCbea(data) {
    if (data.length < HEADER_SIZE + MINIMUM_ENTRY) return false;
    if (!/^Casio /.test(platformName(data))) return false;
    const size = u32(data, HEADER_SIZE);
    if (!size || HEADER_SIZE + 4 + size > data.length) return false;
    const nameLength = data[HEADER_SIZE + 7];
    if (!nameLength) return false;
    return size === nameLength + ENTRY_FIXED + u32(data, HEADER_SIZE + 8 + nameLength + 1);
}

export function readCbea(data) {
    const members = [];
    let position = HEADER_SIZE;
    while (position + MINIMUM_ENTRY <= data.length) {
        const size = u32(data, position);
        if (!size || position + 4 + size > data.length) break;
        const nameLength = data[position + 7];
        let name = "";
        for (let index = 0; index < nameLength; index++) name += String.fromCharCode(data[position + 8 + index]);
        const length = u32(data, position + 8 + nameLength + 1);
        if (size !== nameLength + ENTRY_FIXED + length) break;
        const start = position + 8 + nameLength + 1 + 4;
        let member = data.subarray(start, start + length);
        if (isCpk(member)) {
            try {
                member = expandCpk(member).data;
                name = cpkName(name);
            } catch {
                // leave the member packed if it will not expand
            }
        }
        members.push({ name, data: member });
        position += 4 + size;
    }
    return members;
}

export function cbeaPlatform(data) {
    return platformName(data);
}
