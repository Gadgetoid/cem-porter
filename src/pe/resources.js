import { align, Image, setU16, setU32, u16, u32 } from "./pe.js";
import { appendSection } from "../port/traps.js";

const RESOURCE_DIRECTORY = 2;
const RESOURCE_CHARACTERISTICS = 0x40000040;
const DATA_ALIGNMENT = 8;
const DEPTH = 3;

function readName(data, offset) {
    const length = u16(data, offset);
    let name = "";
    for (let index = 0; index < length; index++) name += String.fromCharCode(u16(data, offset + 2 + 2 * index));
    return name;
}

export function readResources(input) {
    const image = new Image(input);
    const [rootRva] = image.directory(RESOURCE_DIRECTORY);
    if (!rootRva) return [];
    const base = image.offset(rootRva);
    const data = image.data;
    const entries = [];
    const visited = new Set();
    const walk = (offset, path) => {
        if (visited.has(offset) || base + offset + 16 > data.length) return;
        visited.add(offset);
        const count = u16(data, base + offset + 12) + u16(data, base + offset + 14);
        for (let index = 0; index < count; index++) {
            const entry = base + offset + 16 + 8 * index;
            const nameField = u32(data, entry);
            const target = u32(data, entry + 4);
            const key = nameField & 0x80000000 ? readName(data, base + (nameField & 0x7fffffff)) : nameField;
            if (target & 0x80000000) {
                if (path.length < DEPTH - 1) walk(target & 0x7fffffff, [...path, key]);
                continue;
            }
            const leaf = base + target;
            const [type, name, language] = [...path, key];
            const rva = u32(data, leaf);
            const size = u32(data, leaf + 4);
            const start = image.offset(rva);
            entries.push({ type, name, language: language ?? 0, codepage: u32(data, leaf + 8), data: data.slice(start, start + size) });
        }
    };
    walk(0, []);
    return entries;
}

function compareKeys(left, right) {
    const leftNamed = typeof left === "string";
    const rightNamed = typeof right === "string";
    if (leftNamed !== rightNamed) return leftNamed ? -1 : 1;
    if (leftNamed) return left.toUpperCase() < right.toUpperCase() ? -1 : left.toUpperCase() > right.toUpperCase() ? 1 : 0;
    return left - right;
}

function group(entries, depth) {
    if (depth === DEPTH) return entries[0];
    const field = ["type", "name", "language"][depth];
    const keys = [...new Set(entries.map((entry) => entry[field]))].sort(compareKeys);
    return keys.map((key) => ({ key, child: group(entries.filter((entry) => entry[field] === key), depth + 1) }));
}

export function buildResources(entries, sectionRva) {
    const tree = group(entries, 0);
    const directories = [];
    const queue = [tree];
    while (queue.length) {
        const directory = queue.shift();
        directories.push(directory);
        for (const item of directory) if (Array.isArray(item.child)) queue.push(item.child);
    }
    const directoryOffsets = new Map();
    let offset = 0;
    for (const directory of directories) {
        directoryOffsets.set(directory, offset);
        offset += 16 + 8 * directory.length;
    }
    const names = [...new Set(directories.flatMap((directory) => directory.map((item) => item.key)).filter((key) => typeof key === "string"))];
    const nameOffsets = new Map();
    for (const name of names) {
        nameOffsets.set(name, offset);
        offset += 2 + 2 * name.length;
    }
    offset = align(offset, 4);
    const leafOffsets = new Map();
    for (const entry of entries) {
        leafOffsets.set(entry, offset);
        offset += 16;
    }
    const dataOffsets = new Map();
    for (const entry of entries) {
        offset = align(offset, DATA_ALIGNMENT);
        dataOffsets.set(entry, offset);
        offset += entry.data.length;
    }
    const output = new Uint8Array(align(offset, 4));
    for (const directory of directories) {
        const start = directoryOffsets.get(directory);
        setU16(output, start + 12, directory.filter((item) => typeof item.key === "string").length);
        setU16(output, start + 14, directory.filter((item) => typeof item.key !== "string").length);
        directory.forEach((item, index) => {
            const entry = start + 16 + 8 * index;
            setU32(output, entry, typeof item.key === "string" ? (0x80000000 | nameOffsets.get(item.key)) >>> 0 : item.key);
            setU32(output, entry + 4, Array.isArray(item.child) ? (0x80000000 | directoryOffsets.get(item.child)) >>> 0 : leafOffsets.get(item.child));
        });
    }
    for (const [name, start] of nameOffsets) {
        setU16(output, start, name.length);
        for (let index = 0; index < name.length; index++) setU16(output, start + 2 + 2 * index, name.charCodeAt(index));
    }
    for (const entry of entries) {
        const leaf = leafOffsets.get(entry);
        setU32(output, leaf, sectionRva + dataOffsets.get(entry));
        setU32(output, leaf + 4, entry.data.length);
        setU32(output, leaf + 8, entry.codepage);
        output.set(entry.data, dataOffsets.get(entry));
    }
    return output;
}

function setResourceDirectory(data, image, rva, size) {
    setU32(data, image.optional + 96 + 8 * RESOURCE_DIRECTORY, rva);
    setU32(data, image.optional + 100 + 8 * RESOURCE_DIRECTORY, size);
}

function writeSection(input, image, section, contents) {
    const rawSize = align(contents.length, image.fileAlignment);
    const output = new Uint8Array(Math.max(input.length, section.rawOffset + rawSize));
    output.set(input);
    output.fill(0, section.rawOffset, section.rawOffset + Math.max(section.rawSize, rawSize));
    output.set(contents, section.rawOffset);
    setU32(output, section.entry + 8, contents.length);
    setU32(output, section.entry + 16, Math.max(section.rawSize, rawSize));
    setU32(output, image.optional + 56, Math.max(u32(input, image.optional + 56), align(section.virtualAddress + contents.length, image.sectionAlignment)));
    setResourceDirectory(output, image, section.virtualAddress, contents.length);
    return output;
}

function isLast(image, section, length) {
    return image.sections.every((other) => other === section || other.virtualAddress < section.virtualAddress && other.rawOffset + other.rawSize <= section.rawOffset) && section.rawOffset + section.rawSize >= length;
}

function makeHeaderRoom(input) {
    const image = new Image(input);
    const tableEnd = image.sectionTable + 40 * (image.sectionCount + 1);
    const rawOffsets = image.sections.map((section) => section.rawOffset).filter(Boolean);
    const firstRaw = Math.min(...rawOffsets);
    if (tableEnd <= image.headersSize && tableEnd <= firstRaw) return input;
    const headersSize = align(tableEnd, image.fileAlignment);
    const firstRva = Math.min(...image.sections.map((section) => section.virtualAddress));
    if (headersSize > firstRva) throw new Error("no room for another section header");
    const shift = Math.max(0, headersSize - firstRaw);
    const output = new Uint8Array(input.length + shift);
    output.set(input.subarray(0, firstRaw));
    output.set(input.subarray(firstRaw), firstRaw + shift);
    for (const section of image.sections) if (section.rawOffset) setU32(output, section.entry + 20, section.rawOffset + shift);
    setU32(output, image.optional + 60, headersSize);
    const [debugRva, debugSize] = image.directory(6);
    if (debugRva && shift) {
        const debug = new Image(output).offset(debugRva);
        for (let entry = debug; entry + 28 <= debug + debugSize; entry += 28) {
            const pointer = u32(output, entry + 24);
            if (pointer >= firstRaw) setU32(output, entry + 24, pointer + shift);
        }
    }
    return output;
}

export function replaceResources(input, entries) {
    const image = new Image(input);
    const [currentRva] = image.directory(RESOURCE_DIRECTORY);
    const section = currentRva ? image.sections.find((candidate) => candidate.virtualAddress === currentRva) : null;
    if (section) {
        const next = image.sections.filter((candidate) => candidate.virtualAddress > section.virtualAddress).map((candidate) => candidate.virtualAddress);
        const room = Math.min(section.rawSize, next.length ? Math.min(...next) - section.virtualAddress : Infinity);
        const contents = buildResources(entries, section.virtualAddress);
        if (contents.length <= room || isLast(image, section, input.length)) return { data: writeSection(input, image, section, contents), newSection: false };
    }
    const roomy = makeHeaderRoom(input);
    const roomyImage = new Image(roomy);
    const sectionEnds = roomyImage.sections.map((candidate) => candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize));
    const sectionRva = align(Math.max(...sectionEnds), roomyImage.sectionAlignment);
    const contents = buildResources(entries, sectionRva);
    const output = appendSection(roomy, contents, sectionRva, ".rsrc", RESOURCE_CHARACTERISTICS);
    setResourceDirectory(output, roomyImage, sectionRva, contents.length);
    return { data: output, newSection: true };
}
