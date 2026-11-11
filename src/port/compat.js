import { parsePe } from "../pe/pe.js";
import { cpuFamily } from "../rom/romcheck.js";
import { MACHINE_NAMES } from "../rom/romimage.js";
import { findTrapCalls } from "./traps.js";
import { RENAMES, SHIMMED } from "./shim.js";
import { CE1_RENAMES } from "./ce1.js";

export const STATUS_ORDER = ["runs", "patch", "amber", "red"];
export const STATUS_LABELS = { runs: "Runs as is", patch: "CEM Porter patches it", amber: "Might be made to work", red: "Won't work" };

const MAX_RAM_PROGRAM_SIZE = 4 * 1024 * 1024;
const FEW_MISSING = 8;
const FOUR_KB_PAGE_DEVICES = /^philips_(velo|nino)/;
const MIPS16 = 0x266;
const ARM_THUMB2 = 0x1c4;
const SH4 = 0x1a6;
const REDISTRIBUTABLE = [
    [/^mfcce\d+d?\.dll$/, "the MFC for Windows CE runtime"],
    [/^olece\d+d?\.dll$/, "the MFC for Windows CE OLE runtime"],
    [/^atlce\d+\.dll$/, "the ATL runtime"],
    [/^msvcr\d+d?\.dll$/, "the Visual C++ runtime"],
    [/^mfc\d+u?d?\.dll$/, "the MFC runtime"],
    [/^(pvbload|pvbhost|vbscript|msvbvm)\w*\.dll$/, "the eMbedded Visual Basic runtime"],
    [/^gx\.dll$/, "GAPI (gx.dll)"],
    [/^(mscoree|netcfagl)\w*\.dll$/, "the .NET Compact Framework"],
    [/^(msxml|msxml\d)\.dll$/, "MSXML"],
    [/^(cemapi|pimstore)\.dll$/, "the Pocket Outlook object model"],
];

function versionNumber(text) {
    const [major, minor] = String(text).split(".").map(Number);
    return major === 4 && minor === 0 ? 1 : major + minor / 100;
}

function worst(statuses) {
    return statuses.reduce((current, status) => (STATUS_ORDER.indexOf(status) > STATUS_ORDER.indexOf(current) ? status : current), "runs");
}

function check(id, label, status, summary, details = []) {
    return { id, label, status, summary, details };
}

export function detailText(detail) {
    return typeof detail === "string" ? detail : `${detail.text} ${detail.names.join(", ")}`;
}

export function describeBinary(name, data) {
    const parsed = parsePe(data);
    if (!parsed) return null;
    let traps = 0;
    if (cpuFamily(parsed.machine) === "MIPS") {
        try {
            traps = findTrapCalls(data).length;
        } catch {
            traps = 0;
        }
    }
    return {
        name,
        size: Math.max(data.length, parsed.imageSize ?? 0),
        machine: parsed.machine,
        family: cpuFamily(parsed.machine),
        ce: versionNumber(parsed.subsystemVersion),
        subsystemVersion: versionNumber(parsed.subsystemVersion) === 1 ? "1.0" : parsed.subsystemVersion,
        dll: parsed.dll,
        sectionAlignment: parsed.sectionAlignment,
        imports: parsed.imports,
        traps,
    };
}

export function machineLabel(machine) {
    return MACHINE_NAMES[machine] ?? `0x${Number(machine).toString(16)}`;
}

export function porterTarget(device) {
    return (device.family === "MIPS" || (device.family === "SH" && device.machine !== SH4)) && device.ce < 3;
}

function cpuCheck(binary, device) {
    const label = "CPU";
    if (binary.family !== device.family) return check("cpu", label, "red", `${machineLabel(binary.machine)} program, ${machineLabel(device.machine)} device`, ["Different CPU family: it would have to be rebuilt from source."]);
    if (binary.machine === device.machine) return check("cpu", label, "runs", machineLabel(binary.machine));
    if (binary.machine === MIPS16 && device.machine !== MIPS16) return check("cpu", label, "red", "MIPS16 code", ["MIPS16 instructions need a MIPS16 CPU."]);
    if (binary.machine === SH4 && device.machine !== SH4) return check("cpu", label, "red", "SH4 code on SH3", ["SH4 builds use FPU instructions SH3 doesn't have."]);
    if (binary.machine === ARM_THUMB2 && device.machine !== ARM_THUMB2) return check("cpu", label, "red", "ARMv7 code", ["Thumb-2 needs an ARMv7 CPU."]);
    if (binary.family === "ARM" && device.machine === 0x1c0 && binary.machine === 0x1c2) return check("cpu", label, "amber", "ARMV4I program on ARMV4", ["Built with Thumb interworking. Works on ARMv4T and later, not on StrongARM if it calls Thumb code."]);
    return check("cpu", label, "runs", `${machineLabel(binary.machine)} on ${machineLabel(device.machine)}`);
}

function versionCheck(binary, device) {
    const label = "CE version";
    if (binary.ce <= device.ce + 0.001) return check("version", label, "runs", `built for CE ${binary.subsystemVersion}`);
    if (porterTarget(device) && binary.ce < 3) return check("version", label, "patch", `built for CE ${binary.subsystemVersion}, device has ${device.ceLabel}`, ["CEM Porter marks it for the older version."]);
    return check("version", label, "amber", `built for CE ${binary.subsystemVersion}, device has ${device.ceLabel}`, ["The loader refuses newer programs; the header can be changed, but missing functions below still apply."]);
}

function sizeText(size) {
    return size < 1048576 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`;
}

function sizeCheck(binary, device) {
    if (device.ce < 3 && binary.size > MAX_RAM_PROGRAM_SIZE) return check("size", "Size", "red", sizeText(binary.size), ["Too big to load from RAM on CE 1.0 and 2.x (4 MB at most)."]);
    return check("size", "Size", "runs", sizeText(binary.size));
}

function kernelCheck(binary, device) {
    if (!binary.traps || binary.ce < 2) return null;
    if (device.ce >= 2) return check("kernel", "Kernel calls", device.ce >= 6 ? "amber" : "runs", `${binary.traps} direct CE 2.0 kernel calls`, device.ce >= 6 ? ["CE 6 replaced the kernel; direct calls are unlikely to work."] : []);
    if (binary.dll) return check("kernel", "Kernel calls", "red", `${binary.traps} direct CE 2.0 kernel calls in a DLL`, ["These can't be redirected in a DLL."]);
    return check("kernel", "Kernel calls", "patch", `${binary.traps} direct CE 2.0 kernel calls`, ["CEM Porter changes them to imports."]);
}

function pagesCheck(binary, device) {
    if (binary.family !== "MIPS" || binary.sectionAlignment >= 0x1000 || !FOUR_KB_PAGE_DEVICES.test(device.id)) return null;
    return check("pages", "Page size", "patch", "1 KB sections", ["CEM Porter moves them to 4 KB pages for the R3910."]);
}

function referenceNames(binary, dll, references) {
    const table = references(dll, binary);
    if (!table) return null;
    return new Map(table.filter(Array.isArray).map(([ordinal, name]) => [ordinal, name]));
}

function importsCheck(binary, device, context) {
    const { library, references, packageDlls, supplied } = context;
    const missing = [];
    const patched = [];
    const renumbered = [];
    const unverified = [];
    const absent = [];
    const redistributable = [];
    for (const [dll, functions] of Object.entries(binary.imports)) {
        if (packageDlls.has(dll)) continue;
        const table = library(device, dll);
        if (!table) {
            if (dll === "aygshell.dll" && supplied.aygshell && functions.every((name) => typeof name === "string" ? supplied.aygshell.has(name) : true)) {
                patched.push(`${dll} from CEM Porter's shim`);
                continue;
            }
            const runtime = REDISTRIBUTABLE.find(([pattern]) => pattern.test(dll));
            if (runtime) redistributable.push(`${dll} (${runtime[1]})`);
            else absent.push(dll);
            continue;
        }
        const byName = new Map(table.filter(Array.isArray).map(([ordinal, name]) => [name, ordinal]));
        const ordinals = new Set(table.map((entry) => (Array.isArray(entry) ? entry[0] : entry)));
        const expected = functions.some((name) => typeof name === "number") ? referenceNames(binary, dll, references) : null;
        for (const imported of functions) {
            let name = imported;
            if (typeof imported === "number") {
                name = expected?.get(imported);
                if (!name) {
                    if (!ordinals.has(imported)) missing.push(`${dll} #${imported}`);
                    else unverified.push(`${dll} #${imported}`);
                    continue;
                }
                if (byName.has(name) && byName.get(name) !== imported) {
                    renumbered.push(`${name} (#${imported}, #${byName.get(name)} here)`);
                    continue;
                }
            }
            if (byName.has(name)) continue;
            if (dll === "coredll.dll" && supplied.coredll(name, byName)) patched.push(name);
            else missing.push(dll === "coredll.dll" ? name : `${dll}: ${name}`);
        }
    }
    const checks = [];
    const details = [];
    let status = "runs";
    if (patched.length) {
        status = worst([status, "patch"]);
        details.push(`Supplied by CEM Porter: ${patched.join(", ")}`);
    }
    if (renumbered.length) {
        status = worst([status, porterTarget(device) ? "patch" : "amber"]);
        details.push(`Numbered differently here${porterTarget(device) ? " (CEM Porter renumbers them)" : ""}: ${renumbered.join(", ")}`);
    }
    if (unverified.length) details.push(`Imported by number, not checked by name: ${unverified.join(", ")}`);
    if (missing.length) {
        status = worst([status, missing.length <= FEW_MISSING ? "amber" : "red"]);
        details.push({ text: "Missing:", names: missing });
    }
    const summary = missing.length ? `${missing.length} function${missing.length === 1 ? "" : "s"} missing` : patched.length || renumbered.length ? `${patched.length + renumbered.length} patched` : "all present";
    checks.push(check("functions", "Functions", status, summary, details));
    if (absent.length || redistributable.length) {
        const dllStatus = absent.length ? "red" : "amber";
        const dllDetails = [];
        if (redistributable.length) dllDetails.push({ text: "Installable separately:", names: redistributable });
        if (absent.length) dllDetails.push({ text: "Not on this device or in the package:", names: absent });
        checks.push(check("dlls", "DLLs", dllStatus, `${absent.length + redistributable.length} missing`, dllDetails));
    } else {
        checks.push(check("dlls", "DLLs", "runs", "all present"));
    }
    return checks;
}

export function suppliedBy(device, porter) {
    if (!porterTarget(device)) return { coredll: () => false, aygshell: null };
    const cpu = device.family === "MIPS" ? "mips" : "sh3";
    const crt = new Set(porter.crtExports[cpu] ?? []);
    const compat = new Set(device.ce < 2 ? porter.compatExports : []);
    const renames = device.ce < 2 ? { ...RENAMES, ...CE1_RENAMES } : {};
    return {
        coredll: (name, byName) => crt.has(name) || compat.has(name) || (device.ce < 2 && SHIMMED.has(name)) || (renames[name] && byName.has(renames[name])),
        aygshell: cpu === "mips" && device.ce >= 2 ? porter.aygshellExports : null,
    };
}

export function checkDevice(binary, device, context) {
    const checks = [cpuCheck(binary, device)];
    if (checks[0].status !== "red") {
        checks.push(versionCheck(binary, device), ...importsCheck(binary, device, { ...context, supplied: suppliedBy(device, context.porter) }));
        for (const extra of [kernelCheck(binary, device), pagesCheck(binary, device)]) if (extra) checks.push(extra);
    }
    checks.push(sizeCheck(binary, device));
    return { device, checks, status: worst(checks.map((item) => item.status)) };
}

export function referenceDevice(binary, devices, dll, hasLibrary) {
    const candidates = devices.filter((device) => device.family === binary.family && hasLibrary(device, dll));
    const older = candidates.filter((device) => device.ce <= binary.ce + 0.001).sort((left, right) => right.ce - left.ce);
    const newer = candidates.filter((device) => device.ce > binary.ce + 0.001).sort((left, right) => left.ce - right.ce);
    return older[0] ?? newer[0] ?? null;
}
