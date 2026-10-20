import { MACHINE_MIPS, MACHINE_SH3, MACHINE_NAMES, isPe, parsePe, u32 } from "./pe.js";
import { realign } from "./realign.js";
import { redirect, shim, SHIM_DLL, RENAMES, SHIMMED } from "./shim.js";
import { CE1_RENAMES, coredllOrdinalNames, markCe1, moveImports, ordinalsToNames, renameImports } from "./ce1.js";
import { CRT_DLL, portToCe2 } from "./port.js";
import { SH3_CE2_LABEL, SH3_CE212_LABEL, VELO_LABEL, MIPS_LABEL, importEntries, sh3Tables } from "./ordinals.js";
import { ARCHITECTURE_MIPS, ARCHITECTURE_SH3, Package } from "./cabwrite.js";
import { selfInstaller } from "./selfinstall.js";
import { reduceColourBitmaps } from "./bitmaps.js";
import { findTrapCalls, patchSh3TrapCalls, redirectTrapCalls } from "./traps.js";
import { embedModulePath } from "./modulepath.js";
import { WINDOWS, safeFolderName } from "./installplan.js";

export const DEVICES = {
    "velo-ce1": { label: "Philips Velo 1 (MIPS R3910)", cpu: "mips", ce: 1, fourKbPages: true, exports: "velo1" },
    "velo-ce2": { label: "Philips Velo 1 with the CE 2.0 upgrade (MIPS R3910)", cpu: "mips", ce: 2, fourKbPages: true },
    "mips-ce2": { label: "Other MIPS H/PCs (NEC MobilePro 700, Casio A-20, Sharp HC-4100)", cpu: "mips", ce: 2, fourKbPages: false },
    "hp300lx": { label: "HP 300LX (SH3)", cpu: "sh3", ce: 1, fourKbPages: false, exports: "hp300lx" },
    "sh3-ce2": { label: "HP 320LX, 360LX, 620LX, Hitachi HPW-200EC (SH3)", cpu: "sh3", ce: 2, fourKbPages: false },
};

const MACHINES = { mips: MACHINE_MIPS, sh3: MACHINE_SH3 };
const COMPAT_DLL = "CE1COMPAT.DLL";
const SUPPORT_TITLES = { [CRT_DLL]: "C runtime for programs built with later CE 2.x SDKs", [SHIM_DLL]: "CE 1.01 functions for CE 1.0", [COMPAT_DLL]: "CE 2.0 functions for CE 1.0" };

export function deviceSettings(device, assets) {
    const settings = DEVICES[device];
    return {
        ...settings,
        tables: settings.cpu === "sh3" ? sh3Tables(assets.coredllTables, assets.sh3Tables) : assets.coredllTables,
        dllTables: assets.dllTables,
        targetLabel: settings.cpu === "sh3" ? SH3_CE2_LABEL : VELO_LABEL,
        helpersLabel: settings.cpu === "sh3" ? SH3_CE212_LABEL : MIPS_LABEL,
        crtExports: assets.crtExports[settings.cpu],
        deviceName: settings.cpu === "sh3" ? "an SH3 H/PC's CE 2.0" : settings.fourKbPages ? "the Velo's CE 2.0" : "MIPS H/PC 2.0",
        romExports: settings.exports ? assets.romExports[settings.exports] : null,
        compatExports: assets.compatExports,
        trapNames: assets.trapNames,
    };
}

function subsystemVersion(data) {
    const optional = u32(data, 0x3c) + 24;
    const major = data[optional + 48];
    const minor = data[optional + 50];
    return major === 4 && minor === 0 ? 1 : major + minor / 100;
}

function ordinalImports(parsed) {
    return Object.entries(parsed.imports).filter(([, functions]) => functions.some((name) => typeof name === "number")).map(([dll]) => dll);
}

export function portBinary(name, input, settings, destination = null) {
    const result = { name, data: input, notes: [], problems: [], needs: new Set() };
    const parsed = parsePe(input);
    if (!parsed) return result;
    const wanted = MACHINES[settings.cpu];
    if (parsed.machine !== wanted) {
        result.problems.push(`built for ${MACHINE_NAMES[parsed.machine] ?? "0x" + parsed.machine.toString(16)}, not ${settings.cpu.toUpperCase()}`);
        return result;
    }
    let data = input;
    if (settings.cpu === "mips" && settings.fourKbPages && parsed.sectionAlignment < 0x1000) {
        try {
            const moved = realign(data);
            if (moved) {
                data = moved;
                result.notes.push("sections moved to 4 KB pages");
            }
        } catch (error) {
            result.problems.push(`can't move sections to 4 KB pages: ${error.message}`);
        }
    }
    const version = subsystemVersion(data);
    if (settings.ce === 2) {
        const ported = portToCe2(data, settings);
        data = ported.data ?? data;
        for (const note of ported.notes) {
            if (note.startsWith("not in")) result.problems.push(note);
            else result.notes.push(note);
            if (note.includes(CRT_DLL)) result.needs.add(CRT_DLL);
        }
    } else {
        const exports = settings.romExports;
        if (version >= 2 && ordinalImports(parsePe(data)).includes("coredll.dll")) {
            const named = ordinalsToNames(data, coredllOrdinalNames(data, settings.tables, settings.targetLabel, settings.helpersLabel));
            if (named.data) {
                data = named.data;
                result.notes.push(`${named.converted.length} system imports changed from ordinals to names`);
            }
            if (named.unknown.length) result.problems.push(`unknown COREDLL ordinals: ${named.unknown.join(", ")}`);
        }
        const coredllExports = new Set(exports["coredll.dll"]);
        if (version >= 2 && settings.cpu === "mips") {
            const compatNames = new Set(settings.compatExports);
            const resolve = (name) => coredllExports.has(name) ? "COREDLL.dll" : compatNames.has(name) ? COMPAT_DLL : null;
            if (parsePe(data).dll) {
                if (findTrapCalls(data).length) result.problems.push("makes CE 2.0 kernel calls directly, which aren't redirected in a DLL");
            } else {
                const traps = redirectTrapCalls(data, settings.trapNames, resolve);
                if (traps.data) {
                    data = traps.data;
                    result.notes.push(`direct CE 2.0 kernel calls changed to imports: ${traps.calls.map((call) => call.name).join(", ")}`);
                    if (traps.calls.some((call) => resolve(call.name) === COMPAT_DLL)) result.needs.add(COMPAT_DLL);
                }
                if (traps.unknown.length) result.problems.push(`unknown CE 2.0 kernel calls: ${traps.unknown.join(", ")}`);
            }
        }
        if (version >= 2 && settings.cpu === "sh3") {
            const traps = patchSh3TrapCalls(data);
            if (traps.data) {
                data = traps.data;
                result.notes.push(`direct CE 2.0 kernel calls adapted: ${traps.calls.join(", ")}`);
                if (traps.calls.includes("RaiseException")) result.problems.push("RaiseException calls removed");
            }
            if (traps.unknown.length) result.problems.push(`unknown CE 2.0 kernel calls: ${traps.unknown.join(", ")}`);
        }
        const ordinalDlls = ordinalImports(parsePe(data)).filter((dll) => exports[dll]);
        if (ordinalDlls.length) result.problems.push(`imports by ordinal from ${ordinalDlls.join(", ")}`);
        const coredllNames = new Set(exports["coredll.dll"]);
        const renamed = renameImports(data, CE1_RENAMES, coredllNames);
        if (renamed.data) {
            data = renamed.data;
            result.notes.push(`${renamed.renamed.join(", ")} renamed to the CE 1.0 name${renamed.renamed.length > 1 ? "s" : ""}`);
        }
        const shimmed = shim(data);
        if (shimmed.data) {
            data = shimmed.data;
            const renamed = shimmed.changes.filter(([, replacement]) => replacement !== SHIM_DLL).map(([old]) => old);
            const redirected = shimmed.changes.filter(([, replacement]) => replacement === SHIM_DLL).map(([old]) => old);
            if (renamed.length) result.notes.push(`${renamed.join(", ")} renamed to the CE 1.0 name${renamed.length > 1 ? "s" : ""}`);
            if (redirected.length) {
                result.notes.push(`${redirected.join(", ")} from ${SHIM_DLL}`);
                result.needs.add(SHIM_DLL);
            }
        }
        const coredll = new Set(exports["coredll.dll"]);
        const crtExports = new Set(settings.crtExports);
        const runtime = importEntries(data, "coredll.dll").filter((entry) => entry.name && !coredll.has(entry.name) && crtExports.has(entry.name));
        if (runtime.length) {
            data = redirect(data, CRT_DLL, runtime.map((entry) => [entry.name, entry.iatRva]));
            result.notes.push(`${[...new Set(runtime.map((entry) => entry.name))].sort().join(", ")} from ${CRT_DLL}`);
            result.needs.add(CRT_DLL);
        }
        const compatExports = new Set(settings.compatExports);
        const compat = importEntries(data, "coredll.dll").filter((entry) => entry.name && !coredll.has(entry.name) && compatExports.has(entry.name) && !crtExports.has(entry.name));
        if (compat.length) {
            data = redirect(data, COMPAT_DLL, compat.map((entry) => [entry.name, entry.iatRva]));
            const names = [...new Set(compat.map((entry) => entry.name))].sort();
            result.notes.push(`${names.join(", ")} from ${COMPAT_DLL}`);
            if (names.includes("GetModuleFileNameW")) {
                if (!parsePe(data).dll && destination) {
                    data = embedModulePath(data, settings.cpu, destination);
                    result.modulePath = true;
                    result.notes.push("install path built in for GetModuleFileNameW");
                } else {
                    result.problems.push("GetModuleFileNameW returns nothing on CE 1.0");
                }
            }
            result.needs.add(COMPAT_DLL);
        }
        const redirected = new Set([...runtime, ...compat].map((entry) => entry.name));
        const supplied = new Set([...(settings.packageDlls ?? []), CRT_DLL.toLowerCase(), SHIM_DLL.toLowerCase(), COMPAT_DLL.toLowerCase()]);
        for (const [dll, functions] of Object.entries(parsePe(data).imports)) {
            if (exports[dll] || supplied.has(dll)) continue;
            const names = functions.filter((function_) => typeof function_ === "string");
            if (names.length === functions.length && names.every((name) => coredll.has(name))) {
                const moved = moveImports(data, dll, "COREDLL.dll");
                if (moved) {
                    data = moved;
                    result.notes.push(`${names.join(", ")} from COREDLL`);
                    continue;
                }
            }
            const absent = functions.map((function_) => typeof function_ === "number" ? `#${function_}` : function_).filter((name) => !coredll.has(name));
            result.problems.push(`missing ${dll.split(".")[0].toUpperCase()}.DLL${absent.length ? `: ${absent.join(", ")}` : ""}`);
        }
        for (const [dll, functions] of Object.entries(parsePe(data).imports)) {
            if (!exports[dll]) continue;
            const available = new Set(exports[dll]);
            const missing = functions.filter((function_) => typeof function_ === "string" && !available.has(function_) && !RENAMES[function_] && !SHIMMED.has(function_) && !redirected.has(function_));
            if (missing.length) result.problems.push(`not in CE 1.0 ${dll.split(".")[0].toUpperCase()}: ${[...new Set(missing)].join(", ")}`);
        }
        if (version >= 2 || parsePe(data).relocsStripped) {
            data = markCe1(data);
            result.notes.push("marked as a CE 1.0 program");
        }
        try {
            const reduced = reduceColourBitmaps(data);
            if (reduced.data) {
                data = reduced.data;
                const parts = [reduced.bitmaps && `${reduced.bitmaps} bitmap${reduced.bitmaps > 1 ? "s" : ""}`, reduced.icons && `${reduced.icons} icon${reduced.icons > 1 ? "s" : ""}`].filter(Boolean);
                result.notes.push(`${parts.join(" and ")} reduced to 4 greys`);
            }
        } catch (error) {
            result.problems.push(`colour bitmaps left as they are: ${error.message}`);
        }
    }
    result.data = data;
    return result;
}

export function portPlan(plan, sources, deviceSettings, assets) {
    const packageDlls = new Set(plan.operations.filter((operation) => operation.kind === "file").map((operation) => operation.path.split("\\").pop().toLowerCase()));
    const settings = { ...deviceSettings, packageDlls };
    const files = new Map();
    const modulePaths = new Set();
    const reports = [];
    const needs = new Set();
    for (const operation of plan.operations) {
        if (operation.kind !== "file") continue;
        const source = sources.get(operation.source);
        if (!source) {
            reports.push({ name: operation.source, notes: [], problems: ["missing from the package"] });
            continue;
        }
        if (isPe(source)) {
            const report = portBinary(operation.path.split("\\").pop(), source, settings, operation.path);
            reports.push(report);
            if (report.modulePath) modulePaths.add(operation);
            report.needs.forEach((dll) => needs.add(dll));
            files.set(operation, report.data);
        } else {
            files.set(operation, source);
        }
    }
    const setupDlls = [];
    for (const setupDll of plan.setupDlls ?? []) {
        const source = sources.get(setupDll.source);
        if (!source) continue;
        const report = portBinary(`${setupDll.app} setup DLL`, source, settings);
        reports.push(report);
        report.needs.forEach((dll) => needs.add(dll));
        setupDlls.push({ ...setupDll, data: report.data });
    }
    const support = [];
    for (const dll of needs) {
        const runtime = dll === CRT_DLL ? assets.velocrt[settings.cpu] : dll === COMPAT_DLL ? assets.ce1compat[settings.cpu] : assets.veloshim[settings.cpu];
        const data = settings.ce === 1 ? markCe1(runtime) : runtime;
        support.push({ path: `${WINDOWS}\\${dll}`, data, title: SUPPORT_TITLES[dll] });
    }
    return { files, reports, support, modulePaths, setupDlls };
}

function cabDirectory(path) {
    const folder = path.slice(0, path.lastIndexOf("\\"));
    if (/^\\Windows(\\|$)/i.test(folder)) return folder.replace(/^\\Windows/i, "%CE2%");
    if (/^\\Program Files(\\|$)/i.test(folder)) return folder.replace(/^\\Program Files/i, "%CE1%");
    return folder;
}

function onWindows(path) {
    return /^\\Windows(\\|$)/i.test(path);
}

export function planOnCard(plan, cardRoot) {
    const moved = new Map();
    const operations = plan.operations.map((operation) => {
        if (operation.kind === "file") {
            if (onWindows(operation.path)) return operation;
            const leaf = operation.path.split("\\").pop();
            const path = /\.dll$/i.test(leaf) ? `\\Windows\\${leaf}` : cardRoot + operation.path;
            moved.set(operation.path.toLowerCase(), path);
            return { ...operation, path, shared: operation.shared || path.startsWith("\\Windows") };
        }
        if (operation.kind === "mkdir") return onWindows(operation.path) ? operation : { ...operation, path: cardRoot + operation.path };
        return operation;
    });
    const relocate = (value) => {
        if (typeof value !== "string") return value;
        const quoted = value.startsWith("\"");
        const bare = quoted ? value.slice(1, value.indexOf("\"", 1) > 0 ? value.indexOf("\"", 1) : undefined) : value;
        const rest = quoted ? value.slice(bare.length + 1) : "";
        const target = moved.get(bare.toLowerCase()) ?? (/^\\Program Files(\\|$)/i.test(bare) ? cardRoot + bare : bare);
        return quoted ? `"${target}${rest}` : target;
    };
    const retargeted = operations.map((operation) => {
        if (operation.kind === "shortcut") return { ...operation, target: relocate(operation.target) };
        if (operation.kind === "regsz") return { ...operation, value: relocate(operation.value) };
        if (operation.kind === "run") return { ...operation, program: relocate(operation.program) };
        return operation;
    });
    const folders = new Set();
    for (const path of moved.values()) {
        if (!path.startsWith(cardRoot)) continue;
        const parts = path.slice(cardRoot.length).split("\\").filter(Boolean).slice(0, -1);
        parts.forEach((_, index) => folders.add(cardRoot + "\\" + parts.slice(0, index + 1).join("\\")));
    }
    const created = [...folders].sort((first, second) => first.split("\\").length - second.split("\\").length).map((folder) => ({ kind: "mkdir", path: folder }));
    const others = retargeted.filter((operation) => !(operation.kind === "mkdir" && operation.path.startsWith(cardRoot)));
    const setupDlls = (plan.setupDlls ?? []).map((setupDll) => ({ ...setupDll, installFolder: relocate(setupDll.installFolder) }));
    return Object.assign(Object.create(Object.getPrototypeOf(plan)), plan, { operations: [...created, ...others], setupDlls, installFolder: relocate(plan.installFolder) });
}

export function buildCab(plan, ported, settings) {
    const cab = new Package(plan.title, plan.provider || "", { architecture: settings.cpu === "sh3" ? ARCHITECTURE_SH3 : ARCHITECTURE_MIPS });
    const installed = plan.operations.find((operation) => operation.kind === "file" && !onWindows(operation.path));
    if (installed) cab.setup.wholeDirectory(cabDirectory(installed.path));
    const identifiers = new Map();
    for (const support of ported.support) cab.addFile(cab.setup.wholeDirectory(cabDirectory(support.path)), support.path.split("\\").pop(), support.data);
    if (ported.setupDlls.length) cab.setupDll = ported.setupDlls[0].data;
    for (const operation of plan.operations) {
        if (operation.kind === "file" && ported.files.has(operation)) {
            identifiers.set(operation.path.toLowerCase(), cab.addFile(cab.setup.wholeDirectory(cabDirectory(operation.path)), operation.path.split("\\").pop(), ported.files.get(operation)));
        }
    }
    for (const operation of plan.operations) {
        if (operation.kind === "regsz") cab.setup.value(operation.root, operation.key, operation.name, operation.value);
        else if (operation.kind === "regdword") cab.setup.value(operation.root, operation.key, operation.name, operation.value);
        else if (operation.kind === "regmulti") cab.setup.multiValue(operation.root, operation.key, operation.name, operation.value);
        else if (operation.kind === "regbinary") cab.setup.binaryValue(operation.root, operation.key, operation.name, operation.value);
        else if (operation.kind === "shortcut") {
            const target = identifiers.get(operation.target.replace(/^"|"$/g, "").toLowerCase());
            if (target) cab.setup.shortcut(cab.setup.wholeDirectory(cabDirectory(operation.link)), operation.link.split("\\").pop(), target);
        }
    }
    return cab.build();
}

export function buildSelfInstaller(plan, ported, settings, assets) {
    const operations = [];
    ported.setupDlls.forEach((setupDll, index) => {
        operations.push({ kind: "setupdll", path: `\\Windows\\${safeFolderName(plan.title)} setup${index ? ` ${index + 1}` : ""}.dll`, data: setupDll.data, installFolder: setupDll.installFolder || plan.installFolder || "" });
    });
    for (const support of ported.support) operations.push({ kind: "file", path: support.path, data: support.data, shared: true });
    for (const operation of plan.operations) {
        if (/^(regsz|regdword)$/.test(operation.kind) && /^Software\\Apps\\/i.test(operation.key) && /^(Instl|InstlDir)$/i.test(operation.name)) continue;
        if (operation.kind === "file") {
            if (ported.files.has(operation)) operations.push({ kind: "file", path: operation.path, data: ported.files.get(operation), shared: operation.shared, modulePath: ported.modulePaths.has(operation) });
        } else if (operation.kind === "regmulti") {
            operations.push({ ...operation, values: operation.value });
        } else {
            operations.push(operation);
        }
    }
    return selfInstaller(assets.stub[settings.cpu], plan.title, operations);
}
