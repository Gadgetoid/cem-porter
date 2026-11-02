import { contourBounds } from "./outline.js";
import { CODEPAGES, codepageMap } from "./fontsets.js";
import { asciiText } from "./installplan.js";

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;
const HEAD_MAGIC = 0x5f0f3cf5;
const CHECKSUM_TARGET = 0xb1b0afba;
const SECONDS_1904_TO_1970 = 2082844800;
const TABLE_ORDER = ["head", "hhea", "maxp", "OS/2", "hmtx", "cmap", "loca", "glyf", "name", "post"];
const LOWERCASE_WEIGHTS = { a: 64, b: 14, c: 27, d: 35, e: 100, f: 20, g: 14, h: 42, i: 63, j: 3, k: 6, l: 35, m: 20, n: 56, o: 56, p: 17, q: 4, r: 49, s: 56, t: 71, u: 31, v: 10, w: 18, x: 3, y: 18, z: 2, " ": 166 };
const UNICODE_RANGES = [
    [0, 0x0000, 0x007f], [1, 0x0080, 0x00ff], [2, 0x0100, 0x017f], [3, 0x0180, 0x024f], [4, 0x0250, 0x02af], [5, 0x02b0, 0x02ff],
    [6, 0x0300, 0x036f], [7, 0x0370, 0x03ff], [9, 0x0400, 0x04ff], [29, 0x1e00, 0x1eff], [31, 0x2000, 0x206f], [32, 0x2070, 0x209f],
    [33, 0x20a0, 0x20cf], [35, 0x2100, 0x214f], [36, 0x2150, 0x218f], [37, 0x2190, 0x21ff], [38, 0x2200, 0x22ff], [39, 0x2300, 0x23ff],
    [43, 0x2500, 0x257f], [44, 0x2580, 0x259f], [45, 0x25a0, 0x25ff], [46, 0x2600, 0x26ff], [60, 0xe000, 0xf8ff], [62, 0xfb00, 0xfb4f],
];
const CODEPAGE_COVERAGE = 0.9;

class Writer {
    constructor() {
        this.bytes = [];
    }

    get length() {
        return this.bytes.length;
    }

    u8(value) {
        this.bytes.push(value & 0xff);
    }

    u16(value) {
        this.bytes.push((value >> 8) & 0xff, value & 0xff);
    }

    i16(value) {
        this.u16(value < 0 ? value + 0x10000 : value);
    }

    u32(value) {
        this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    }

    tag(text) {
        for (const character of text) this.u8(character.charCodeAt(0));
    }

    raw(bytes) {
        for (const byte of bytes) this.bytes.push(byte);
    }

    pad(alignment) {
        while (this.bytes.length % alignment) this.bytes.push(0);
    }

    toBytes() {
        return Uint8Array.from(this.bytes);
    }
}

function encodeGlyph(contours, bounds) {
    const writer = new Writer();
    if (!contours.length) return writer.toBytes();
    writer.i16(contours.length);
    writer.i16(bounds.xMin);
    writer.i16(bounds.yMin);
    writer.i16(bounds.xMax);
    writer.i16(bounds.yMax);
    let end = -1;
    for (const contour of contours) {
        end += contour.length;
        writer.u16(end);
    }
    writer.u16(0);
    const flags = [];
    const xs = new Writer();
    const ys = new Writer();
    let x = 0;
    let y = 0;
    for (const point of contours.flat()) {
        let flag = point.on ? ON_CURVE : 0;
        const dx = point.x - x;
        const dy = point.y - y;
        if (dx === 0) flag |= X_SAME_OR_POSITIVE;
        else if (Math.abs(dx) < 256) {
            flag |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0);
            xs.u8(Math.abs(dx));
        } else xs.i16(dx);
        if (dy === 0) flag |= Y_SAME_OR_POSITIVE;
        else if (Math.abs(dy) < 256) {
            flag |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0);
            ys.u8(Math.abs(dy));
        } else ys.i16(dy);
        flags.push(flag);
        x = point.x;
        y = point.y;
    }
    for (let index = 0; index < flags.length;) {
        let repeats = 0;
        while (index + repeats + 1 < flags.length && flags[index + repeats + 1] === flags[index] && repeats < 255) repeats++;
        if (repeats > 1) {
            writer.u8(flags[index] | REPEAT);
            writer.u8(repeats);
            index += repeats + 1;
        } else {
            writer.u8(flags[index]);
            index += 1;
        }
    }
    writer.raw(xs.bytes);
    writer.raw(ys.bytes);
    writer.pad(4);
    return writer.toBytes();
}

function averageWidth(glyphs) {
    const byCharacter = new Map(glyphs.filter((glyph) => glyph.codepoint !== null).map((glyph) => [String.fromCodePoint(glyph.codepoint), glyph.advance]));
    if (Object.keys(LOWERCASE_WEIGHTS).every((character) => byCharacter.has(character))) {
        return Math.round(Object.entries(LOWERCASE_WEIGHTS).reduce((total, [character, weight]) => total + byCharacter.get(character) * weight, 0) / 1000);
    }
    const widths = glyphs.map((glyph) => glyph.advance).filter((advance) => advance > 0);
    return widths.length ? Math.round(widths.reduce((total, width) => total + width, 0) / widths.length) : 0;
}

function unicodeRanges(codepoints) {
    const words = [0, 0, 0, 0];
    for (const [bit, first, last] of UNICODE_RANGES) {
        if (codepoints.some((codepoint) => codepoint >= first && codepoint <= last)) words[bit >> 5] |= 1 << (bit & 31);
    }
    return words.map((word) => word >>> 0);
}

function codepageRanges(codepoints) {
    const present = new Set(codepoints);
    let bits = 0;
    const basicLatin = Array.from({ length: 0x5f }, (_, index) => 0x20 + index);
    if (basicLatin.filter((codepoint) => present.has(codepoint)).length >= basicLatin.length * CODEPAGE_COVERAGE) bits |= 1 << CODEPAGES[1252].bit;
    for (const codepage of [1250, 1251, 1253]) {
        const needed = [...codepageMap(codepage).values()].filter((codepoint) => codepoint >= 0x80);
        if (needed.filter((codepoint) => present.has(codepoint)).length >= needed.length * CODEPAGE_COVERAGE) bits |= 1 << CODEPAGES[codepage].bit;
    }
    return bits >>> 0;
}

function format4(mapping) {
    const codes = [...mapping.keys()].filter((codepoint) => codepoint <= 0xfffe).sort((first, second) => first - second);
    const runs = [];
    for (const codepoint of codes) {
        const run = runs[runs.length - 1];
        if (run && codepoint === run.end + 1 && mapping.get(codepoint) === mapping.get(run.end) + 1) run.end = codepoint;
        else runs.push({ start: codepoint, end: codepoint });
    }
    runs.push({ start: 0xffff, end: 0xffff, delta: 1 });
    const count = runs.length;
    const power = 2 ** Math.floor(Math.log2(count));
    const writer = new Writer();
    writer.u16(4);
    writer.u16(16 + 8 * count);
    writer.u16(0);
    writer.u16(count * 2);
    writer.u16(power * 2);
    writer.u16(Math.log2(power));
    writer.u16(count * 2 - power * 2);
    runs.forEach((run) => writer.u16(run.end));
    writer.u16(0);
    runs.forEach((run) => writer.u16(run.start));
    runs.forEach((run) => writer.u16(((run.delta ?? mapping.get(run.start) - run.start) + 0x10000) & 0xffff));
    runs.forEach(() => writer.u16(0));
    return writer.bytes;
}

function cmapTable(mapping) {
    const mac = new TextDecoder("macintosh");
    const format0 = new Writer();
    format0.u16(0);
    format0.u16(262);
    format0.u16(0);
    for (let byte = 0; byte < 256; byte++) format0.u8(byte < 0x20 ? 0 : mapping.get(mac.decode(Uint8Array.of(byte)).codePointAt(0)) ?? 0);
    const unicode = format4(mapping);
    const writer = new Writer();
    writer.u16(0);
    writer.u16(2);
    writer.u16(1);
    writer.u16(0);
    writer.u32(20);
    writer.u16(3);
    writer.u16(1);
    writer.u32(20 + format0.length);
    writer.raw(format0.bytes);
    writer.raw(unicode);
    return writer.bytes;
}

function utf16(text) {
    const bytes = [];
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        bytes.push(unit >> 8, unit & 0xff);
    }
    return bytes;
}

function nameTable(names) {
    const entries = Object.entries(names).filter(([, text]) => text).map(([id, text]) => [Number(id), text]).sort((first, second) => first[0] - second[0]);
    const records = [
        ...entries.map(([id, text]) => ({ platform: 1, encoding: 0, language: 0, id, bytes: [...asciiText(text)].map((character) => character.charCodeAt(0)) })),
        ...entries.map(([id, text]) => ({ platform: 3, encoding: 1, language: 0x409, id, bytes: utf16(text) })),
    ];
    const writer = new Writer();
    writer.u16(0);
    writer.u16(records.length);
    writer.u16(6 + 12 * records.length);
    const storage = [];
    for (const record of records) {
        writer.u16(record.platform);
        writer.u16(record.encoding);
        writer.u16(record.language);
        writer.u16(record.id);
        writer.u16(record.bytes.length);
        writer.u16(storage.length);
        storage.push(...record.bytes);
    }
    writer.raw(storage);
    return writer.bytes;
}

function longDateTime(writer, date) {
    const seconds = Math.floor(date.getTime() / 1000) + SECONDS_1904_TO_1970;
    writer.u32(Math.floor(seconds / 0x100000000));
    writer.u32(seconds >>> 0);
}

function checksum(bytes) {
    let sum = 0;
    for (let index = 0; index < bytes.length; index += 4) {
        sum = (sum + ((bytes[index] << 24) | ((bytes[index + 1] ?? 0) << 16) | ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0))) >>> 0;
    }
    return sum;
}

export function postScriptName(family, style) {
    const clean = (text) => asciiText(text).replace(/[^A-Za-z0-9]/g, "");
    return `${clean(family)}-${clean(style)}`.slice(0, 63);
}

export function buildTtf(font) {
    const glyphs = font.glyphs.map((glyph) => {
        const bounds = contourBounds(glyph.contours);
        return { ...glyph, bounds, data: encodeGlyph(glyph.contours, bounds) };
    });
    const inked = glyphs.filter((glyph) => glyph.bounds);
    const extent = {
        xMin: Math.min(0, ...inked.map((glyph) => glyph.bounds.xMin)),
        yMin: Math.min(0, ...inked.map((glyph) => glyph.bounds.yMin)),
        xMax: Math.max(0, ...inked.map((glyph) => glyph.bounds.xMax)),
        yMax: Math.max(0, ...inked.map((glyph) => glyph.bounds.yMax)),
    };
    const codepoints = glyphs.filter((glyph) => glyph.codepoint !== null).map((glyph) => glyph.codepoint);
    const mapping = new Map(glyphs.map((glyph, index) => [glyph.codepoint, index]).filter(([codepoint]) => codepoint !== null));
    const glyfLength = glyphs.reduce((total, glyph) => total + glyph.data.length, 0);
    const longLoca = glyfLength > 0x1fffe;
    const winAscent = Math.max(font.winAscent, extent.yMax);
    const winDescent = Math.max(font.winDescent, -extent.yMin);
    const macStyle = (font.bold ? 1 : 0) | (font.italic ? 2 : 0);
    const fsSelection = (font.italic ? 0x01 : 0) | (font.bold ? 0x20 : 0) | (!font.bold && !font.italic ? 0x40 : 0);
    const tables = {};

    const head = new Writer();
    head.u32(0x00010000);
    head.u32(0x00010000);
    head.u32(0);
    head.u32(HEAD_MAGIC);
    head.u16(0x000b);
    head.u16(font.unitsPerEm);
    longDateTime(head, font.created);
    longDateTime(head, font.created);
    head.i16(extent.xMin);
    head.i16(extent.yMin);
    head.i16(extent.xMax);
    head.i16(extent.yMax);
    head.u16(macStyle);
    head.u16(8);
    head.i16(2);
    head.i16(longLoca ? 1 : 0);
    head.i16(0);
    tables.head = head.bytes;

    const hhea = new Writer();
    hhea.u32(0x00010000);
    hhea.i16(winAscent);
    hhea.i16(-winDescent);
    hhea.i16(font.lineGap);
    hhea.u16(Math.max(...glyphs.map((glyph) => glyph.advance)));
    hhea.i16(Math.min(0, ...inked.map((glyph) => glyph.bounds.xMin)));
    hhea.i16(Math.min(0, ...inked.map((glyph) => glyph.advance - glyph.bounds.xMax)));
    hhea.i16(Math.max(0, ...inked.map((glyph) => glyph.bounds.xMax)));
    hhea.i16(font.italicAngle ? Math.round(font.unitsPerEm) : 1);
    hhea.i16(font.italicAngle ? Math.round(-Math.tan((font.italicAngle * Math.PI) / 180) * font.unitsPerEm) : 0);
    for (let index = 0; index < 5; index++) hhea.i16(0);
    hhea.i16(0);
    hhea.u16(glyphs.length);
    tables.hhea = hhea.bytes;

    const maxp = new Writer();
    maxp.u32(0x00010000);
    maxp.u16(glyphs.length);
    maxp.u16(Math.max(0, ...glyphs.map((glyph) => glyph.contours.reduce((total, contour) => total + contour.length, 0))));
    maxp.u16(Math.max(0, ...glyphs.map((glyph) => glyph.contours.length)));
    maxp.u16(0);
    maxp.u16(0);
    maxp.u16(2);
    for (let index = 0; index < 8; index++) maxp.u16(0);
    tables.maxp = maxp.bytes;

    const em = font.unitsPerEm;
    const os2 = new Writer();
    os2.u16(1);
    os2.i16(averageWidth(glyphs));
    os2.u16(font.weight);
    os2.u16(font.widthClass);
    os2.u16(0);
    for (const value of [0.65 * em, 0.6 * em, 0, 0.075 * em, 0.65 * em, 0.6 * em, 0, 0.35 * em]) os2.i16(Math.round(value));
    os2.i16(font.strikeoutSize);
    os2.i16(font.strikeoutPosition);
    os2.i16(font.familyClass);
    os2.raw(font.panose);
    unicodeRanges(codepoints).forEach((word) => os2.u32(word));
    os2.tag((font.vendor + "    ").slice(0, 4));
    os2.u16(fsSelection);
    os2.u16(Math.min(0xffff, Math.min(...codepoints)));
    os2.u16(Math.min(0xffff, Math.max(...codepoints)));
    os2.i16(font.typoAscender);
    os2.i16(font.typoDescender);
    os2.i16(font.typoLineGap);
    os2.u16(winAscent);
    os2.u16(winDescent);
    os2.u32(codepageRanges(codepoints));
    os2.u32(0);
    tables["OS/2"] = os2.bytes;

    const hmtx = new Writer();
    for (const glyph of glyphs) {
        hmtx.u16(glyph.advance);
        hmtx.i16(glyph.bounds ? glyph.bounds.xMin : 0);
    }
    tables.hmtx = hmtx.bytes;

    tables.cmap = cmapTable(mapping);

    const loca = new Writer();
    const glyf = new Writer();
    for (const glyph of glyphs) {
        if (longLoca) loca.u32(glyf.length);
        else loca.u16(glyf.length / 2);
        glyf.raw(glyph.data);
    }
    if (longLoca) loca.u32(glyf.length);
    else loca.u16(glyf.length / 2);
    tables.loca = loca.bytes;
    tables.glyf = glyf.bytes;

    const fullName = font.style === "Regular" ? font.family : `${font.family} ${font.style}`;
    tables.name = nameTable({
        0: font.copyright,
        1: font.family,
        2: font.style,
        3: `${fullName}; ${font.version}`,
        4: fullName,
        5: font.version,
        6: postScriptName(font.family, font.style),
        13: font.license,
        14: font.licenseUrl,
    });

    const post = new Writer();
    post.u32(0x00030000);
    post.u32(Math.round(font.italicAngle * 65536) >>> 0);
    post.i16(font.underlinePosition);
    post.i16(font.underlineThickness);
    post.u32(font.fixedPitch ? 1 : 0);
    for (let index = 0; index < 4; index++) post.u32(0);
    tables.post = post.bytes;

    const tags = TABLE_ORDER.filter((tag) => tables[tag]);
    const sortedTags = [...tags].sort();
    const count = tags.length;
    const power = 2 ** Math.floor(Math.log2(count));
    let offset = 12 + 16 * count;
    const placed = {};
    for (const tag of tags) {
        placed[tag] = { offset, length: tables[tag].length };
        offset += Math.ceil(tables[tag].length / 4) * 4;
    }
    const output = new Writer();
    output.u32(0x00010000);
    output.u16(count);
    output.u16(power * 16);
    output.u16(Math.log2(power));
    output.u16(count * 16 - power * 16);
    for (const tag of sortedTags) {
        output.tag(tag);
        output.u32(checksum(tables[tag]));
        output.u32(placed[tag].offset);
        output.u32(placed[tag].length);
    }
    for (const tag of tags) {
        output.raw(tables[tag]);
        output.pad(4);
    }
    const bytes = output.toBytes();
    const adjustment = (CHECKSUM_TARGET - checksum(bytes)) >>> 0;
    new DataView(bytes.buffer).setUint32(placed.head.offset + 8, adjustment);
    return bytes;
}
