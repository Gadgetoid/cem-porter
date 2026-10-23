import { blast } from "./blast.js";
import { readCabinet } from "./cabread.js";
import { inflateRaw } from "./inflate.js";
import { extractIs3, isIs3, IS3_SIGNATURE } from "./is3.js";
import { extractIs5, isIs5 } from "./is5.js";
import { isLzh, scanLzh } from "./lzh.js";
import { isPe, readSections, u16, u32 } from "./pe.js";
import { findBytes, hasEndRecordNearEnd, readLocalEntries, readZip, readZipLeniently, tryDecodeCp932 } from "./zip.js";

export const MAX_DEPTH = 6;

const MACHINE_X86 = 0x14c;
const EMBEDDED_SEARCH_MINIMUM_SIZE = 16384;
const ZIP_LOCAL_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const CAB_SIGNATURE = [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0];
const SZDD_SIGNATURE = [0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33];
const LZH_MARKERS = ["-lh5-", "-lh6-", "-lh7-", "-lh0-", "-lh1-"];
const SZDD_WINDOW_SIZE = 4096;
const MINIMUM_BLAST_OUTPUT = 64;
const CARVE_PROBE_SIZE = 256;
const CARVE_TAIL = 64;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function asBytes(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function startsWith(data, signature, offset = 0) {
    return signature.every((byte, index) => data[offset + index] === byte);
}

function latin1Bytes(text) {
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function asciiBytes(text) {
    return Array.from(text, (character) => character.charCodeAt(0));
}

function hex(value) {
    return "0x" + value.toString(16);
}

export function safeName(name) {
    const parts = name.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== "." && part !== "..");
    return parts.join("/") || "unnamed";
}

function baseName(name) {
    return name.slice(name.lastIndexOf("/") + 1);
}

function folderName(name) {
    const slash = name.lastIndexOf("/");
    return slash < 0 ? "" : name.slice(0, slash);
}

function joinPath(directory, name) {
    return directory ? directory + "/" + name : name;
}

function folderKey(path) {
    return path.normalize("NFC").toLowerCase();
}

class FileTree {
    constructor() {
        this.directories = new Map();
        this.files = new Map();
    }

    resolve(path) {
        const parts = path.split("/").filter((part) => part !== "" && part !== ".");
        let directory = "";
        for (const part of parts.slice(0, -1)) {
            const candidate = joinPath(directory, part);
            const key = folderKey(candidate);
            if (!this.directories.has(key)) this.directories.set(key, candidate);
            directory = this.directories.get(key);
        }
        return joinPath(directory, parts[parts.length - 1]);
    }

    write(path, data) {
        const resolved = this.resolve(path);
        const key = folderKey(resolved);
        const existing = this.files.get(key);
        if (existing) existing.data = data;
        else this.files.set(key, { path: resolved, data });
    }

    list() {
        return [...this.files.values()];
    }
}

function containsParentReference(name) {
    return name.split("/").includes("..");
}

function extractLikeBsdtar(entries, failedToRead) {
    const decodeAsLocale = (entry) => entry.name ?? decodeUtf8(entry.nameBytes);
    const decodeAsCp932 = (entry) => entry.name ?? tryDecodeCp932(entry.nameBytes);
    let { tree, failed } = writeEntries(entries, decodeAsLocale);
    let returnCode = failedToRead || failed;
    if (returnCode && tree.list().length === 0) {
        ({ tree, failed } = writeEntries(entries, decodeAsCp932));
        returnCode = failedToRead || failed;
    }
    const members = tree.list().map((file) => ({ name: file.path, data: file.data }));
    if (returnCode && members.length === 0) return null;
    return members;
}

function decodeUtf8(bytes) {
    try {
        return utf8.decode(bytes);
    } catch {
        return null;
    }
}

function writeEntries(entries, decode) {
    const tree = new FileTree();
    let failed = false;
    for (const entry of entries) {
        const name = decode(entry);
        if (name === null) {
            failed = true;
            break;
        }
        if (containsParentReference(name)) {
            failed = true;
            continue;
        }
        const path = name.replace(/^\/+/, "");
        if (!path || path.endsWith("/")) continue;
        tree.write(path, entry.data);
    }
    return { tree, failed };
}

function cabinetEntries(data) {
    try {
        const members = readCabinet(data);
        return { entries: members.map((member) => cabinetEntry(member)), failed: false };
    } catch {
        return { entries: [], failed: true };
    }
}

function cabinetEntry(member) {
    const name = member.name.replaceAll("\\", "/");
    const isLatin1 = [...name].every((character) => character.charCodeAt(0) < 256);
    if (!isLatin1) return { name, data: member.data };
    return { name: null, nameBytes: latin1Bytes(name), data: member.data };
}

function readCabinetLikeBsdtar(data) {
    const { entries, failed } = cabinetEntries(data);
    return extractLikeBsdtar(entries, failed);
}

function readLzhLikeBsdtar(data) {
    const { members, error } = scanLzh(data);
    const entries = members.map((member) => ({ name: null, nameBytes: member.nameBytes, data: member.data }));
    return extractLikeBsdtar(entries, Boolean(error));
}

function readZipLikeBsdtar(data) {
    const { members, error } = readZipLeniently(data);
    const entries = members.map((member) => ({ name: member.name, nameBytes: member.nameBytes, data: member.data }));
    return extractLikeBsdtar(entries, Boolean(error));
}

function readIs3(data) {
    const members = extractIs3(data);
    const latest = new Map();
    for (const member of members) latest.set(folderKey(member.name), member.data);
    return members.map((member) => ({ name: member.name, data: latest.get(folderKey(member.name)) }));
}

function tryReadIs3(data) {
    try {
        return readIs3(data);
    } catch {
        return null;
    }
}

function readIs5(name, data, siblings) {
    const path = safeName(name);
    const volume = /^([^.\d]*)(\d+)\.cab$/i.exec(baseName(path));
    if (!volume || Number(volume[2]) !== 1) return null;
    const prefix = volume[1].toLowerCase();
    const volumes = new Map([[1, data]]);
    let header = data;
    for (const sibling of siblings) {
        const siblingPath = safeName(sibling.name);
        if (folderName(siblingPath) !== folderName(path)) continue;
        const match = /^([^.\d]*)(\d+)\.(cab|hdr)$/i.exec(baseName(siblingPath));
        if (!match || match[1].toLowerCase() !== prefix || !isIs5(sibling.data)) continue;
        if (match[3].toLowerCase() === "hdr" && Number(match[2]) === 1) header = sibling.data;
        else if (match[3].toLowerCase() === "cab" && Number(match[2]) > 1) volumes.set(Number(match[2]), sibling.data);
    }
    try {
        const { members, failed } = extractIs5(header, volumes);
        return extractLikeBsdtar(members.map((member) => ({ name: null, nameBytes: member.nameBytes, data: member.data })), failed);
    } catch {
        return null;
    }
}

export function expandSzdd(data) {
    const missingChar = data.length > 9 ? data[9] : null;
    const expandedSize = u32(data, 10);
    const window = new Uint8Array(SZDD_WINDOW_SIZE).fill(0x20);
    let windowPosition = SZDD_WINDOW_SIZE - 16;
    const output = new Uint8Array(expandedSize);
    let written = 0;
    let source = 14;
    const put = (byte) => {
        output[written++] = byte;
        window[windowPosition] = byte;
        windowPosition = (windowPosition + 1) & (SZDD_WINDOW_SIZE - 1);
    };
    while (source < data.length && written < expandedSize) {
        const control = data[source++];
        for (let bit = 0; bit < 8; bit++) {
            if (source >= data.length || written >= expandedSize) break;
            if (control & (1 << bit)) {
                put(data[source++]);
                continue;
            }
            if (source + 1 >= data.length) break;
            const low = data[source];
            const high = data[source + 1];
            source += 2;
            const matchPosition = low | ((high & 0xf0) << 4);
            const length = (high & 0x0f) + 3;
            for (let index = 0; index < length; index++) put(window[(matchPosition + index) & (SZDD_WINDOW_SIZE - 1)]);
        }
    }
    return { data: output.slice(0, written), missingChar };
}

export function szddName(name, missingChar) {
    if ((name.endsWith("_") || name.endsWith("$")) && missingChar) {
        return name.slice(0, -1) + String.fromCharCode(missingChar).toLowerCase();
    }
    return name;
}

function tryBlast(data) {
    if (data.length < 4 || (data[0] !== 0 && data[0] !== 1) || data[1] < 4 || data[1] > 6) return null;
    try {
        const output = blast(data);
        return output.length > MINIMUM_BLAST_OUTPUT ? output : null;
    } catch {
        return null;
    }
}

function startsWithZipOrPe(output) {
    return (output[0] === 0x4d && output[1] === 0x5a) || (output[0] === 0x50 && output[1] === 0x4b);
}

function isCarvedPayload(output) {
    return isPe(output) || startsWith(output, ZIP_LOCAL_SIGNATURE);
}

function probeDeflate(data, position) {
    const { output, error } = inflateRaw(data, { start: position, end: position + CARVE_PROBE_SIZE, maxOutput: 2 });
    return !error && output.length === 2 && startsWithZipOrPe(output);
}

export function carveDeflate(data, start) {
    const carved = [];
    let position = start;
    const limit = data.length - CARVE_TAIL;
    while (position < limit) {
        if (!probeDeflate(data, position)) {
            position++;
            continue;
        }
        const result = inflateRaw(data, { start: position });
        if (result.finished && isCarvedPayload(result.output)) {
            carved.push({ offset: position, data: result.output });
            position = result.end;
        } else {
            position++;
        }
    }
    return carved;
}

export function overlayStart(data) {
    let end = 0;
    for (const section of readSections(data)) end = Math.max(end, section.rawOffset + section.rawSize);
    return end;
}

function findEmbeddedCabinet(data, start) {
    for (const searchStart of [start, 0]) {
        let offset = findBytes(data, CAB_SIGNATURE, searchStart);
        while (offset >= 0) {
            const members = readCabinetLikeBsdtar(data.subarray(offset)) ?? [];
            if (members.length) return { members, method: `embedded cab at ${hex(offset)}` };
            offset = findBytes(data, CAB_SIGNATURE, offset + 4);
        }
    }
    return null;
}

function findEmbeddedLzh(data, start) {
    for (const marker of LZH_MARKERS) {
        const index = findBytes(data, asciiBytes(marker), start);
        if (index < 2) continue;
        const members = readLzhLikeBsdtar(data.subarray(index - 2)) ?? [];
        if (members.length) return { members, method: `embedded LHA archive at ${hex(index - 2)}` };
    }
    return null;
}

export function findEmbedded(data, start) {
    const zipOffset = findBytes(data, ZIP_LOCAL_SIGNATURE, start);
    if (zipOffset >= 0) {
        const members = readLocalEntries(data, zipOffset);
        if (members.length) return { members, method: `embedded zip entries from ${hex(zipOffset)}` };
    }
    const cabinet = findEmbeddedCabinet(data, start);
    if (cabinet) return cabinet;
    const is3Offset = findBytes(data, IS3_SIGNATURE, start);
    if (is3Offset >= 0) {
        const members = tryReadIs3(data.subarray(is3Offset)) ?? [];
        if (members.length) return { members, method: `embedded InstallShield 3 archive at ${hex(is3Offset)}` };
    }
    const lzh = findEmbeddedLzh(data, start);
    if (lzh) return lzh;
    const members = carveDeflate(data, start).map(({ offset, data: output }) => ({
        name: "carved_" + offset.toString(16).padStart(6, "0") + (isPe(output) ? ".exe" : ".zip"),
        data: output,
    }));
    return { members, method: "raw deflate streams carved from installer" };
}

function peMachine(data) {
    return u16(data, u32(data, 0x3c) + 4);
}

function tryReadZip(data) {
    try {
        return readZip(data);
    } catch {
        return null;
    }
}

export function membersOf(name, data, siblings = []) {
    const lower = name.toLowerCase();
    if (startsWith(data, ZIP_LOCAL_SIGNATURE) || (lower.endsWith(".zip") && hasEndRecordNearEnd(data))) {
        const members = tryReadZip(data);
        if (members) return { members, method: "zip" };
        const fallback = readZipLikeBsdtar(data);
        if (fallback !== null) return { members: fallback, method: "zip (bsdtar)" };
    }
    if (startsWith(data, CAB_SIGNATURE.slice(0, 4))) return { members: readCabinetLikeBsdtar(data), method: "cab" };
    if (isLzh(data)) return { members: readLzhLikeBsdtar(data), method: "lzh" };
    if (isIs3(data)) {
        const members = tryReadIs3(data);
        return { members, method: members ? "InstallShield 3 archive" : null };
    }
    if (isIs5(data)) {
        const members = readIs5(name, data, siblings);
        if (members) return { members, method: "InstallShield cabinet" };
    }
    if (startsWith(data, SZDD_SIGNATURE)) {
        const expanded = expandSzdd(data);
        return { members: [{ name: baseName(szddName(name, expanded.missingChar)), data: expanded.data }], method: "SZDD" };
    }
    if ((lower.endsWith("_") || lower.endsWith("$")) && !isPe(data)) {
        const expanded = tryBlast(data);
        if (expanded) return { members: [{ name: baseName(name.slice(0, -1) + "?"), data: expanded }], method: "PKWARE DCL" };
    }
    if (isPe(data) && peMachine(data) === MACHINE_X86 && data.length > EMBEDDED_SEARCH_MINIMUM_SIZE) {
        const start = overlayStart(data);
        const embedded = findEmbedded(data, start < data.length ? start : 0);
        if (embedded.members.length) return embedded;
    }
    return { members: null, method: null };
}

function unpackInto(name, data, directory, tree, log, depth, siblings = []) {
    const { members, method } = depth > MAX_DEPTH ? { members: null, method: null } : membersOf(name, data, siblings);
    if (members === null) {
        tree.write(joinPath(directory, safeName(name)), data);
        return;
    }
    const folder = joinPath(directory, safeName(name) + ".d");
    log.push({ container: folder, method, members: members.length });
    for (const member of members) unpackInto(member.name, member.data, folder, tree, log, depth + 1, members);
}

export function unpack(name, data) {
    const tree = new FileTree();
    const log = [];
    unpackInto(name, asBytes(data), "", tree, log, 0);
    return { files: tree.list(), log };
}
