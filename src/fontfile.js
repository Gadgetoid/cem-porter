import { parse } from "../vendor/opentype.js";
import { Image, isPe, u16, u32 } from "./pe.js";
import { resourceLeaves } from "./bitmaps.js";

const RT_FONT = 8;
const NE_RT_FONT = 0x8008;
const VECTOR_FONT = 1;
const PAGE_FLAG = 0x80000000;
const PAGE_SIZE = 0x1000;
const CHARSETS = { 0: "ANSI", 1: "Default", 2: "Symbol", 77: "Mac", 128: "Shift-JIS", 129: "Hangul", 134: "GB2312", 136: "Big5", 161: "Greek", 162: "Turkish", 177: "Hebrew", 178: "Arabic", 186: "Baltic", 204: "Cyrillic", 222: "Thai", 238: "Eastern European", 255: "OEM" };

export function charsetName(charset) {
    return CHARSETS[charset] ?? `Character set ${charset}`;
}

function unpage(data) {
    if (data.length < 8 || !(u32(data, 0) & PAGE_FLAG)) return data;
    const start = u32(data, 0) & ~PAGE_FLAG;
    if (start % 4 || start > data.length) return data;
    for (let index = 0; index < start / 4; index++) {
        const entry = u32(data, 4 * index);
        if (!(entry & PAGE_FLAG) || (entry & ~PAGE_FLAG) !== start + index * PAGE_SIZE) return data;
    }
    return data.subarray(start);
}

function cString(data, offset) {
    let end = offset;
    while (end < data.length && data[end]) end++;
    return String.fromCharCode(...data.subarray(offset, Math.min(end, offset + 256)));
}

export function readFnt(data) {
    const version = u16(data, 0);
    if ((version !== 0x200 && version !== 0x300) || data.length < 0x76) return null;
    const type = u16(data, 0x42);
    const firstChar = data[0x5f];
    const lastChar = data[0x60];
    const height = u16(data, 0x58);
    const font = {
        version: version >> 8,
        copyright: cString(data, 6).slice(0, 60).trim(),
        vector: Boolean(type & VECTOR_FONT),
        points: u16(data, 0x44),
        ascent: u16(data, 0x4a),
        italic: Boolean(data[0x50]),
        underline: Boolean(data[0x51]),
        weight: u16(data, 0x53),
        charset: data[0x55],
        fixedWidth: u16(data, 0x56),
        height,
        averageWidth: u16(data, 0x5b),
        maxWidth: u16(data, 0x5d),
        firstChar,
        lastChar,
        defaultChar: firstChar + data[0x61],
        face: u32(data, 0x69) < data.length ? cString(data, u32(data, 0x69)) : "",
        glyphs: new Map(),
    };
    if (font.vector || lastChar < firstChar) return font;
    const table = version === 0x300 ? 0x94 : 0x76;
    const entrySize = version === 0x300 ? 6 : 4;
    for (let code = firstChar; code <= lastChar; code++) {
        const entry = table + (code - firstChar) * entrySize;
        if (entry + entrySize > data.length) break;
        const width = u16(data, entry);
        const offset = version === 0x300 ? u32(data, entry + 2) : u16(data, entry + 2);
        const columns = Math.ceil(width / 8);
        if (offset + columns * height > data.length) continue;
        const pixels = new Uint8Array(width * height);
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                if (data[offset + (x >> 3) * height + y] & (0x80 >> (x & 7))) pixels[y * width + x] = 1;
            }
        }
        font.glyphs.set(code, { width, pixels });
    }
    return font;
}

function fntResource(data) {
    return { version: u16(data, 0), font: readFnt(data) };
}

function neFonts(data) {
    const header = u32(data, 0x3c);
    if (header + 0x40 > data.length || data[header] !== 0x4e || data[header + 1] !== 0x45) return [];
    let offset = header + u16(data, header + 0x24);
    const shift = u16(data, offset);
    offset += 2;
    const resources = [];
    while (offset + 8 <= data.length) {
        const type = u16(data, offset);
        if (!type) break;
        const count = u16(data, offset + 2);
        offset += 8;
        for (let index = 0; index < count && offset + 12 <= data.length; index++, offset += 12) {
            if (type !== NE_RT_FONT) continue;
            const start = u16(data, offset) << shift;
            const length = u16(data, offset + 2) << shift;
            resources.push(fntResource(data.subarray(start, Math.min(data.length, start + length))));
        }
    }
    return resources;
}

function peFonts(data) {
    const image = new Image(data);
    return resourceLeaves(image).filter((leaf) => leaf.path[0] === RT_FONT).map((leaf) => {
        const rva = u32(image.data, leaf.entry);
        const offset = image.offset(rva);
        return fntResource(image.data.subarray(offset, offset + u32(image.data, leaf.entry + 4)));
    });
}

export function readBitmapFonts(input) {
    const data = unpage(input);
    const resources = data.length >= 0x40 && data[0] === 0x4d && data[1] === 0x5a ? isPe(data) ? peFonts(data) : neFonts(data) : [fntResource(data)];
    const fonts = resources.map((resource) => resource.font).filter(Boolean);
    const unsupported = [...new Set(resources.filter((resource) => !resource.font).map((resource) => resource.version))];
    return fonts.length || unsupported.length && resources.length > 1 ? { fonts, unsupported } : null;
}

function collectionFont(buffer) {
    const view = new DataView(buffer);
    const first = view.getUint32(12);
    const tables = view.getUint16(first + 4);
    new Uint8Array(buffer).copyWithin(0, first, first + 12 + 16 * tables);
    return buffer;
}

export function readTrueType(data) {
    const buffer = data.slice().buffer;
    const isCollection = u32(data, 0) === 0x66637474;
    const faces = isCollection ? new DataView(buffer).getUint32(8) : 1;
    return { font: parse(isCollection ? collectionFont(buffer) : buffer), faces };
}

export function readBuzzer(data) {
    const source = String.fromCharCode(...data.subarray(0, 4096)).replace(/\x1a[\s\S]*$/, "").trim();
    if (!/^\d+\s*(,\s*\d+\s*)*$/.test(source)) return null;
    const numbers = source.split(",").map((part) => Number(part.trim()));
    const tones = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) tones.push({ frequency: numbers[index], duration: numbers[index + 1] });
    return tones.length ? tones : null;
}
