import { align, readSections, setU16, setU32, u16, u32 } from "./pe.js";

export const ROOTS = { HKCR: 0x80000000, HKCU: 0x80000001, HKLM: 0x80000002, HKU: 0x80000003 };

const KINDS = { mkdir: 1, file: 2, shortcut: 3, regsz: 4, regmulti: 5, run: 6, regdword: 8, regkey: 9, regbinary: 11, setupdll: 12 };
const FILE_SHARED = 1;
const FILE_MODULE_PATH = 2;
const MARKER = [0x43, 0x45, 0x50, 0x4b, 0x43, 0x45, 0x4c, 0x4f];
const SECTION_NAME = ".cepk";
const SECTION_CHARACTERISTICS = 0x40000040;

class PayloadWriter {
    constructor() {
        this.chunks = [];
        this.length = 0;
        this.strings = new Map();
    }

    reserve(length) {
        const offset = this.length;
        const chunk = new Uint8Array(length);
        this.chunks.push(chunk);
        this.length += length;
        return { offset, chunk };
    }

    alignTo(alignment) {
        const padding = align(this.length, alignment) - this.length;
        if (padding) this.reserve(padding);
    }

    string(text) {
        if (this.strings.has(text)) return this.strings.get(text);
        this.alignTo(2);
        const { offset, chunk } = this.reserve(2 * (text.length + 1));
        for (let index = 0; index < text.length; index++) setU16(chunk, 2 * index, text.charCodeAt(index));
        this.strings.set(text, offset);
        return offset;
    }

    multiString(values) {
        const joined = values.join("\0") + "\0";
        this.alignTo(2);
        const { offset, chunk } = this.reserve(2 * (joined.length + 1));
        for (let index = 0; index < joined.length; index++) setU16(chunk, 2 * index, joined.charCodeAt(index));
        return offset;
    }

    bytes(data, withLength = false) {
        this.alignTo(4);
        const prefix = withLength ? 4 : 0;
        const { offset, chunk } = this.reserve(prefix + data.length);
        if (withLength) setU32(chunk, 0, data.length);
        chunk.set(data, prefix);
        return offset;
    }

    build() {
        const output = new Uint8Array(this.length);
        let position = 0;
        for (const chunk of this.chunks) {
            output.set(chunk, position);
            position += chunk.length;
        }
        return output;
    }
}

function rootValue(root) {
    if (typeof root === "number") return root >>> 0;
    const value = ROOTS[root.toUpperCase().replace("HKEY_LOCAL_MACHINE", "HKLM").replace("HKEY_CURRENT_USER", "HKCU").replace("HKEY_CLASSES_ROOT", "HKCR").replace("HKEY_USERS", "HKU")];
    if (value === undefined) throw new Error(`unknown registry root ${root}`);
    return value;
}

function operationValues(writer, operation) {
    switch (operation.kind) {
        case "mkdir":
            return [writer.string(operation.path), 0, 0, 0];
        case "file":
            return [writer.string(operation.path), writer.bytes(operation.data), operation.data.length, (operation.shared ? FILE_SHARED : 0) | (operation.modulePath ? FILE_MODULE_PATH : 0)];
        case "shortcut":
            return [writer.string(operation.link), writer.string(operation.target), 0, 0];
        case "regkey":
            return [rootValue(operation.root), writer.string(operation.key), 0, 0];
        case "regsz":
            return [rootValue(operation.root), writer.string(operation.key), writer.string(operation.name ?? ""), writer.string(operation.value)];
        case "regmulti":
            return [rootValue(operation.root), writer.string(operation.key), writer.string(operation.name ?? ""), writer.multiString(operation.values)];
        case "regdword":
            return [rootValue(operation.root), writer.string(operation.key), writer.string(operation.name ?? ""), operation.value >>> 0];
        case "regbinary":
            return [rootValue(operation.root), writer.string(operation.key), writer.string(operation.name ?? ""), writer.bytes(operation.value, true)];
        case "setupdll":
            return [writer.string(operation.path), writer.bytes(operation.data), operation.data.length, writer.string(operation.installFolder)];
        case "run":
            return [writer.string(operation.program), writer.string(operation.arguments ?? ""), 0, 0];
        default:
            throw new Error(`unknown operation ${operation.kind}`);
    }
}

export function buildPayload(title, operations) {
    const writer = new PayloadWriter();
    const { chunk: header } = writer.reserve(20);
    const { offset: operationsOffset, chunk: table } = writer.reserve(20 * operations.length);
    operations.forEach((operation, index) => {
        const values = operationValues(writer, operation);
        setU32(table, 20 * index, KINDS[operation.kind]);
        values.forEach((value, position) => setU32(table, 20 * index + 4 + 4 * position, value));
    });
    const titleOffset = writer.string(title);
    setU32(header, 0, 0x4b504543);
    setU32(header, 4, 1);
    setU32(header, 8, titleOffset);
    setU32(header, 12, operations.length);
    setU32(header, 16, operationsOffset);
    return writer.build();
}

function findMarker(data) {
    for (let offset = 0; offset + MARKER.length <= data.length; offset += 4) {
        if (MARKER.every((value, index) => data[offset + index] === value)) return offset;
    }
    throw new Error("installer stub has no payload marker");
}

export function attachPayload(stub, payload) {
    const header = u32(stub, 0x3c);
    const optional = header + 24;
    const sectionCount = u16(stub, header + 6);
    const sections = readSections(stub);
    const sectionAlignment = u32(stub, optional + 32);
    const fileAlignment = u32(stub, optional + 36);
    const imageBase = u32(stub, optional + 28);
    const tableEnd = sections[sections.length - 1].entry + 40;
    const firstRaw = Math.min(...sections.filter((section) => section.rawSize).map((section) => section.rawOffset));
    if (tableEnd + 40 > firstRaw) throw new Error("no room for another section header");
    const last = sections.reduce((highest, section) => (section.virtualAddress > highest.virtualAddress ? section : highest));
    const virtualAddress = align(last.virtualAddress + Math.max(last.virtualSize, last.rawSize), sectionAlignment);
    const fileEnd = Math.max(...sections.map((section) => section.rawOffset + section.rawSize));
    const rawOffset = align(fileEnd, fileAlignment);
    const rawSize = align(payload.length, fileAlignment);
    const output = new Uint8Array(rawOffset + rawSize);
    output.set(stub.subarray(0, Math.min(stub.length, rawOffset)));
    output.set(payload, rawOffset);
    const entry = tableEnd;
    output.fill(0, entry, entry + 40);
    for (let index = 0; index < SECTION_NAME.length; index++) output[entry + index] = SECTION_NAME.charCodeAt(index);
    setU32(output, entry + 8, payload.length);
    setU32(output, entry + 12, virtualAddress);
    setU32(output, entry + 16, rawSize);
    setU32(output, entry + 20, rawOffset);
    setU32(output, entry + 36, SECTION_CHARACTERISTICS);
    setU16(output, header + 6, sectionCount + 1);
    setU32(output, optional + 56, align(virtualAddress + payload.length, sectionAlignment));
    setU32(output, optional + 8, u32(output, optional + 8) + rawSize);
    const marker = findMarker(output);
    setU32(output, marker + 8, imageBase + virtualAddress);
    setU32(output, marker + 12, payload.length);
    return output;
}

export function selfInstaller(stub, title, operations) {
    return attachPayload(stub, buildPayload(title, operations));
}
