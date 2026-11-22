import { u16, u32 } from "./pe.js";

function readPascal(data, offset) {
    let name = "";
    for (let index = 0; index < data[offset]; index++) name += String.fromCharCode(data[offset + 1 + index]);
    return name;
}

export function isNe(data) {
    if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) return false;
    const header = u32(data, 0x3c);
    return header + 0x40 <= data.length && data[header] === 0x4e && data[header + 1] === 0x45;
}

export function readNeResources(data) {
    const header = u32(data, 0x3c);
    const table = header + u16(data, header + 0x24);
    if (table === header || table + 2 > data.length) return [];
    const shift = u16(data, table);
    const key = (value) => (value & 0x8000 ? value & 0x7fff : readPascal(data, table + value));
    const entries = [];
    let offset = table + 2;
    while (offset + 8 <= data.length && u16(data, offset)) {
        const type = key(u16(data, offset));
        const count = u16(data, offset + 2);
        offset += 8;
        for (let index = 0; index < count && offset + 12 <= data.length; index++, offset += 12) {
            const start = u16(data, offset) << shift;
            const size = u16(data, offset + 2) << shift;
            entries.push({ type, name: key(u16(data, offset + 6)), language: 0, data: data.slice(start, start + size) });
        }
    }
    return entries;
}
