import { resourceLeaves } from "./bitmaps.js";
import { Image, isPe, u16, u32 } from "./pe.js";

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
const utf16 = new TextDecoder("utf-16le");

function leafData(image, leaf) {
    const rva = u32(image.data, leaf.entry);
    const size = u32(image.data, leaf.entry + 4);
    const offset = image.offset(rva);
    return image.data.subarray(offset, offset + size);
}

function decodeDib(data, wantedWidth) {
    const headerSize = u32(data, 0);
    const width = u32(data, 4) | 0;
    const height = (u32(data, 8) | 0) >> 1;
    const bits = u16(data, 14);
    if (headerSize < 40 || width <= 0 || height <= 0 || width > 256) return null;
    const colourCount = u32(data, 32) || (bits <= 8 ? 1 << bits : 0);
    const palette = headerSize;
    const pixels = palette + 4 * colourCount;
    const stride = Math.floor((width * bits + 31) / 32) * 4;
    const maskStride = Math.floor((width + 31) / 32) * 4;
    const mask = pixels + stride * height;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const source = pixels + (height - 1 - row) * stride;
        const maskRow = mask + (height - 1 - row) * maskStride;
        for (let column = 0; column < width; column++) {
            const target = 4 * (row * width + column);
            let red = 0;
            let green = 0;
            let blue = 0;
            let alpha = 255;
            if (bits <= 8) {
                const bit = column * bits;
                const index = (data[source + (bit >> 3)] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
                const entry = palette + 4 * index;
                [blue, green, red] = [data[entry], data[entry + 1], data[entry + 2]];
            } else if (bits === 16) {
                const value = u16(data, source + 2 * column);
                red = ((value >> 10) & 31) * 255 / 31;
                green = ((value >> 5) & 31) * 255 / 31;
                blue = (value & 31) * 255 / 31;
            } else if (bits === 24 || bits === 32) {
                const pixel = source + (bits / 8) * column;
                [blue, green, red] = [data[pixel], data[pixel + 1], data[pixel + 2]];
                if (bits === 32 && data[pixel + 3]) alpha = data[pixel + 3];
            } else {
                return null;
            }
            if (mask + maskStride * height <= data.length && data[maskRow + (column >> 3)] & (0x80 >> (column & 7))) alpha = 0;
            rgba.set([red, green, blue, alpha], target);
        }
    }
    return { width, height, bits, rgba, wantedWidth };
}

export function readBitmapFile(data) {
    if (data.length < 54 || data[0] !== 0x42 || data[1] !== 0x4d) return null;
    const dib = data.subarray(14);
    const headerSize = u32(dib, 0);
    const width = u32(dib, 4) | 0;
    const rawHeight = u32(dib, 8) | 0;
    const height = Math.abs(rawHeight);
    const bits = u16(dib, 14);
    if (headerSize < 40 || width <= 0 || !height || width > 4096 || height > 4096 || u32(dib, 16)) return null;
    const colourCount = u32(dib, 32) || (bits <= 8 ? 1 << bits : 0);
    const pixels = u32(data, 10) - 14;
    const stride = Math.floor((width * bits + 31) / 32) * 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const source = pixels + (rawHeight > 0 ? height - 1 - row : row) * stride;
        for (let column = 0; column < width; column++) {
            let red;
            let green;
            let blue;
            if (bits <= 8) {
                const bit = column * bits;
                const index = (dib[source + (bit >> 3)] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
                const entry = headerSize + 4 * Math.min(index, colourCount - 1);
                [blue, green, red] = [dib[entry], dib[entry + 1], dib[entry + 2]];
            } else if (bits === 16) {
                const value = u16(dib, source + 2 * column);
                [red, green, blue] = [((value >> 10) & 31) * 255 / 31, ((value >> 5) & 31) * 255 / 31, (value & 31) * 255 / 31];
            } else if (bits === 24 || bits === 32) {
                const pixel = source + (bits / 8) * column;
                [blue, green, red] = [dib[pixel], dib[pixel + 1], dib[pixel + 2]];
            } else {
                return null;
            }
            rgba.set([red, green, blue, 255], 4 * (row * width + column));
        }
    }
    return { width, height, bits, rgba };
}

function groupIcons(image, leaves) {
    const icons = new Map(leaves.filter((leaf) => leaf.path[0] === RT_ICON).map((leaf) => [leaf.path[1], leaf]));
    const groups = leaves.filter((leaf) => leaf.path[0] === RT_GROUP_ICON);
    return groups.map((group) => {
        const data = leafData(image, group);
        const count = u16(data, 4);
        return Array.from({ length: count }, (_, index) => {
            const entry = 6 + 14 * index;
            return { width: data[entry] || 256, height: data[entry + 1] || 256, bits: u16(data, entry + 6), id: u16(data, entry + 12) };
        }).filter((entry) => icons.has(entry.id)).map((entry) => ({ ...entry, leaf: icons.get(entry.id) }));
    }).filter((entries) => entries.length);
}

export function readIcon(data, size) {
    if (!isPe(data)) return null;
    try {
        const image = new Image(data);
        const groups = groupIcons(image, resourceLeaves(image));
        if (!groups.length) return null;
        const entries = groups[0];
        const exact = entries.filter((entry) => entry.width === size);
        const chosen = (exact.length ? exact : entries).sort((left, right) => right.bits - left.bits || Math.abs(left.width - size) - Math.abs(right.width - size))[0];
        return decodeDib(leafData(image, chosen.leaf), size);
    } catch {
        return null;
    }
}

export function iconSizes(data) {
    if (!isPe(data)) return [];
    try {
        const image = new Image(data);
        return groupIcons(image, resourceLeaves(image)).map((entries) => entries.map((entry) => `${entry.width}x${entry.height} ${entry.bits}-bit`));
    } catch {
        return [];
    }
}

function align4(value) {
    return (value + 3) & ~3;
}

function readVersionBlock(data, offset, end) {
    const length = u16(data, offset);
    const valueLength = u16(data, offset + 2);
    const isText = u16(data, offset + 4) === 1;
    let keyEnd = offset + 6;
    while (keyEnd + 1 < end && u16(data, keyEnd)) keyEnd += 2;
    const key = utf16.decode(data.subarray(offset + 6, keyEnd));
    const valueStart = align4(keyEnd + 2);
    const blockEnd = Math.min(end, offset + (length || end - offset));
    const valueBytes = isText ? valueLength * 2 : valueLength;
    const value = data.subarray(valueStart, Math.min(blockEnd, valueStart + valueBytes));
    const children = [];
    let child = align4(valueStart + valueBytes);
    while (child + 6 <= blockEnd) {
        const block = readVersionBlock(data, child, blockEnd);
        if (!block.length) break;
        children.push(block);
        child = align4(child + block.length);
    }
    return { key, isText, value, children, length };
}

function versionNumber(high, low) {
    return `${high >>> 16}.${high & 0xffff}.${low >>> 16}.${low & 0xffff}`;
}

export function readVersion(data) {
    if (!isPe(data)) return null;
    try {
        const image = new Image(data);
        const leaf = resourceLeaves(image).find((candidate) => candidate.path[0] === RT_VERSION);
        if (!leaf) return null;
        const bytes = leafData(image, leaf);
        const root = readVersionBlock(bytes, 0, bytes.length);
        const result = { strings: {} };
        if (root.value.length >= 52 && u32(root.value, 0) === 0xfeef04bd) {
            result.fileVersion = versionNumber(u32(root.value, 8), u32(root.value, 12));
            result.productVersion = versionNumber(u32(root.value, 16), u32(root.value, 20));
        }
        for (const child of root.children) {
            if (child.key !== "StringFileInfo") continue;
            for (const table of child.children) {
                for (const entry of table.children) {
                    const text = utf16.decode(entry.value).replace(/\0+$/, "");
                    if (text) result.strings[entry.key] = text;
                }
            }
        }
        return result;
    } catch {
        return null;
    }
}

export function readExports(data) {
    if (!isPe(data)) return [];
    try {
        const image = new Image(data);
        const [rva] = image.directory(0);
        if (!rva) return [];
        const directory = image.offset(rva);
        const base = u32(image.data, directory + 16);
        const functionCount = u32(image.data, directory + 20);
        const nameCount = u32(image.data, directory + 24);
        const names = u32(image.data, directory + 32);
        const ordinals = u32(image.data, directory + 36);
        const named = new Map();
        for (let index = 0; index < nameCount; index++) named.set(u16(image.data, image.offset(ordinals + 2 * index)), image.cString(image.word(names + 4 * index)));
        return Array.from({ length: functionCount }, (_, index) => ({ ordinal: base + index, name: named.get(index) ?? null }));
    } catch {
        return [];
    }
}
