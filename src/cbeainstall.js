const LATIN1 = new TextDecoder("latin1");

function decodeText(bytes) {
    for (const label of ["shift_jis", "utf-8"]) {
        try {
            const text = new TextDecoder(label, { fatal: true }).decode(bytes);
            return text;
        } catch {
            // try the next one
        }
    }
    return LATIN1.decode(bytes);
}

export function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index) & 0xff;
    return out;
}

export function decodeName(name) {
    return decodeText(latin1Bytes(name));
}

export function parseInf(bytes) {
    const text = decodeText(bytes);
    const sections = new Map();
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(";")) continue;
        const header = line.match(/^\[(.+)\]$/);
        if (header) {
            current = header[1].trim();
            if (!sections.has(current)) sections.set(current, []);
            continue;
        }
        if (current) sections.get(current).push(line);
    }
    return sections;
}

export function appInformation(sections) {
    const info = {};
    for (const line of sections.get("App Information") || []) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (!match) continue;
        info[match[1].trim()] = unquote(match[2].trim());
    }
    return info;
}

function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    return trimmed;
}

export function splitArguments(line) {
    const parts = [];
    let current = "";
    let quoted = false;
    for (const character of line) {
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (character === "," && !quoted) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += character;
    }
    parts.push(current.trim());
    return parts;
}

export function expand(path, drive, installDir) {
    return path
        .replace(/\?Drive\?/gi, drive)
        .replace(/%INSTALL_DIR%/gi, installDir);
}

export function planInstall(members, { drive = "\\Nand Disk" } = {}) {
    const byName = new Map(members.map((member) =>
        [decodeName(member.name).toLowerCase(), member]));
    const install = byName.get("install.inf");
    if (!install) throw new Error("no Install.inf in this package");

    const sections = parseInf(install.data);
    const info = appInformation(sections);
    const installDir = expand(info.InstallDir || `${drive}\\Program Files`, drive, "");

    const dirs = (sections.get("Make Dirs") || [])
        .map((line) => expand(unquote(line), drive, installDir));

    const copies = [];
    const missing = [];
    for (const line of sections.get("Copy Files") || []) {
        const parts = splitArguments(line);
        if (parts.length < 2) continue;
        const target = expand(parts[0], drive, installDir);
        let source = parts[1];
        const member = byName.get(source.toLowerCase())
            || byName.get(source.replace(/\.inf$/i, ".txt").toLowerCase());
        if (!member) {
            missing.push(source);
            continue;
        }
        copies.push({ target, source: decodeName(member.name), data: member.data });
    }

    const registry = (sections.get("Add Registry") || []).map((line) => splitArguments(line));

    const needed = new Set(dirs);
    for (const copy of copies) {
        const parent = copy.target.slice(0, copy.target.lastIndexOf("\\"));
        if (parent) needed.add(parent);
    }
    const ordered = [...needed].sort((a, b) => a.length - b.length);

    return { info, installDir, dirs: ordered, copies, registry, missing };
}

export function describePlan(plan) {
    const lines = [];
    lines.push(`${plan.info.Program || "package"} ${plan.info.Version || ""}`.trim());
    lines.push(`install dir ${plan.installDir}`);
    for (const dir of plan.dirs) lines.push(`mkdir ${dir}`);
    for (const copy of plan.copies) lines.push(`copy ${copy.source} -> ${copy.target}`);
    if (plan.registry.length) lines.push(`${plan.registry.length} registry entries (not applied)`);
    for (const name of plan.missing) lines.push(`MISSING from package: ${name}`);
    return lines;
}
