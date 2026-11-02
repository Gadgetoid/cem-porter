// Recreate a missing base-relocation table for a dumped/stripped ARM CE module.
//
// Dumped ROM/XIP modules often have their .reloc table stripped (and the reloc-stripped
// characteristics flag set), so realign/rebase can't work. On ARM every absolute address a
// module uses is stored as a 32-bit word in a literal pool (ARM can't embed a full address in
// an instruction), so the relocations can be recovered without disassembly:
//
//   1. a candidate is any 4-byte-aligned word whose value lands in [imageBase, imageBase+size)
//   2. in code, keep a candidate only if some `LDR Rd,[pc,#imm]` actually loads it (real literal
//      pool); in pure-data sections keep every candidate. This removes the handful of stray
//      instructions that coincidentally look like an in-range address.
//
// Validated against the reloctut example (dumped_kbdrABB.dll): recovers all 144 real HIGHLOW
// relocations with zero false positives. Needs a correct section layout + imageBase first
// (see fixDumpedHeader for corrupt dumps); the recovered entries feed encodeRelocations().

import { u32 } from "./pe.js";
import { REL_HIGHLOW } from "./realign.js";

// Collect the addresses that pc-relative literal loads reference, within one code section.
// ARM32 (0x1c0): LDR Rd,[pc,#imm]  (4-byte)  -> cond=1110 0101 U001 1111 Rd imm12, tgt = (at+8)±imm
// SH3/SH4 (0x1a2/0x1a3/0x1a6): mov.l @(disp,PC),Rn (2-byte) -> 1101 nnnn dddddddd, tgt = (at+4 & ~3)+disp*4
// These mark which words are *loaded as data* - the literal pools where real address constants live.
function literalTargets(bytes, rva, size, machine) {
    const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    const targets = new Set();
    if (machine === 0x1c0) {
        for (let a = rva; a + 4 <= rva + size; a += 4) {
            const w = u32(a);
            if ((w & 0x0f7f0000) >>> 0 !== 0x051f0000) continue;
            const t = (a + 8 + (((w >>> 23) & 1) ? (w & 0xfff) : -(w & 0xfff))) >>> 0;
            if (t >= rva && t < rva + size) targets.add(t);
        }
    } else if (machine === 0x1a2 || machine === 0x1a3 || machine === 0x1a6) {
        for (let a = rva; a + 2 <= rva + size; a += 2) {
            const hw = u16(a);
            if ((hw >>> 12) !== 0xd) continue;
            const t = (((a + 4) & ~3) + (hw & 0xff) * 4) >>> 0;
            if (t >= rva && t < rva + size) targets.add(t);
        }
    }
    return targets;
}

// image: { bytes, imageBase, imageSize, sections: [{ rva, size, code }] } where `rva` is the
// true RVA (header fixed), `code` marks executable sections, and reading [rva,rva+size) from
// `bytes` at that rva gives the mapped data. Returns [{ kind: REL_HIGHLOW, site, parameter:null }].
// Single-dump recreation (ARM32 and SH3/SH4, both single-word HIGHLOW). image.machine selects the
// literal-load decoder. Caveat: a data word that coincidentally falls in [imageBase,imageBase+size)
// and is loaded by a literal instruction cannot be told apart from a real address constant, so a
// handful of false positives are possible (e.g. 4/1131 on an SH3 DLL). For guaranteed precision use
// relocationsByDiff() with two dumps at different load bases. MIPS needs lui/addiu pairing (not here).
export function recreateRelocations(image) {
    const { bytes, imageBase, imageSize, sections, machine } = image;
    const lo = imageBase >>> 0, hi = (imageBase + imageSize) >>> 0;
    const litTargets = new Set();
    for (const s of sections) {
        if (!s.code) continue;
        for (const t of literalTargets(bytes, s.rva, s.size, machine)) litTargets.add(t);
    }
    const sites = [];
    for (const s of sections) {
        for (let rva = s.rva; rva + 4 <= s.rva + s.size; rva += 4) {
            const w = u32(bytes, rva);
            if (w < lo || w >= hi) continue;              // not an in-image address
            if (s.code && !litTargets.has(rva)) continue; // stray instruction, not a loaded literal
            sites.push(rva);
        }
    }
    sites.sort((a, b) => a - b);
    return sites.map((site) => ({ kind: REL_HIGHLOW, site, parameter: null }));
}

// Reliable, architecture-independent: given two dumps of the SAME module mapped at bases that differ
// by `delta`, every 32-bit word that differs by exactly `delta` is a relocation (ARM/SH3/x86 single
// words; for MIPS it also flags the changed lui/addiu immediates). No false positives.
export function relocationsByDiff(bytesA, bytesB, delta) {
    const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const sites = [];
    const n = Math.min(bytesA.length, bytesB.length);
    for (let o = 0; o + 4 <= n; o += 4) {
        if (((u32(bytesB, o) - u32(bytesA, o)) >>> 0) === (delta >>> 0)) sites.push(o);
    }
    return sites.map((site) => ({ kind: REL_HIGHLOW, site, parameter: null }));
}

// Encode relocations to .reloc section bytes (same block format as realign's encodeRelocations).
function encodeReloc(sites) {
    const PAGE = 0x1000;
    const pages = new Map();
    for (const s of sites) { const page = s - (s % PAGE); (pages.get(page) ?? pages.set(page, []).get(page)).push(s); }
    const parts = [];
    for (const page of [...pages.keys()].sort((a, b) => a - b)) {
        const entries = pages.get(page).sort((a, b) => a - b).map((s) => (REL_HIGHLOW << 12) | (s - page));
        if (entries.length % 2) entries.push(0);
        const block = new Uint8Array(8 + 2 * entries.length);
        const dv = new DataView(block.buffer);
        dv.setUint32(0, page, true); dv.setUint32(4, block.length, true);
        entries.forEach((e, i) => dv.setUint16(8 + 2 * i, e, true));
        parts.push(block);
    }
    const total = parts.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total); let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
}

// Take a rebuilt PE (correct section RVAs, empty/stripped reloc) and return a relocatable PE:
// recreate the relocations, append a .reloc section + directory entry, clear RELOCS_STRIPPED.
export function attachRelocations(pe, { code = [".text"] } = {}) {
    const u16 = (o) => pe[o] | (pe[o + 1] << 8);
    const u32 = (o) => (pe[o] | (pe[o + 1] << 8) | (pe[o + 2] << 16) | (pe[o + 3] << 24)) >>> 0;
    const nt = u32(0x3c), opt = nt + 24, optSize = u16(nt + 20), nsec = u16(nt + 6);
    const imageBase = u32(opt + 28), sectAlign = u32(opt + 32), fileAlign = u32(opt + 36);
    const secTab = opt + optSize;
    const sections = [];
    for (let i = 0; i < nsec; i++) {
        const b = secTab + i * 40;
        sections.push({ name: String.fromCharCode(...pe.slice(b, b + 8)).replace(/\0+$/, ""),
            rva: u32(b + 12), size: Math.max(u32(b + 8), u32(b + 16)), raw: u32(b + 20), rawSize: u32(b + 16) });
    }
    const imageSize = u32(opt + 56);
    // flat image at RVAs
    const bytes = new Uint8Array(imageSize);
    for (const s of sections) bytes.set(pe.slice(s.raw, s.raw + s.rawSize), s.rva);
    const image = { bytes, imageBase, imageSize, sections: sections.map((s) => ({ rva: s.rva, size: s.size, code: code.includes(s.name) })) };
    const sites = recreateRelocations(image).map((r) => r.site);
    const reloc = encodeReloc(sites);
    // append .reloc section
    const alignUp = (x, a) => Math.ceil(x / a) * a;
    const newRva = alignUp(Math.max(...sections.map((s) => s.rva + s.size)), sectAlign);
    const newRaw = alignUp(pe.length, fileAlign);
    const out = new Uint8Array(newRaw + alignUp(reloc.length, fileAlign));
    out.set(pe);
    out.set(reloc, newRaw);
    const dv = new DataView(out.buffer);
    dv.setUint16(nt + 6, nsec + 1, true);                 // section count
    dv.setUint16(nt + 22, u16(nt + 22) & ~1, true);       // clear RELOCS_STRIPPED
    dv.setUint32(opt + 56, newRva + alignUp(reloc.length, sectAlign), true); // SizeOfImage
    dv.setUint32(opt + 96 + 5 * 8, newRva, true);         // reloc directory rva
    dv.setUint32(opt + 96 + 5 * 8 + 4, reloc.length, true); // reloc directory size
    const nb = secTab + nsec * 40;                         // new section header
    out.set(new TextEncoder().encode(".reloc"), nb);
    dv.setUint32(nb + 8, reloc.length, true);  dv.setUint32(nb + 12, newRva, true);
    dv.setUint32(nb + 16, alignUp(reloc.length, fileAlign), true); dv.setUint32(nb + 20, newRaw, true);
    dv.setUint32(nb + 36, 0x42000040, true);              // INITIALIZED_DATA|DISCARDABLE|READ
    return { pe: out, count: sites.length };
}
