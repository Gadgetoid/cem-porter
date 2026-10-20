import { latin1Decode, u32 } from "./pe.js";

export const PROGRAM_FILES = "\\Program Files";
export const START_MENU = "\\Windows\\Programs";
export const WINDOWS = "\\Windows";

export const CE_MACROS = {
    1: "\\Program Files", 2: "\\Windows", 3: "\\Windows\\Desktop", 4: "\\Windows\\StartUp", 5: "\\My Documents",
    6: "\\Program Files\\Accessories", 7: "\\Program Files\\Communication", 8: "\\Program Files\\Games",
    9: "\\Program Files\\Pocket Outlook", 10: "\\Program Files\\Office", 11: "\\Windows\\Programs",
    12: "\\Windows\\Programs\\Accessories", 13: "\\Windows\\Programs\\Communications", 14: "\\Windows\\Programs\\Games",
    15: "\\Windows\\Fonts", 16: "\\Windows\\Recent", 17: "\\Windows\\Favorites",
};

const CAB_HIVES = { 1: "HKCR", 2: "HKCU", 3: "HKLM", 4: "HKU" };
const ROOT_NAMES = { HKEY_CLASSES_ROOT: "HKCR", HKEY_CURRENT_USER: "HKCU", HKEY_LOCAL_MACHINE: "HKLM", HKEY_USERS: "HKU" };
const SKIPPED_ON_DEVICE = new Set([".load", ".inf", ".ld", ".lid", ".md", ".log"]);
const HELP_EXTENSIONS = new Set([".htc", ".htp"]);
const HELPER_PROGRAM = /(unload|uninst|unins|setup|install|reset|delete|remove)/i;


export function asciiText(text) {
    if (!text) return "";
    return text.normalize("NFKD")
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, "\"")
        .replace(/[–—]/g, "-")
        .split("")
        .filter((character) => (character >= " " && character < "\u007f") || character === "\n")
        .join("");
}

export function safeFolderName(title) {
    return asciiText(title).replace(/[\\/:*?"<>|]/g, "").trim() || "Application";
}

function extension(name) {
    const leaf = name.split(/[\\/]/).pop();
    const dot = leaf.lastIndexOf(".");
    return dot > 0 ? leaf.slice(dot).toLowerCase() : "";
}

export class Plan {
    constructor(title) {
        this.title = title;
        this.provider = "";
        this.operations = [];
        this.directories = new Set();
        this.warnings = [];
        this.skipped = [];
        this.setupDlls = [];
        this.installFolder = "";
    }

    mkdir(path) {
        const parts = path.replace(/^\\+|\\+$/g, "").split("\\");
        for (let count = 1; count <= parts.length; count++) {
            const partial = "\\" + parts.slice(0, count).join("\\");
            const lowered = partial.toLowerCase();
            if (["\\windows", "\\program files", "\\windows\\programs"].includes(lowered)) continue;
            if (!this.directories.has(lowered)) {
                this.directories.add(lowered);
                this.operations.push({ kind: "mkdir", path: partial });
            }
        }
    }

    copy(source, destination, shared = false) {
        this.mkdir(destination.slice(0, destination.lastIndexOf("\\")));
        if (this.operations.some((operation) => operation.kind === "file" && operation.path.toLowerCase() === destination.toLowerCase())) return;
        this.operations.push({ kind: "file", source, path: destination, shared });
    }

    shortcut(link, target) {
        this.mkdir(link.slice(0, link.lastIndexOf("\\")));
        this.operations.push({ kind: "shortcut", link, target });
    }

    registry(kind, root, key, name, value) {
        this.operations.push({ kind, root, key, name, value, values: kind === "regmulti" ? value : undefined });
    }

    hasFiles() {
        return this.operations.some((operation) => operation.kind === "file");
    }
}

export function mergePlans(title, plans) {
    if (plans.length === 1) return plans[0];
    const merged = new Plan(title);
    merged.provider = plans.find((plan) => plan.provider)?.provider ?? "";
    for (const plan of plans) {
        for (const operation of plan.operations) {
            if (operation.kind === "mkdir") merged.mkdir(operation.path);
            else if (operation.kind === "file") merged.copy(operation.source, operation.path, operation.shared);
            else if (operation.kind === "shortcut") merged.shortcut(operation.link, operation.target);
            else merged.operations.push(operation);
        }
        merged.warnings.push(...plan.warnings);
        merged.skipped.push(...plan.skipped);
        merged.setupDlls.push(...plan.setupDlls);
        merged.installFolder = merged.installFolder || plan.installFolder;
    }
    return merged;
}

export function expandMacros(text, installFolder, appName) {
    return text.replace(/%([A-Za-z0-9]+)%/g, (match, token) => {
        if (token.toLowerCase() === "installdir") return installFolder;
        if (token.toLowerCase() === "appname") return appName;
        const number = /^ce(\d+)$/i.exec(token);
        if (number && CE_MACROS[Number(number[1])]) return CE_MACROS[Number(number[1])];
        return match;
    });
}

export function planFromCabSetup(setup, members, { title, installFolder } = {}) {
    const appName = asciiText(setup.app) || asciiText(title) || "Application";
    const plan = new Plan(appName);
    plan.provider = asciiText(setup.provider);
    const cabInstall = installFolder || `${PROGRAM_FILES}\\${safeFolderName(appName)}`;
    const strings = setup.strings;
    const joined = (spec) => spec.map((value) => strings[value] ?? "").join("\\");
    const directoryPath = (identifier) => {
        const path = expandMacros(joined(setup.directories[identifier] ?? []), cabInstall, appName) || cabInstall;
        return path.startsWith("\\") ? path : "\\" + path;
    };
    const destinations = {};
    for (const identifier of Object.keys(setup.files).map(Number).sort((first, second) => first - second)) {
        const entry = setup.files[identifier];
        const member = members[identifier];
        if (!member) {
            plan.warnings.push(`${setup.app}: file ${identifier} (${entry.name}) missing from the CAB`);
            continue;
        }
        const destination = `${directoryPath(entry.directory)}\\${entry.name}`;
        destinations[identifier] = destination;
        plan.copy(member, destination, destination.toLowerCase().startsWith("\\windows\\"));
    }
    for (const key of setup.keys) {
        const hive = setup.hives[key.hive];
        if (!hive) continue;
        const root = CAB_HIVES[hive.hive] ?? "HKLM";
        const subkey = expandMacros(joined(hive.spec), cabInstall, appName);
        const data = key.data;
        let split = data.indexOf(0);
        if (split < 0) split = data.length;
        const name = latin1Decode(data.subarray(0, split));
        const value = data.subarray(split + 1);
        const kind = key.flags & 0x10001;
        if (kind === 0x10001) {
            const padded = new Uint8Array(4);
            padded.set(value.subarray(0, 4));
            plan.registry("regdword", root, subkey, name, u32(padded, 0));
        } else if (kind === 0x10000) {
            const parts = latin1Decode(value).split("\0").filter(Boolean).map((part) => expandMacros(part, cabInstall, appName));
            plan.registry("regmulti", root, subkey, name, parts);
        } else if (kind === 1) {
            plan.registry("regbinary", root, subkey, name, value.slice());
        } else {
            plan.registry("regsz", root, subkey, name, expandMacros(latin1Decode(value).split("\0")[0], cabInstall, appName));
        }
    }
    const installedKey = "Software\\Apps\\" + [plan.provider, appName].filter(Boolean).join(" ");
    plan.registry("regsz", "HKLM", installedKey, "InstlDir", cabInstall);
    plan.registry("regdword", "HKLM", installedKey, "Instl", 1);
    for (const link of setup.links) {
        const [, baseDirectory, baseMacro, targetIdentifier, targetKind] = link.fields;
        const base = baseDirectory ? directoryPath(baseDirectory) : CE_MACROS[baseMacro] ?? CE_MACROS[11];
        const name = expandMacros(joined(link.spec), cabInstall, appName);
        const target = targetKind === 1 ? destinations[targetIdentifier] : directoryPath(targetIdentifier);
        if (target) plan.shortcut(`${base}\\${name}`, target);
    }
    plan.installFolder = cabInstall;
    if (members[999]) plan.setupDlls.push({ source: members[999], app: appName, installFolder: cabInstall });
    return plan;
}

function loadTokens(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return [];
    const tokens = [];
    let current = null;
    let quoted = false;
    for (const character of trimmed) {
        if (character === "\"") {
            quoted = !quoted;
            current = current ?? "";
        } else if (!quoted && /\s/.test(character)) {
            if (current !== null) tokens.push(current);
            current = null;
        } else {
            current = (current ?? "") + character;
        }
    }
    if (quoted) return trimmed.split(/\s+/);
    if (current !== null) tokens.push(current);
    return tokens;
}

function loadPath(directory, name, destination) {
    let base;
    if (directory === ".") base = destination;
    else if (directory.startsWith("\\")) base = directory;
    else base = `${destination}\\${directory}`;
    if (!name) return base;
    return base.endsWith("\\") ? base + name : `${base}\\${name}`;
}

function registryLocation(root, key, appName) {
    const rootName = root === "~" ? "HKLM" : ROOT_NAMES[root.toUpperCase()] ?? "HKLM";
    return [rootName, key === "~" ? `Software\\Apps\\${appName}` : key];
}

export function planFromLoadScript(script, findSource, { installFolder, appName }) {
    const plan = new Plan(appName);
    plan.operations.push({ kind: "regkey", root: "HKLM", key: `Software\\Apps\\${appName}` });
    for (const line of script.split(/\r?\n/)) {
        const tokens = loadTokens(line).map((token) => token.replaceAll("%P", installFolder));
        if (!tokens.length) continue;
        const command = tokens[0].toLowerCase();
        if (command.startsWith("exit")) break;
        if ((command === "copy" || command === "copyshared") && tokens.length === 4) {
            const found = findSource(tokens[3]);
            if (!found) {
                plan.skipped.push(`${tokens[3]} not in the package`);
                continue;
            }
            plan.copy(found, loadPath(tokens[2], tokens[3], installFolder), command === "copyshared" || tokens[2].toLowerCase().startsWith("\\windows"));
        } else if (command === "mkdir" && tokens.length === 2) {
            plan.mkdir(loadPath(tokens[1], "", installFolder));
        } else if (command === "createshortcut" && tokens.length === 5) {
            plan.shortcut(loadPath(tokens[1], tokens[2], installFolder), loadPath(tokens[3], tokens[4] === "\"\"" ? "" : tokens[4], installFolder));
        } else if ((command === "regstring" || command === "regstringmulti") && tokens.length === 6) {
            const [root, key] = registryLocation(tokens[1], tokens[2], appName);
            const name = tokens[4].toLowerCase() === "default" ? "" : tokens[4];
            if (command === "regstringmulti") plan.registry("regmulti", root, key, name, tokens[5].split("\\0"));
            else plan.registry("regsz", root, key, name, tokens[5]);
        } else if (command === "regint" && tokens.length === 6) {
            const [root, key] = registryLocation(tokens[1], tokens[2], appName);
            const number = Number.parseInt(tokens[5] || "0", tokens[5]?.toLowerCase().startsWith("0x") ? 16 : 10);
            plan.registry("regdword", root, key, tokens[4].toLowerCase() === "default" ? "" : tokens[4], Number.isNaN(number) ? 0 : number >>> 0);
        } else if (command === "regkeycreate" && tokens.length >= 3) {
            const [root, key] = registryLocation(tokens[1], tokens[2], appName);
            plan.operations.push({ kind: "regkey", root, key });
        } else if (command === "remoteexec" && tokens.length >= 2) {
            const program = tokens[1].startsWith("\\") ? tokens[1] : loadPath(".", tokens[1], installFolder);
            plan.operations.push({ kind: "run", program, arguments: tokens[2] ?? "" });
        }
    }
    retargetShortcuts(plan);
    return plan;
}

function retargetShortcuts(plan) {
    const copied = plan.operations.filter((operation) => operation.kind === "file").map((operation) => operation.path);
    const copiedLower = new Set(copied.map((path) => path.toLowerCase()));
    for (const operation of plan.operations) {
        if (operation.kind !== "shortcut" || copiedLower.has(operation.target.toLowerCase())) continue;
        const leaf = operation.target.split("\\").pop().toLowerCase();
        const matches = copied.filter((path) => path.split("\\").pop().toLowerCase() === leaf);
        if (matches.length === 1) operation.target = matches[0];
    }
}

export function defaultDestination(relative, installFolder, isCpuFolder, deviceName = (name) => name) {
    const parts = relative.replace(/\//g, "\\").split("\\");
    const name = deviceName(parts.pop().replace(/\.(pvb)\.\.pv$/i, ".$1"));
    const lowered = parts.map((part) => part.toLowerCase());
    if (lowered.includes("windows")) {
        const after = parts.slice(lowered.indexOf("windows") + 1);
        return { path: [WINDOWS, ...after, name].join("\\"), shared: true };
    }
    const type = extension(name);
    if (HELP_EXTENSIONS.has(type) || type === ".dll") return { path: `${WINDOWS}\\${name}`, shared: true };
    const kept = parts.filter((part) => !isCpuFolder(part));
    return { path: [installFolder, ...kept, name].join("\\"), shared: false };
}

export function planFromFiles(files, { title, installFolder, isCpuFolder = () => false, programKind, deviceName, base = "" }) {
    const plan = new Plan(title);
    const folder = installFolder || `${PROGRAM_FILES}\\${safeFolderName(title)}`;
    const programs = [];
    const sorted = [...files].sort((first, second) => first.split("/").length - second.split("/").length || first.toLowerCase().localeCompare(second.toLowerCase()));
    for (const relative of sorted) {
        if (SKIPPED_ON_DEVICE.has(extension(relative))) continue;
        const inside = base && relative.startsWith(base + "/") ? relative.slice(base.length + 1) : relative;
        const { path, shared } = defaultDestination(inside, folder, isCpuFolder, deviceName);
        plan.copy(relative, path, shared);
        if (programKind(relative) === "exe" && path.toLowerCase().endsWith(".exe") && !HELPER_PROGRAM.test(path.split("\\").pop())) programs.push(path);
    }
    const safeTitle = safeFolderName(title);
    if (programs.length === 1) {
        plan.shortcut(`${START_MENU}\\${safeTitle}.lnk`, programs[0]);
    } else {
        const seen = new Set();
        for (const program of programs) {
            const stem = program.split("\\").pop().replace(/\.[^.]*$/, "");
            if (seen.has(stem.toLowerCase())) continue;
            seen.add(stem.toLowerCase());
            plan.shortcut(`${START_MENU}\\${safeTitle}\\${stem}.lnk`, program);
        }
    }
    plan.operations.unshift({ kind: "regkey", root: "HKLM", key: `Software\\Apps\\${safeTitle}` });
    return plan;
}
