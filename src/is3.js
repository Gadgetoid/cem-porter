import { blast } from "./blast.js";
import { u16, u32 } from "./pe.js";

export const IS3_SIGNATURE = [0x13, 0x5d, 0x65, 0x8c];

const utf8 = new TextDecoder("utf-8", { fatal: true });

function ensureAvailable(data, offset, size) {
    if (offset < 0 || offset + size > data.length) throw new RangeError("InstallShield 3 archive is truncated");
}

function joinPath(directory, name) {
    if (name.startsWith("/") || directory === "") return name;
    return directory.endsWith("/") ? directory + name : directory + "/" + name;
}

export function isIs3(data) {
    return IS3_SIGNATURE.every((byte, index) => data[index] === byte);
}

export function extractIs3(data) {
    ensureAvailable(data, 0, 0x33);
    const fileCount = u16(data, 0x0c);
    const tableOffset = u32(data, 0x29);
    const directoryCount = u16(data, 0x31);
    let position = tableOffset;
    const directories = [];
    for (let index = 0; index < directoryCount; index++) {
        ensureAvailable(data, position, 6);
        const count = u16(data, position);
        const chunk = u16(data, position + 2);
        const nameLength = u16(data, position + 4);
        const name = utf8.decode(data.subarray(position + 6, position + 6 + nameLength));
        for (let repeat = 0; repeat < count; repeat++) directories.push(name);
        position += chunk;
    }
    const members = [];
    for (let index = 0; index < fileCount; index++) {
        ensureAvailable(data, position + 3, 12);
        const size = u32(data, position + 3);
        const compressedSize = u32(data, position + 7);
        const offset = u32(data, position + 11);
        ensureAvailable(data, position + 23, 2);
        const chunk = u16(data, position + 23);
        ensureAvailable(data, position + 29, 1);
        const nameLength = data[position + 29];
        const name = utf8.decode(data.subarray(position + 30, position + 30 + nameLength));
        position += chunk;
        const content = blast(data.subarray(offset, offset + compressedSize));
        if (content.length !== size) throw new Error(`${name}: ${content.length} != ${size}`);
        if (index >= directories.length) throw new RangeError("InstallShield 3 file has no directory");
        members.push({ name: joinPath(directories[index], name), data: content });
    }
    return members;
}
