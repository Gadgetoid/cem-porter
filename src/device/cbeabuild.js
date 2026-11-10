import { writeCbea, PLACE_ALTERNATIVE } from "./cbeawrite.js";
import { parsePe } from "../pe/pe.js";

const ROOTS = { HKLM: "HKEY_LOCAL_MACHINE", HKCU: "HKEY_CURRENT_USER", HKCR: "HKEY_CLASSES_ROOT", HKU: "HKEY_USERS" };
const PROGRAM_FILES = "\\Program Files";
const UNLOAD_FOLDER = "Storage Card\\Program Files";
const AYGSHELL_PATH = "\\Windows\\aygshell.dll";

function leaf(path) {
    return path.slice(path.lastIndexOf("\\") + 1);
}

function parent(path) {
    return path.slice(0, path.lastIndexOf("\\"));
}

function within(path, folder) {
    return path.toLowerCase().startsWith(`${folder.toLowerCase()}\\`);
}

function latin1(text) {
    return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

function lines(...rows) {
    return latin1(rows.flat().join("\r\n") + "\r\n");
}

function isBookkeeping(operation) {
    return /^Software\\Apps\\/i.test(operation.key) && /^(Instl|InstlDir)$/i.test(operation.name);
}

function installedFiles(plan, ported) {
    return plan.operations.filter((operation) => operation.kind === "file" && ported.files.has(operation));
}

function mainProgram(plan, files) {
    for (const operation of plan.operations) {
        if (operation.kind !== "shortcut") continue;
        const target = operation.target.replace(/^"|"$/g, "").toLowerCase();
        const file = files.find((candidate) => candidate.path.toLowerCase() === target);
        if (file) return file;
    }
    return files.find((file) => /\.exe$/i.test(file.path) && within(file.path, PROGRAM_FILES))
        || files.find((file) => /\.exe$/i.test(file.path));
}

function needsAygshell(data) {
    try {
        return Boolean(parsePe(data).imports["aygshell.dll"]);
    } catch {
        return false;
    }
}

export function aygshellUsers(plan, dataFor = () => null) {
    return plan.operations
        .filter((operation) => operation.kind === "file" && /\.(exe|dll)$/i.test(operation.path))
        .filter((operation) => {
            const data = dataFor(operation.source);
            return data && needsAygshell(data);
        })
        .map((operation) => leaf(operation.path));
}

export function cbeaWarnings(plan, dataFor = () => null) {
    const warnings = [];
    const shellUsers = aygshellUsers(plan, dataFor);
    if (shellUsers.length) warnings.push(`${shellUsers.join(", ")} use${shellUsers.length === 1 ? "s" : ""} AYGSHELL.DLL; the package adds CEM Porter's shim to \\Windows`);
    const unsupported = plan.operations.filter((operation) => operation.kind === "regmulti" || operation.kind === "regbinary");
    if (unsupported.length) warnings.push(`${unsupported.length} multi-string or binary registry value${unsupported.length === 1 ? "" : "s"} left out of the .cbea`);
    if (plan.setupDlls?.length) warnings.push("CoInstall doesn't run setup DLLs; the .cbea installs without it");
    return warnings;
}

export function buildCbea(plan, ported, { destination = PLACE_ALTERNATIVE, aygshell = null } = {}) {
    const files = installedFiles(plan, ported);
    const program = mainProgram(plan, files);
    if (!program) throw new Error("no program to install");
    const installDir = within(program.path, PROGRAM_FILES) ? parent(program.path) : plan.installFolder || `${PROGRAM_FILES}\\${plan.title}`;
    const title = plan.title;
    const maker = plan.provider || title;
    const programBase = leaf(program.path).replace(/\.exe$/i, "");
    const deviceFolder = `${PROGRAM_FILES}\\${leaf(installDir)}`;
    const onDevice = (path) => within(path, installDir) ? `${deviceFolder}${path.slice(installDir.length)}` : path;
    const uninstallName = `Un${title.replace(/[^\w]+/g, "")}.inf`;

    const devicePath = (path) => {
        if (path.toLowerCase() === installDir.toLowerCase()) return "%INSTALL_DIR%";
        if (within(path, installDir)) return `%INSTALL_DIR%${path.slice(installDir.length)}`;
        if (within(path, PROGRAM_FILES) || within(path, "\\My Documents")) return `?Drive?${path}`;
        return path;
    };

    const usedNames = new Set([uninstallName.toLowerCase(), `${programBase}.txt`.toLowerCase(), "install.inf"]);
    const memberName = (path) => {
        const name = leaf(path);
        let candidate = name;
        for (let index = 2; usedNames.has(candidate.toLowerCase()); index++) candidate = `${index}_${name}`;
        usedNames.add(candidate.toLowerCase());
        return candidate;
    };

    const copies = files.map((file) => ({ file, member: memberName(file.path) }));
    const shim = aygshell ? { path: AYGSHELL_PATH, member: memberName(AYGSHELL_PATH), data: aygshell } : null;
    const folders = new Set();
    for (const operation of plan.operations) {
        if (operation.kind === "mkdir" && !within(operation.path, "\\Windows\\Programs") && operation.path.toLowerCase() !== "\\windows\\programs") folders.add(operation.path);
    }
    for (const { file } of copies) {
        for (let folder = parent(file.path); folder && folder.toLowerCase() !== PROGRAM_FILES.toLowerCase(); folder = parent(folder)) {
            if (folder.toLowerCase() === "\\windows") break;
            folders.add(folder);
        }
    }
    const makeDirs = [...folders]
        .filter((folder) => folder.toLowerCase() !== installDir.toLowerCase() && !/^\\windows$/i.test(folder))
        .filter((folder) => !within(installDir, folder))
        .sort((a, b) => a.length - b.length);

    const registry = [];
    for (const operation of plan.operations) {
        if ((operation.kind !== "regsz" && operation.kind !== "regdword") || isBookkeeping(operation)) continue;
        const root = ROOTS[operation.root] || operation.root;
        const value = operation.kind === "regdword" ? `${operation.value >>> 0}` : `"${operation.value}"`;
        registry.push(`${root}, ${operation.key}, ${operation.name}, ${operation.kind === "regdword" ? "REG_DWORD" : "REG_SZ"}, FLG_ADDREG_REPLACEONLY, ${value}`);
    }

    const install = lines(
        `; ${title}`,
        "[App Information]",
        `Maker       = "${maker}"`,
        `Program     = "${title}"`,
        "Version     = 1.0",
        `InstallDir  = "?Drive?${deviceFolder}"`,
        `ExeFile     = "\\Program Disk${deviceFolder.slice(PROGRAM_FILES.length)}\\${leaf(program.path)}"`,
        `Destination = ${destination === PLACE_ALTERNATIVE ? "ALTERNATIVE" : "MAINMEM_ONLY"}`,
        "Unload      = 1",
        `Uninstall   = "${uninstallName}"`,
        `Caption     = "${title}"`,
        "",
        makeDirs.length ? ["[Make Dirs]", ...makeDirs.map((folder) => `"${devicePath(folder)}"`), ""] : [],
        "[Copy Files]",
        `"?Drive?${PROGRAM_FILES}\\${uninstallName}" , "${uninstallName}", COPYFLG_REPLACEONLY`,
        `"%INSTALL_DIR%\\${programBase}.inf" , "${programBase}.txt", COPYFLG_REPLACEONLY`,
        ...copies.map(({ file, member }) => `"${devicePath(file.path)}" , "${member}", COPYFLG_REPLACEONLY`),
        shim ? `"${shim.path}" , "${shim.member}", COPYFLG_REPLACEONLY` : [],
        "",
        registry.length ? ["[Add Registry]", ...registry, ""] : [],
        "; End",
    );

    const outsideFiles = copies.filter(({ file }) => !within(file.path, installDir)).map(({ file }) => `"${devicePath(file.path)}"`);
    const ownFolders = [...folders].filter((folder) => within(folder, installDir)).sort((a, b) => b.length - a.length);
    const uninstall = lines(
        `; ${title}`,
        "[Uninstall Information]",
        `Maker   = "${maker}"`,
        `Program = "${title}"`,
        "",
        "[Delete Files]",
        `"?Drive?${PROGRAM_FILES}\\${uninstallName}"`,
        ...outsideFiles,
        "",
        "[Delete Dirs]",
        ...ownFolders.map((folder) => `"?Drive?${onDevice(folder)}"`),
        `"?Drive?${deviceFolder}"`,
        "",
        "; End",
    );

    const menu = lines(`[${title}]`, "menu:", "yes", "appname:", title, "uninstl:", "yes", "unloadfile:", `${UNLOAD_FOLDER}\\${uninstallName}`);

    return writeCbea({
        place: destination,
        members: [
            { name: "Install.inf", data: install },
            { name: uninstallName, data: uninstall },
            { name: `${programBase}.txt`, data: menu },
            ...copies.map(({ file, member }) => ({ name: member, data: ported.files.get(file) })),
            ...(shim ? [{ name: shim.member, data: shim.data }] : []),
        ],
    });
}
