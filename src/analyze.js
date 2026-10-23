import { MACHINE_MIPS, MACHINE_SH3, MACHINE_NAMES, isPe, latin1Decode, parsePe } from "./pe.js";
import { readSetup } from "./cesetup.js";
import { mergePlans, planFromCabSetup, planFromFiles, planFromLoadScript, PROGRAM_FILES, safeFolderName } from "./installplan.js";

const CAB_ARCHITECTURES = { 4000: "mips", 10003: "sh3", 10004: "sh3" };
const CPU_OF_MACHINE = { [MACHINE_MIPS]: "mips", [MACHINE_SH3]: "sh3" };
const CPU_FOLDER = /^(mips|mip|r4000|r3000|sh3|sh-3|sh 3|hitachi|(mips|sh3)[ _-]?ce ?[12](\.\d+)?|ce ?[12](\.\d+)?(\.x)?|ce1\.0-2\.0|wce ?[12]0?|for all cpus|hpc|h_pc|en)$/i;
const CPU_SUFFIXES = { mips: [".aur", ".r39", ".mips", ".mip", ".mps", ".r4000"], sh3: [".sh3", ".sh"] };
const LOAD_SCRIPT = /\.load(?:\.([a-z]+))?$/i;
const NOT_LOAD_VARIANTS = /^(txt|bak|old|orig|log|doc|htm|html)$/i;

function folderOf(path) {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
}

function leafOf(path) {
    return path.slice(path.lastIndexOf("/") + 1);
}

function binaryInfo(data) {
    const parsed = parsePe(data);
    if (!parsed) return null;
    const [major, minor] = parsed.subsystemVersion.split(".").map(Number);
    const ce = major === 4 && minor === 0 ? 1 : major + minor / 100;
    return { cpu: CPU_OF_MACHINE[parsed.machine] ?? null, machine: MACHINE_NAMES[parsed.machine] ?? `0x${parsed.machine.toString(16)}`, ce, dll: parsed.dll, alignment: parsed.sectionAlignment, imports: parsed.imports };
}

function ceLabel(version) {
    if (!version) return "";
    if (version < 2) return version >= 1.01 ? "CE 1.01" : "CE 1.0";
    return version > 2.0 ? `CE ${version.toFixed(2).replace(/0$/, "")}` : "CE 2.0";
}

function describeBuild(infos) {
    const cpus = [...new Set(infos.map((info) => info.cpu ?? info.machine))];
    const highest = Math.max(0, ...infos.map((info) => info.ce));
    return { cpu: cpus.length === 1 ? cpus[0] : cpus.join("+"), ce: highest, ceLabel: ceLabel(highest) };
}

function stripCpuSuffix(name, cpu) {
    const lowered = name.toLowerCase();
    for (const suffix of CPU_SUFFIXES[cpu] ?? []) {
        if (lowered.endsWith(suffix) && name.slice(0, -suffix.length).includes(".")) return name.slice(0, -suffix.length);
    }
    return name.replace(/\.(mips|sh3)\.\d+$/i, "");
}

export function findBuilds(inputName, files) {
    const byPath = new Map(files.map((file) => [file.path, file.data]));
    const used = new Set();
    const builds = [];
    const folders = new Map();
    for (const file of files) {
        const folder = folderOf(file.path);
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(file.path);
    }
    for (const [folder, paths] of folders) {
        const setupPath = paths.find((path) => /\.000$/.test(path) && readSetup(byPath.get(path)));
        if (!setupPath) continue;
        const setup = readSetup(byPath.get(setupPath));
        const members = {};
        for (const path of paths) {
            const number = /\.(\d{3})$/.exec(path);
            if (number && Number(number[1]) > 0) members[Number(number[1])] = path;
            used.add(path);
        }
        const infos = Object.values(members).map((path) => binaryInfo(byPath.get(path))).filter(Boolean);
        const described = describeBuild(infos);
        builds.push({
            kind: "cab",
            title: setup.app || leafOf(folder),
            source: folder || inputName,
            cpu: CAB_ARCHITECTURES[setup.architecture] ?? described.cpu,
            ce: described.ce,
            ceLabel: described.ceLabel,
            palmSize: infos.some((info) => info.imports["aygshell.dll"]) || Math.abs(described.ce - 2.01) < 0.001 || /\((ppc|palm)/i.test(setup.app),
            plan: () => planFromCabSetup(setup, members),
        });
    }
    const title = inputName.replace(/\.[^.]+$/, "").replace(/[-_ ]?(mips|sh3|hpc|ce2?|setup|install)$/i, "") || "Application";
    builds.push(...mergeCabBuilds(builds, title));
    const scripts = files.filter((file) => isLoadScript(file.path) && !used.has(file.path) && !/(^|[^a-z])(sh-?4|arm|x86)([^a-z]|$)/i.test(file.path));
    const siblings = new Map();
    for (const script of scripts) {
        const parent = folderOf(folderOf(script.path));
        siblings.set(parent, (siblings.get(parent) ?? 0) + 1);
    }
    const scriptFolders = new Map();
    for (const script of scripts) {
        const folder = folderOf(script.path);
        const parent = folderOf(folder);
        const key = siblings.get(parent) > 1 && scripts.filter((other) => folderOf(other.path) === folder).length === 1 ? parent : folder;
        if (!scriptFolders.has(key)) scriptFolders.set(key, []);
        scriptFolders.get(key).push(script);
    }
    const within = (path, folder) => !folder || path.startsWith(folder + "/");
    for (const [folder, folderScripts] of scriptFolders) {
        const scriptDirectories = new Set(folderScripts.map((script) => folderOf(script.path)));
        const candidates = files.filter((other) => !used.has(other.path) && isPe(other.data) && within(other.path, folder) && [...scriptDirectories].some((directory) => folderOf(other.path) === directory || folderOf(folderOf(other.path)) === directory));
        const variants = [...new Set(folderScripts.map((script) => loadVariant(script.path)).filter(Boolean))];
        const sets = variants.length ? variants.map((variant) => [variant, folderScripts.filter((script) => [variant, ""].includes(loadVariant(script.path)))]) : [["", folderScripts]];
        const resolved = [];
        for (const [variant, scripts] of sets) {
            const baseTitle = scripts.length === 1 ? loadAppName(scripts[0].path) : title;
            const buildTitle = variant ? `${baseTitle} (${variant[0].toUpperCase()}${variant.slice(1)})` : baseTitle;
            const planFor = (cpu) => mergePlans(buildTitle, scripts.map((script) => {
                const appName = loadAppName(script.path);
                const searchFolders = [folderOf(script.path), containerOf(script.path)];
                return planFromLoadScript(latin1Decode(script.data), (wanted) => findLoadSource(files, searchFolders, wanted, cpu, variant), { installFolder: `${PROGRAM_FILES}\\${safeFolderName(appName)}`, appName });
            }));
            const infos = candidates.map((other) => binaryInfo(other.data)).filter(Boolean);
            for (const cpu of Object.values(CPU_OF_MACHINE)) {
                const sources = planFor(cpu).operations.filter((operation) => operation.kind === "file").map((operation) => operation.source);
                resolved.push(...sources);
                infos.push(...sources.map((path) => binaryInfo(byPath.get(path))).filter((info) => info?.cpu === cpu));
            }
            for (const cpu of [...new Set(infos.map((info) => info.cpu).filter(Boolean))]) {
                const described = describeBuild(infos.filter((info) => info.cpu === cpu));
                builds.push({
                    kind: "load",
                    title: buildTitle,
                    source: scripts.length === 1 ? scripts[0].path : `${folder || inputName} (${scripts.length} scripts)`,
                    cpu,
                    ce: described.ce,
                    ceLabel: described.ceLabel,
                    plan: () => planFor(cpu),
                });
            }
        }
        for (const path of [...candidates.map((other) => other.path), ...folderScripts.map((script) => script.path), ...resolved]) used.add(path);
    }
    const loose = files.filter((file) => !used.has(file.path));
    const groups = new Map();
    for (const file of loose) {
        const info = isPe(file.data) ? binaryInfo(file.data) : null;
        if (!info || !info.cpu) continue;
        const key = `${info.cpu} ${folderOf(file.path)}`;
        if (!groups.has(key)) groups.set(key, { cpu: info.cpu, infos: [], paths: new Set() });
        const group = groups.get(key);
        group.infos.push(info);
        group.paths.add(file.path);
    }
    for (const group of groups.values()) {
        const folders = new Set([...group.paths].map(folderOf));
        const extras = loose.filter((file) => !isPe(file.data) && folders.has(folderOf(file.path)) && !/\.(load|inf|txt|htm|html|doc)$/i.test(file.path)).map((file) => file.path);
        const described = describeBuild(group.infos);
        builds.push({
            kind: "files",
            title,
            source: [...folders].join(", ") || inputName,
            cpu: group.cpu,
            ce: described.ce,
            ceLabel: described.ceLabel,
            plan: () => planFromFiles([...group.paths, ...extras], {
                title,
                isCpuFolder: (part) => CPU_FOLDER.test(part),
                programKind: (path) => {
                    const data = byPath.get(path);
                    return isPe(data) ? (parsePe(data).dll ? "dll" : "exe") : null;
                },
                deviceName: (name) => stripCpuSuffix(name, group.cpu),
                base: folders.size === 1 ? [...folders][0] : "",
            }),
        });
    }
    const counts = new Map();
    for (const build of builds) counts.set(build.title, (counts.get(build.title) ?? 0) + 1);
    for (const build of builds) {
        if (counts.get(build.title) > 1 && !build.merged) build.title = `${build.title} (${leafOf(build.source.replace(/\.d$/, "")).replace(/\.cab$/i, "")})`;
    }
    return builds;
}

function isLoadScript(path) {
    const match = LOAD_SCRIPT.exec(path);
    return Boolean(match) && !NOT_LOAD_VARIANTS.test(match[1] ?? "");
}

function loadVariant(path) {
    return LOAD_SCRIPT.exec(path)?.[1]?.toLowerCase() ?? "";
}

function loadAppName(path) {
    return leafOf(path).replace(LOAD_SCRIPT, "");
}

function containerOf(path) {
    return /^(.*\.d)\//.exec(path)?.[1] ?? "";
}

function findLoadSource(files, folders, name, cpu, variant) {
    const bases = [name, ...CPU_SUFFIXES[cpu].map((suffix) => name + suffix), name + `.${cpu}.200`, name + `.${cpu}.100`];
    const wanted = (variant ? [`.${variant}`, ""] : [""]).flatMap((ending) => bases.map((base) => (base + ending).toLowerCase()));
    const suitsCpu = (file) => {
        const info = isPe(file.data) ? binaryInfo(file.data) : null;
        return !info || info.cpu === cpu;
    };
    for (const folder of [...new Set(folders)]) {
        const prefix = folder ? folder + "/" : "";
        const matches = files.filter((file) => file.path.startsWith(prefix) && wanted.includes(leafOf(file.path).toLowerCase()) && suitsCpu(file));
        const isVariant = (file) => Boolean(variant) && leafOf(file.path).toLowerCase().endsWith(`.${variant}`);
        matches.sort((left, right) => isVariant(right) - isVariant(left));
        if (matches.length) return matches[0].path;
    }
    return null;
}

function variantOf(buildTitle) {
    return /\(([^)]+)\)\s*$/.exec(buildTitle)?.[1] ?? "";
}

function mergeCabBuilds(builds, title) {
    const groups = new Map();
    for (const build of builds) {
        if (build.kind !== "cab") continue;
        const key = `${build.cpu}|${build.ceLabel}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(build);
    }
    const merged = [];
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        const variants = [...new Set(members.map((build) => variantOf(build.title)).filter(Boolean))];
        const sets = variants.length ? variants.map((variant) => [variant, members.filter((build) => [variant, ""].includes(variantOf(build.title)))]) : [["", members]];
        const shared = members.map((build) => /^(.*?)\s*Shared Files$/i.exec(build.title)?.[1]).find(Boolean);
        const base = shared || title;
        for (const [variant, chosen] of sets) {
            if (chosen.length < 2) continue;
            const mergedTitle = variant ? `${base} (${variant})` : base;
            merged.push({
                kind: "cab",
                merged: true,
                title: mergedTitle,
                source: `${chosen.length} CABs`,
                cpu: chosen[0].cpu,
                ce: Math.max(...chosen.map((build) => build.ce)),
                ceLabel: chosen[0].ceLabel,
                palmSize: chosen.some((build) => build.palmSize) || /^(ppc|palm)/i.test(variant),
                plan: () => mergePlans(mergedTitle, chosen.map((build) => build.plan())),
            });
        }
    }
    return merged;
}

export function matchScore(build, device) {
    let score = 0;
    if (build.merged) score += 3;
    if (build.cpu === device.cpu) score += 100;
    if (build.ce && (build.ce < 2) === (device.ce < 2)) score += 20;
    if (build.ce && build.ce <= device.ce + 0.001) score += 10;
    if (build.kind === "cab") score += 2;
    if (build.palmSize) score -= 50;
    score -= Math.round(build.ce * 4);
    return score;
}
