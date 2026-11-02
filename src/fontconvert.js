import { parse } from "../vendor/opentype.js";
import { contoursFromCommands, contoursFromPoints, countPoints, reverseContours, roundContours, scaleContours, simplifyContours } from "./outline.js";
import { buildTtf } from "./ttfwrite.js";
import { buildFnt, FNT_FIRST_CHAR, FNT_LAST_CHAR, FAMILY_MODERN, FAMILY_ROMAN, FAMILY_SWISS } from "./fntwrite.js";
import { CODEPAGES, codepageMap } from "./fontsets.js";
import { contoursToCommands, rasterize } from "./raster.js";

export const RIBBI = ["Regular", "Bold", "Italic", "Bold Italic"];
const MIN_CUBIC_ERROR = 0.001;
const PANOSE_SANS = new Set([11, 12, 13]);
const PANOSE_MONOSPACED = 9;
const POINTS_TO_PIXELS = 96 / 72;

function readHdmx(bytes, numGlyphs) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(0);
    if (version !== 0x00010000 && version !== 0x74727565) return null;
    const tableCount = view.getUint16(4);
    for (let index = 0; index < tableCount; index++) {
        const record = 12 + index * 16;
        if (String.fromCharCode(...bytes.subarray(record, record + 4)) !== "hdmx") continue;
        const offset = view.getUint32(record + 8);
        const recordCount = view.getInt16(offset + 2);
        const recordSize = view.getInt32(offset + 4);
        const widths = new Map();
        for (let entry = 0; entry < recordCount; entry++) {
            const start = offset + 8 + entry * recordSize;
            widths.set(bytes[start], bytes.subarray(start + 2, start + 2 + numGlyphs));
        }
        return widths;
    }
    return null;
}

export function openFont(bytes) {
    const font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    font.hintedWidths = readHdmx(bytes, font.numGlyphs);
    return font;
}

function text(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    return value.en ?? Object.values(value)[0] ?? "";
}

export function englishName(font, key) {
    for (const platform of ["windows", "macintosh", "unicode"]) {
        const value = text(font.names?.[platform]?.[key]);
        if (value) return value;
    }
    return "";
}

export function describeFont(font) {
    const fvar = font.variation ? font.tables.fvar : null;
    return {
        family: englishName(font, "fontFamily"),
        style: englishName(font, "fontSubfamily") || "Regular",
        outlines: font.outlinesFormat === "cff" ? "PostScript" : "TrueType",
        axes: fvar ? fvar.axes.map((axis) => ({ tag: axis.tag, name: text(axis.name) || axis.tag, min: axis.minValue, max: axis.maxValue, value: axis.defaultValue })) : [],
        instances: fvar ? fvar.instances.map((instance) => ({ name: text(instance.name), coordinates: instance.coordinates })) : [],
        glyphs: font.numGlyphs,
    };
}

export function defaultNaming(font, instanceName, coordinates) {
    const description = describeFont(font);
    const weight = Math.round(coordinates?.wght ?? font.tables.os2?.usWeightClass ?? 400);
    if (!description.axes.length) {
        const style = RIBBI.includes(description.style) ? description.style : "Regular";
        const family = RIBBI.includes(description.style) ? description.family : `${description.family} ${description.style}`;
        return { family, style, weight };
    }
    const base = englishName(font, "preferredFamily") || description.family;
    const name = (instanceName || description.style).trim();
    if (RIBBI.includes(name)) return { family: base, style: name, weight };
    const italic = /\bItalic\b/.test(name) || (font.tables.os2?.fsSelection & 1) === 1;
    const rest = name.replace(/\s*\bItalic\b\s*/, " ").trim();
    return { family: rest ? `${base} ${rest}` : base, style: italic ? "Italic" : "Regular", weight };
}

function parseCompositeDeltas(font, glyph) {
    const variations = font.variation?.process.gvar()?.glyphVariations?.[glyph.index];
    if (!glyph.components?.length || !variations?.headers?.length || variations.componentDeltas) return;
    const points = glyph.points;
    glyph.points = glyph.components.map(() => null);
    try {
        for (const header of variations.headers) void [header.deltas, header.deltasY];
    } finally {
        glyph.points = points;
    }
    variations.componentDeltas = true;
}

function loadGlyph(font, glyph) {
    void glyph.path;
    parseCompositeDeltas(font, glyph);
    for (const component of glyph.components ?? []) loadGlyph(font, font.glyphs.get(component.glyphIndex));
}

function sourceGlyph(font, glyph, coordinates) {
    loadGlyph(font, glyph);
    return font.variation && coordinates ? font.variation.getTransform(glyph, coordinates) : glyph;
}

function variedComposite(font, glyph, coordinates) {
    return Boolean(font.variation && coordinates && glyph.components?.length);
}

function componentOffsets(font, glyph, coordinates) {
    const offsets = glyph.components.map((component) => ({ x: component.dx, y: component.dy, onCurve: true, lastPointOfContour: true }));
    const variations = font.variation.process.gvar()?.glyphVariations?.[glyph.index];
    if (!variations?.headers?.length) return offsets;
    return font.variation.process.applyTupleVariationStore(variations, offsets, coordinates, "gvar");
}

function composedContours(font, glyph, coordinates, cubicError) {
    const offsets = componentOffsets(font, glyph, coordinates);
    return glyph.components.flatMap((component, index) => {
        const parts = glyphOutline(font, font.glyphs.get(component.glyphIndex), coordinates, cubicError).contours;
        return parts.map((contour) => contour.map((point) => ({
            x: component.xScale * point.x + component.scale10 * point.y + offsets[index].x,
            y: component.scale01 * point.x + component.yScale * point.y + offsets[index].y,
            on: point.on,
        })));
    });
}

export function glyphOutline(font, glyph, coordinates, cubicError) {
    const source = sourceGlyph(font, glyph, coordinates);
    let contours;
    if (variedComposite(font, glyph, coordinates)) contours = composedContours(font, glyph, coordinates, cubicError);
    else if (font.outlinesFormat === "cff") contours = reverseContours(contoursFromCommands(source.path.commands, cubicError));
    else if (source.points?.length) contours = contoursFromPoints(source.points);
    else contours = contoursFromCommands(source.path.commands, cubicError);
    return { advance: source.advanceWidth ?? glyph.advanceWidth ?? 0, contours };
}

function glyphFor(font, codepoint) {
    const index = font.charToGlyphIndex(String.fromCodePoint(codepoint));
    return index > 0 ? font.glyphs.get(index) : null;
}

function verticalMetrics(font) {
    const os2 = font.tables.os2;
    const hhea = font.tables.hhea;
    return {
        winAscent: os2?.usWinAscent || hhea.ascender,
        winDescent: os2?.usWinDescent || -hhea.descender,
        typoAscender: os2?.sTypoAscender ?? hhea.ascender,
        typoDescender: os2?.sTypoDescender ?? hhea.descender,
        typoLineGap: os2?.sTypoLineGap ?? hhea.lineGap,
        lineGap: hhea.lineGap ?? 0,
    };
}

function fixedPitch(font) {
    return Boolean(font.tables.post?.isFixedPitch) || font.tables.os2?.panose?.[3] === PANOSE_MONOSPACED;
}

export function convertTtf(font, options) {
    const sourceEm = font.unitsPerEm;
    const unitsPerEm = options.unitsPerEm || sourceEm;
    const scale = unitsPerEm / sourceEm;
    const tolerance = options.detail * unitsPerEm;
    const cubicError = Math.max(MIN_CUBIC_ERROR * sourceEm, tolerance / scale);
    const prepare = (outline) => ({
        advance: Math.round(outline.advance * scale),
        contours: roundContours(simplifyContours(scaleContours(outline.contours, scale), tolerance)),
    });
    const missing = [];
    const glyphs = [];
    let sourcePoints = 0;
    const notdef = glyphOutline(font, font.glyphs.get(0), options.coordinates, cubicError);
    sourcePoints += countPoints(notdef.contours);
    glyphs.push({ codepoint: null, ...prepare(notdef) });
    for (const codepoint of options.codepoints) {
        const glyph = glyphFor(font, codepoint);
        if (!glyph) {
            missing.push(codepoint);
            continue;
        }
        const outline = glyphOutline(font, glyph, options.coordinates, cubicError);
        sourcePoints += countPoints(outline.contours);
        glyphs.push({ codepoint, ...prepare(outline) });
    }
    if (glyphs.length < 2) throw new Error("none of the chosen characters are in this font");
    const metrics = verticalMetrics(font);
    const scaled = (value) => Math.round((value ?? 0) * scale);
    const os2 = font.tables.os2 ?? {};
    const post = font.tables.post ?? {};
    const data = buildTtf({
        unitsPerEm,
        family: options.family,
        style: options.style,
        bold: options.style.includes("Bold"),
        italic: options.style.includes("Italic"),
        weight: options.weight,
        widthClass: os2.usWidthClass || 5,
        familyClass: os2.sFamilyClass ?? 0,
        panose: os2.panose ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        vendor: os2.achVendID || "CEMP",
        strikeoutSize: scaled(os2.yStrikeoutSize || sourceEm / 20),
        strikeoutPosition: scaled(os2.yStrikeoutPosition || sourceEm / 4),
        winAscent: scaled(metrics.winAscent),
        winDescent: scaled(metrics.winDescent),
        typoAscender: scaled(metrics.typoAscender),
        typoDescender: scaled(metrics.typoDescender),
        typoLineGap: scaled(metrics.typoLineGap),
        lineGap: scaled(metrics.lineGap),
        italicAngle: post.italicAngle ?? 0,
        underlinePosition: scaled(post.underlinePosition ?? -sourceEm / 10),
        underlineThickness: scaled(post.underlineThickness || sourceEm / 20),
        fixedPitch: fixedPitch(font),
        copyright: englishName(font, "copyright"),
        version: englishName(font, "version") || "Version 1.000",
        license: englishName(font, "license"),
        licenseUrl: englishName(font, "licenseURL"),
        created: options.created ?? new Date(),
        glyphs,
    });
    return { data, glyphs, missing, unitsPerEm, winAscent: scaled(metrics.winAscent), winDescent: scaled(metrics.winDescent), sourcePoints, points: glyphs.reduce((total, glyph) => total + countPoints(glyph.contours), 0) };
}

function pitchFamily(font) {
    if (fixedPitch(font)) return FAMILY_MODERN;
    const panose = font.tables.os2?.panose;
    if (panose && panose[0] === 2 && panose[1] >= 2 && !PANOSE_SANS.has(panose[1])) return FAMILY_ROMAN;
    return FAMILY_SWISS;
}

function boxGlyph(width, height, ascent, pixelsPerEm) {
    const bitmap = new Uint8Array(width * height);
    const top = Math.max(0, ascent - Math.round(pixelsPerEm * 0.7));
    const right = width - 3;
    for (let y = top; y < ascent; y++) {
        for (let x = 1; x <= right; x++) {
            if (y === top || y === ascent - 1 || x === 1 || x === right) bitmap[y * width + x] = 1;
        }
    }
    return { width, bitmap };
}

export function fntMetrics(font, points) {
    const pixelsPerEm = Math.round(points * POINTS_TO_PIXELS);
    const metrics = verticalMetrics(font);
    const ascent = Math.round((metrics.winAscent * pixelsPerEm) / font.unitsPerEm);
    const descent = Math.round((metrics.winDescent * pixelsPerEm) / font.unitsPerEm);
    return { pixelsPerEm, ascent, height: ascent + descent, internalLeading: Math.max(0, ascent + descent - pixelsPerEm) };
}

function usablePath(commands, width, height) {
    return commands.every((command) => ["x", "y", "x1", "y1", "x2", "y2"].every((key) => {
        const value = command[key];
        if (value === undefined) return true;
        const limit = key.startsWith("x") ? width : height;
        return Number.isFinite(value) && value > -limit && value < 2 * limit;
    }));
}

export function renderBitmapGlyph(font, glyph, metrics, options) {
    const source = sourceGlyph(font, glyph, options.coordinates);
    const hintedWidth = options.hinting && !font.variation ? font.hintedWidths?.get(metrics.pixelsPerEm)?.[glyph.index] : 0;
    const width = Math.max(1, hintedWidth || Math.round((source.advanceWidth * metrics.pixelsPerEm) / font.unitsPerEm));
    if (variedComposite(font, glyph, options.coordinates)) {
        const contours = composedContours(font, glyph, options.coordinates, MIN_CUBIC_ERROR * font.unitsPerEm);
        const commands = contoursToCommands(contours, metrics.pixelsPerEm / font.unitsPerEm, 0, metrics.ascent);
        return { width, bitmap: rasterize(commands, width, metrics.height), unhinted: Boolean(options.hinting && font.tables.fpgm) };
    }
    const pathOptions = (hinting) => ({ hinting, variation: font.variation ? options.coordinates : undefined });
    let path = glyph.getPath(0, metrics.ascent, metrics.pixelsPerEm, pathOptions(options.hinting), font);
    let unhinted = false;
    if (options.hinting && !usablePath(path.commands, width, metrics.height)) {
        path = glyph.getPath(0, metrics.ascent, metrics.pixelsPerEm, pathOptions(false), font);
        unhinted = true;
    }
    return { width, bitmap: rasterize(path.commands, width, metrics.height), unhinted };
}

export function convertFnt(font, options) {
    const map = codepageMap(options.codepage);
    const results = [];
    for (const points of options.sizes) {
        const metrics = fntMetrics(font, points);
        const notdef = renderBitmapGlyph(font, font.glyphs.get(0), metrics, options);
        const fallback = notdef.bitmap.some(Boolean) ? notdef : boxGlyph(Math.max(4, Math.round(metrics.pixelsPerEm * 0.75)), metrics.height, metrics.ascent, metrics.pixelsPerEm);
        const glyphs = [fallback];
        const missing = [];
        for (let code = FNT_FIRST_CHAR + 1; code <= FNT_LAST_CHAR; code++) {
            const codepoint = map.get(code);
            const glyph = codepoint === undefined ? null : glyphFor(font, codepoint);
            if (!glyph) {
                if (codepoint !== undefined) missing.push(codepoint);
                glyphs.push(fallback);
                continue;
            }
            glyphs.push(renderBitmapGlyph(font, glyph, metrics, options));
        }
        const data = buildFnt({
            face: options.family,
            copyright: englishName(font, "copyright"),
            points,
            ascent: metrics.ascent,
            internalLeading: metrics.internalLeading,
            height: metrics.height,
            weight: options.weight,
            italic: options.style.includes("Italic"),
            charset: CODEPAGES[options.codepage].charset,
            family: pitchFamily(font),
            fixedPitch: fixedPitch(font),
            glyphs,
        });
        results.push({ points, data, glyphs, missing, metrics, map, unhinted: glyphs.filter((glyph) => glyph.unhinted).length });
    }
    return results;
}

export function ttfCells(result, points) {
    const pixelsPerEm = Math.round(points * POINTS_TO_PIXELS);
    const scale = pixelsPerEm / result.unitsPerEm;
    const ascent = Math.round(result.winAscent * scale);
    const height = ascent + Math.round(result.winDescent * scale);
    const cells = new Map();
    for (const glyph of result.glyphs) {
        const width = Math.max(1, Math.round(glyph.advance * scale));
        cells.set(glyph.codepoint, { width, bitmap: rasterize(contoursToCommands(glyph.contours, scale, 0, ascent), width, height) });
    }
    return { height, cells, fallback: cells.get(null) };
}

export function fntCells(result) {
    const cells = new Map();
    for (const [code, codepoint] of result.map) cells.set(codepoint, result.glyphs[code - FNT_FIRST_CHAR]);
    return { height: result.metrics.height, cells, fallback: result.glyphs[0] };
}
