import { zipSync } from "../vendor/fflate.js";
import { unpack } from "./unpack.js";
import { isPe, parsePe } from "./pe.js";
import { openRom, MACHINE_NAMES, ATTRIBUTE_NAMES, hex } from "./romimage.js";
import { buildTree, decodeText, extensionOf, findPath, pathOf, resolveShortcut, sortChildren, typeName } from "./romtree.js";
import { iconSizes, readBitmapFile, readExports, readIcon, readVersion } from "./romres.js";
import { artIcon, bitmapIcon, iconKind } from "./romicons.js";
import { raiseWindow, saveBytes, setupDesktop } from "./desktop.js";

const elements = Object.fromEntries(["window-title", "open", "folder", "up", "view-icons", "view-details", "properties", "save-selected", "save-all", "region", "view", "drop", "drop-title", "drop-hint", "file-input", "status", "size", "dialog", "dialog-title", "dialog-close", "dialog-tabs", "dialog-panel", "dialog-save", "dialog-ok", "rom-bar", "rom-facts", "rom-details"].map((id) => [id, document.getElementById(id)]));
const state = { source: null, rom: null, region: null, tree: null, folder: null, selected: new Set(), anchor: null, view: "icons", sort: { key: "name", ascending: true }, order: [], images: new Map(), icons: new Map(), iconJob: 0, dialogNode: undefined, exportNames: new Map(), choices: [], regions: [] };
const TEXT_EXTENSIONS = new Set(["txt", "ini", "inf", "htm", "html", "htc", "htp", "lnk", "reg", "bat", "xml", "log"]);
const IMAGE_TYPES = { bmp: "image/bmp", "2bp": "image/bmp", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", ico: "image/x-icon" };
const SOUND_TYPES = { wav: "audio/wav" };
const ZIP_EARLIEST = new Date(1980, 0, 2);

function setStatus(text) {
    elements.status.textContent = text;
}

function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(date) {
    return date ? date.toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }) : "";
}

function exactSize(bytes) {
    return `${formatSize(bytes)} (${bytes.toLocaleString()} bytes)`;
}

function versionLabel(region) {
    const version = region.version;
    if (region.layout === "ce1") return ce1Minor(region);
    if (!version) return "unknown";
    const [major, minor] = version;
    if (minor === 0) return `${major}.0`;
    if (major >= 4 && minor % 10 === 0) return `${major}.${minor / 10}`;
    return minor < 10 ? `${major}.0${minor}` : `${major}.${minor}`;
}

function ce1Minor(region) {
    if (region.ce1Label) return region.ce1Label;
    const core = region.modules.find((module) => module.name.toLowerCase() === "coredll.dll");
    let label = "1.0";
    try {
        if (core && readExports(region.moduleData(core)).some((entry) => entry.name === "AFS_CreateFileW")) label = "1.01";
    } catch {
        label = "1.0";
    }
    region.ce1Label = label;
    return label;
}

function groupModules() {
    return state.regions.flatMap((region) => region.modules);
}

function groupFiles() {
    return state.regions.flatMap((region) => region.files);
}

function platformGuess(region) {
    const names = new Set(groupModules().map((module) => module.name.toLowerCase()));
    const version = versionLabel(region);
    const palm = names.has("aygshell.dll");
    if (region.layout === "ce1") return "Handheld PC 1.0";
    if (version === "2.0") return palm ? "Palm-size PC" : "Handheld PC 2.0";
    if (version === "2.01") return palm ? "Palm-size PC 1.0" : "Windows CE 2.01";
    if (version === "2.11") return palm ? "Palm-size PC 1.2" : "Handheld PC Professional";
    if (version === "2.12") return "Windows CE 2.12";
    if (version === "3.0") return palm ? "Pocket PC 2000 or 2002" : names.has("explorer.exe") ? "Handheld PC 2000 or Windows CE 3.0" : "Windows CE 3.0";
    const major = Number(version.split(".")[0]);
    if (major === 4) return `Windows CE .NET ${version}`;
    if (major === 6) return `Windows Embedded CE ${version}`;
    if (major >= 7) return `Windows Embedded Compact ${version}`;
    return `Windows CE ${version}`;
}

function machineName(machine) {
    return MACHINE_NAMES[machine] ?? (machine ? `0x${machine.toString(16)}` : "unknown");
}

function nodeData(node) {
    const item = node.item;
    return item.kind === "module" ? item.region.moduleData(item) : item.region.fileData(item);
}

function nodeSize(node) {
    if (node.kind === "folder") return null;
    return node.item.size;
}

function nodeTime(node) {
    return node.kind === "folder" ? null : node.item.time;
}

function isShortcut(node) {
    return node.kind !== "folder" && extensionOf(node.name) === "lnk";
}

function folderTotals(folder) {
    let files = 0;
    let folders = 0;
    let bytes = 0;
    const walk = (current) => {
        for (const child of current.children) {
            if (child.kind === "folder") {
                folders++;
                walk(child);
            } else {
                files++;
                bytes += nodeSize(child);
            }
        }
    };
    walk(folder);
    return { files, folders, bytes };
}

function cachedIcon(item, size, compute) {
    const key = `${item.kind}:${item.index}:${size}`;
    if (!state.icons.has(key)) {
        try {
            state.icons.set(key, compute());
        } catch {
            state.icons.set(key, null);
        }
    }
    return state.icons.get(key);
}

function peIcon(node, size) {
    const item = node.item;
    if (item.kind !== "module" && !["exe", "dll", "cpl"].includes(extensionOf(item.name))) return null;
    return cachedIcon(item, size, () => {
        const data = nodeData(node);
        return isPe(data) ? readIcon(data, size) : null;
    });
}

function realIcon(node, size, shortcut = false) {
    if (node.kind === "folder") return artIcon("folder", size, shortcut);
    if (isShortcut(node) && !shortcut) {
        const target = resolveShortcut(state.tree, node, nodeData)?.node;
        if (target && target !== node && !isShortcut(target)) return realIcon(target, size, true);
        return artIcon("file", size, true);
    }
    const icon = peIcon(node, size);
    if (icon) return bitmapIcon(icon, size, shortcut);
    return artIcon(iconKind(node, extensionOf(node.name)), size, shortcut);
}

function placeholderIcon(node, size) {
    return artIcon(iconKind(node, extensionOf(node.name)), size, isShortcut(node));
}

function scheduleIcons(nodes, size) {
    const job = ++state.iconJob;
    const queue = [...nodes];
    const step = () => {
        if (job !== state.iconJob) return;
        const started = performance.now();
        while (queue.length && performance.now() - started < 12) {
            const node = queue.shift();
            const image = state.images.get(node);
            if (image) image.src = realIcon(node, size);
        }
        if (queue.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
}

function sortedChildren(folder) {
    const { key, ascending } = state.sort;
    const children = sortChildren(folder.children);
    if (key === "name") return ascending ? children : children.reverse();
    const value = (node) => key === "size" ? nodeSize(node) ?? -1 : key === "type" ? typeName(node) : nodeTime(node)?.getTime() ?? 0;
    return children.sort((left, right) => {
        const folders = (left.kind === "folder" ? 0 : 1) - (right.kind === "folder" ? 0 : 1);
        if (folders) return folders;
        const [a, b] = [value(left), value(right)];
        const compared = typeof a === "string" ? a.localeCompare(b) : a - b;
        return (ascending ? compared : -compared) || left.name.localeCompare(right.name);
    });
}

function allFolders(folder, depth = 0, list = []) {
    list.push({ folder, depth });
    for (const child of sortChildren(folder.children)) if (child.kind === "folder") allFolders(child, depth + 1, list);
    return list;
}

function renderFolderList() {
    const options = allFolders(state.tree).map(({ folder, depth }) => {
        const option = new Option(`${"  ".repeat(depth)}${folder.parent ? folder.name : "\\"}`, pathOf(folder));
        option.selected = folder === state.folder;
        return option;
    });
    elements.folder.replaceChildren(...options);
}

function renderView() {
    state.images.clear();
    const view = elements.view;
    view.replaceChildren();
    if (!state.folder) {
        view.append(elements.drop);
        return;
    }
    const children = sortedChildren(state.folder);
    state.order = children;
    if (!children.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "This folder is empty.";
        view.append(empty);
    } else if (state.view === "icons") {
        const list = document.createElement("ul");
        list.className = "icons";
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-multiselectable", "true");
        for (const node of children) {
            const item = document.createElement("li");
            item.setAttribute("role", "option");
            const image = document.createElement("img");
            image.alt = "";
            image.src = placeholderIcon(node, 32);
            const label = document.createElement("span");
            label.textContent = node.name;
            item.append(image, label);
            bindItem(item, node);
            state.images.set(node, image);
            list.append(item);
        }
        view.append(list);
    } else {
        const table = document.createElement("table");
        table.className = "details";
        const head = table.createTHead().insertRow();
        for (const [key, label] of [["name", "Name"], ["size", "Size"], ["type", "Type"], ["modified", "Modified"]]) {
            const th = document.createElement("th");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label + (state.sort.key === key ? (state.sort.ascending ? " ▴" : " ▾") : "");
            button.addEventListener("click", () => {
                state.sort = { key, ascending: state.sort.key === key ? !state.sort.ascending : true };
                renderView();
            });
            th.append(button);
            head.append(th);
        }
        const body = table.createTBody();
        for (const node of children) {
            const row = body.insertRow();
            const name = row.insertCell();
            name.className = "name";
            const image = document.createElement("img");
            image.alt = "";
            image.src = placeholderIcon(node, 16);
            const label = document.createElement("span");
            label.textContent = node.name;
            name.append(image, label);
            const size = row.insertCell();
            size.className = "size";
            size.textContent = node.kind === "folder" ? "" : formatSize(nodeSize(node));
            row.insertCell().textContent = typeName(node);
            row.insertCell().textContent = formatDate(nodeTime(node));
            bindItem(row, node);
            state.images.set(node, image);
        }
        view.append(table);
    }
    scheduleIcons(children, state.view === "icons" ? 32 : 16);
    renderSelection();
}

function bindItem(element, node) {
    element.dataset.selectable = "true";
    element.addEventListener("click", (event) => {
        event.stopPropagation();
        select(node, event);
    });
    element.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        activate(node);
    });
    element._node = node;
}

function renderSelection() {
    for (const element of elements.view.querySelectorAll("[data-selectable]")) {
        const selected = state.selected.has(element._node);
        element.classList.toggle("selected", selected);
        element.setAttribute("aria-selected", String(selected));
    }
    const count = state.selected.size;
    elements.properties.disabled = !state.region;
    elements["save-selected"].disabled = !count;
    if (!state.folder) return;
    if (count) {
        const bytes = [...state.selected].reduce((total, node) => total + (node.kind === "folder" ? folderTotals(node).bytes : nodeSize(node)), 0);
        setStatus(`${count} object${count === 1 ? "" : "s"} selected`);
        elements.size.textContent = formatSize(bytes);
    } else {
        const files = state.folder.children.filter((child) => child.kind !== "folder");
        setStatus(`${state.folder.children.length} object${state.folder.children.length === 1 ? "" : "s"}`);
        elements.size.textContent = formatSize(files.reduce((total, node) => total + nodeSize(node), 0));
    }
}

function select(node, event = {}) {
    if (event.shiftKey && state.anchor) {
        const [from, to] = [state.order.indexOf(state.anchor), state.order.indexOf(node)].sort((a, b) => a - b);
        if (!(event.ctrlKey || event.metaKey)) state.selected.clear();
        state.order.slice(from, to + 1).forEach((item) => state.selected.add(item));
    } else if (event.ctrlKey || event.metaKey) {
        if (state.selected.has(node)) state.selected.delete(node);
        else state.selected.add(node);
        state.anchor = node;
    } else {
        state.selected = new Set([node]);
        state.anchor = node;
    }
    renderSelection();
}

function openFolder(folder) {
    state.folder = folder;
    state.selected.clear();
    state.anchor = null;
    elements.up.disabled = !folder.parent;
    elements["window-title"].textContent = `${folder.parent ? folder.name : state.source.name} - ROM Explorer`;
    renderFolderList();
    renderView();
    elements.view.scrollTop = 0;
    elements.view.focus({ preventScroll: true });
}

function activate(node) {
    if (node.kind === "folder") {
        openFolder(node);
        return;
    }
    if (isShortcut(node)) {
        const target = resolveShortcut(state.tree, node, nodeData)?.node;
        if (target?.kind === "folder") {
            openFolder(target);
            return;
        }
    }
    showProperties(node);
}

function moveSelection(step) {
    if (!state.order.length) return;
    const current = state.anchor ? state.order.indexOf(state.anchor) : -1;
    const next = Math.max(0, Math.min(state.order.length - 1, current + step));
    select(state.order[next]);
    const element = [...elements.view.querySelectorAll("[data-selectable]")].find((candidate) => candidate._node === state.order[next]);
    element?.scrollIntoView({ block: "nearest" });
}

function iconColumns() {
    const items = [...elements.view.querySelectorAll(".icons li")];
    if (items.length < 2) return 1;
    const top = items[0].offsetTop;
    const index = items.findIndex((item) => item.offsetTop !== top);
    return index < 0 ? items.length : index;
}

function zipEntries(nodes, prefix = "") {
    const entries = {};
    const add = (node, path) => {
        if (node.kind === "folder") {
            for (const child of node.children) add(child, `${path}${child.name}${child.kind === "folder" ? "/" : ""}`);
            return;
        }
        try {
            const time = node.item.time && node.item.time > ZIP_EARLIEST ? node.item.time : ZIP_EARLIEST;
            entries[path] = [nodeData(node), { mtime: time }];
        } catch (error) {
            entries[`${path}.unreadable.txt`] = new TextEncoder().encode(`${node.name} couldn't be extracted: ${error.message}\n`);
        }
    };
    for (const node of nodes) add(node, `${prefix}${node.name}${node.kind === "folder" ? "/" : ""}`);
    return entries;
}

function baseName(name) {
    return name.replace(/\.[^.]*$/, "") || "rom";
}

function saveNodes(nodes) {
    if (nodes.length === 1 && nodes[0].kind !== "folder") {
        try {
            saveBytes(nodeData(nodes[0]), nodes[0].name);
            setStatus(`Saved ${nodes[0].name}.`);
        } catch (error) {
            setStatus(`Couldn't extract ${nodes[0].name}: ${error.message}`);
        }
        return;
    }
    setStatus("Making a zip...");
    setTimeout(() => {
        const name = nodes.length === 1 ? nodes[0].name : state.folder.parent ? state.folder.name : baseName(state.source.name);
        const data = zipSync(zipEntries(nodes), { level: 6 });
        saveBytes(data, `${name}.zip`);
        setStatus(`Saved ${name}.zip (${formatSize(data.length)}).`);
    }, 0);
}

function saveAll() {
    setStatus("Making a zip of the whole ROM...");
    setTimeout(() => {
        const entries = zipEntries(sortChildren(state.tree.children));
        entries["ROM information.txt"] = new TextEncoder().encode(romReport());
        const data = zipSync(entries, { level: 6 });
        saveBytes(data, `${baseName(state.source.name)}.zip`);
        setStatus(`Saved ${baseName(state.source.name)}.zip (${formatSize(data.length)}).`);
    }, 0);
}

function facts(rows) {
    const list = document.createElement("dl");
    list.className = "facts";
    for (const [term, value] of rows) {
        if (value === null || value === undefined || value === "") continue;
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        if (value instanceof Node) dd.append(value);
        else dd.textContent = value;
        list.append(dt, dd);
    }
    return list;
}

function table(headings, rows, alignRight = []) {
    const element = document.createElement("table");
    const head = element.createTHead().insertRow();
    for (const heading of headings) {
        const th = document.createElement("th");
        th.textContent = heading;
        head.append(th);
    }
    const body = element.createTBody();
    for (const row of rows) {
        const tr = body.insertRow();
        row.forEach((value, index) => {
            const td = tr.insertCell();
            td.textContent = value;
            if (alignRight.includes(index)) td.className = "size";
        });
    }
    const wrapper = document.createElement("div");
    wrapper.className = "list sunken";
    wrapper.style.maxHeight = "260px";
    wrapper.append(element);
    return wrapper;
}

function heading(icon, text) {
    const element = document.createElement("div");
    element.className = "heading";
    const image = document.createElement("img");
    image.alt = "";
    image.src = icon;
    const label = document.createElement("span");
    label.textContent = text;
    element.append(image, label);
    return element;
}

function rule() {
    return document.createElement("hr");
}

function attributeText(attributes) {
    const names = Object.entries(ATTRIBUTE_NAMES).filter(([bit]) => attributes & Number(bit)).map(([, name]) => name);
    return `${names.join(", ") || "None"} (${hex(attributes, 4)})`;
}

function range(first, last) {
    return `${hex(first)}-${hex(last)} (${formatSize(((last >>> 0) - (first >>> 0)) >>> 0)})`;
}

const COMPRESSION_NAMES = { lz1k: "LZ, 1 KB blocks", lz4k: "LZ, 4 KB blocks", lzx: "LZX, 4 KB blocks", xpress: "XPRESS, 4 KB blocks", lzw: "LZW" };

function romSummary() {
    const region = state.region;
    const modules = groupModules();
    const files = groupFiles();
    const kernel = modules.find((module) => module.name.toLowerCase() === "nk.exe");
    const items = [...modules, ...files];
    const times = items.map((item) => item.time).filter(Boolean).sort((a, b) => a - b);
    const compressedModules = modules.filter((module) => module.sections?.some((section) => section.flags & 0x2000)).length;
    const compressedFiles = files.filter((file) => file.storedSize < file.size || (file.region.layout === "ce1" && file.attributes & 0x800)).length;
    const stored = files.reduce((total, file) => total + file.storedSize, 0);
    return [
        ["File", state.source.name + (state.source.container ? ` (in ${state.source.container})` : "")],
        ["File size", exactSize(state.source.size)],
        ["Format", state.rom.format],
        ["Windows CE", versionLabel(region)],
        ["Platform (guess)", platformGuess(region)],
        ["Processor", machineName(region.machine) + (region.header.cpuType ? "" : " (from its code; the ROM header doesn't say)")],
        ["Kernel built", formatDate(kernel?.time)],
        ["Newest file", formatDate(times[times.length - 1])],
        ["Oldest file", formatDate(times[0])],
        ["Modules", `${modules.length} (${compressedModules} compressed)`],
        ["Files", `${files.length} (${compressedFiles} compressed, ${formatSize(stored)} stored)`],
        ["Compression", compressedModules || compressedFiles ? COMPRESSION_NAMES[region.compression] : "None"],
        ["ROM regions", state.regions.length > 1 ? `${state.regions.length}, chained (see Memory)` : null],
        ["Contents", formatSize(items.reduce((total, item) => total + item.size, 0))],
    ];
}

function romMemory() {
    return state.regions.flatMap((region, index) => {
        const rows = regionMemory(region);
        if (state.regions.length < 2) return rows;
        const contents = region.modules.slice(0, 3).map((module) => module.name).join(", ");
        return [[`Region ${index + 1}`, `${region.modules.length} modules, ${region.files.length} files (${contents}${region.modules.length > 3 ? ", ..." : ""})`], ...rows.map(([term, value]) => [`  ${term}`, value])];
    });
}

function regionMemory(region) {
    const header = region.header;
    return [
        ["ROM", range(header.physFirst, header.physLast)],
        ["ROM header at", hex(region.headerAddress)],
        ["First byte of file", hex(region.base)],
        ["DLL address range", range(header.dllFirst, header.dllLast)],
        ["Kernel RAM", range(header.ramStart, header.ramEnd)],
        ["RAM free from", hex(header.ramFree)],
        ["Object store share", header.fsRamPercent ? `${hex(header.fsRamPercent)} (percent of RAM per 2 MB block, low byte first)` : null],
        ["Kernel flags", hex(header.kernelFlags)],
        ["Driver globals", header.driverGlobalsLength ? range(header.driverGlobalsStart, header.driverGlobalsStart + header.driverGlobalsLength) : null],
        ["Copy entries", `${header.copyEntries}`],
        ["CPU type field", header.cpuType ? `${hex(header.cpuType, 4)} (${machineName(header.cpuType)})` : "0 (not set)"],
        ["Extensions", header.extensions ? hex(header.extensions) : null],
        ["Profiling", header.profileLength ? `${formatSize(header.profileLength)} at ${hex(header.profileOffset)}` : null],
        ["Header layout", region.layout === "ce1" ? "CE 1.0 (inline names, PE headers)" : `CE 2.0 or later (module units at ${region.unitsOffset})`],
        ["BIN records", state.rom.bin ? `${state.rom.bin.records}, entry point ${hex(state.rom.bin.entry)}${state.rom.bin.problems.length ? `; ${state.rom.bin.problems.length} problem(s)` : ""}` : null],
    ];
}

function romReport() {
    const lines = ["ROM Explorer report", ""];
    for (const [term, value] of [...romSummary(), ...romMemory()]) if (value) lines.push(`${term}: ${value}`);
    if (state.rom.regions.length > 1) {
        lines.push("", "ROM images in this file:");
        state.rom.regions.forEach((region, index) => lines.push(`  ${index + 1}. header ${hex(region.headerAddress)}, ${range(region.header.physFirst, region.header.physLast)}, ${region.modules.length} modules, ${region.files.length} files, CE ${versionLabel(region)}`));
    }
    lines.push("", "Modules (name, size, image base, entry, sections):");
    for (const module of groupModules()) lines.push(`  ${module.name.padEnd(24)} ${String(module.size).padStart(9)}  ${module.header ? `${hex(module.header.imageBase)} ${hex(module.header.imageBase + module.header.entry)} ${module.sections.map((section) => `${section.name}${section.flags & 0x2000 ? "*" : ""}`).join(" ")}` : module.problem ?? ""}`);
    lines.push("", "Files (name, size, stored size, attributes, address):");
    for (const file of groupFiles()) lines.push(`  ${file.name.padEnd(24)} ${String(file.size).padStart(9)} ${String(file.storedSize).padStart(9)}  ${hex(file.attributes, 4)}  ${hex(file.load)}`);
    lines.push("", "* compressed in ROM");
    return lines.join("\r\n") + "\r\n";
}

function romTabs() {
    const tabs = [
        ["General", () => [heading(artIcon("data", 32), state.source.name), rule(), facts(romSummary())]],
        ["Memory", () => [facts(romMemory())]],
    ];
    if (state.rom.regions.length > 1) {
        tabs.push(["Images", () => {
            const rows = state.rom.regions.map((region, index) => [String(index + 1), state.regions.includes(region) ? "Yes" : "", hex(region.headerAddress), range(region.header.physFirst, region.header.physLast), String(region.modules.length), String(region.files.length), versionLabel(region)]);
            const note = document.createElement("p");
            note.textContent = "This file holds more than one ROM region. Regions chained together are shown as one; pick others from the list in the toolbar.";
            return [note, table(["#", "Shown", "Header", "Range", "Modules", "Files", "CE"], rows, [4, 5])];
        }]);
    }
    if (state.regions.some((region) => region.header.copyEntries)) {
        tabs.push(["Copy entries", () => {
            const rows = state.regions.flatMap((region) => region.copyEntries()).map((entry) => [hex(entry.source), hex(entry.destination), formatSize(entry.copyLength), formatSize(entry.destinationLength)]);
            const note = document.createElement("p");
            note.textContent = "Data the kernel copies from ROM to RAM at boot.";
            return [note, table(["From", "To", "Copied", "Size in RAM"], rows, [2, 3])];
        }]);
    }
    return tabs;
}

function generalFacts(node) {
    const item = node.item;
    const rows = [
        ["Type", typeName(node)],
        ["Location", pathOf(node.parent)],
        ["Size", exactSize(nodeSize(node))],
        ["Modified", formatDate(item.time)],
        ["Attributes", attributeText(item.attributes)],
    ];
    if (node.kind === "copy") rows.push(["Copy of", `${pathOf(node.source)}, made by initobj.dat at cold boot`]);
    if (item.kind === "file") {
        rows.push(["Stored in ROM", `${exactSize(item.storedSize)} at ${hex(item.load)}`]);
        if (item.storedSize !== item.size) rows.push(["Compression", `${Math.round(100 - (100 * item.storedSize) / Math.max(1, item.size))}% smaller in ROM`]);
    } else {
        const stored = (item.sections ?? []).reduce((total, section) => total + section.storedSize, 0);
        rows.push(["Stored in ROM", `${exactSize(stored)} in ${item.sections?.length ?? 0} sections`]);
        rows.push(["ROM entry", `${hex(item.e32)} (e32), ${hex(item.o32)} (o32)`]);
    }
    return rows;
}

function programTab(node) {
    const item = node.item;
    const data = nodeData(node);
    const parsed = parsePe(data);
    const header = item.header;
    const rows = [];
    if (header) {
        rows.push(["Processor", machineName(item.region.layout === "ce1" ? header.machine : item.region.machine)]);
        rows.push(["Kind", header.flags & 0x2000 ? "DLL" : "Program"]);
        rows.push(["Image base", hex(header.imageBase)]);
        rows.push(["Entry point", hex(header.imageBase + header.entry)]);
        rows.push(["Image size", formatSize(header.imageSize)]);
        rows.push(["Built for", `CE ${header.version[0]}.${String(header.version[1]).padStart(2, "0")}, subsystem ${header.subsystem}`]);
    }
    rows.push(["Rebuilt file", exactSize(data.length)]);
    const sizes = iconSizes(data);
    if (sizes.length) rows.push(["Icons", `${sizes[0].join(", ")}${sizes.length > 1 ? ` and ${sizes.length - 1} more icon${sizes.length === 2 ? "" : "s"}` : ""}`]);
    const content = [facts(rows)];
    if (item.sections?.length) {
        content.push(table(["Section", "Address", "Size", "In ROM", "Flags"], item.sections.map((section) => [section.name, hex(section.rva), formatSize(section.virtualSize), section.flags & 0x2000 ? `${formatSize(section.storedSize)} compressed` : formatSize(section.storedSize), hex(section.flags)]), [2]));
    }
    if (parsed && Object.keys(parsed.imports).length) {
        const rows = [];
        for (const [dll, functions] of Object.entries(parsed.imports)) {
            const names = exportNames(dll);
            const inRom = names ? "" : " (not in this ROM)";
            for (const entry of functions) rows.push([dll + inRom, typeof entry === "number" ? `${names?.get(entry) ?? "?"} (#${entry})` : entry]);
        }
        content.push(table(["Imports from", "Function"], rows));
    }
    return content;
}

function exportNames(dll) {
    const key = dll.toLowerCase();
    if (!state.exportNames.has(key)) {
        const module = groupModules().find((candidate) => candidate.name.toLowerCase() === key);
        let names = null;
        if (module) {
            try {
                names = new Map(readExports(module.region.moduleData(module)).filter((entry) => entry.name).map((entry) => [entry.ordinal, entry.name]));
            } catch {
                names = null;
            }
        }
        state.exportNames.set(key, names);
    }
    return state.exportNames.get(key);
}

function exportsTab(node) {
    const exports = readExports(nodeData(node));
    const named = exports.filter((entry) => entry.name);
    const note = document.createElement("p");
    note.textContent = `${exports.length} ordinals, ${named.length} with names.`;
    return [note, table(["Ordinal", "Name"], exports.map((entry) => [String(entry.ordinal), entry.name ?? ""]))];
}

function versionTab(version) {
    return [facts([["File version", version.fileVersion], ["Product version", version.productVersion], ...Object.entries(version.strings)])];
}

function bitmapPreview(bitmap) {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").putImageData(new ImageData(bitmap.rgba, bitmap.width, bitmap.height), 0, 0);
    canvas.className = "preview-image";
    canvas.style.width = `${Math.min(bitmap.width * 2, 560)}px`;
    const note = document.createElement("p");
    note.textContent = `${bitmap.width} x ${bitmap.height}, ${bitmap.bits}-bit`;
    return [canvas, note];
}

function previewTab(node) {
    const data = nodeData(node);
    const extension = extensionOf(node.name);
    const bitmap = readBitmapFile(data);
    if (bitmap) return bitmapPreview(bitmap);
    if (IMAGE_TYPES[extension]) {
        const image = document.createElement("img");
        image.className = "preview-image";
        image.alt = node.name;
        image.src = URL.createObjectURL(new Blob([data], { type: IMAGE_TYPES[extension] }));
        return [image];
    }
    if (SOUND_TYPES[extension]) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = URL.createObjectURL(new Blob([data], { type: SOUND_TYPES[extension] }));
        return [audio];
    }
    const pre = document.createElement("pre");
    pre.textContent = decodeText(data.subarray(0, 65536));
    return [pre];
}

function shortcutTab(node) {
    const shortcut = resolveShortcut(state.tree, node, nodeData);
    if (!shortcut) return [facts([["Target", "Not a readable shortcut"]])];
    return [facts([["Target", shortcut.target], ["Arguments", shortcut.arguments], ["Command", shortcut.command], ["In this ROM", shortcut.node ? pathOf(shortcut.node) : "No"]])];
}

function nodeTabs(node) {
    if (node.kind === "folder") {
        const totals = folderTotals(node);
        return [["General", () => [heading(artIcon("folder", 32), node.name || "\\"), rule(), facts([["Type", "File Folder"], ["Location", node.parent ? pathOf(node.parent) : ""], ["Contains", `${totals.files} files, ${totals.folders} folders`], ["Size", exactSize(totals.bytes)]])]]];
    }
    const tabs = [["General", () => [heading(realIcon(node, 32), node.name), rule(), facts(generalFacts(node))]]];
    let data = null;
    try {
        data = nodeData(node);
    } catch (error) {
        tabs.push(["Problem", () => [facts([["Couldn't extract", error.message]])]]);
        return tabs;
    }
    if (isPe(data)) {
        if (node.item.kind === "module") tabs.push(["Program", () => programTab(node)]);
        if (readExports(data).length) tabs.push(["Exports", () => exportsTab(node)]);
        const version = readVersion(data);
        if (version) tabs.push(["Version", () => versionTab(version)]);
    }
    if (isShortcut(node)) tabs.push(["Shortcut", () => shortcutTab(node)]);
    const extension = extensionOf(node.name);
    if (!isPe(data) && (TEXT_EXTENSIONS.has(extension) || IMAGE_TYPES[extension] || SOUND_TYPES[extension])) tabs.push(["Preview", () => previewTab(node)]);
    return tabs;
}

function showProperties(node = null) {
    if (!state.region) return;
    state.dialogNode = node;
    const tabs = node ? nodeTabs(node) : romTabs();
    elements["dialog-title"].textContent = `${node ? node.name || "\\" : state.source.name} Properties`;
    elements["dialog-save"].hidden = !node;
    elements["dialog-save"].textContent = node?.kind === "folder" ? "Save as .zip" : "Save file";
    const showTab = (index) => {
        [...elements["dialog-tabs"].children].forEach((button, buttonIndex) => button.setAttribute("aria-selected", String(buttonIndex === index)));
        try {
            elements["dialog-panel"].replaceChildren(...tabs[index][1]());
        } catch (error) {
            elements["dialog-panel"].replaceChildren(facts([["Couldn't read this", error.message]]));
        }
    };
    elements["dialog-tabs"].replaceChildren(...tabs.map(([label], index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "tab");
        button.textContent = label;
        button.addEventListener("click", () => showTab(index));
        return button;
    }));
    showTab(0);
    elements.dialog.hidden = false;
    raiseWindow(elements.dialog);
    elements["dialog-ok"].focus();
}

function renderRomBar() {
    const region = state.region;
    const modules = groupModules();
    const files = groupFiles();
    const kernel = modules.find((module) => module.name.toLowerCase() === "nk.exe");
    const contents = [...modules, ...files].reduce((total, item) => total + item.size, 0);
    const platform = platformGuess(region);
    const version = `Windows CE ${versionLabel(region)}`;
    const rows = [
        ["CE", platform === version ? versionLabel(region) : `${versionLabel(region)} (${platform})`],
        ["CPU", machineName(region.machine)],
        ["Modules", String(modules.length)],
        ["Files", String(files.length)],
        ["Contents", formatSize(contents)],
        ["ROM file", formatSize(state.source.size)],
        ["Kernel built", kernel?.time ? kernel.time.toLocaleDateString() : ""],
        ["Regions", state.regions.length > 1 ? String(state.regions.length) : ""],
    ];
    elements["rom-facts"].replaceChildren(...rows.filter(([, value]) => value).map(([term, value]) => {
        const pair = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        pair.append(dt, dd);
        return pair;
    }));
    elements["rom-bar"].hidden = false;
}

function closeDialog() {
    elements.dialog.hidden = true;
    elements.view.focus();
}

function useChoice(index) {
    const choice = state.choices[index];
    state.rom = choice.rom;
    state.source = { name: choice.candidate.name, size: choice.candidate.data.length, container: choice.candidate.container };
    state.regions = choice.group;
    state.region = choice.group.find((region) => region.modules.some((module) => module.name.toLowerCase() === "coredll.dll")) ?? choice.group[0];
    state.icons.clear();
    state.exportNames.clear();
    const { root, notes } = buildTree(state.regions);
    state.tree = root;
    const windows = findPath(root, "\\Windows");
    elements.folder.disabled = false;
    elements["save-all"].disabled = false;
    openFolder(windows ?? root);
    renderRomBar();
    const region = state.region;
    const names = new Set(groupModules().map((module) => module.name.toLowerCase()));
    const partial = names.has("nk.exe") && names.has("coredll.dll") ? "" : " No kernel and COREDLL together, so this is probably a boot loader or a partial image.";
    const chained = state.regions.length > 1 ? ` in ${state.regions.length} chained regions` : "";
    setStatus(`${state.source.name}: Windows CE ${versionLabel(region)}, ${machineName(region.machine)}, ${groupModules().length} modules and ${groupFiles().length} files${chained}.${partial}${notes.length ? " " + notes.join(" ") : ""}`);
}

function* romCandidates(name, data) {
    yield { name, data, container: null };
    let files = [];
    try {
        files = unpack(name, data).files;
    } catch {
        return;
    }
    const unpacked = files.filter((file) => file.data !== data && file.data.length >= 65536).sort((left, right) => right.data.length - left.data.length);
    for (const file of unpacked) yield { name: file.path.split("/").pop(), data: file.data, container: name };
}

async function openFile(file) {
    closeDialog();
    setStatus(`Reading ${file.name}...`);
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(file.size);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const data = new Uint8Array(await file.arrayBuffer());
    const choices = [];
    const failures = [];
    for (const candidate of romCandidates(file.name, data)) {
        try {
            const rom = openRom(candidate.data, candidate.name);
            rom.groups.forEach((group, index) => choices.push({ rom, candidate, group, index }));
            if (!candidate.container) break;
        } catch (error) {
            failures.push(candidate.container ? `${candidate.name}: ${error.message}` : error.message);
        }
    }
    if (!choices.length) {
        setStatus(`Couldn't open ${file.name}. ${failures[1] ?? failures[0] ?? "No ROM image found."}`);
        return;
    }
    state.choices = choices;
    const files = new Set(choices.map((choice) => choice.candidate.name));
    elements.region.hidden = choices.length < 2;
    elements.region.replaceChildren(...choices.map((choice, index) => {
        const region = choice.group.find((member) => member.modules.some((module) => module.name.toLowerCase() === "coredll.dll")) ?? choice.group[0];
        const prefix = files.size > 1 ? `${choice.candidate.name}, ` : "";
        const modules = choice.group.reduce((total, member) => total + member.modules.length, 0);
        return new Option(`${prefix}image ${choice.index + 1}: ${modules} modules, CE ${versionLabel(region)}`, String(index));
    }));
    useChoice(0);
}

function setView(view) {
    state.view = view;
    elements["view-icons"].setAttribute("aria-pressed", String(view === "icons"));
    elements["view-details"].setAttribute("aria-pressed", String(view === "details"));
    try {
        localStorage.setItem("rom-explorer-view", view);
    } catch {
        return renderView();
    }
    renderView();
}

function setup() {
    try {
        state.view = localStorage.getItem("rom-explorer-view") === "details" ? "details" : "icons";
    } catch {
        state.view = "icons";
    }
    elements["view-icons"].setAttribute("aria-pressed", String(state.view === "icons"));
    elements["view-details"].setAttribute("aria-pressed", String(state.view === "details"));
    const pick = () => elements["file-input"].click();
    elements.open.addEventListener("click", pick);
    elements.drop.addEventListener("click", pick);
    elements.drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick();
        }
    });
    elements["file-input"].addEventListener("change", () => {
        if (elements["file-input"].files[0]) openFile(elements["file-input"].files[0]);
        elements["file-input"].value = "";
    });
    for (const target of [elements.view, document.body]) {
        target.addEventListener("dragover", (event) => {
            event.preventDefault();
            elements.drop.classList.add("over");
        });
    }
    document.body.addEventListener("dragleave", () => elements.drop.classList.remove("over"));
    document.body.addEventListener("drop", (event) => {
        event.preventDefault();
        elements.drop.classList.remove("over");
        if (event.dataTransfer.files[0]) openFile(event.dataTransfer.files[0]);
    });
    elements.folder.addEventListener("change", () => {
        const folder = findPath(state.tree, elements.folder.value);
        if (folder) openFolder(folder);
    });
    elements.up.addEventListener("click", () => state.folder?.parent && openFolder(state.folder.parent));
    elements["view-icons"].addEventListener("click", () => setView("icons"));
    elements["view-details"].addEventListener("click", () => setView("details"));
    elements.properties.addEventListener("click", () => showProperties(state.selected.size === 1 ? [...state.selected][0] : null));
    elements["save-selected"].addEventListener("click", () => saveNodes([...state.selected]));
    elements["save-all"].addEventListener("click", saveAll);
    elements["rom-details"].addEventListener("click", () => showProperties(null));
    elements.region.addEventListener("change", () => useChoice(Number(elements.region.value)));
    elements.view.addEventListener("click", () => {
        if (!state.folder) return;
        state.selected.clear();
        renderSelection();
    });
    elements.view.addEventListener("keydown", (event) => {
        if (!state.folder || !elements.dialog.hidden) return;
        const columns = state.view === "icons" ? iconColumns() : 1;
        const moves = { ArrowRight: state.view === "icons" ? 1 : 0, ArrowLeft: state.view === "icons" ? -1 : 0, ArrowDown: columns, ArrowUp: -columns };
        if (moves[event.key]) {
            event.preventDefault();
            moveSelection(moves[event.key]);
        } else if (event.key === "Enter" && state.anchor) {
            event.preventDefault();
            activate(state.anchor);
        } else if (event.key === "Backspace" && state.folder.parent) {
            event.preventDefault();
            openFolder(state.folder.parent);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            state.selected = new Set(state.order);
            renderSelection();
        } else if (event.altKey && event.key === "Enter") {
            event.preventDefault();
            showProperties(state.selected.size === 1 ? [...state.selected][0] : null);
        }
    });
    elements["dialog-close"].addEventListener("click", closeDialog);
    elements["dialog-ok"].addEventListener("click", closeDialog);
    elements["dialog-save"].addEventListener("click", () => state.dialogNode && saveNodes([state.dialogNode]));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.dialog.hidden) closeDialog();
    });
    setupDesktop({ readmeKey: "rom-explorer-readme" });
}

setup();
