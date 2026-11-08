import { asciiText } from "../port/installplan.js";

export const FNT_FIRST_CHAR = 31;
export const FNT_LAST_CHAR = 255;
const HEADER_SIZE = 118;
const COPYRIGHT_SIZE = 60;
const RESOLUTION = 96;
const MAX_SIZE = 0x10000;

export const FAMILY_SWISS = 0x20;
export const FAMILY_ROMAN = 0x10;
export const FAMILY_MODERN = 0x30;
const VARIABLE_PITCH = 0x01;

function columns(width) {
    return Math.ceil(width / 8);
}

function packGlyph(glyph, height) {
    const bytes = new Uint8Array(columns(glyph.width) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < glyph.width; x++) {
            if (glyph.bitmap[y * glyph.width + x]) bytes[(x >> 3) * height + y] |= 0x80 >> (x & 7);
        }
    }
    return bytes;
}

function latin1(text) {
    return Uint8Array.from([...asciiText(text)].map((character) => character.charCodeAt(0)));
}

export function buildFnt(font) {
    const glyphs = [...font.glyphs, { width: font.glyphs[0].width, bitmap: new Uint8Array(font.glyphs[0].width * font.height) }];
    const packed = glyphs.map((glyph) => packGlyph(glyph, font.height));
    const bitsOffset = HEADER_SIZE + glyphs.length * 4;
    const bitsLength = packed.reduce((total, bytes) => total + bytes.length, 0);
    const face = latin1(font.face);
    const copyright = latin1(font.copyright);
    const facePosition = bitsOffset + bitsLength;
    const size = facePosition + face.length + 1 + copyright.length + 1;
    if (size > MAX_SIZE) throw new Error(`${font.points} pt is ${size} bytes, over the 64 KB a version 2 font can hold`);
    const data = new Uint8Array(size);
    const view = new DataView(data.buffer);
    const widths = font.glyphs.map((glyph) => glyph.width);
    const x = font.glyphs[0x78 - FNT_FIRST_CHAR]?.width;
    view.setUint16(0, 0x0200, true);
    view.setUint32(2, size, true);
    data.set(copyright.slice(0, COPYRIGHT_SIZE - 1), 6);
    view.setUint16(0x42, 0, true);
    view.setUint16(0x44, font.points, true);
    view.setUint16(0x46, RESOLUTION, true);
    view.setUint16(0x48, RESOLUTION, true);
    view.setUint16(0x4a, font.ascent, true);
    view.setUint16(0x4c, font.internalLeading, true);
    view.setUint16(0x4e, 0, true);
    data[0x50] = font.italic ? 1 : 0;
    data[0x51] = 0;
    data[0x52] = 0;
    view.setUint16(0x53, font.weight, true);
    data[0x55] = font.charset;
    view.setUint16(0x56, font.fixedPitch ? widths[1] : 0, true);
    view.setUint16(0x58, font.height, true);
    data[0x5a] = font.family | (font.fixedPitch ? 0 : VARIABLE_PITCH);
    view.setUint16(0x5b, x || Math.round(widths.reduce((total, width) => total + width, 0) / widths.length), true);
    view.setUint16(0x5d, Math.max(...widths), true);
    data[0x5f] = FNT_FIRST_CHAR;
    data[0x60] = FNT_LAST_CHAR;
    data[0x61] = FNT_FIRST_CHAR;
    data[0x62] = 0x20;
    view.setUint16(0x63, Math.ceil(packed.reduce((total, bytes, index) => total + columns(glyphs[index].width), 0) / 2) * 2, true);
    view.setUint32(0x65, 0, true);
    view.setUint32(0x69, facePosition, true);
    view.setUint32(0x6d, 0, true);
    view.setUint32(0x71, bitsOffset, true);
    let offset = bitsOffset;
    glyphs.forEach((glyph, index) => {
        view.setUint16(HEADER_SIZE + index * 4, glyph.width, true);
        view.setUint16(HEADER_SIZE + index * 4 + 2, offset, true);
        data.set(packed[index], offset);
        offset += packed[index].length;
    });
    data.set(face, facePosition);
    data.set(copyright, facePosition + face.length + 1);
    return data;
}
