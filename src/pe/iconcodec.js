import { setU16, setU32, u16, u32 } from "./pe.js";

export const RT_ICON = 3;
export const RT_GROUP_ICON = 14;
const HEADER_SIZE = 40;
const OPAQUE = 128;
const GREYS = [0, 85, 170, 255];
const VGA = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

export const DEPTHS = { 2: "4 greys", 4: "16 colours", 8: "256 colours" };

function stride(width, bits) {
    return Math.floor((width * bits + 31) / 32) * 4;
}

export function isPng(data) {
    return PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

export function resize(source, size) {
    if (source.width === size && source.height === size) return source.rgba;
    const output = new Uint8ClampedArray(size * size * 4);
    const scaleX = source.width / size;
    const scaleY = source.height / size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const left = x * scaleX;
            const top = y * scaleY;
            const right = Math.max(left + 1, (x + 1) * scaleX);
            const bottom = Math.max(top + 1, (y + 1) * scaleY);
            let red = 0;
            let green = 0;
            let blue = 0;
            let alpha = 0;
            let area = 0;
            for (let sourceY = Math.floor(top); sourceY < Math.min(source.height, Math.ceil(bottom)); sourceY++) {
                const coverY = Math.min(bottom, sourceY + 1) - Math.max(top, sourceY);
                for (let sourceX = Math.floor(left); sourceX < Math.min(source.width, Math.ceil(right)); sourceX++) {
                    const weight = coverY * (Math.min(right, sourceX + 1) - Math.max(left, sourceX));
                    const pixel = 4 * (sourceY * source.width + sourceX);
                    const pixelAlpha = source.rgba[pixel + 3] * weight;
                    red += source.rgba[pixel] * pixelAlpha;
                    green += source.rgba[pixel + 1] * pixelAlpha;
                    blue += source.rgba[pixel + 2] * pixelAlpha;
                    alpha += pixelAlpha;
                    area += weight;
                }
            }
            const target = 4 * (y * size + x);
            if (alpha) output.set([red / alpha, green / alpha, blue / alpha, alpha / area], target);
        }
    }
    return output;
}

function medianCut(rgba, count) {
    const colours = [];
    for (let index = 0; index < rgba.length; index += 4) if (rgba[index + 3] >= OPAQUE) colours.push([rgba[index], rgba[index + 1], rgba[index + 2]]);
    if (!colours.length) return [[0, 0, 0]];
    const boxes = [colours];
    while (boxes.length < count) {
        let best = -1;
        let bestRange = 0;
        let bestChannel = 0;
        boxes.forEach((box, index) => {
            if (box.length < 2) return;
            for (let channel = 0; channel < 3; channel++) {
                let low = 255;
                let high = 0;
                for (const colour of box) {
                    low = Math.min(low, colour[channel]);
                    high = Math.max(high, colour[channel]);
                }
                if (high - low > bestRange) [best, bestRange, bestChannel] = [index, high - low, channel];
            }
        });
        if (best < 0) break;
        const box = boxes[best].sort((left, right) => left[bestChannel] - right[bestChannel]);
        boxes.splice(best, 1, box.slice(0, box.length >> 1), box.slice(box.length >> 1));
    }
    return boxes.map((box) => [0, 1, 2].map((channel) => Math.round(box.reduce((total, colour) => total + colour[channel], 0) / box.length)));
}

function paletteFor(rgba, bits) {
    if (bits === 2) return GREYS.map((level) => [level, level, level]);
    if (bits === 4) return VGA;
    const palette = [[0, 0, 0], ...medianCut(rgba, 255).filter((colour) => colour.some(Boolean))].slice(0, 256);
    while (palette.length < 256) palette.push([0, 0, 0]);
    return palette;
}

function nearest(palette, red, green, blue, grey) {
    if (grey) {
        const level = (red * 299 + green * 587 + blue * 114) / 1000;
        return Math.min(3, Math.max(0, Math.round(level / 85)));
    }
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach((colour, index) => {
        const distance = 3 * (colour[0] - red) ** 2 + 4 * (colour[1] - green) ** 2 + 2 * (colour[2] - blue) ** 2;
        if (distance < bestDistance) [best, bestDistance] = [index, distance];
    });
    return best;
}

function indexPixels(rgba, size, palette, grey, dither) {
    const indices = new Uint8Array(size * size);
    const work = Float32Array.from(rgba);
    const spread = (x, y, error, weight) => {
        if (x < 0 || x >= size || y >= size) return;
        const pixel = 4 * (y * size + x);
        if (work[pixel + 3] < OPAQUE) return;
        for (let channel = 0; channel < 3; channel++) work[pixel + channel] += error[channel] * weight;
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const pixel = 4 * (y * size + x);
            if (work[pixel + 3] < OPAQUE) continue;
            const colour = [0, 1, 2].map((channel) => Math.min(255, Math.max(0, work[pixel + channel])));
            const index = nearest(palette, colour[0], colour[1], colour[2], grey);
            indices[y * size + x] = index;
            if (!dither) continue;
            const error = colour.map((value, channel) => value - palette[index][channel]);
            spread(x + 1, y, error, 7 / 16);
            spread(x - 1, y + 1, error, 3 / 16);
            spread(x, y + 1, error, 5 / 16);
            spread(x + 1, y + 1, error, 1 / 16);
        }
    }
    return indices;
}

export function encodeIconImage(source, size, bits, dither = false) {
    const rgba = resize(source, size);
    const palette = paletteFor(rgba, bits);
    const black = palette.findIndex((colour) => colour.every((value) => value === 0));
    const indices = indexPixels(rgba, size, palette, bits === 2, dither);
    const colourStride = stride(size, bits);
    const maskStride = stride(size, 1);
    const paletteSize = 4 * palette.length;
    const pixelsStart = HEADER_SIZE + paletteSize;
    const maskStart = pixelsStart + colourStride * size;
    const data = new Uint8Array(maskStart + maskStride * size);
    setU32(data, 0, HEADER_SIZE);
    setU32(data, 4, size);
    setU32(data, 8, size * 2);
    setU16(data, 12, 1);
    setU16(data, 14, bits);
    setU32(data, 20, colourStride * size);
    palette.forEach((colour, index) => data.set([colour[2], colour[1], colour[0], 0], HEADER_SIZE + 4 * index));
    for (let y = 0; y < size; y++) {
        const row = size - 1 - y;
        for (let x = 0; x < size; x++) {
            const transparent = rgba[4 * (y * size + x) + 3] < OPAQUE;
            const index = transparent ? Math.max(0, black) : indices[y * size + x];
            const bit = x * bits;
            data[pixelsStart + row * colourStride + (bit >> 3)] |= index << (8 - bits - (bit & 7));
            if (transparent) data[maskStart + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    return data;
}

export function readGroup(data) {
    const count = u16(data, 4);
    return Array.from({ length: count }, (_, index) => {
        const entry = 6 + 14 * index;
        return { width: data[entry] || 256, height: data[entry + 1] || 256, colours: data[entry + 2], planes: u16(data, entry + 4), bits: u16(data, entry + 6), bytes: u32(data, entry + 8), id: u16(data, entry + 12) };
    });
}

export function buildGroup(images) {
    const data = new Uint8Array(6 + 14 * images.length);
    setU16(data, 2, 1);
    setU16(data, 4, images.length);
    images.forEach((image, index) => {
        const entry = 6 + 14 * index;
        data[entry] = image.width >= 256 ? 0 : image.width;
        data[entry + 1] = image.height >= 256 ? 0 : image.height;
        data[entry + 2] = image.bits < 8 ? 1 << image.bits : 0;
        setU16(data, entry + 4, 1);
        setU16(data, entry + 6, image.bits);
        setU32(data, entry + 8, image.data.length);
        setU16(data, entry + 12, image.id);
    });
    return data;
}

export function dibInfo(data) {
    if (isPng(data)) {
        const view = new DataView(data.buffer, data.byteOffset, data.length);
        return { width: view.getUint32(16), height: view.getUint32(20), bits: 32, png: true };
    }
    return { width: u32(data, 4), height: (u32(data, 8) | 0) / 2, bits: u16(data, 14), png: false };
}

export function readIco(data) {
    if (data.length < 6 || u16(data, 0) !== 0 || u16(data, 2) !== 1) return null;
    const count = u16(data, 4);
    const images = [];
    for (let index = 0; index < count; index++) {
        const entry = 6 + 16 * index;
        if (entry + 16 > data.length) break;
        const size = u32(data, entry + 8);
        const offset = u32(data, entry + 12);
        if (offset + size > data.length) continue;
        const image = data.slice(offset, offset + size);
        images.push({ ...dibInfo(image), data: image });
    }
    return images;
}

export function writeIco(images) {
    const header = 6 + 16 * images.length;
    const output = new Uint8Array(header + images.reduce((total, image) => total + image.data.length, 0));
    setU16(output, 2, 1);
    setU16(output, 4, images.length);
    let offset = header;
    images.forEach((image, index) => {
        const entry = 6 + 16 * index;
        output[entry] = image.width >= 256 ? 0 : image.width;
        output[entry + 1] = image.height >= 256 ? 0 : image.height;
        output[entry + 2] = image.bits < 8 ? 1 << image.bits : 0;
        setU16(output, entry + 4, 1);
        setU16(output, entry + 6, image.bits);
        setU32(output, entry + 8, image.data.length);
        setU32(output, entry + 12, offset);
        output.set(image.data, offset);
        offset += image.data.length;
    });
    return output;
}

export function iconGroups(entries) {
    const icons = new Map(entries.filter((entry) => entry.type === RT_ICON).map((entry) => [entry.name, entry]));
    return entries.filter((entry) => entry.type === RT_GROUP_ICON).map((group) => ({
        name: group.name,
        language: group.language,
        images: readGroup(group.data).filter((image) => icons.has(image.id)).map((image) => ({ ...image, data: icons.get(image.id).data })),
    }));
}

function sameGroup(entry, name, language) {
    return entry.type === RT_GROUP_ICON && entry.name === name && entry.language === language;
}

export function removeIconGroup(entries, name, language) {
    const target = entries.find((entry) => sameGroup(entry, name, language));
    if (!target) return entries;
    const others = entries.filter((entry) => entry.type === RT_GROUP_ICON && entry !== target);
    const shared = new Set(others.flatMap((entry) => readGroup(entry.data).map((image) => image.id)));
    const unused = new Set(readGroup(target.data).map((image) => image.id).filter((id) => !shared.has(id)));
    return entries.filter((entry) => entry !== target && !(entry.type === RT_ICON && unused.has(entry.name)));
}

export function defaultLanguage(entries) {
    return entries.find((entry) => entry.type === RT_GROUP_ICON)?.language ?? entries[0]?.language ?? 0x409;
}

export function nextGroupName(entries) {
    const numbers = entries.filter((entry) => entry.type === RT_GROUP_ICON && typeof entry.name === "number").map((entry) => entry.name);
    return numbers.length ? Math.max(...numbers) + 1 : 1;
}

export function putIconGroup(entries, name, language, images) {
    const remaining = removeIconGroup(entries, name, language);
    const position = entries.findIndex((entry) => sameGroup(entry, name, language));
    let nextId = Math.max(0, ...remaining.filter((entry) => entry.type === RT_ICON && typeof entry.name === "number").map((entry) => entry.name)) + 1;
    const numbered = images.map((image) => ({ ...image, id: nextId++ }));
    const iconEntries = numbered.map((image) => ({ type: RT_ICON, name: image.id, language, codepage: 0, data: image.data }));
    const group = { type: RT_GROUP_ICON, name, language, codepage: 0, data: buildGroup(numbered) };
    const output = [...remaining, ...iconEntries];
    if (position < 0) output.push(group);
    else output.splice(Math.min(position, output.length), 0, group);
    return output;
}
