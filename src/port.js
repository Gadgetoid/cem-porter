import { remap, VELO_LABEL, MIPS_LABEL } from "./ordinals.js";
import { redirect } from "./shim.js";

export const CRT_DLL = "VELOCRT.DLL";

export function portToCe2(data, { tables, dllTables, targetLabel = VELO_LABEL, helpersLabel = MIPS_LABEL, crtExports, deviceName }) {
    const notes = [];
    const crtNames = new Set(crtExports);
    const remapped = remap(data, tables, dllTables, targetLabel, helpersLabel);
    if (remapped.data) {
        data = remapped.data;
        const sourceName = remapped.label.split(" (")[0];
        notes.push(`${remapped.changed.length} system imports renumbered from ${sourceName} ordinals to ${deviceName} ones`);
    }

    const runtime = remapped.unresolved.filter(({ name }) => crtNames.has(name)).map(({ name, iatRva }) => [name, iatRva]);
    if (runtime.length) {
        data = redirect(data, CRT_DLL, runtime);
        const runtimeNames = [...new Set(runtime.map(([name]) => name))].sort();
        notes.push(`${runtimeNames.join(", ")} from ${CRT_DLL}`);
    }

    const absentByDll = new Map();
    for (const { name, dll } of remapped.unresolved) {
        if (crtNames.has(name)) continue;
        if (!absentByDll.has(dll)) absentByDll.set(dll, new Set());
        absentByDll.get(dll).add(name);
    }
    for (const dll of [...absentByDll.keys()].sort()) {
        const names = [...absentByDll.get(dll)].sort();
        notes.push(`not in ${deviceName} ${dll.split(".")[0].toUpperCase()}: ${names.join(", ")}`);
    }
    return { data, notes };
}
