import { parsePe } from "./pe.js";
import { readExports } from "./romres.js";
import { CE1_RENAMES } from "./ce1.js";
import { RENAMES, SHIMMED } from "./shim.js";
import { detect, MIPS_LABEL, SH3_CE2_LABEL, SH3_CE212_LABEL, sh3Tables, sourceNames, VELO_LABEL } from "./ordinals.js";

const FAMILIES = {
    MIPS: [0x162, 0x166, 0x168, 0x169, 0x266, 0x366],
    SH: [0x1a2, 0x1a3, 0x1a4, 0x1a6, 0x1a8],
    ARM: [0x1c0, 0x1c2, 0x1c4],
    x86: [0x14c],
    PowerPC: [0x1f0],
};

export function cpuFamily(machine) {
    return Object.entries(FAMILIES).find(([, machines]) => machines.includes(machine))?.[0] ?? null;
}

function exportTable(data) {
    const byName = new Map();
    const byOrdinal = new Map();
    for (const entry of readExports(data)) {
        byOrdinal.set(entry.ordinal, entry.name);
        if (entry.name) byName.set(entry.name, entry.ordinal);
    }
    return { byName, byOrdinal };
}

export class ExportIndex {
    constructor(providers) {
        this.providers = providers;
        this.tables = new Map();
    }

    get(dll) {
        const key = dll.toLowerCase();
        if (!this.tables.has(key)) {
            const provider = this.providers.get(key);
            let table = null;
            if (provider) {
                try {
                    table = { ...exportTable(provider.data()), source: provider.source };
                } catch {
                    table = { byName: new Map(), byOrdinal: new Map(), source: provider.source, unreadable: true };
                }
            }
            this.tables.set(key, table);
        }
        return this.tables.get(key);
    }
}

function versionNumber(text) {
    const [major, minor] = text.split(".").map(Number);
    return major === 4 && minor === 0 ? 1 : major + minor / 100;
}

function ordinalNames(data, machine, tables) {
    if (!tables) return { names: null, label: null };
    const family = cpuFamily(machine);
    const coredllTables = family === "SH" ? sh3Tables(tables.coredllTables, tables.sh3Tables) : tables.coredllTables;
    const { label } = detect(data, coredllTables, family === "SH" ? SH3_CE2_LABEL : VELO_LABEL);
    if (!label) return { names: null, label: null };
    return { names: sourceNames(coredllTables, label, family === "SH" ? SH3_CE212_LABEL : MIPS_LABEL), label };
}

export function checkProgram(name, data, { romIndex, packageIndex, romMachine, romVersion, tables }) {
    const parsed = parsePe(data);
    if (!parsed) return null;
    const result = { name, machine: parsed.machine, kind: parsed.dll ? "DLL" : "Program", builtFor: parsed.subsystemVersion, problems: [], warnings: [], dlls: [] };
    const appFamily = cpuFamily(parsed.machine);
    const romFamily = cpuFamily(romMachine);
    if (appFamily !== romFamily) result.problems.push(`built for ${appFamily ?? "an unknown CPU"}, the ROM is ${romFamily ?? "an unknown CPU"}`);
    else if (parsed.machine !== romMachine) result.warnings.push("same CPU family as the ROM, different variant");
    const appVersion = versionNumber(parsed.subsystemVersion);
    if (romVersion && appVersion > romVersion + 0.001) result.warnings.push(`built for CE ${parsed.subsystemVersion}, newer than the ROM's CE ${romVersion.toFixed(2)}`);
    const { names: sdkNames, label } = Object.keys(parsed.imports).includes("coredll.dll") ? ordinalNames(data, parsed.machine, tables) : { names: null, label: null };
    result.sdk = label;
    const porterCpu = appFamily === "MIPS" ? "mips" : appFamily === "SH" ? "sh3" : null;
    const supplied = new Set(porterCpu && tables ? [...(tables.crtExports?.[porterCpu] ?? []), ...(tables.compatExports ?? [])] : []);
    const romCoredll = romIndex.get("coredll.dll");
    if (porterCpu && romVersion !== null && romVersion < 2) {
        for (const name of SHIMMED) supplied.add(name);
        for (const [name, target] of Object.entries({ ...RENAMES, ...CE1_RENAMES })) if (romCoredll?.byName.has(target)) supplied.add(name);
    }
    for (const [dll, functions] of Object.entries(parsed.imports)) {
        const packaged = packageIndex.get(dll);
        const table = packaged ?? romIndex.get(dll);
        const entry = { dll, source: table ? table.source : null, total: functions.length, missing: [], renumbered: [], unverified: [], supplied: [] };
        const markMissing = (name, text) => (dll === "coredll.dll" && supplied.has(name) ? entry.supplied : entry.missing).push(text);
        result.dlls.push(entry);
        if (!table) {
            result.problems.push(`${dll} isn't in the ROM or the package`);
            continue;
        }
        for (const imported of functions) {
            if (typeof imported === "string") {
                if (!table.byName.has(imported)) markMissing(imported, imported);
                continue;
            }
            const expected = dll === "coredll.dll" ? sdkNames?.get(imported) : null;
            if (expected) {
                const actual = table.byName.get(expected);
                if (actual === undefined) markMissing(expected, `${expected} (#${imported})`);
                else if (actual !== imported) entry.renumbered.push(`${expected} (#${imported}, #${actual} on this ROM)`);
            } else if (!table.byOrdinal.has(imported)) {
                entry.missing.push(`#${imported}`);
            } else {
                entry.unverified.push(`#${imported} (${table.byOrdinal.get(imported) ?? "no name"} on this ROM)`);
            }
        }
        if (entry.missing.length) result.problems.push(`${entry.missing.length} function${entry.missing.length === 1 ? "" : "s"} missing from ${dll}`);
        if (entry.supplied.length) result.warnings.push(`${entry.supplied.length} ${dll} function${entry.supplied.length === 1 ? "" : "s"} missing from the ROM but supplied when ported with CEM Porter`);
        if (entry.renumbered.length) result.warnings.push(`${entry.renumbered.length} ${dll} ordinal${entry.renumbered.length === 1 ? "" : "s"} numbered differently on this ROM (CEM Porter can renumber them)`);
    }
    result.status = result.problems.length ? "fail" : result.warnings.length ? "warn" : "ok";
    return result;
}

export function providerMap(items) {
    const providers = new Map();
    for (const item of items) {
        const key = item.name.toLowerCase();
        if (!providers.has(key)) providers.set(key, item);
    }
    return providers;
}
