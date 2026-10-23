import { latin1Decode } from "./pe.js";

const utf16 = new TextDecoder("utf-16le");
const INITOBJ_LINE = /^\s*(?:root|Directory\s*\(\s*"([^"]*)"\s*\))\s*:-\s*(Directory|File|Permanent)\s*\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)"\s*)?\)/i;

export const TYPE_NAMES = {
    exe: "Application", dll: "Application Extension", cpl: "Control Panel Extension", lnk: "Shortcut", htc: "Help File", htp: "Help Topic",
    htm: "HTML Document", html: "HTML Document", txt: "Text Document", ini: "Configuration Settings", wav: "Sound", bmp: "Bitmap Image",
    "2bp": "Bitmap Image", gif: "GIF Image", jpg: "JPEG Image", ttf: "TrueType Font", fnt: "Font", fon: "Font", ttc: "TrueType Font",
    nls: "National Language Support", dat: "DAT File", fdf: "FDF File", drv: "Device Driver", ocx: "ActiveX Control", tlb: "Type Library",
    cab: "Cabinet File", pwd: "Pocket Word Document", pxl: "Pocket Excel Workbook", mid: "MIDI Sequence", ico: "Icon", cur: "Cursor",
};

export function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function typeName(node) {
    if (node.kind === "folder") return "File Folder";
    const extension = extensionOf(node.name);
    return TYPE_NAMES[extension] ?? (extension ? `${extension.toUpperCase()} File` : "File");
}

export function decodeText(data) {
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return utf16.decode(data.subarray(2));
    let zeros = 0;
    for (let index = 1; index < Math.min(data.length, 512); index += 2) if (!data[index]) zeros++;
    return zeros > Math.min(data.length, 512) / 4 ? utf16.decode(data) : latin1Decode(data);
}

function folder(name, parent) {
    return { kind: "folder", name, parent, children: [] };
}

export function pathOf(node) {
    const parts = [];
    for (let current = node; current?.parent; current = current.parent) parts.unshift(current.name);
    return "\\" + parts.join("\\");
}

function childNamed(parent, name) {
    const lowered = name.toLowerCase();
    return parent.children.find((child) => child.name.toLowerCase() === lowered);
}

function ensureFolder(root, path) {
    let current = root;
    for (const part of path.split("\\").filter(Boolean)) {
        let next = childNamed(current, part);
        if (!next) {
            next = folder(part, current);
            current.children.push(next);
        } else if (next.kind !== "folder") {
            return null;
        }
        current = next;
    }
    return current;
}

export function findPath(root, path) {
    let current = root;
    for (const part of path.split("\\").filter(Boolean)) {
        current = current?.kind === "folder" ? childNamed(current, part) : null;
        if (!current) return null;
    }
    return current;
}

function uniqueName(parent, name) {
    if (!childNamed(parent, name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let number = 2; ; number++) {
        const candidate = `${stem} (${number})${extension}`;
        if (!childNamed(parent, candidate)) return candidate;
    }
}

export function shortcutTarget(data) {
    const latin1 = latin1Decode(data);
    const raw = /\d+#/.test(latin1) ? latin1 : decodeText(data);
    const text = raw.replace(/^[^\x20-\x7e]*/, "").replace(/\0[\s\S]*$/, "").trim();
    const hash = text.indexOf("#");
    if (hash < 0) return null;
    const command = text.slice(hash + 1).trim();
    if (!command) return null;
    const quoted = /^"([^"]*)"\s*(.*)$/.exec(command);
    const [target, args] = quoted ? [quoted[1], quoted[2]] : [command.split(/\s+/)[0], command.slice(command.split(/\s+/)[0].length).trim()];
    return { command, target, arguments: args };
}

export function buildTree(regions) {
    const root = folder("", null);
    const windows = ensureFolder(root, "\\Windows");
    const items = regions.flatMap((region) => [...region.modules, ...region.files]);
    for (const item of items) {
        const node = { kind: item.kind, name: uniqueName(windows, item.name), parent: windows, item };
        windows.children.push(node);
    }
    const initobj = regions.flatMap((region) => region.files).find((file) => file.name.toLowerCase() === "initobj.dat");
    const notes = [];
    if (initobj) {
        let text = "";
        try {
            text = decodeText(initobj.region.fileData(initobj));
        } catch (error) {
            notes.push(`initobj.dat couldn't be read: ${error.message}`);
        }
        for (const line of text.split(/\r?\n/)) {
            const match = INITOBJ_LINE.exec(line);
            if (!match) continue;
            const [, parentPath = "\\", command, name, source] = match;
            const parent = ensureFolder(root, parentPath);
            if (!parent) continue;
            if (command.toLowerCase() === "directory") {
                ensureFolder(root, `${parentPath.replace(/\\$/, "")}\\${name.trim()}`);
                continue;
            }
            const target = source ? findPath(root, source) : null;
            if (!target || target.kind === "folder") continue;
            const existing = childNamed(parent, name);
            if (existing) continue;
            parent.children.push({ kind: "copy", name, parent, item: target.item, source: target });
        }
    }
    return { root, notes };
}

export function resolveShortcut(root, node, readData) {
    if (extensionOf(node.name) !== "lnk") return null;
    try {
        const shortcut = shortcutTarget(readData(node));
        if (!shortcut) return null;
        const path = shortcut.target.startsWith("\\") ? shortcut.target : `\\Windows\\${shortcut.target}`;
        return { ...shortcut, node: findPath(root, path) ?? (extensionOf(path) ? null : findPath(root, `${path}.exe`)) };
    } catch {
        return null;
    }
}

export function sortChildren(children) {
    return [...children].sort((left, right) => (left.kind === "folder" ? 0 : 1) - (right.kind === "folder" ? 0 : 1) || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}
