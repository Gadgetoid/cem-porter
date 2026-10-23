import { Image, setU16, setU32, u16, u32 } from "./pe.js";

const RT_BITMAP = 2;
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const GREY_LEVELS = [0, 85, 170, 255];

export function resourceLeaves(image) {
    const [rootRva] = image.directory(2);
    if (!rootRva) return [];
    const base = image.offset(rootRva);
    const leaves = [];
    const walk = (offset, path) => {
        if (path.length > 3 || base + offset + 16 > image.data.length) return;
        const named = u16(image.data, base + offset + 12);
        const numbered = u16(image.data, base + offset + 14);
        for (let index = 0; index < named + numbered; index++) {
            const entry = base + offset + 16 + 8 * index;
            const name = u32(image.data, entry);
            const target = u32(image.data, entry + 4);
            const key = name & 0x80000000 ? null : name;
            if (target & 0x80000000) walk(target & 0x7fffffff, [...path, key]);
            else leaves.push({ path: [...path, key], entry: base + target });
        }
    };
    walk(0, []);
    return leaves;
}

function grey(red, green, blue) {
    return (red * 299 + green * 587 + blue * 114) / 1000;
}

function nearestLevel(value) {
    return Math.min(3, Math.max(0, Math.round(value / 85)));
}

function readPixels(data, start, width, height, bits, colours) {
    const stride = Math.floor((width * bits + 31) / 32) * 4;
    const levels = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
        const line = start + row * stride;
        for (let column = 0; column < width; column++) {
            let value;
            if (bits <= 8) {
                const bitOffset = column * bits;
                const byte = data[line + (bitOffset >> 3)];
                const index = (byte >> (8 - bits - (bitOffset & 7))) & ((1 << bits) - 1);
                value = colours[index] ?? 0;
            } else if (bits === 16) {
                const pixel = u16(data, line + 2 * column);
                value = grey(((pixel >> 10) & 31) * 255 / 31, ((pixel >> 5) & 31) * 255 / 31, (pixel & 31) * 255 / 31);
            } else {
                const position = line + (bits / 8) * column;
                value = grey(data[position + 2], data[position + 1], data[position]);
            }
            levels[row * width + column] = nearestLevel(value);
        }
    }
    return levels;
}

function writePixels(data, start, width, height, levels) {
    const stride = Math.floor((width * 2 + 31) / 32) * 4;
    data.fill(0, start, start + stride * height);
    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            data[start + row * stride + (column >> 2)] |= levels[row * width + column] << (6 - 2 * (column & 3));
        }
    }
    return stride * height;
}

function reduceDib(data, offset, size, isIcon) {
    const headerSize = u32(data, offset);
    if (headerSize < 40) return null;
    const width = u32(data, offset + 4) | 0;
    const storedHeight = u32(data, offset + 8) | 0;
    const bits = u16(data, offset + 14);
    const compression = u32(data, offset + 16);
    if (bits <= 2 || compression !== 0 || ![4, 8, 16, 24, 32].includes(bits) || width <= 0) return null;
    const height = Math.abs(isIcon ? storedHeight / 2 : storedHeight);
    const usedColours = u32(data, offset + 32) || (bits <= 8 ? 1 << bits : 0);
    const colours = [];
    for (let index = 0; index < usedColours; index++) {
        const entry = offset + headerSize + 4 * index;
        colours.push(grey(data[entry + 2], data[entry + 1], data[entry]));
    }
    const pixelsStart = offset + headerSize + 4 * usedColours;
    const sourceStride = Math.floor((width * bits + 31) / 32) * 4;
    const levels = readPixels(data, pixelsStart, width, height, bits, colours);
    const maskStride = Math.floor((width + 31) / 32) * 4;
    const mask = isIcon ? data.slice(pixelsStart + sourceStride * height, pixelsStart + sourceStride * height + maskStride * height) : null;
    setU32(data, offset, 40);
    setU16(data, offset + 14, 2);
    setU32(data, offset + 20, 0);
    setU32(data, offset + 32, 4);
    setU32(data, offset + 36, 4);
    GREY_LEVELS.forEach((level, index) => {
        const entry = offset + 40 + 4 * index;
        data[entry] = level;
        data[entry + 1] = level;
        data[entry + 2] = level;
        data[entry + 3] = 0;
    });
    let length = 56 + writePixels(data, offset + 56, width, height, levels);
    if (mask) {
        data.set(mask, offset + length);
        length += mask.length;
    }
    setU32(data, offset + 20, length - 56);
    if (length > size) throw new Error("reduced bitmap is larger than the original");
    data.fill(0, offset + length, offset + size);
    return length;
}

export function reduceColourBitmaps(input) {
    const image = new Image(input.slice());
    const leaves = resourceLeaves(image);
    let bitmaps = 0;
    let icons = 0;
    const reducedIcons = new Set();
    for (const leaf of leaves) {
        const type = leaf.path[0];
        if (type !== RT_BITMAP && type !== RT_ICON) continue;
        const rva = u32(image.data, leaf.entry);
        const size = u32(image.data, leaf.entry + 4);
        const length = reduceDib(image.data, image.offset(rva), size, type === RT_ICON);
        if (length === null) continue;
        setU32(image.data, leaf.entry + 4, length);
        if (type === RT_BITMAP) bitmaps++;
        else {
            icons++;
            reducedIcons.add(leaf.path[1]);
        }
    }
    for (const leaf of leaves) {
        if (leaf.path[0] !== RT_GROUP_ICON || !reducedIcons.size) continue;
        const offset = image.offset(u32(image.data, leaf.entry));
        const count = u16(image.data, offset + 4);
        for (let index = 0; index < count; index++) {
            const entry = offset + 6 + 14 * index;
            if (!reducedIcons.has(u16(image.data, entry + 12))) continue;
            image.data[entry + 2] = 4;
            setU16(image.data, entry + 6, 2);
            const width = image.data[entry] || 256;
            const height = image.data[entry + 1] || 256;
            setU32(image.data, entry + 8, 56 + Math.floor((width * 2 + 31) / 32) * 4 * height + Math.floor((width + 31) / 32) * 4 * height);
        }
    }
    return bitmaps || icons ? { data: image.data, bitmaps, icons } : { data: null, bitmaps: 0, icons: 0 };
}
