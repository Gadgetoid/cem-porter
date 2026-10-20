import { u16, u32 } from "./pe.js";

function decodeLatin1(bytes) {
    let text = "";
    for (let position = 0; position < bytes.length; position += 0x2000) {
        text += String.fromCharCode(...bytes.subarray(position, position + 0x2000));
    }
    return text;
}

function ensureAvailable(data, offset, size) {
    if (offset + size > data.length) throw new RangeError("Setup file is truncated");
}

function text(data, offset, length) {
    const field = data.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return decodeLatin1(end === -1 ? field : field.subarray(0, end));
}

function idList(data, offset, length) {
    const count = Math.floor(length / 2);
    ensureAvailable(data, offset, count * 2);
    const values = [];
    for (let index = 0; index < count; index++) {
        const value = u16(data, offset + 2 * index);
        if (value) values.push(value);
    }
    return values;
}

function words(data, offset, count) {
    ensureAvailable(data, offset, count * 2);
    return Array.from({ length: count }, (_, index) => u16(data, offset + 2 * index));
}

function dwords(data, offset, count) {
    ensureAvailable(data, offset, count * 4);
    return Array.from({ length: count }, (_, index) => u32(data, offset + 4 * index));
}

export function isSetup(data) {
    return data.length >= 4 && data[0] === 0x4d && data[1] === 0x53 && data[2] === 0x43 && data[3] === 0x45;
}

export function readSetup(data) {
    if (!isSetup(data)) return null;
    const counts = words(data, 0x30, 6);
    const offsets = dwords(data, 0x3c, 6);
    const [appOffset, appLength, providerOffset, providerLength, unsupportedOffset, unsupportedLength] = words(data, 0x54, 6);
    const architecture = dwords(data, 0x14, 1)[0];
    const versions = dwords(data, 0x18, 6);

    let position = offsets[0];
    const strings = {};
    for (let index = 0; index < counts[0]; index++) {
        const [identifier, length] = words(data, position, 2);
        strings[identifier] = text(data, position + 4, length);
        position += 4 + length;
    }

    position = offsets[1];
    const directories = {};
    for (let index = 0; index < counts[1]; index++) {
        const [identifier, length] = words(data, position, 2);
        directories[identifier] = idList(data, position + 4, length);
        position += 4 + length;
    }

    position = offsets[2];
    const files = {};
    for (let index = 0; index < counts[2]; index++) {
        ensureAvailable(data, position, 12);
        const [identifier, directory, unknown] = words(data, position, 3);
        const flags = u32(data, position + 6);
        const length = u16(data, position + 10);
        files[identifier] = { directory, flags, name: text(data, position + 12, length), unknown };
        position += 12 + length;
    }

    position = offsets[3];
    const hives = {};
    for (let index = 0; index < counts[3]; index++) {
        const [identifier, hive, unknown, length] = words(data, position, 4);
        hives[identifier] = { hive, spec: idList(data, position + 8, length), unknown };
        position += 8 + length;
    }

    position = offsets[4];
    const keys = [];
    for (let index = 0; index < counts[4]; index++) {
        ensureAvailable(data, position, 12);
        const [, hive, unknown] = words(data, position, 3);
        const flags = u32(data, position + 6);
        const length = u16(data, position + 10);
        keys.push({ hive, flags, data: data.slice(position + 12, position + 12 + length), unknown });
        position += 12 + length;
    }

    position = offsets[5];
    const links = [];
    for (let index = 0; index < counts[5]; index++) {
        const fields = words(data, position, 6);
        const length = fields[5];
        links.push({ fields: fields.slice(0, 5), spec: idList(data, position + 12, length) });
        position += 12 + length;
    }

    return {
        app: text(data, appOffset, appLength),
        provider: text(data, providerOffset, providerLength),
        unsupported: unsupportedLength ? text(data, unsupportedOffset, unsupportedLength) : "",
        architecture,
        versions,
        strings,
        directories,
        files,
        hives,
        keys,
        links,
    };
}

export function setupPath(setup, parts) {
    return parts.map((part) => setup.strings[part] ?? `?${part}`).join("\\");
}
