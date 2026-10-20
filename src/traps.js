import { Image, align, setU16, setU32, u32 } from "./pe.js";
import { redirect } from "./shim.js";

const SECTION_NAME = ".ceptrap";
const SECTION_CHARACTERISTICS = 0xe0000060;
const CODE_SECTION = 0x20000000;

function isTrapLoad(word) {
    return word >>> 26 === 9 && ((word >>> 21) & 31) === 0 && (word & 0xffff) >= 0x8000;
}

function jumpThrough(word, register) {
    const masked = (word & 0xfc1fffff) >>> 0;
    if (((word >>> 21) & 31) !== register) return null;
    if (masked === 0x0000f809) return "call";
    if (masked === 0x00000008) return "tail";
    return null;
}

export function findTrapCalls(data) {
    const image = new Image(data);
    const sites = [];
    for (const section of image.sections) {
        if (!(section.characteristics & CODE_SECTION)) continue;
        const words = Math.floor(Math.min(section.rawSize, section.virtualSize || section.rawSize) / 4);
        for (let index = 0; index < words; index++) {
            const word = u32(data, section.rawOffset + 4 * index);
            if (!isTrapLoad(word)) continue;
            const register = (word >>> 16) & 31;
            for (let next = index + 1; next < Math.min(words, index + 5); next++) {
                const kind = jumpThrough(u32(data, section.rawOffset + 4 * next), register);
                if (kind) {
                    sites.push({ offset: section.rawOffset + 4 * next, rva: section.virtualAddress + 4 * next, trap: (0xffff0000 | (word & 0xffff)) >>> 0, kind });
                    break;
                }
            }
        }
    }
    return sites;
}

export function appendSection(data, contents, virtualAddress, name = SECTION_NAME) {
    const image = new Image(data);
    const tableEnd = image.sectionTable + 40 * image.sectionCount;
    const rawOffsets = image.sections.map((section) => section.rawOffset).filter(Boolean);
    if (tableEnd + 40 > image.headersSize || tableEnd + 40 > Math.min(...rawOffsets)) throw new Error("no room for another section header");
    const rawOffset = align(data.length, image.fileAlignment);
    const rawSize = align(contents.length, image.fileAlignment);
    const output = new Uint8Array(rawOffset + rawSize);
    output.set(data);
    output.set(contents, rawOffset);
    output.fill(0, tableEnd, tableEnd + 40);
    for (let index = 0; index < name.length; index++) output[tableEnd + index] = name.charCodeAt(index);
    setU32(output, tableEnd + 8, contents.length);
    setU32(output, tableEnd + 12, virtualAddress);
    setU32(output, tableEnd + 16, rawSize);
    setU32(output, tableEnd + 20, rawOffset);
    setU32(output, tableEnd + 36, SECTION_CHARACTERISTICS);
    setU16(output, image.pe + 6, image.sectionCount + 1);
    setU32(output, image.optional + 56, align(virtualAddress + contents.length, image.sectionAlignment));
    return output;
}

export function redirectTrapCalls(data, trapNames, resolve) {
    const sites = findTrapCalls(data);
    if (!sites.length) return { data: null, calls: [], unknown: [] };
    const chosen = new Map();
    const unknown = new Set();
    for (const site of sites) {
        const key = `0x${site.trap.toString(16).padStart(8, "0")}`;
        const name = (trapNames[key] ?? []).find((candidate) => resolve(candidate));
        if (name) chosen.set(site, name);
        else unknown.add(key);
    }
    if (!chosen.size) return { data: null, calls: [], unknown: [...unknown] };
    const image = new Image(data);
    const names = [...new Set(chosen.values())];
    const sectionEnds = image.sections.map((section) => section.virtualAddress + Math.max(section.virtualSize, section.rawSize));
    const sectionVa = align(Math.max(...sectionEnds), image.sectionAlignment);
    const contents = new Uint8Array(4 * names.length + 16 * names.length);
    const slotRva = (index) => sectionVa + 4 * index;
    const thunkVa = (index) => image.imageBase + sectionVa + 4 * names.length + 16 * index;
    names.forEach((name, index) => {
        const slot = image.imageBase + slotRva(index);
        const low = slot & 0xffff;
        const high = ((slot >>> 16) + (low >= 0x8000 ? 1 : 0)) & 0xffff;
        const thunk = 4 * names.length + 16 * index;
        setU32(contents, thunk, (0x3c190000 | high) >>> 0);
        setU32(contents, thunk + 4, (0x8f390000 | low) >>> 0);
        setU32(contents, thunk + 8, 0x03200008);
        setU32(contents, thunk + 12, 0);
    });
    let output = appendSection(data, contents, sectionVa);
    for (const [site, name] of chosen) {
        const target = (thunkVa(names.indexOf(name)) >>> 2) & 0x3ffffff;
        setU32(output, site.offset, ((site.kind === "call" ? 0x0c000000 : 0x08000000) | target) >>> 0);
    }
    const byDll = new Map();
    names.forEach((name, index) => {
        const dll = resolve(name);
        if (!byDll.has(dll)) byDll.set(dll, []);
        byDll.get(dll).push([name, slotRva(index)]);
    });
    for (const [dll, redirects] of byDll) output = redirect(output, dll, redirects);
    const counts = names.map((name) => ({ name, sites: [...chosen.values()].filter((value) => value === name).length }));
    return { data: output, calls: counts, unknown: [...unknown] };
}

const SH3_NOP = 0x0009;
const SH3_RETURN = 0x000b;
const SH3_ZERO_R0 = 0xe000;
const SH3_CE2_TRAPS = {
    0xfffff9fd: { name: "TerminateProcess", action: "nop" },
    0xfffffd51: { name: "SetLastError", action: "nop" },
    0xfffffd4f: { name: "GetLastError", action: "zero" },
    0xfffffd1d: { name: "RaiseException", action: "nop" },
    0xfffffde3: { name: "TlsCall", action: "literal", literal: 0xdfe1 },
};

export function patchSh3TrapCalls(input) {
    const data = input.slice();
    const image = new Image(data);
    const changed = new Map();
    const unknown = new Set();
    const swapped = new Map();
    for (const section of image.sections) {
        if (!(section.characteristics & CODE_SECTION)) continue;
        const end = section.rawOffset + Math.min(section.rawSize, section.virtualSize || section.rawSize);
        for (let offset = section.rawOffset; offset + 2 <= end; offset += 2) {
            const word = data[offset] | (data[offset + 1] << 8);
            if (word >>> 12 !== 9) continue;
            const literal = offset + 4 + 2 * (word & 0xff);
            if (literal + 2 > end) continue;
            const value = (0xffff0000 | data[literal] | (data[literal + 1] << 8)) >>> 0;
            if ((data[literal + 1] & 0x80) === 0 || !(value & 1) || value < 0xffff8000) continue;
            const register = (word >>> 8) & 15;
            for (let next = offset + 2; next < Math.min(end, offset + 8); next += 2) {
                const jump = data[next] | (data[next + 1] << 8);
                const call = jump === (0x400b | (register << 8));
                const tail = jump === (0x402b | (register << 8));
                if (!call && !tail) continue;
                const known = swapped.get(literal) ?? SH3_CE2_TRAPS[value];
                if (swapped.has(literal)) {
                    changed.set(known.name, (changed.get(known.name) ?? 0) + 1);
                } else if (!known) {
                    unknown.add(`0x${value.toString(16)}`);
                } else {
                    if (known.action === "literal") {
                        data[literal] = known.literal & 0xff;
                        data[literal + 1] = known.literal >>> 8;
                        swapped.set(literal, known);
                    } else {
                        const replacement = tail ? SH3_RETURN : known.action === "zero" ? SH3_ZERO_R0 : SH3_NOP;
                        data[next] = replacement & 0xff;
                        data[next + 1] = replacement >>> 8;
                    }
                    changed.set(known.name, (changed.get(known.name) ?? 0) + 1);
                }
                break;
            }
        }
    }
    return { data: changed.size ? data : null, calls: [...changed.keys()], unknown: [...unknown] };
}
