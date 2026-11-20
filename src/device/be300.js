import { parsePe, u16, u32 } from "../pe/pe.js";
import { readResources } from "../pe/resources.js";
import { MIPS16_EXTENSION, isMips16, mips16StandIn, needsMips16Loader, patchMips16Machine } from "../port/mips16.js";

const RT_DIALOG = 5;
const DIALOG_HAS_FONT = 0x40;
const AYGSHELL_FULL_SCREEN = 65;
const DIALOG_ATOMS = new Set([0x80, 0x81, 0x82, 0x83, 0x84, 0x85]);
const KNOWN_CLASSES = new Set([
    "button", "edit", "static", "listbox", "scrollbar", "combobox",
    "ttbutton", "ttstatic", "capedit",
    "syslistview32", "systreeview32", "systabcontrol32", "sysheader32", "toolbarwindow32", "rebarwindow32",
    "msctls_trackbar32", "msctls_updown32", "msctls_progress32", "msctls_statusbar32",
]);

function leaf(path) {
    return path.slice(path.lastIndexOf("\\") + 1);
}

function isProgram(path) {
    return /\.(exe|dll)$/i.test(path);
}

function inWindows(path) {
    return /^\\Windows\\[^\\]+$/i.test(path);
}

export function prepareBe300Files(entries, installDir, mips16Loader) {
    const prepared = [];
    const moved = [];
    const loaded = [];
    for (const entry of entries) {
        let path = entry.path;
        if (/\.dll$/i.test(path) && inWindows(path)) {
            path = `${installDir}\\${leaf(path)}`;
            moved.push(leaf(path));
        }
        if (!isProgram(path) || !isMips16(entry.data)) {
            prepared.push({ ...entry, path });
            continue;
        }
        if (mips16Loader && needsMips16Loader(entry.data)) {
            prepared.push({ ...entry, path, data: mips16StandIn(mips16Loader, entry.data) });
            prepared.push({ ...entry, path: path.replace(/\.dll$/i, MIPS16_EXTENSION), data: entry.data });
            loaded.push(leaf(path));
            continue;
        }
        prepared.push({ ...entry, path, data: patchMips16Machine(entry.data) });
    }
    return { entries: prepared, moved, loaded };
}

function utf16Strings(data) {
    const strings = [];
    let current = "";
    for (let offset = 0; offset + 1 < data.length; offset += 2) {
        const code = data[offset] | (data[offset + 1] << 8);
        if (code >= 0x20 && code < 0x7f) {
            current += String.fromCharCode(code);
            continue;
        }
        if (current.length >= 4) strings.push(current);
        current = "";
    }
    if (current.length >= 4) strings.push(current);
    return strings;
}

function dialogClasses(data) {
    const classes = [];
    let position = 0;
    const word = () => {
        const value = u16(data, position);
        position += 2;
        return value;
    };
    const field = () => {
        const first = u16(data, position);
        if (first === 0) {
            position += 2;
            return null;
        }
        if (first === 0xffff) {
            position += 4;
            return u16(data, position - 2);
        }
        let text = "";
        while (position + 1 < data.length && u16(data, position)) text += String.fromCharCode(word());
        position += 2;
        return text;
    };
    if (data.length < 18 || u16(data, 2) === 0xffff) return classes;
    const style = u32(data, 0);
    const count = u16(data, 8);
    position = 18;
    field();
    field();
    field();
    if (style & DIALOG_HAS_FONT) {
        word();
        field();
    }
    for (let index = 0; index < count && position < data.length; index++) {
        position = (position + 3) & ~3;
        position += 18;
        const itemClass = field();
        field();
        const extra = word();
        position += extra;
        if (itemClass !== null) classes.push(itemClass);
    }
    return classes;
}

function unknownDialogClasses(data) {
    const unknown = new Set();
    let entries;
    try {
        entries = readResources(data);
    } catch {
        return unknown;
    }
    for (const entry of entries) {
        if (entry.type !== RT_DIALOG) continue;
        for (const itemClass of dialogClasses(entry.data)) {
            if (typeof itemClass === "number" ? !DIALOG_ATOMS.has(itemClass) : !KNOWN_CLASSES.has(itemClass.toLowerCase())) unknown.add(String(itemClass));
        }
    }
    return unknown;
}

function list(items) {
    return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
}

export function be300Findings(plan, dataFor) {
    const findings = [];
    const files = plan.operations.filter((operation) => operation.kind === "file");
    const programs = files.filter((operation) => isProgram(operation.path));
    const mips16 = programs.filter((operation) => {
        const data = dataFor(operation.source);
        return data && isMips16(data);
    });
    if (mips16.length) findings.push(`${list(mips16.map((operation) => leaf(operation.path)))} ${mips16.length === 1 ? "is" : "are"} MIPS16; marked as plain MIPS so the BE-300's loader accepts ${mips16.length === 1 ? "it" : "them"}`);
    const loaded = mips16.filter((operation) => needsMips16Loader(dataFor(operation.source)));
    if (loaded.length) findings.push(`${list(loaded.map((operation) => leaf(operation.path)))} need${loaded.length === 1 ? "s" : ""} CEM Porter's MIPS16 loader: the BE-300 kernel skips MIPS16 jump relocations`);
    const movedDlls = files.filter((operation) => /\.dll$/i.test(operation.path) && inWindows(operation.path));
    if (movedDlls.length) findings.push(`${list(movedDlls.map((operation) => leaf(operation.path)))} moved from \\Windows to the install folder`);
    const ephemeral = files.filter((operation) => inWindows(operation.path) && !/\.dll$/i.test(operation.path));
    if (ephemeral.length) findings.push(`${ephemeral.length} file${ephemeral.length === 1 ? "" : "s"} still go${ephemeral.length === 1 ? "es" : ""} to \\Windows, which a reset clears: ${list(ephemeral.slice(0, 6).map((operation) => leaf(operation.path)))}${ephemeral.length > 6 ? " and others" : ""}`);
    const exes = files.filter((operation) => /\.exe$/i.test(operation.path));
    if (exes.length > 1) findings.push(`${exes.length} programs, but a .cbea gets one launcher entry; only the main program appears`);
    for (const operation of programs) {
        const data = dataFor(operation.source);
        if (!data) continue;
        const name = leaf(operation.path);
        const paths = [...new Set(utf16Strings(data).filter((text) => /\\windows\\/i.test(text)))];
        if (paths.length) findings.push(`${name} refers to ${list(paths.slice(0, 4))}${paths.length > 4 ? " and others" : ""}; \\Windows is cleared by a reset`);
        const unknown = [...unknownDialogClasses(data)];
        if (unknown.length) findings.push(`${name}'s dialogs use control${unknown.length === 1 ? "" : "s"} the BE-300 may not have: ${list(unknown)}`);
        let imports = {};
        try {
            imports = parsePe(data).imports;
        } catch {
            imports = {};
        }
        const aygshell = Object.entries(imports).find(([dll]) => dll.toLowerCase() === "aygshell.dll")?.[1] ?? [];
        if (aygshell.includes(AYGSHELL_FULL_SCREEN) || aygshell.includes("SHFullScreen")) findings.push(`${name} goes full screen and may draw over the tornado; check it has a way to quit`);
    }
    return findings;
}
