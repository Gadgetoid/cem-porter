import { zipSync } from "../vendor/fflate.js";
import { isPe } from "./pe.js";
import { ATTRIBUTE_NAMES, hex } from "./romimage.js";
import { decodeText, extensionOf, findPath, pathOf, resolveShortcut, sortChildren, typeName } from "./romtree.js";
import { readBitmapFile, readExports, readIcon, readVersion } from "./romres.js";
import { artIcon, bitmapIcon, iconKind } from "./romicons.js";
import { raiseWindow, saveBytes } from "./desktop.js";

const TEXT_EXTENSIONS = new Set(["txt", "ini", "inf", "htm", "html", "htc", "htp", "lnk", "reg", "bat", "xml", "log"]);
const IMAGE_TYPES = { bmp: "image/bmp", "2bp": "image/bmp", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", ico: "image/x-icon" };
const SOUND_TYPES = { wav: "audio/wav" };
const ZIP_EARLIEST = new Date(1980, 0, 2);
const ELEMENT_IDS = ["window-title", "open", "folder", "up", "view-icons", "view-details", "properties", "save-selected", "view", "drop", "drop-title", "drop-hint", "file-input", "status", "size", "dialog", "dialog-title", "dialog-close", "dialog-tabs", "dialog-panel", "dialog-save", "dialog-ok"];

export function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function formatDate(date) {
    return date ? date.toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }) : "";
}

export function exactSize(bytes) {
    return `${formatSize(bytes)} (${bytes.toLocaleString()} bytes)`;
}

export function baseName(name) {
    return name.replace(/\.[^.]*$/, "") || "rom";
}

export function facts(rows) {
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

export function table(headings, rows, alignRight = []) {
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

export function heading(icon, text) {
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

export function rule() {
    return document.createElement("hr");
}

export function attributeText(attributes) {
    const names = Object.entries(ATTRIBUTE_NAMES).filter(([bit]) => attributes & Number(bit)).map(([, name]) => name);
    return `${names.join(", ") || "None"} (${hex(attributes, 4)})`;
}

export function pairs(rows) {
    return rows.filter(([, value]) => value).map(([term, value]) => {
        const pair = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        pair.append(dt, dd);
        return pair;
    });
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

export function folderTotals(folder) {
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

function versionTab(version) {
    return [facts([["File version", version.fileVersion], ["Product version", version.productVersion], ...Object.entries(version.strings)])];
}

export function createBrowser({ title, viewKey, readData, generalFacts, extraTabs = () => [], summaryTabs, openFile, shortcutPlace = "In this ROM" }) {
    const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, document.getElementById(id)]));
    const state = { source: null, tree: null, folder: null, selected: new Set(), anchor: null, view: "icons", sort: { key: "name", ascending: true }, order: [], images: new Map(), icons: new WeakMap(), iconJob: 0, dialogNode: undefined };

    function setStatus(text) {
        elements.status.textContent = text;
    }

    function cachedIcon(item, size, compute) {
        if (!state.icons.has(item)) state.icons.set(item, new Map());
        const sizes = state.icons.get(item);
        if (!sizes.has(size)) {
            try {
                sizes.set(size, compute());
            } catch {
                sizes.set(size, null);
            }
        }
        return sizes.get(size);
    }

    function peIcon(node, size) {
        const item = node.item;
        if (item.kind !== "module" && !["exe", "dll", "cpl"].includes(extensionOf(item.name))) return null;
        return cachedIcon(item, size, () => {
            const data = readData(node);
            return isPe(data) ? readIcon(data, size) : null;
        });
    }

    function realIcon(node, size, shortcut = false) {
        if (node.kind === "folder") return artIcon("folder", size, shortcut);
        if (isShortcut(node) && !shortcut) {
            const target = resolveShortcut(state.tree, node, readData)?.node;
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
            const option = new Option(`${"  ".repeat(depth)}${folder.parent ? folder.name : "\\"}`, pathOf(folder));
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
        elements.properties.disabled = !state.tree;
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
        elements["window-title"].textContent = `${folder.parent ? folder.name : state.source.name} - ${title}`;
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
            const target = resolveShortcut(state.tree, node, readData)?.node;
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
                entries[path] = [readData(node), { mtime: time }];
            } catch (error) {
                entries[`${path}.unreadable.txt`] = new TextEncoder().encode(`${node.name} couldn't be extracted: ${error.message}\n`);
            }
        };
        for (const node of nodes) add(node, `${prefix}${node.name}${node.kind === "folder" ? "/" : ""}`);
        return entries;
    }

    function saveNodes(nodes) {
        if (nodes.length === 1 && nodes[0].kind !== "folder") {
            try {
                saveBytes(readData(nodes[0]), nodes[0].name);
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

    function exportsTab(node) {
        const exports = readExports(readData(node));
        const named = exports.filter((entry) => entry.name);
        const note = document.createElement("p");
        note.textContent = `${exports.length} ordinals, ${named.length} with names.`;
        return [note, table(["Ordinal", "Name"], exports.map((entry) => [String(entry.ordinal), entry.name ?? ""]))];
    }

    function previewTab(node) {
        const data = readData(node);
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
        const shortcut = resolveShortcut(state.tree, node, readData);
        if (!shortcut) return [facts([["Target", "Not a readable shortcut"]])];
        return [facts([["Target", shortcut.target], ["Arguments", shortcut.arguments], ["Command", shortcut.command], [shortcutPlace, shortcut.node ? pathOf(shortcut.node) : "No"]])];
    }

    function nodeTabs(node) {
        if (node.kind === "folder") {
            const totals = folderTotals(node);
            return [["General", () => [heading(artIcon("folder", 32), node.name || "\\"), rule(), facts([["Type", "File Folder"], ["Location", node.parent ? pathOf(node.parent) : ""], ["Contains", `${totals.files} files, ${totals.folders} folders`], ["Size", exactSize(totals.bytes)]])]]];
        }
        const tabs = [["General", () => [heading(realIcon(node, 32), node.name), rule(), facts(generalFacts(node))]]];
        let data = null;
        try {
            data = readData(node);
        } catch (error) {
            tabs.push(["Problem", () => [facts([["Couldn't extract", error.message]])]]);
            return tabs;
        }
        tabs.push(...extraTabs(node, data));
        if (isPe(data)) {
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
        if (!state.tree) return;
        state.dialogNode = node;
        const tabs = node ? nodeTabs(node) : summaryTabs();
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

    function closeDialog() {
        elements.dialog.hidden = true;
        elements.view.focus();
    }

    function show(tree, source, folder) {
        state.tree = tree;
        state.source = source;
        state.icons = new WeakMap();
        elements.folder.disabled = false;
        openFolder(folder ?? tree);
    }

    function setView(view) {
        state.view = view;
        elements["view-icons"].setAttribute("aria-pressed", String(view === "icons"));
        elements["view-details"].setAttribute("aria-pressed", String(view === "details"));
        try {
            localStorage.setItem(viewKey, view);
        } catch {
            return renderView();
        }
        renderView();
    }

    try {
        state.view = localStorage.getItem(viewKey) === "details" ? "details" : "icons";
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

    return { state, elements, setStatus, show, openFolder, showProperties, closeDialog, zipEntries, realIcon };
}
