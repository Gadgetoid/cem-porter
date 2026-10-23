import { inflateRaw } from "./inflate.js";
import { bcj2Decode, bcjArmDecode, bcjX86Decode, deltaDecode, lzma2Decode, lzmaDecode } from "./lzma.js";
import { u32 } from "./pe.js";

export const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

const ID = { end: 0x00, header: 0x01, archiveProperties: 0x02, additionalStreams: 0x03, mainStreams: 0x04, files: 0x05, packInfo: 0x06, unpackInfo: 0x07, substreams: 0x08, size: 0x09, crc: 0x0a, folder: 0x0b, unpackSize: 0x0c, unpackStreams: 0x0d, emptyStream: 0x0e, emptyFile: 0x0f, name: 0x11, mtime: 0x14, attributes: 0x15, encodedHeader: 0x17, dummy: 0x19 };
const METHOD_NAMES = { "00": "Copy", "21": "LZMA2", "030101": "LZMA", "03030103": "BCJ", "0303011b": "BCJ2", "03030501": "ARM", "03030701": "ARM Thumb", "03030205": "PowerPC", "03030401": "IA-64", "03030805": "SPARC", "03": "Delta", "040108": "Deflate", "040109": "Deflate64", "040202": "BZip2", "030401": "PPMd", "06f10701": "AES" };
const FILETIME_UNIX_EPOCH_MS = 11644473600000n;
const utf16 = new TextDecoder("utf-16le");

class Reader {
    constructor(data, position = 0) {
        this.data = data;
        this.position = position;
    }

    byte() {
        if (this.position >= this.data.length) throw new Error("7z header is truncated");
        return this.data[this.position++];
    }

    number() {
        const first = this.byte();
        let mask = 0x80;
        let value = 0;
        for (let index = 0; index < 8; index++) {
            if (!(first & mask)) return value + (first & (mask - 1)) * 2 ** (8 * index);
            value += this.byte() * 2 ** (8 * index);
            mask >>= 1;
        }
        return value;
    }

    u32() {
        const value = u32(this.data, this.position);
        this.position += 4;
        return value;
    }

    u64() {
        const low = this.u32();
        const high = this.u32();
        return { low, high, value: high * 2 ** 32 + low };
    }

    bytes(count) {
        const start = this.position;
        this.position += count;
        if (this.position > this.data.length) throw new Error("7z header is truncated");
        return this.data.subarray(start, this.position);
    }

    bits(count) {
        const result = [];
        let mask = 0;
        let byte = 0;
        for (let index = 0; index < count; index++) {
            if (!mask) {
                byte = this.byte();
                mask = 0x80;
            }
            result.push(Boolean(byte & mask));
            mask >>= 1;
        }
        return result;
    }

    definedBits(count) {
        const all = this.byte();
        return all ? new Array(count).fill(true) : this.bits(count);
    }
}

function hexId(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readDigests(reader, count) {
    const defined = reader.definedBits(count);
    return defined.map((isDefined) => (isDefined ? reader.u32() : null));
}

function readPackInfo(reader) {
    const info = { position: reader.number(), sizes: [] };
    const count = reader.number();
    for (let type = reader.number(); type !== ID.end; type = reader.number()) {
        if (type === ID.size) info.sizes = Array.from({ length: count }, () => reader.number());
        else if (type === ID.crc) readDigests(reader, count);
        else throw new Error(`unexpected 7z pack property ${type}`);
    }
    return info;
}

function readFolder(reader) {
    const coders = [];
    const coderCount = reader.number();
    for (let index = 0; index < coderCount; index++) {
        const flags = reader.byte();
        if (flags & 0x80) throw new Error("7z alternative coder methods aren't supported");
        const id = hexId(reader.bytes(flags & 0x0f));
        const complex = flags & 0x10;
        const inputs = complex ? reader.number() : 1;
        const outputs = complex ? reader.number() : 1;
        const properties = flags & 0x20 ? reader.bytes(reader.number()) : new Uint8Array(0);
        coders.push({ id, inputs, outputs, properties });
    }
    const totalOutputs = coders.reduce((sum, coder) => sum + coder.outputs, 0);
    const totalInputs = coders.reduce((sum, coder) => sum + coder.inputs, 0);
    const bindPairs = Array.from({ length: totalOutputs - 1 }, () => ({ input: reader.number(), output: reader.number() }));
    const packedCount = totalInputs - bindPairs.length;
    let packed;
    if (packedCount === 1) {
        packed = [Array.from({ length: totalInputs }, (_, index) => index).find((index) => !bindPairs.some((pair) => pair.input === index))];
    } else {
        packed = Array.from({ length: packedCount }, () => reader.number());
    }
    return { coders, bindPairs, packed, unpackSizes: [] };
}

function readUnpackInfo(reader) {
    if (reader.number() !== ID.folder) throw new Error("7z folder list missing");
    const count = reader.number();
    if (reader.byte()) throw new Error("external 7z folders aren't supported");
    const folders = Array.from({ length: count }, () => readFolder(reader));
    for (let type = reader.number(); type !== ID.end; type = reader.number()) {
        if (type === ID.unpackSize) {
            for (const folder of folders) folder.unpackSizes = Array.from({ length: folder.coders.reduce((sum, coder) => sum + coder.outputs, 0) }, () => reader.number());
        } else if (type === ID.crc) {
            readDigests(reader, count);
        } else {
            throw new Error(`unexpected 7z unpack property ${type}`);
        }
    }
    return folders;
}

function folderSize(folder) {
    const bound = new Set(folder.bindPairs.map((pair) => pair.output));
    const main = folder.unpackSizes.findIndex((_, index) => !bound.has(index));
    return folder.unpackSizes[main];
}

function readSubstreams(reader, folders) {
    const counts = folders.map(() => 1);
    let sizes = null;
    let type = reader.number();
    if (type === ID.unpackStreams) {
        folders.forEach((_, index) => (counts[index] = reader.number()));
        type = reader.number();
    }
    if (type === ID.size) {
        sizes = [];
        folders.forEach((folder, index) => {
            if (!counts[index]) return;
            let total = 0;
            for (let stream = 1; stream < counts[index]; stream++) {
                const size = reader.number();
                sizes.push(size);
                total += size;
            }
            sizes.push(folderSize(folder) - total);
        });
        type = reader.number();
    }
    if (!sizes) {
        sizes = [];
        folders.forEach((folder, index) => {
            if (counts[index] === 1) sizes.push(folderSize(folder));
            else if (counts[index]) throw new Error("7z substream sizes missing");
        });
    }
    while (type !== ID.end) {
        if (type === ID.crc) {
            const unknown = folders.reduce((sum, _, index) => sum + (counts[index] === 1 ? 0 : counts[index]), 0) + counts.filter((count) => count === 1).length;
            readDigests(reader, unknown);
        } else {
            throw new Error(`unexpected 7z substream property ${type}`);
        }
        type = reader.number();
    }
    return { counts, sizes };
}

function readStreams(reader) {
    const streams = { pack: null, folders: [], substreams: null };
    for (let type = reader.number(); type !== ID.end; type = reader.number()) {
        if (type === ID.packInfo) streams.pack = readPackInfo(reader);
        else if (type === ID.unpackInfo) streams.folders = readUnpackInfo(reader);
        else if (type === ID.substreams) streams.substreams = readSubstreams(reader, streams.folders);
        else throw new Error(`unexpected 7z streams property ${type}`);
    }
    if (!streams.substreams) streams.substreams = { counts: streams.folders.map(() => 1), sizes: streams.folders.map(folderSize) };
    return streams;
}

function filetime({ low, high }) {
    const ticks = (BigInt(high) << 32n) | BigInt(low);
    return ticks ? new Date(Number(ticks / 10000n - FILETIME_UNIX_EPOCH_MS)) : null;
}

function readFiles(reader) {
    const count = reader.number();
    const files = Array.from({ length: count }, () => ({ name: "", emptyStream: false, emptyFile: false, time: null, attributes: 0 }));
    let emptyStreams = [];
    for (let type = reader.number(); type !== ID.end; type = reader.number()) {
        const size = reader.number();
        const end = reader.position + size;
        if (type === ID.name) {
            if (reader.byte()) throw new Error("external 7z names aren't supported");
            const text = utf16.decode(reader.bytes(end - reader.position));
            text.split("\0").slice(0, count).forEach((name, index) => (files[index].name = name));
        } else if (type === ID.emptyStream) {
            emptyStreams = reader.bits(count);
            emptyStreams.forEach((empty, index) => (files[index].emptyStream = empty));
        } else if (type === ID.emptyFile) {
            const emptyIndices = files.map((file, index) => (file.emptyStream ? index : -1)).filter((index) => index >= 0);
            reader.bits(emptyIndices.length).forEach((empty, index) => (files[emptyIndices[index]].emptyFile = empty));
        } else if (type === ID.mtime || type === ID.attributes) {
            const defined = reader.definedBits(count);
            if (reader.byte()) throw new Error("external 7z file properties aren't supported");
            defined.forEach((isDefined, index) => {
                if (!isDefined) return;
                if (type === ID.mtime) files[index].time = filetime(reader.u64());
                else files[index].attributes = reader.u32();
            });
        }
        reader.position = end;
    }
    return files;
}

function runCoder(coder, inputs, size) {
    const name = METHOD_NAMES[coder.id] ?? `method ${coder.id}`;
    const input = inputs[0];
    switch (coder.id) {
        case "00":
            return input;
        case "030101":
            return lzmaDecode(coder.properties, input, size);
        case "21":
            return lzma2Decode(input, size);
        case "03030103":
            return bcjX86Decode(Uint8Array.from(input));
        case "0303011b":
            return bcj2Decode(inputs[0], inputs[1], inputs[2], inputs[3], size);
        case "03030501":
            return bcjArmDecode(Uint8Array.from(input));
        case "03":
            return deltaDecode(Uint8Array.from(input), (coder.properties[0] ?? 0) + 1);
        case "040108": {
            const { output, error } = inflateRaw(input, { maxOutput: size });
            if (error) throw new Error(`Deflate: ${error}`);
            return output;
        }
        default:
            throw new Error(`7z ${name} compression isn't supported`);
    }
}

function decodeFolder(data, folder, packStart, packSizes) {
    const packed = [];
    let position = packStart;
    for (const size of packSizes) {
        packed.push(data.subarray(position, position + size));
        position += size;
    }
    const inputBase = [];
    const outputBase = [];
    let inputs = 0;
    let outputs = 0;
    for (const coder of folder.coders) {
        inputBase.push(inputs);
        outputBase.push(outputs);
        inputs += coder.inputs;
        outputs += coder.outputs;
    }
    const cache = new Map();
    const outputOf = (index) => {
        if (cache.has(index)) return cache.get(index);
        const coderIndex = outputBase.findLastIndex((base) => base <= index);
        const coder = folder.coders[coderIndex];
        if (coder.outputs !== 1) throw new Error(`7z ${METHOD_NAMES[coder.id] ?? coder.id} isn't supported`);
        const streams = Array.from({ length: coder.inputs }, (_, offset) => {
            const input = inputBase[coderIndex] + offset;
            const pair = folder.bindPairs.find((candidate) => candidate.input === input);
            if (pair) return outputOf(pair.output);
            const packedIndex = folder.packed.indexOf(input);
            if (packedIndex < 0) throw new Error("7z folder has an unbound input");
            return packed[packedIndex];
        });
        const result = runCoder(coder, streams, folder.unpackSizes[index]);
        cache.set(index, result);
        return result;
    };
    const bound = new Set(folder.bindPairs.map((pair) => pair.output));
    const main = folder.unpackSizes.findIndex((_, index) => !bound.has(index));
    return outputOf(main);
}

function unpackStreams(data, streams) {
    const results = [];
    let packIndex = 0;
    let packPosition = 32 + streams.pack.position;
    for (const folder of streams.folders) {
        const sizes = streams.pack.sizes.slice(packIndex, packIndex + folder.packed.length);
        results.push(decodeFolder(data, folder, packPosition, sizes));
        packIndex += folder.packed.length;
        packPosition += sizes.reduce((sum, size) => sum + size, 0);
    }
    return results;
}

export function isSevenZip(data) {
    return data.length >= 32 && SEVEN_ZIP_SIGNATURE.every((byte, index) => data[index] === byte);
}

export function extractSevenZip(data) {
    const start = new Reader(data, 12);
    const nextOffset = start.u64().value;
    const nextSize = start.u64().value;
    if (32 + nextOffset + nextSize > data.length) throw new Error("7z archive is truncated");
    let header = data.subarray(32 + nextOffset, 32 + nextOffset + nextSize);
    for (let reader = new Reader(header); ; reader = new Reader(header)) {
        const type = reader.number();
        if (type === ID.header) break;
        if (type !== ID.encodedHeader) throw new Error("7z header is unreadable");
        header = unpackStreams(data, readStreams(reader))[0];
    }
    const reader = new Reader(header, 1);
    let streams = null;
    let files = [];
    for (let type = reader.number(); type !== ID.end; type = reader.number()) {
        if (type === ID.archiveProperties) {
            for (let property = reader.number(); property !== ID.end; property = reader.number()) reader.bytes(reader.number());
        } else if (type === ID.additionalStreams) {
            readStreams(reader);
        } else if (type === ID.mainStreams) {
            streams = readStreams(reader);
        } else if (type === ID.files) {
            files = readFiles(reader);
        } else {
            throw new Error(`unexpected 7z header property ${type}`);
        }
    }
    const outputs = streams ? unpackStreams(data, streams) : [];
    const members = [];
    let folderIndex = 0;
    let streamInFolder = 0;
    let offsetInFolder = 0;
    let sizeIndex = 0;
    for (const file of files) {
        if (file.emptyStream) {
            if (!file.emptyFile && file.name) continue;
            members.push({ name: file.name, data: new Uint8Array(0), time: file.time });
            continue;
        }
        while (streams.substreams.counts[folderIndex] === 0 || streamInFolder >= streams.substreams.counts[folderIndex]) {
            folderIndex++;
            streamInFolder = 0;
            offsetInFolder = 0;
        }
        const size = streams.substreams.sizes[sizeIndex++];
        members.push({ name: file.name, data: outputs[folderIndex].subarray(offsetInFolder, offsetInFolder + size), time: file.time });
        offsetInFolder += size;
        streamInFolder++;
    }
    return members;
}
