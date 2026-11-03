import { u16, u32, cString, isPe, parsePe, readSections, rvaToOffset, MACHINE_NAMES } from "./pe.js";

// A small, extensible annotation engine for the hex tool. Each annotator is an
// independent "role" that turns a binary into a flat list of intervals; the UI
// toggles them on and off and overlays them. Intervals are plain objects so the
// set is easy to grow (a disassembler / patch-site heuristic is just another
// annotator returning intervals).
//
//   interval: { start, end, cat, label, detail?, value? }   // end exclusive
//   annotator: { id, label, role, defaultOn, build(ctx) -> interval[] }

export function hex(value, digits = 8) {
    return (value >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

const SUBSYSTEMS = { 0: "unknown", 1: "native", 2: "Windows GUI", 3: "Windows console", 9: "Windows CE GUI" };
const DIR_NAMES = ["Export", "Import", "Resource", "Exception", "Certificate", "Base relocation", "Debug",
    "Architecture", "Global pointer", "TLS", "Load config", "Bound import", "Import address table",
    "Delay import", "CLR runtime", "Reserved"];
const FILE_FLAGS = [[0x0001, "RELOCS_STRIPPED"], [0x0002, "EXECUTABLE"], [0x2000, "DLL"], [0x0100, "32BIT"]];
const SCN_FLAGS = [[0x20, "CODE"], [0x40, "INIT_DATA"], [0x80, "UNINIT_DATA"], [0x02000000, "DISCARDABLE"],
    [0x20000000, "EXEC"], [0x40000000, "READ"], [0x80000000, "WRITE"]];

function decodeFlags(value, table) {
    const names = table.filter(([bit]) => value & bit).map(([, name]) => name);
    return names.length ? names.join(" | ") : "none";
}

function dirEntry(data, index) {
    const nt = u32(data, 0x3c);
    const base = nt + 24 + 96 + 8 * index;
    return { rva: u32(data, base), size: u32(data, base + 4) };
}

export function buildContext(data) {
    const pe = isPe(data) ? parsePe(data) : null;
    const sections = pe ? readSections(data) : [];
    return { data, pe, sections, isPe: Boolean(pe) };
}

// -- annotators ------------------------------------------------------------

const peStructure = {
    id: "structure", label: "PE structure", role: "structure", defaultOn: true,
    build({ data, isPe: ok }) {
        if (!ok) return [];
        const out = [];
        const field = (start, size, label, detail) => out.push({ start, end: start + size, cat: "struct", label, detail });
        const nt = u32(data, 0x3c);
        field(0, 2, "DOS signature", '"MZ" - marks a DOS/PE executable.');
        field(0x3c, 4, "PE header offset", `e_lfanew = ${hex(nt)}. Points at the PE header.`);
        field(nt, 4, "PE signature", '"PE\\0\\0".');
        const machine = u16(data, nt + 4);
        field(nt + 4, 2, "Machine", `${MACHINE_NAMES[machine] ?? "?"} (${hex(machine, 4)}).`);
        field(nt + 6, 2, "Section count", `${u16(data, nt + 6)} sections.`);
        field(nt + 8, 4, "Timestamp", `${hex(u32(data, nt + 8))}.`);
        field(nt + 20, 2, "Optional header size", `${u16(data, nt + 20)} bytes.`);
        field(nt + 22, 2, "Characteristics", decodeFlags(u16(data, nt + 22), FILE_FLAGS) + ".");
        const opt = nt + 24;
        field(opt, 2, "Optional magic", u16(data, opt) === 0x10b ? "PE32." : hex(u16(data, opt), 4));
        field(opt + 16, 4, "Entry point", `RVA ${hex(u32(data, opt + 16))}.`);
        field(opt + 28, 4, "Image base", `${hex(u32(data, opt + 28))} - preferred load address.`);
        field(opt + 32, 4, "Section alignment", `${hex(u32(data, opt + 32))}.`);
        field(opt + 36, 4, "File alignment", `${hex(u32(data, opt + 36))}.`);
        field(opt + 56, 4, "Size of image", `${hex(u32(data, opt + 56))}.`);
        field(opt + 60, 4, "Size of headers", `${hex(u32(data, opt + 60))}.`);
        field(opt + 68, 2, "Subsystem", `${SUBSYSTEMS[u16(data, opt + 68)] ?? u16(data, opt + 68)}.`);
        const dirCount = Math.min(u32(data, opt + 92), 16);
        for (let i = 0; i < dirCount; i++) {
            const base = opt + 96 + 8 * i;
            const rva = u32(data, base), size = u32(data, base + 4);
            field(base, 8, `Dir: ${DIR_NAMES[i]}`, rva ? `RVA ${hex(rva)}, ${size} bytes.` : "empty.");
        }
        const secTab = opt + u16(data, nt + 20);
        for (const section of readSections(data)) {
            out.push({
                start: section.entry, end: section.entry + 40, cat: "struct",
                label: `Section header: ${section.name || "(unnamed)"}`,
                detail: `RVA ${hex(section.virtualAddress)}, virtual ${hex(section.virtualSize)}, raw ${hex(section.rawSize)} @ ${hex(section.rawOffset)}, flags ${decodeFlags(section.characteristics, SCN_FLAGS)}.`,
            });
        }
        return out;
    },
};

const sectionBodies = {
    id: "sections", label: "Section bodies", role: "sections", defaultOn: true,
    build({ sections }) {
        return sections.filter((s) => s.rawSize > 0).map((s) => ({
            start: s.rawOffset, end: s.rawOffset + s.rawSize,
            cat: s.characteristics & 0x20 ? "code" : "data",
            label: `${s.name || "(unnamed)"} (${s.characteristics & 0x20 ? "code" : "data"})`,
            detail: `${s.rawSize} bytes on disk, loads at ${hex(s.virtualAddress)}.`,
        }));
    },
};

const MIN_STRING = 4;
const printable = (b) => b >= 0x20 && b < 0x7f;

const strings = {
    id: "strings", label: "Strings", role: "strings", defaultOn: true,
    build({ data }) {
        const out = [];
        const len = data.length;
        const text = (start, end, wide) => {
            let s = "";
            for (let i = start; i < end; i += wide ? 2 : 1) s += String.fromCharCode(data[i]);
            const shown = s.length > 48 ? s.slice(0, 48) + "..." : s;
            out.push({ start, end, cat: "string", label: `"${shown}"`, detail: `${wide ? "UTF-16LE" : "ASCII"} string, ${s.length} chars.` });
        };
        let i = 0;
        while (i < len) {
            let j = i, chars = 0;
            while (j + 1 < len && printable(data[j]) && data[j + 1] === 0) { j += 2; chars++; }
            if (chars >= MIN_STRING) { text(i, j, true); i = j; continue; }
            j = i; let count = 0;
            while (j < len && printable(data[j])) { j++; count++; }
            if (count >= MIN_STRING) { text(i, j, false); i = j; continue; }
            i++;
        }
        return out;
    },
};

const imports = {
    id: "imports", label: "Imports", role: "imports", defaultOn: false,
    build({ data, sections, isPe: ok }) {
        if (!ok) return [];
        const dir = dirEntry(data, 1);
        if (!dir.rva) return [];
        const out = [];
        let off = rvaToOffset(sections, dir.rva);
        let guard = 0;
        while (off !== null && off + 20 <= data.length && guard++ < 4096) {
            const nameRva = u32(data, off + 12), origThunk = u32(data, off), firstThunk = u32(data, off + 16);
            if (!nameRva && !firstThunk) break;
            const nameOff = rvaToOffset(sections, nameRva);
            const dll = nameOff !== null ? cString(data, nameOff) : "?";
            out.push({ start: off, end: off + 20, cat: "import", label: `Import descriptor: ${dll}`, detail: "Points at the DLL name and thunk arrays." });
            if (nameOff !== null) out.push({ start: nameOff, end: nameOff + dll.length + 1, cat: "import", label: `DLL name: ${dll}` });
            let thunk = rvaToOffset(sections, origThunk || firstThunk);
            let tGuard = 0;
            while (thunk !== null && thunk + 4 <= data.length && tGuard++ < 8192) {
                const value = u32(data, thunk);
                if (!value) break;
                if (!(value & 0x80000000)) {
                    const hintOff = rvaToOffset(sections, value);
                    if (hintOff !== null) {
                        const fn = cString(data, hintOff + 2);
                        out.push({ start: hintOff, end: hintOff + 2 + fn.length + 1, cat: "import", label: `Import: ${dll}!${fn}` });
                    }
                }
                thunk += 4;
            }
            off += 20;
        }
        return out;
    },
};

const relocations = {
    id: "relocations", label: "Relocations", role: "relocations", defaultOn: false,
    build({ data, sections, isPe: ok }) {
        if (!ok) return [];
        const dir = dirEntry(data, 5);
        if (!dir.rva) return [];
        const start = rvaToOffset(sections, dir.rva);
        if (start === null) return [];
        const end = start + dir.size;
        const out = [];
        let off = start, guard = 0;
        while (off + 8 <= end && guard++ < 65536) {
            const page = u32(data, off), blockSize = u32(data, off + 4);
            if (blockSize < 8) break;
            out.push({ start: off, end: off + 8, cat: "reloc", label: `Reloc block @ ${hex(page)}`, detail: `${(blockSize - 8) / 2} fixups in this page.` });
            for (let p = off + 8; p < off + blockSize && p + 2 <= end; p += 2) {
                const entry = u16(data, p), type = entry >> 12;
                if (!type) continue;
                const targetOff = rvaToOffset(sections, page + (entry & 0xfff));
                if (targetOff !== null) out.push({ start: targetOff, end: targetOff + 4, cat: "reloc", label: `Relocation -> ${hex(page + (entry & 0xfff))}`, detail: `type ${type}; this word is an address, rebased when the module loads elsewhere.` });
            }
            off += blockSize;
        }
        return out;
    },
};

// Patch-site heuristics. Surfaces candidate sites with a concrete byte patch for a
// human to apply and test (guided, not turnkey). Grounded in the corpus in
// patch-points.md: the universal MIPS boolean-return tail and the ARM tst/bne gate.
const MACHINE_MIPS = 0x166, MACHINE_ARM = 0x1c0;
const MIPS_MOVE_V0_ZERO = 0x00001025;   // or $v0,$zero,$zero  = return 0
const MIPS_LI_V0_ONE = 0x24020001;      // addiu $v0,$zero,1   = return 1
const MIPS_JR_RA = 0x03e00008;          // jr $ra
const ARM_BX_LR = 0xe12fff1e;

const leBytes = (word) => [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff];

function codeSections(ctx) {
    return ctx.sections.filter((s) => s.rawSize > 0 && s.characteristics & 0x20);
}

// The universal MIPS boolean-return tail: move $v0,$zero (return 0) as a function's
// return, with jr $ra just after and a paired addiu $v0,$zero,1 (return 1) in the
// same tail. The pairing is what makes it a boolean check rather than a void/error
// return, and it holds across every MIPS point in the corpus.
function mipsPatchSites(ctx) {
    const { data } = ctx;
    const word = (offset) => u32(data, offset);
    const out = [];
    for (const section of codeSections(ctx)) {
        const start = section.rawOffset, end = start + section.rawSize;
        for (let off = start; off + 4 <= end; off += 4) {
            if (word(off) !== MIPS_MOVE_V0_ZERO) continue;
            let returns = false;
            for (let k = 1; k <= 3 && off + 4 * k + 4 <= end; k++) if (word(off + 4 * k) === MIPS_JR_RA) { returns = true; break; }
            if (!returns) continue;
            let paired = false;
            for (let k = 1; k <= 16 && off - 4 * k >= start; k++) if (word(off - 4 * k) === MIPS_LI_V0_ONE) { paired = true; break; }
            if (!paired) continue;
            out.push({
                start: off, end: off + 4, cat: "patch", confidence: "high",
                label: "Return-flip site (boolean fail path)",
                detail: "move $v0,$zero returns 0 here, with jr $ra just after and a paired 'return 1' above - a boolean check. Patch to addiu $v0,$zero,1 to force it to return 1.",
                patch: { at: off, from: leBytes(MIPS_MOVE_V0_ZERO), to: leBytes(MIPS_LI_V0_ONE) },
            });
        }
    }
    return out;
}

// ARM constant-return stub: mov r0,#0 ; bx lr. The clean analog of the MIPS flip -
// force a failing check to return 1. Gate-style patches (SoftMaker's tst/bne name
// tie) are deliberately NOT scanned for: tst/cmp feeding a branch is ubiquitous
// (thousands per binary), so those are located through the evidence layer (a string
// or import xref to the validator) rather than a blind scan.
function armPatchSites(ctx) {
    const { data } = ctx;
    const word = (offset) => u32(data, offset);
    const out = [];
    for (const section of codeSections(ctx)) {
        const start = section.rawOffset, end = start + section.rawSize;
        for (let off = start; off + 4 <= end; off += 4) {
            const w = word(off);
            if ((w & 0x0ffff000) !== 0x03a00000 || (w & 0xff) !== 0) continue;   // mov r0,#0
            let stub = false;
            for (let k = 1; k <= 2 && off + 4 * k + 4 <= end; k++) if (word(off + 4 * k) === ARM_BX_LR) { stub = true; break; }
            if (!stub) continue;
            out.push({
                start: off, end: off + 4, cat: "patch", confidence: "high",
                label: "Return-0 stub",
                detail: "mov r0,#0; bx lr returns 0. Patch to mov r0,#1 to force it to return 1.",
                patch: { at: off, from: leBytes(w), to: leBytes((w & 0xfffff000) | 1) },
            });
        }
    }
    return out;
}

const patchSites = {
    id: "patchsites", label: "Patch sites", role: "patch", defaultOn: false,
    build(ctx) {
        if (!ctx.isPe) return [];
        if (ctx.pe.machine === MACHINE_MIPS) return mipsPatchSites(ctx);
        if (ctx.pe.machine === MACHINE_ARM) return armPatchSites(ctx);
        return [];
    },
};

export const ANNOTATORS = [peStructure, sectionBodies, strings, imports, relocations, patchSites];

export function buildLayer(annotator, ctx) {
    const intervals = annotator.build(ctx);
    intervals.sort((a, b) => a.start - b.start);
    return { id: annotator.id, label: annotator.label, intervals };
}

const BACKSCAN = 64;

// Intervals covering an offset, from a single sorted layer, narrowest last.
export function hitsAt(intervals, offset) {
    let lo = 0, hi = intervals.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (intervals[mid].start <= offset) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo - 1; i >= 0 && i >= lo - 1 - BACKSCAN; i--) {
        if (intervals[i].end > offset) out.push(intervals[i]);
    }
    out.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    return out;
}
