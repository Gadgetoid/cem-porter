import { u16, u32 } from "./pe.js";
import { decodeText } from "./romtree.js";

const LIST_MAX = 65536;
const DEPTH_MAX = 64;
const RGDB_MAGIC = 0x42444752;
const RGDB_BLOCK_SIZE = 0x1000;
const RGDB_BLOCK_HEADER = 0x18;
const RGDB_ROOT_MARKER = 0x08;
const RGDB_KEY = 4;
const RGDB_VALUE = 5;
const HIVE_MAGIC = 0x1d8374b2;
const HIVE_HEADER = 8;
const HIVE_KEY = 1;
const HIVE_VALUE = 2;
const HIVE_DEFAULT = "Default";

export const ROOT_KEYS = ["HKEY_CLASSES_ROOT", "HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE", "HKEY_USERS"];
const ROOT_ALIASES = { HKCR: 0, HKCU: 1, HKLM: 2, HKU: 3 };
export const REGISTRY_TYPES = { 0: "REG_NONE", 1: "REG_SZ", 2: "REG_EXPAND_SZ", 3: "REG_BINARY", 4: "REG_DWORD", 5: "REG_DWORD_BIG_ENDIAN", 6: "REG_LINK", 7: "REG_MULTI_SZ" };

const utf16 = new TextDecoder("utf-16le");

function text(data, offset, units) {
    return utf16.decode(data.subarray(offset, offset + 2 * units)).replace(/\0[\s\S]*$/, "");
}

function newKey(name, parent) {
    return { name, className: "", parent, keys: [], values: [] };
}

export function readRgdb(file) {
    const record = (offset, type, minimum) => {
        if (!offset || offset + 4 > file.length) return null;
        const size = u16(file, offset);
        if (file[offset + 2] !== type || size < minimum || offset + size > file.length) return null;
        return { offset, size };
    };
    const fill = (key, firstChild, firstValue, depth) => {
        let steps = 0;
        for (let offset = firstValue; offset && steps < LIST_MAX; steps++) {
            const value = record(offset, RGDB_VALUE, 12);
            if (!value || 12 + file[offset + 8] + u16(file, offset + 10) > value.size) {
                key.damaged = true;
                break;
            }
            const nameBytes = file[offset + 8];
            const start = offset + 12 + nameBytes;
            key.values.push({ name: text(file, offset + 12, nameBytes >> 1), type: file[offset + 9], data: file.slice(start, start + u16(file, offset + 10)) });
            offset = u32(file, offset + 4);
        }
        if (depth > DEPTH_MAX) return;
        steps = 0;
        for (let offset = firstChild; offset && steps < LIST_MAX; steps++) {
            const found = record(offset, RGDB_KEY, 24);
            if (!found) {
                key.damaged = true;
                break;
            }
            const nameBytes = Math.min(file[offset + 20], found.size - 24);
            const classBytes = Math.min(file[offset + 21], found.size - 24 - nameBytes);
            const child = newKey(text(file, offset + 24, nameBytes >> 1), key);
            child.className = text(file, offset + 24 + nameBytes, classBytes >> 1);
            key.keys.push(child);
            fill(child, u32(file, offset + 4), u32(file, offset + 12), depth + 1);
            offset = u32(file, offset + 8);
        }
    };
    const roots = [];
    ROOT_KEYS.forEach((name, index) => {
        for (let offset = RGDB_BLOCK_HEADER; offset + 4 <= Math.min(RGDB_BLOCK_SIZE, file.length); ) {
            const size = u16(file, offset);
            if (!size) break;
            if (record(offset, RGDB_KEY, 24) && file[offset + 19] === RGDB_ROOT_MARKER && file[offset + 16] === index) {
                const key = newKey(name, null);
                fill(key, u32(file, offset + 4), u32(file, offset + 12), 0);
                roots.push(key);
                break;
            }
            offset += size;
        }
    });
    return roots;
}

function makeRoots() {
    return ROOT_KEYS.map((name) => newKey(name, null));
}

function usedRoots(roots) {
    return roots.filter((root) => root.keys.length || root.values.length);
}

function findOrAddKey(root, parts) {
    let key = root;
    for (const part of parts) {
        let child = key.keys.find((candidate) => candidate.name.toLowerCase() === part.toLowerCase());
        if (!child) {
            child = newKey(part, key);
            key.keys.push(child);
        }
        key = child;
    }
    return key;
}

function readHive(file) {
    const roots = makeRoots();
    const end = Math.min(file.length, u32(file, 4));
    let key = null;
    let damaged = false;
    for (let offset = HIVE_HEADER; offset + 4 <= end; ) {
        const size = u16(file, offset);
        const kind = u16(file, offset + 2);
        const body = offset + 4;
        if (!size || body + size > end) {
            damaged = true;
            break;
        }
        if (kind === HIVE_KEY && size >= 6) {
            const root = roots[u16(file, body)];
            const units = u16(file, body + 2);
            if (!root || 6 + 2 * units > size) {
                damaged = true;
                key = null;
            } else {
                key = findOrAddKey(root, text(file, body + 6, units).split("\\").filter(Boolean));
            }
        } else if (kind === HIVE_VALUE && size >= 6 && key) {
            const units = u16(file, body + 2);
            const length = u16(file, body + 4);
            const start = body + 6 + 2 * units;
            if (6 + 2 * units + length > size) damaged = true;
            else {
                const name = text(file, body + 6, units);
                key.values.push({ name: name === HIVE_DEFAULT ? "" : name, type: u16(file, body), data: file.slice(start, start + length) });
            }
        } else {
            damaged = true;
        }
        offset = body + size;
    }
    return { roots: usedRoots(roots), damaged };
}

function encodeString(value) {
    const data = new Uint8Array(2 * value.length + 2);
    for (let index = 0; index < value.length; index++) {
        data[2 * index] = value.charCodeAt(index) & 0xff;
        data[2 * index + 1] = value.charCodeAt(index) >> 8;
    }
    return data;
}

function unquote(value) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function hexBytes(list) {
    return Uint8Array.from(list.split(",").map((part) => part.trim()).filter(Boolean).map((part) => parseInt(part, 16)));
}

function parseData(raw) {
    if (raw.startsWith('"')) return { type: 1, data: encodeString(unquote(raw)) };
    const dword = raw.match(/^dword:\s*([0-9a-f]{1,8})$/i);
    if (dword) {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, parseInt(dword[1], 16), true);
        return { type: 4, data };
    }
    const multi = raw.match(/^multi_sz:\s*(.*)$/i);
    if (multi) {
        const strings = [...multi[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
        return { type: 7, data: encodeString(strings.join("\0") + "\0") };
    }
    const binary = raw.match(/^hex(?:\(([0-9a-f]+)\))?:\s*(.*)$/i);
    if (binary) return { type: binary[1] ? parseInt(binary[1], 16) : 3, data: hexBytes(binary[2]) };
    return null;
}

function splitValue(line) {
    if (line.startsWith("@")) return line[1] === "=" ? ["", line.slice(2)] : null;
    const match = line.match(/^"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/);
    return match ? [match[1].replace(/\\(.)/g, "$1"), match[2]] : null;
}

function readText(source) {
    const roots = makeRoots();
    const lines = source.replace(/\\\r?\n\s*/g, "").split(/\r?\n/);
    let key = null;
    let damaged = false;
    let deleted = 0;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#") || /^(REGEDIT4|Windows Registry Editor)/i.test(line)) continue;
        if (line.startsWith("[")) {
            const path = line.replace(/^\[|\]$/g, "");
            if (path.startsWith("-")) {
                deleted++;
                key = null;
                continue;
            }
            const [rootName, ...parts] = path.split("\\").filter(Boolean);
            const rootIndex = ROOT_KEYS.indexOf(rootName?.toUpperCase()) >= 0 ? ROOT_KEYS.indexOf(rootName.toUpperCase()) : ROOT_ALIASES[rootName?.toUpperCase()];
            key = rootIndex === undefined ? null : findOrAddKey(roots[rootIndex], parts);
            if (!key) damaged = true;
            continue;
        }
        const pair = key && splitValue(line);
        if (!pair) {
            damaged = true;
            continue;
        }
        if (pair[1].trim() === "-") {
            deleted++;
            continue;
        }
        const parsed = parseData(pair[1].trim());
        if (!parsed) {
            damaged = true;
            continue;
        }
        const existing = key.values.findIndex((value) => value.name.toLowerCase() === pair[0].toLowerCase());
        const value = { name: pair[0], ...parsed };
        if (existing >= 0) key.values[existing] = value;
        else key.values.push(value);
    }
    return { roots: usedRoots(roots), damaged, deleted };
}

export function readRegistryFile(data) {
    if (data.length >= 4 && u32(data, 0) === RGDB_MAGIC) return { format: "CE 1.x registry hive (RGDB)", roots: readRgdb(data), damaged: false };
    if (data.length >= 8 && u32(data, 0) === HIVE_MAGIC) return { format: "Binary registry file", ...readHive(data) };
    const source = decodeText(data);
    if (!/^﻿?\s*(REGEDIT4|Windows Registry Editor|\[|;)/i.test(source)) return null;
    const result = readText(source);
    return result.roots.length ? { format: "Registry script", ...result } : null;
}

export function countRegistry(roots) {
    let keys = 0;
    let values = 0;
    const walk = (key) => {
        keys++;
        values += key.values.length;
        key.keys.forEach(walk);
    };
    roots.forEach(walk);
    return { keys: keys - roots.length, values };
}

export function formatValue(value) {
    const { type, data } = value;
    if ((type === 4 || type === 5) && data.length >= 4) {
        const number = type === 4 ? u32(data, 0) : new DataView(data.buffer, data.byteOffset).getUint32(0, false);
        return `0x${number.toString(16).padStart(8, "0")} (${number})`;
    }
    if (type === 1 || type === 2) return text(data, 0, data.length >> 1);
    if (type === 7) return utf16.decode(data.subarray(0, data.length & ~1)).replace(/\0+$/, "").split("\0").join(" | ");
    return [...data.subarray(0, 256)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ") + (data.length > 256 ? " ..." : "");
}

function regString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function regHex(data) {
    return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join(",");
}

function regValue(value) {
    const name = value.name ? `"${regString(value.name)}"` : "@";
    if (value.type === 1) return `${name}="${regString(text(value.data, 0, value.data.length >> 1))}"`;
    if (value.type === 4 && value.data.length === 4) return `${name}=dword:${u32(value.data, 0).toString(16).padStart(8, "0")}`;
    if (value.type === 3) return `${name}=hex:${regHex(value.data)}`;
    return `${name}=hex(${value.type.toString(16)}):${regHex(value.data)}`;
}

export function keyPath(key) {
    const parts = [];
    for (let current = key; current; current = current.parent) parts.unshift(current.name);
    return parts.join("\\");
}

export function registryText(roots) {
    const lines = ["REGEDIT4", ""];
    const walk = (key) => {
        lines.push(`[${keyPath(key)}]`, ...key.values.map(regValue), "");
        key.keys.forEach(walk);
    };
    roots.forEach(walk);
    return lines.join("\r\n");
}
