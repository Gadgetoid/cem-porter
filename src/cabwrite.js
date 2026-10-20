import { setU16, setU32, u32 } from "./pe.js";

export const ARCHITECTURE_ANY = 0;
export const ARCHITECTURE_MIPS = 4000;
export const ARCHITECTURE_SH3 = 10003;

export const HIVES = { HKCR: 1, HKCU: 2, HKLM: 3, HKU: 4 };
export const REG_SZ = 0x00000000;
export const REG_BINARY = 0x00000001;
export const REG_MULTI_SZ = 0x00010000;
export const REG_DWORD = 0x00010001;
export const NO_CLOBBER = 0x00000002;

export const FILE_WARN_IF_SKIPPED = 0x00000001;
export const FILE_NO_SKIP = 0x00000002;
export const FILE_NO_OVERWRITE = 0x00000010;
export const FILE_SHARED = 0x80000000;

const BLOCK_SIZE = 0x8000;
const SETUP_HEADER_SIZE = 0x64;
const CABINET_HEADER_SIZE = 36;
const FOLDER_SIZE = 8;
const FILE_ENTRY_SIZE = 16;
const DATA_HEADER_SIZE = 8;

export function encodeLatin1(text) {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code > 0xff) throw new RangeError(`"${text}" can't be encoded as latin-1`);
        bytes[index] = code;
    }
    return bytes;
}

function concatenate(chunks) {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) {
        output.set(chunk, position);
        position += chunk.length;
    }
    return output;
}

function terminated(text) {
    return concatenate([encodeLatin1(text), new Uint8Array(1)]);
}

function idList(values) {
    const encoded = new Uint8Array(2 * (values.length + 1));
    values.forEach((value, index) => setU16(encoded, 2 * index, value));
    return encoded;
}

function words(...values) {
    const encoded = new Uint8Array(2 * values.length);
    values.forEach((value, index) => setU16(encoded, 2 * index, value));
    return encoded;
}

function entryHeader(identifier, parent, unknown, flags, length) {
    const encoded = new Uint8Array(12);
    setU16(encoded, 0, identifier);
    setU16(encoded, 2, parent);
    setU16(encoded, 4, unknown);
    setU32(encoded, 6, flags);
    setU16(encoded, 10, length);
    return encoded;
}

function sameParts(first, second) {
    return first.length === second.length && first.every((part, index) => part === second[index]);
}

export class Setup {
    constructor(app, provider, { architecture = ARCHITECTURE_MIPS, unsupported = "", versions = [0, 0, 0, 0, 0, 0] } = {}) {
        this.app = app;
        this.provider = provider;
        this.architecture = architecture;
        this.unsupported = unsupported;
        this.versions = versions;
        this.strings = [];
        this.directories = [];
        this.files = [];
        this.hives = [];
        this.keys = [];
        this.links = [];
    }

    string(text) {
        const existing = this.strings.find((entry) => entry.text === text);
        if (existing) return existing.identifier;
        const identifier = this.strings.length + 1;
        this.strings.push({ identifier, text });
        return identifier;
    }

    directory(path) {
        const parts = path.split("\\").map((part) => this.string(part));
        const existing = this.directories.find((entry) => sameParts(entry.parts, parts));
        if (existing) return existing.identifier;
        const identifier = this.directories.length + 1;
        this.directories.push({ identifier, parts });
        return identifier;
    }

    wholeDirectory(path) {
        const parts = [this.string(path)];
        const existing = this.directories.find((entry) => sameParts(entry.parts, parts));
        if (existing) return existing.identifier;
        const identifier = this.directories.length + 1;
        this.directories.push({ identifier, parts });
        return identifier;
    }

    file(directory, name, member, flags = 0) {
        const identifier = this.files.length + 1;
        this.files.push({ identifier, directory: typeof directory === "number" ? directory : this.directory(directory), member, flags, name });
        return identifier;
    }

    hive(root, key) {
        const parts = key.split("\\").map((part) => this.string(part));
        const rootIdentifier = HIVES[root];
        const existing = this.hives.find((entry) => entry.root === rootIdentifier && sameParts(entry.parts, parts));
        if (existing) return existing.identifier;
        const identifier = this.hives.length + 1;
        this.hives.push({ identifier, root: rootIdentifier, parts });
        return identifier;
    }

    value(root, key, name, value, flags = null) {
        let kind;
        let data;
        if (typeof value === "number") {
            if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${value} isn't a DWORD`);
            kind = REG_DWORD;
            data = new Uint8Array(4);
            setU32(data, 0, value);
        } else {
            kind = REG_SZ;
            data = terminated(value);
        }
        if (flags !== null) kind = (kind | flags) >>> 0;
        const identifier = this.keys.length + 1;
        const expands = typeof value === "string" && value.includes("%");
        this.keys.push({
            identifier,
            hive: this.hive(root, key),
            expands: expands ? 1 : 0,
            kind,
            data: concatenate([terminated(name), data]),
        });
    }

    multiValue(root, key, name, values) {
        this.rawValue(root, key, name, REG_MULTI_SZ, concatenate([...values.map(terminated), new Uint8Array(1)]));
    }

    binaryValue(root, key, name, bytes) {
        this.rawValue(root, key, name, REG_BINARY, bytes);
    }

    rawValue(root, key, name, kind, data) {
        const identifier = this.keys.length + 1;
        this.keys.push({ identifier, hive: this.hive(root, key), expands: 0, kind, data: concatenate([terminated(name), data]) });
    }

    shortcut(directory, name, fileIdentifier) {
        const identifier = this.links.length + 1;
        this.links.push({
            identifier,
            directory: typeof directory === "number" ? directory : this.directory(directory),
            macro: 0,
            target: fileIdentifier,
            targetKind: 1,
            parts: [this.string(name)],
        });
    }

    encode() {
        const chunks = [];
        let length = 0;
        const append = (chunk) => {
            chunks.push(chunk);
            length += chunk.length;
        };

        const app = terminated(this.app);
        const provider = terminated(this.provider);
        const unsupported = this.unsupported ? concatenate([terminated(this.unsupported), new Uint8Array(1)]) : new Uint8Array(0);
        const appOffset = SETUP_HEADER_SIZE + length;
        append(app);
        const providerOffset = SETUP_HEADER_SIZE + length;
        append(provider);
        const unsupportedOffset = SETUP_HEADER_SIZE + length;
        append(unsupported);

        const offsets = [SETUP_HEADER_SIZE + length];
        for (const { identifier, text } of this.strings) {
            const encoded = terminated(text);
            append(words(identifier, encoded.length));
            append(encoded);
        }
        offsets.push(SETUP_HEADER_SIZE + length);
        for (const { identifier, parts } of this.directories) {
            const encoded = idList(parts);
            append(words(identifier, encoded.length));
            append(encoded);
        }
        offsets.push(SETUP_HEADER_SIZE + length);
        for (const { identifier, directory, member, flags, name } of this.files) {
            const encoded = terminated(name);
            append(entryHeader(identifier, directory, member, flags, encoded.length));
            append(encoded);
        }
        offsets.push(SETUP_HEADER_SIZE + length);
        for (const { identifier, root, parts } of this.hives) {
            const encoded = idList(parts);
            append(words(identifier, root, 0, encoded.length));
            append(encoded);
        }
        offsets.push(SETUP_HEADER_SIZE + length);
        for (const { identifier, hive, expands, kind, data } of this.keys) {
            append(entryHeader(identifier, hive, expands, kind, data.length));
            append(data);
        }
        offsets.push(SETUP_HEADER_SIZE + length);
        for (const { identifier, directory, macro, target, targetKind, parts } of this.links) {
            const encoded = idList(parts);
            append(words(identifier, directory, macro, target, targetKind, encoded.length));
            append(encoded);
        }

        const counts = [this.strings, this.directories, this.files, this.hives, this.keys, this.links].map((table) => table.length);
        const header = new Uint8Array(SETUP_HEADER_SIZE);
        header.set(encodeLatin1("MSCE"), 0);
        setU32(header, 8, SETUP_HEADER_SIZE + length);
        setU32(header, 16, 1);
        setU32(header, 20, this.architecture);
        this.versions.forEach((version, index) => setU32(header, 0x18 + 4 * index, version));
        counts.forEach((count, index) => setU16(header, 0x30 + 2 * index, count));
        offsets.forEach((offset, index) => setU32(header, 0x3c + 4 * index, offset));
        const strings = [
            appOffset,
            app.length,
            providerOffset,
            provider.length,
            unsupported.length ? unsupportedOffset : 0,
            unsupported.length,
        ];
        strings.forEach((value, index) => setU16(header, 0x54 + 2 * index, value));
        return concatenate([header, ...chunks]);
    }
}

export function checksum(data, seed = 0) {
    let value = seed;
    const full = data.length - (data.length % 4);
    for (let position = 0; position < full; position += 4) {
        value ^= u32(data, position);
    }
    const remainder = data.subarray(full);
    let tail = 0;
    for (const byte of remainder) {
        tail = (tail << 8) | byte;
    }
    return (value ^ tail) >>> 0;
}

export function cabinet(members, { setIdentifier = 0x5643, dosDate = 0x2d21, dosTime = 0x6000 } = {}) {
    const stream = concatenate(members.map((member) => member.data));
    const blocks = [];
    for (let position = 0; position < stream.length; position += BLOCK_SIZE) {
        blocks.push(stream.subarray(position, position + BLOCK_SIZE));
    }
    if (!blocks.length) blocks.push(new Uint8Array(0));

    const filesOffset = CABINET_HEADER_SIZE + FOLDER_SIZE;
    const fileEntries = [];
    let folderOffset = 0;
    for (const member of members) {
        const entry = new Uint8Array(FILE_ENTRY_SIZE);
        setU32(entry, 0, member.data.length);
        setU32(entry, 4, folderOffset);
        setU16(entry, 8, 0);
        setU16(entry, 10, dosDate);
        setU16(entry, 12, dosTime);
        setU16(entry, 14, 0x20);
        fileEntries.push(entry, terminated(member.name));
        folderOffset += member.data.length;
    }
    const fileTable = concatenate(fileEntries);
    const dataOffset = filesOffset + fileTable.length;

    const dataBlocks = [];
    for (const block of blocks) {
        const blockHeader = new Uint8Array(DATA_HEADER_SIZE);
        setU16(blockHeader, 4, block.length);
        setU16(blockHeader, 6, block.length);
        setU32(blockHeader, 0, checksum(blockHeader.subarray(4), checksum(block)));
        dataBlocks.push(blockHeader, block);
    }
    const dataArea = concatenate(dataBlocks);

    const header = new Uint8Array(CABINET_HEADER_SIZE);
    header.set(encodeLatin1("MSCF"), 0);
    setU32(header, 8, dataOffset + dataArea.length);
    setU32(header, 16, filesOffset);
    header[24] = 3;
    header[25] = 1;
    setU16(header, 26, 1);
    setU16(header, 28, members.length);
    setU16(header, 32, setIdentifier);

    const folder = new Uint8Array(FOLDER_SIZE);
    setU32(folder, 0, dataOffset);
    setU16(folder, 4, blocks.length);

    return concatenate([header, folder, fileTable, dataArea]);
}

export function memberName(name, number) {
    const dot = name.lastIndexOf(".");
    const stem = dot === -1 ? name : name.slice(0, dot);
    const characters = Array.from(stem).filter((character) => /[\p{L}\p{N}]/u.test(character));
    const cleaned = characters.slice(0, 8).join("") || "FILE";
    return `${cleaned}.${String(number).padStart(3, "0")}`;
}

export class Package {
    constructor(app, provider, options = {}) {
        this.setup = new Setup(app, provider, options);
        this.members = [];
        this.setupDll = null;
    }

    addFile(directory, name, data, flags = 0) {
        const number = this.members.length + 1;
        this.members.push({ name: memberName(name, number), data });
        return this.setup.file(directory, name, number, flags);
    }

    build() {
        const setup = this.setup.encode();
        const setupName = memberName(this.setup.app, 0);
        const members = [{ name: setupName, data: setup }, ...[...this.members].reverse()];
        if (this.setupDll) members.push({ name: memberName(this.setup.app, 999), data: this.setupDll });
        return cabinet(members);
    }
}
