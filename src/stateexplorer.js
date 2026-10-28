import { zipSync } from "../vendor/fflate.js";
import { hex } from "./romimage.js";
import { findPath, pathOf, sortChildren, typeName } from "./romtree.js";
import { artIcon } from "./romicons.js";
import { raiseWindow, saveBytes, setupDesktop } from "./desktop.js";
import { readState } from "./statefile.js";
import { formatValue, keyPath, OBJECT_NAMES, openObjectStore, REGISTRY_TYPES, registryText } from "./objectstore.js";
import { attributeText, baseName, createBrowser, exactSize, facts, folderTotals, formatDate, formatSize, heading, pairs, rule, table } from "./browser.js";

const elements = Object.fromEntries(["save-all", "registry-open", "drop-title", "drop-hint", "state-bar", "state-facts", "state-details", "registry", "registry-title", "registry-close", "registry-up", "registry-path", "registry-summary", "registry-list", "registry-rows", "registry-save", "registry-ok"].map((id) => [id, document.getElementById(id)]));
const state = { file: null, store: null, registry: null, counts: null, key: null };
const browser = createBrowser({ title: "State Explorer", viewKey: "state-explorer-view", readData: nodeData, generalFacts, summaryTabs: stateTabs, openFile, shortcutPlace: "In RAM" });
const view = browser.state;
const setStatus = browser.setStatus;

function nodeData(node) {
    return state.store.fileData(node.item);
}

function versionLabel() {
    return state.store.ce2 ? "2.0 or later" : "1.0 or 1.01";
}

function contents() {
    return folderTotals(view.tree);
}

function counts() {
    state.counts ??= state.store.counts();
    return state.counts;
}

function generalFacts(node) {
    const item = node.item;
    const compressed = state.store.compressedChunks(item);
    return [
        ["Type", typeName(node)],
        ["Location", pathOf(node.parent)],
        ["Size", exactSize(item.size)],
        ["Modified", formatDate(item.time)],
        ["Attributes", attributeText(item.attributes)],
        ["Stored in RAM", `${exactSize(item.storedSize)} in ${item.chunks.length} chunk${item.chunks.length === 1 ? "" : "s"}${compressed ? `, ${compressed} compressed` : ""}`],
        ["Object", `${item.id} (${hex(item.id, 4)})`],
    ];
}

function stateSummary() {
    const { file, store } = state;
    const totals = contents();
    const registry = state.registry;
    return [
        ["File", view.source.name],
        ["File size", `${exactSize(view.source.size)}${file.compressed ? `, ${formatSize(file.size)} uncompressed` : ""}`],
        ["Emulator", file.format.emulator],
        ["Processor", file.format.cpu],
        ["Saved", formatDate(file.savedAt)],
        ["ROM hash", file.romHash.toString(16).toUpperCase().padStart(16, "0")],
        ["Windows CE", versionLabel()],
        ["RAM", file.regions.map((region) => `${region.name} ${formatSize(region.data.length)}`).join(", ")],
        ["Object store", `${formatSize(store.size)} in ${store.sections.length} section${store.sections.length === 1 ? "" : "s"}`],
        ["Files", `${totals.files} in ${totals.folders} folders, ${formatSize(totals.bytes)}`],
        ["Registry", registry.source ? `${registry.keys} keys, ${registry.values} values, from ${registry.source}` : "Not found"],
    ];
}

function stateMemory() {
    const { store } = state;
    return [
        ["Store log", hex(store.logAddress)],
        ...store.sections.map((section, index) => [`Section ${index}`, `${hex(section.va)}, ${exactSize(section.size)}`]),
        ["Handle blocks", String(store.handleBlocks.length)],
        ["Registry roots", store.ce2 ? `object ${store.registryRoots}` : null],
    ];
}

function stateReport() {
    const lines = ["State Explorer report", ""];
    for (const [term, value] of [...stateSummary(), ...stateMemory()]) if (value) lines.push(`${term}: ${value}`);
    lines.push("", "Objects:");
    for (const [type, count] of [...counts()].sort((a, b) => a[0] - b[0])) lines.push(`  ${(OBJECT_NAMES[type] ?? `Type ${type}`).padEnd(20)} ${count}`);
    lines.push("", "Records:");
    for (const record of state.file.records) lines.push(`  ${record.name.padEnd(24)} ${String(record.size).padStart(9)}`);
    lines.push("", "Files (path, size, stored size, attributes, modified):");
    const walk = (folder) => {
        for (const child of sortChildren(folder.children)) {
            if (child.kind === "folder") walk(child);
            else lines.push(`  ${pathOf(child)}  ${child.item.size}  ${child.item.storedSize}  ${hex(child.item.attributes, 4)}  ${child.item.time?.toISOString() ?? ""}`);
        }
    };
    walk(view.tree);
    return lines.join("\r\n") + "\r\n";
}

function stateTabs() {
    return [
        ["General", () => [heading(artIcon("data", 32), view.source.name), rule(), facts(stateSummary())]],
        ["Memory", () => [facts(stateMemory())]],
        ["Objects", () => {
            const note = document.createElement("p");
            note.textContent = "Objects in the store by type. Databases aren't read.";
            const rows = [...counts()].sort((a, b) => a[0] - b[0]).map(([type, count]) => [OBJECT_NAMES[type] ?? `Type ${type}`, String(count)]);
            return [note, table(["Object", "Count"], rows, [1])];
        }],
        ["Records", () => {
            const note = document.createElement("p");
            note.textContent = `${state.file.records.length} records saved by ${state.file.format.emulator}.`;
            return [note, table(["Record", "Size"], state.file.records.map((record) => [record.name, String(record.size)]), [1])];
        }],
    ];
}

function renderStateBar() {
    const totals = contents();
    const rows = [
        ["Emulator", state.file.format.emulator],
        ["CE", versionLabel()],
        ["CPU", state.file.format.cpu],
        ["Saved", state.file.savedAt ? formatDate(state.file.savedAt) : ""],
        ["Files", String(totals.files)],
        ["Contents", formatSize(totals.bytes)],
        ["Store", formatSize(state.store.size)],
    ];
    elements["state-facts"].replaceChildren(...pairs(rows));
    elements["state-bar"].hidden = false;
}

function countRegistry(roots) {
    let keys = 0;
    let values = 0;
    const walk = (key) => {
        keys++;
        values += key.values.length;
        key.keys.forEach(walk);
    };
    roots.forEach(walk);
    return { keys: keys - roots.length, values };
}

function keyRow(body, key) {
    const row = body.insertRow();
    row.className = "selectable";
    row.tabIndex = 0;
    const name = row.insertCell();
    name.className = "name";
    const image = document.createElement("img");
    image.alt = "";
    image.src = artIcon("folder", 16);
    const label = document.createElement("span");
    label.textContent = key.name;
    name.append(image, label);
    row.insertCell().textContent = "Key";
    const data = row.insertCell();
    data.className = "data";
    data.textContent = `${key.keys.length} keys, ${key.values.length} values${key.className ? `, class ${key.className}` : ""}${key.damaged ? ", damaged" : ""}`;
    row.addEventListener("click", () => [...body.rows].forEach((other) => other.classList.toggle("selected", other === row)));
    row.addEventListener("dblclick", () => openKey(key));
    row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") openKey(key);
    });
}

function valueRow(body, value) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.className = "name";
    const image = document.createElement("img");
    image.alt = "";
    image.src = artIcon(value.type === 1 || value.type === 2 || value.type === 7 ? "text" : "data", 16);
    const label = document.createElement("span");
    label.textContent = value.name || "(Default)";
    name.append(image, label);
    row.insertCell().textContent = REGISTRY_TYPES[value.type] ?? `Type ${value.type}`;
    const data = row.insertCell();
    data.className = "data";
    data.textContent = formatValue(value);
}

function openKey(key) {
    state.key = key;
    const roots = state.registry.roots;
    const keys = key ? key.keys : roots;
    const values = key ? key.values : [];
    elements["registry-path"].textContent = key ? keyPath(key) : "Registry";
    elements["registry-up"].disabled = !key;
    const body = elements["registry-rows"];
    body.replaceChildren();
    [...keys].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })).forEach((child) => keyRow(body, child));
    [...values].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })).forEach((value) => valueRow(body, value));
    if (!keys.length && !values.length) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = 3;
        cell.className = "empty";
        cell.textContent = "This key is empty.";
    }
    elements["registry-list"].scrollTop = 0;
    elements["registry-list"].focus({ preventScroll: true });
}

function showRegistry() {
    if (!state.registry?.roots.length) return;
    const { keys, values, source } = state.registry;
    elements["registry-title"].textContent = `Registry - ${view.source.name}`;
    elements["registry-summary"].textContent = `${keys} keys and ${values} values, read from ${source}. Double-click a key to open it.`;
    elements.registry.hidden = false;
    raiseWindow(elements.registry);
    openKey(state.key);
}

function closeRegistry() {
    elements.registry.hidden = true;
    browser.elements.view.focus({ preventScroll: true });
}

function saveRegistry() {
    saveBytes(new TextEncoder().encode(registryText(state.registry.roots)), `${baseName(view.source.name)}.reg`);
}

function saveAll() {
    setStatus("Making a zip of the whole state...");
    setTimeout(() => {
        const entries = browser.zipEntries(sortChildren(view.tree.children));
        entries["State information.txt"] = new TextEncoder().encode(stateReport());
        if (state.registry.roots.length) entries["Registry.reg"] = new TextEncoder().encode(registryText(state.registry.roots));
        const data = zipSync(entries, { level: 6 });
        saveBytes(data, `${baseName(view.source.name)}.zip`);
        setStatus(`Saved ${baseName(view.source.name)}.zip (${formatSize(data.length)}).`);
    }, 0);
}

async function openFile(file) {
    browser.closeDialog();
    closeRegistry();
    setStatus(`Reading ${file.name}...`);
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(file.size);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const data = new Uint8Array(await file.arrayBuffer());
    let stateFile;
    let store;
    let tree;
    try {
        stateFile = readState(data);
        store = openObjectStore(stateFile);
        tree = store.tree();
    } catch (error) {
        setStatus(`Couldn't open ${file.name}: ${error.message}`);
        return;
    }
    let registry;
    try {
        registry = store.registry(tree.root);
    } catch (error) {
        registry = { source: null, roots: [], problem: error.message };
    }
    Object.assign(registry, countRegistry(registry.roots));
    Object.assign(state, { file: stateFile, store, registry, counts: null, key: null });
    elements["save-all"].disabled = false;
    elements["registry-open"].disabled = !registry.roots.length;
    browser.show(tree.root, { name: file.name, size: file.size }, findPath(tree.root, "\\My Documents"));
    renderStateBar();
    const totals = contents();
    const notes = [...tree.problems, ...(registry.problem ? [`the registry couldn't be read: ${registry.problem}`] : [])];
    setStatus(`${file.name}: ${stateFile.format.emulator}, Windows CE ${versionLabel()}, ${totals.files} files in RAM${registry.source ? `, ${registry.keys} registry keys` : ", no registry found"}.${notes.length ? ` Problems: ${notes.join("; ")}.` : ""}`);
}

function setup() {
    elements["save-all"].addEventListener("click", saveAll);
    elements["state-details"].addEventListener("click", () => browser.showProperties(null));
    elements["registry-open"].addEventListener("click", showRegistry);
    elements["registry-up"].addEventListener("click", () => state.key && openKey(state.key.parent));
    elements["registry-close"].addEventListener("click", closeRegistry);
    elements["registry-ok"].addEventListener("click", closeRegistry);
    elements["registry-save"].addEventListener("click", saveRegistry);
    elements["registry-list"].addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && state.key) {
            event.preventDefault();
            openKey(state.key.parent);
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.registry.hidden) closeRegistry();
    });
    setupDesktop({ readmeKey: "state-explorer-readme" });
}

setup();
