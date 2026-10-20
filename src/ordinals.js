import { u16, u32, setU32, cString, rvaToOffset } from "./pe.js";

export const VELO_LABEL = "H/PC 2.0 (Velo 1)";
export const CE211_LABEL = "H/PC Pro 2.11 (Cassiopeia E-55)";
export const MIPS_LABEL = "HPC2000 3.0 (MobilePro 790)";
export const SH3_CE2_LABEL = "H/PC 2.0 SH3 (HP 320LX)";
export const SH3_CE212_LABEL = "CE 2.12 SH3 (Odo)";
export const CPU_HELPERS = 2000;

export const PROBES = new Set([
    "CreateWindowExW", "RegisterClassW", "GetMessageW", "DispatchMessageW", "DefWindowProcW", "TranslateMessage",
    "PostQuitMessage", "BeginPaint", "EndPaint", "LoadStringW", "LocalAlloc", "LocalFree", "SendMessageW",
    "ShowWindow", "UpdateWindow", "GetStockObject", "SelectObject", "CreateFileW", "CloseHandle", "SetWindowTextW",
    "DestroyWindow", "MessageBoxW", "GetDC", "ReleaseDC", "InvalidateRect", "SetTimer", "KillTimer", "LoadIconW",
    "LoadCursorW", "GetClientRect", "DeleteObject", "memset", "memcpy", "wcslen", "wcscpy",
]);

export function sh3Tables(coredllTables, sh3TablesJson) {
    const tables = {};
    for (const [label, table] of Object.entries(coredllTables)) {
        if (label !== VELO_LABEL) tables[label] = table;
    }
    return Object.assign(tables, sh3TablesJson);
}

function has(table, name) {
    return name !== null && Object.hasOwn(table, name);
}

function readImportSections(data) {
    const header = u32(data, 0x3c);
    const sectionCount = u16(data, header + 6);
    const optionalSize = u16(data, header + 20);
    const optional = header + 24;
    const sections = [];
    for (let index = 0; index < sectionCount; index++) {
        const entry = optional + optionalSize + 40 * index + 8;
        sections.push({
            virtualSize: u32(data, entry),
            virtualAddress: u32(data, entry + 4),
            rawSize: u32(data, entry + 8),
            rawOffset: u32(data, entry + 12),
        });
    }
    return { sections, importRva: u32(data, optional + 104) };
}

export function importEntries(data, wantedDll) {
    const { sections, importRva } = readImportSections(data);
    const entries = [];
    if (!importRva) return entries;
    let position = rvaToOffset(sections, importRva);
    while (position !== null) {
        const originalThunk = u32(data, position);
        const nameRva = u32(data, position + 12);
        const firstThunk = u32(data, position + 16);
        if (!nameRva) break;
        const nameOffset = rvaToOffset(sections, nameRva);
        const dll = cString(data, nameOffset ?? 0).toLowerCase();
        if (dll === wantedDll) {
            const lookupRva = originalThunk || firstThunk;
            for (let index = 0; ; index++) {
                const lookupOffset = rvaToOffset(sections, lookupRva + 4 * index);
                if (lookupOffset === null) break;
                const value = u32(data, lookupOffset);
                if (!value) break;
                const iatRva = firstThunk + 4 * index;
                let name = null;
                if (!(value & 0x80000000)) {
                    const hintOffset = rvaToOffset(sections, value);
                    name = hintOffset !== null ? cString(data, hintOffset + 2) : null;
                }
                entries.push({ iatRva, lookupOffset, iatOffset: rvaToOffset(sections, iatRva), value, name });
            }
        }
        position += 20;
    }
    return entries;
}

export function coredllEntries(data) {
    return importEntries(data, "coredll.dll");
}

function entryOffsets(entry) {
    return [...new Set([entry.lookupOffset, entry.iatOffset].filter((offset) => offset !== null))];
}

export function coredllOrdinalSlots(data) {
    const slots = [];
    for (const entry of coredllEntries(data)) {
        if (!(entry.value & 0x80000000)) continue;
        for (const offset of entryOffsets(entry)) slots.push([offset, entry.value & 0xffff]);
    }
    return slots;
}

export function detect(data, tables, target = VELO_LABEL) {
    const slots = coredllOrdinalSlots(data);
    const ordinals = new Set(slots.map(([, ordinal]) => ordinal));
    if (!ordinals.size) return { label: null, scores: {}, slots };
    const scores = {};
    for (const [label, table] of Object.entries(tables)) {
        const byOrdinal = new Map();
        for (const [name, ordinal] of Object.entries(table)) byOrdinal.set(ordinal, name);
        const names = new Set([...ordinals].map((ordinal) => byOrdinal.get(ordinal)));
        scores[label] = [...names].filter((name) => PROBES.has(name)).length;
    }
    if (Math.max(...ordinals) > Math.max(...Object.values(tables[target]))) scores[target] = -1;
    let best = null;
    for (const label of Object.keys(scores)) {
        if (best === null) {
            best = label;
            continue;
        }
        const better = scores[label] > scores[best] || (scores[label] === scores[best] && label === target && best !== target);
        if (better) best = label;
    }
    return { label: best, scores, slots };
}

export function sourceNames(tables, label, helpers = MIPS_LABEL) {
    const names = new Map();
    for (const fallback of [helpers, CE211_LABEL, label]) {
        for (const [name, ordinal] of Object.entries(tables[fallback])) {
            if (ordinal < CPU_HELPERS) names.set(ordinal, name);
        }
    }
    for (const [name, ordinal] of Object.entries(tables[helpers])) {
        if (ordinal >= CPU_HELPERS) names.set(ordinal, name);
    }
    return names;
}

export function veloName(name, table) {
    if (has(table, name)) return name;
    if (name && name.endsWith("W") && has(table, name.slice(0, -1))) return name.slice(0, -1);
    return null;
}

function writeOrdinal(output, entry, ordinal) {
    for (const offset of [entry.lookupOffset, entry.iatOffset]) {
        if (offset !== null) setU32(output, offset, (0x80000000 | ordinal) >>> 0);
    }
}

function compareChanged([nameA, ordinalA], [nameB, ordinalB]) {
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return ordinalA - ordinalB;
}

export function remap(data, tables, dllTables, targetLabel = VELO_LABEL, helpersLabel = MIPS_LABEL) {
    const { label, scores } = detect(data, tables, targetLabel);
    const renumber = Boolean(label) && label !== targetLabel && scores[label] > scores[targetLabel];
    const source = renumber ? sourceNames(tables, label, helpersLabel) : new Map();
    const target = tables[targetLabel];
    const output = new Uint8Array(data);
    const changed = new Map();
    const missing = new Set();
    const unresolved = [];

    for (const entry of coredllEntries(data)) {
        if (entry.value & 0x80000000) {
            if (!renumber) continue;
            const ordinal = entry.value & 0xffff;
            const sourceName = source.get(ordinal) ?? null;
            const resolved = veloName(sourceName, target);
            if (resolved) {
                writeOrdinal(output, entry, target[resolved]);
                changed.set(`${ordinal}`, [sourceName, target[resolved]]);
                continue;
            }
            const name = sourceName || `#${ordinal}`;
            missing.add(name);
            unresolved.push({ iatRva: entry.iatRva, name, dll: "coredll.dll" });
        } else if (entry.name && !has(target, entry.name)) {
            unresolved.push({ iatRva: entry.iatRva, name: entry.name, dll: "coredll.dll" });
        }
    }

    for (const [dll, tablesForDll] of Object.entries(dllTables)) {
        const velo = tablesForDll[VELO_LABEL];
        for (const entry of importEntries(data, dll)) {
            if (entry.name && !has(velo, entry.name)) unresolved.push({ iatRva: entry.iatRva, name: entry.name, dll });
        }
    }

    if (renumber) {
        for (const [dll, tablesForDll] of Object.entries(dllTables)) {
            const names = new Map();
            for (const fallback of [MIPS_LABEL, CE211_LABEL, label]) {
                for (const [name, ordinal] of Object.entries(tablesForDll[fallback] ?? {})) names.set(ordinal, name);
            }
            const velo = tablesForDll[VELO_LABEL];
            for (const entry of importEntries(data, dll)) {
                if (!(entry.value & 0x80000000)) continue;
                const ordinal = entry.value & 0xffff;
                const name = names.get(ordinal) ?? null;
                if (has(velo, name)) {
                    writeOrdinal(output, entry, velo[name]);
                    changed.set(`${dll}\u0000${ordinal}`, [name, velo[name]]);
                } else {
                    missing.add(`${dll} ${name || `#${ordinal}`}`);
                }
            }
        }
    }

    return {
        data: renumber ? output : null,
        label,
        changed: [...changed.values()].sort(compareChanged),
        missing: [...missing].sort(),
        unresolved,
    };
}
