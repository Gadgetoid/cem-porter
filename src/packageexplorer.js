import { zipSync } from "../vendor/fflate.js";
import { unpack } from "./unpack.js";
import { readSetup } from "./cesetup.js";
import { planFromCabSetup } from "./installplan.js";
import { encodeLatin1 } from "./cabwrite.js";
import { extensionOf, pathOf, sortChildren, typeName } from "./romtree.js";
import { artIcon } from "./romicons.js";
import { registryPreview } from "./previews.js";
import { saveBytes, setupDesktop } from "./desktop.js";
import { putHandoff } from "./handoff.js";
import { baseName, createBrowser, digestText, exactSize, facts, folderTotals, formatSize, heading, pairs, rule, table } from "./browser.js";

const elements = Object.fromEntries(["save-all", "drop-title", "drop-hint", "package-bar", "package-facts", "package-details"].map((id) => [id, document.getElementById(id)]));
const state = { inputs: [], log: [], containers: new Map(), setups: [] };
const CAB_ARCHITECTURES = { 0: "Any", 2577: "StrongARM", 4000: "MIPS R4000", 10003: "SH3", 10004: "SH3E", 10005: "SH4", 70001: "ARM720" };
const PROGRAM_EXTENSIONS = new Set(["exe", "dll", "cpl"]);
const browser = createBrowser({
    title: "Package Explorer", viewKey: "package-explorer-view", readData: nodeData, generalFacts, extraTabs, folderTabs, summaryTabs: packageTabs, openFile, shortcutPlace: "In this package",
    nodeActions: [{
        label: "Save container",
        show: (node) => Boolean(node.container),
        run: (node, data) => {
            const name = node.container.name.split(/[\\/]/).pop();
            saveBytes(data, name);
            browser.setStatus(`Saved ${name}.`);
        },
    }, {
        label: "Open in Hex",
        show: (node) => node.kind === "file" || Boolean(node.container),
        run: (node, data) => putHandoff(node.name, data)
            .then(() => { window.location.href = "hex.html"; })
            .catch((error) => browser.setStatus(`Couldn't open in Hex: ${error.message}`)),
    }, {
        label: "Open in Icon Lab",
        show: (node) => node.kind === "file" && PROGRAM_EXTENSIONS.has(extensionOf(node.name)),
        run: (node, data) => putHandoff(node.name, data, "icons")
            .then(() => { window.location.href = "icons.html"; })
            .catch((error) => browser.setStatus(`Couldn't open in Icon Lab: ${error.message}`)),
    }],
});
const view = browser.state;
const setStatus = browser.setStatus;

function nodeData(node) {
    return node.container ? node.container.data : node.item.data;
}

function pathKey(path) {
    return path.normalize("NFC").toLowerCase();
}

function newFolder(name, parent) {
    const folder = { kind: "folder", name, parent, children: [] };
    parent?.children.push(folder);
    return folder;
}

function ensureFolder(root, folders, path) {
    let current = root;
    let currentPath = "";
    for (const part of path.split("/").filter(Boolean)) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const key = pathKey(currentPath);
        if (!folders.has(key)) folders.set(key, newFolder(part, current));
        current = folders.get(key);
    }
    return current;
}

function uniqueName(parent, node, name) {
    const taken = (candidate) => parent.children.some((child) => child !== node && child.name.toLowerCase() === candidate.toLowerCase());
    if (!taken(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let number = 2; ; number++) {
        const candidate = `${stem} (${number})${extension}`;
        if (!taken(candidate)) return candidate;
    }
}

function buildTree(files, log) {
    const root = newFolder("", null);
    const folders = new Map();
    const containers = new Map();
    for (const entry of log) {
        const folder = ensureFolder(root, folders, entry.container);
        folder.container = entry;
        containers.set(entry, folder);
    }
    for (const file of files) {
        const slash = file.path.lastIndexOf("/");
        const parent = slash < 0 ? root : ensureFolder(root, folders, file.path.slice(0, slash));
        const name = file.path.slice(slash + 1);
        parent.children.push({ kind: "file", name, parent, item: { name, size: file.data.length, time: null, data: file.data, storedName: file.storedName, container: file.container } });
    }
    for (const folder of containers.values()) folder.name = uniqueName(folder.parent, folder, folder.name.replace(/\.d$/, ""));
    return { root, containers };
}

function readCabSetups(containers) {
    const setups = [];
    for (const folder of containers.values()) {
        const files = folder.children.filter((child) => child.kind === "file");
        const setupNode = files.find((child) => /\.000$/.test(child.name) && readSetup(child.item.data));
        if (!setupNode) continue;
        const setup = readSetup(setupNode.item.data);
        const members = {};
        for (const child of files) {
            const number = /\.(\d{3})$/.exec(child.name);
            if (number && Number(number[1]) > 0) members[Number(number[1])] = child;
        }
        const plan = planFromCabSetup(setup, members);
        const cab = { folder, setupNode, setup, plan };
        for (const operation of plan.operations.filter((operation) => operation.kind === "file")) {
            operation.source.item.installPath = operation.path;
            operation.source.name = uniqueName(folder, operation.source, operation.path.split("\\").pop());
        }
        if (members[999]) members[999].item.setupDll = true;
        setupNode.item.cab = cab;
        folder.cab = cab;
        setups.push(cab);
    }
    return setups;
}

function containerPath(entry) {
    return entry ? pathOf(state.containers.get(entry)) : "";
}

function generalFacts(node) {
    const item = node.item;
    const container = item.container;
    return [
        ["Type", typeName(node)],
        ["Location", pathOf(node.parent)],
        ["Size", exactSize(item.size)],
        ["Stored as", item.storedName && item.storedName.split(/[\\/]/).pop() !== node.name ? item.storedName : ""],
        ["Installs to", item.installPath ?? ""],
        ["Setup DLL", item.setupDll ? "Run by wceload while installing" : ""],
        ["Unpacked from", container ? `${containerPath(container)} (${container.method})` : "Opened directly"],
    ];
}

function regString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function registryLine(operation) {
    const name = operation.name ? `"${regString(operation.name)}"` : "@";
    if (operation.kind === "regdword") return `${name}=dword:${operation.value.toString(16).padStart(8, "0")}`;
    if (operation.kind === "regmulti") return `${name}=multi_sz:${operation.value.map((part) => `"${regString(part)}"`).join(",")}`;
    if (operation.kind === "regbinary") return `${name}=hex:${[...operation.value].map((byte) => byte.toString(16).padStart(2, "0")).join(",")}`;
    return `${name}="${regString(operation.value)}"`;
}

function registryScript(plan) {
    const keys = new Map();
    for (const operation of plan.operations) {
        if (!operation.kind.startsWith("reg")) continue;
        const key = `${operation.root}\\${operation.key}`;
        if (!keys.has(key)) keys.set(key, []);
        if (operation.kind !== "regkey") keys.get(key).push(registryLine(operation));
    }
    const lines = ["REGEDIT4", ""];
    for (const [key, values] of keys) lines.push(`[${key}]`, ...values, "");
    return lines.join("\r\n");
}

function setupTab(cab) {
    const { setup, plan } = cab;
    const installs = plan.operations.filter((operation) => operation.kind === "file");
    const rows = installs.map((operation) => [operation.source.item.storedName, operation.source.name, operation.path]);
    if (cab.plan.setupDlls.length) rows.push([cab.plan.setupDlls[0].source.item.storedName, "", "Setup DLL"]);
    return [
        facts([
            ["Program", setup.app],
            ["Provider", setup.provider],
            ["Processor", `${CAB_ARCHITECTURES[setup.architecture] ?? "Unknown"} (${setup.architecture})`],
            ["Install folder", plan.installFolder],
            ["Unsupported", setup.unsupported],
            ["Problems", plan.warnings.join("; ")],
        ]),
        table(["Stored as", "Name", "Installs to"], rows),
    ];
}

function registryTab(cab) {
    const data = encodeLatin1(registryScript(cab.plan));
    const note = document.createElement("p");
    note.textContent = "Entries wceload writes, including its own Software\\Apps key.";
    return [note, ...(registryPreview(data) ?? [])];
}

function shortcutsTab(cab) {
    const shortcuts = cab.plan.operations.filter((operation) => operation.kind === "shortcut");
    if (!shortcuts.length) return [facts([["Shortcuts", "None"]])];
    return [table(["Shortcut", "Target"], shortcuts.map((operation) => [operation.link, operation.target]))];
}

function cabTabs(cab) {
    return [["Setup", () => setupTab(cab)], ["Registry", () => registryTab(cab)], ["Shortcuts", () => shortcutsTab(cab)]];
}

function extraTabs(node) {
    return node.item.cab ? cabTabs(node.item.cab) : [];
}

function folderTabs(folder) {
    const tabs = [];
    if (folder.container) {
        const { method, members, parent, name, data } = folder.container;
        tabs.push(["Container", () => [facts([["Format", method], ["Stored as", name], ["Size", exactSize(data.length)], ["Members", String(members)], ["Inside", parent ? containerPath(parent) : "Opened directly"], ["SHA-256", digestText(data)]])]]);
    }
    if (folder.cab) tabs.push(...cabTabs(folder.cab));
    return tabs;
}

function formats() {
    return [...new Set(state.log.map((entry) => entry.method))];
}

function packageName() {
    return state.inputs.map((input) => input.name).join(", ");
}

function packageSummary() {
    const totals = folderTotals(view.tree);
    return [
        ["Opened", packageName()],
        ["Size", exactSize(state.inputs.reduce((total, input) => total + input.size, 0))],
        ["Formats", formats().join(", ") || "None, not a package"],
        ["Containers", String(state.log.length)],
        ["Files", `${totals.files}, ${formatSize(totals.bytes)}`],
        ["CE CABs", state.setups.length ? state.setups.map((cab) => cab.setup.app || cab.folder.name).join(", ") : ""],
    ];
}

function packageTabs() {
    return [
        ["General", () => [heading(artIcon("folder", 32), packageName()), rule(), facts(packageSummary())]],
        ["Unpacking", () => {
            const note = document.createElement("p");
            note.textContent = `${state.log.length} container${state.log.length === 1 ? "" : "s"} unpacked.`;
            return [note, table(["Container", "Format", "Members"], state.log.map((entry) => [containerPath(entry), entry.method, String(entry.members)]), [2])];
        }],
    ];
}

function renderPackageBar() {
    const totals = folderTotals(view.tree);
    const rows = [
        ["Formats", formats().join(", ") || "none"],
        ["Containers", String(state.log.length)],
        ["Files", String(totals.files)],
        ["Contents", formatSize(totals.bytes)],
        ["CE CABs", state.setups.length ? String(state.setups.length) : ""],
    ];
    elements["package-facts"].replaceChildren(...pairs(rows));
    elements["package-bar"].hidden = false;
}

function saveAll() {
    setStatus("Making a zip of the whole package...");
    setTimeout(() => {
        const name = baseName(state.inputs[0].name);
        const data = zipSync(browser.zipEntries(sortChildren(view.tree.children)), { level: 6 });
        saveBytes(data, `${name}.zip`);
        setStatus(`Saved ${name}.zip (${formatSize(data.length)}).`);
    }, 0);
}

async function openFile(file, files = [file]) {
    browser.closeDialog();
    const label = files.length === 1 ? file.name : `${files.length} files`;
    setStatus(`Unpacking ${label}...`);
    elements["drop-title"].textContent = label;
    elements["drop-hint"].textContent = formatSize(files.reduce((total, input) => total + input.size, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    let tree;
    let log;
    let unpacked;
    try {
        const inputs = await Promise.all(files.map(async (input) => ({ name: input.name, size: input.size, data: new Uint8Array(await input.arrayBuffer()) })));
        unpacked = [];
        log = [];
        for (const input of inputs) {
            const result = unpack(input.name, input.data, inputs.filter((other) => other !== input));
            unpacked.push(...result.files);
            log.push(...result.log);
        }
        tree = buildTree(unpacked, log);
        Object.assign(state, { inputs, log, containers: tree.containers, setups: readCabSetups(tree.containers) });
    } catch (error) {
        setStatus(`Couldn't read ${label}: ${error.message}`);
        return;
    }
    elements["save-all"].disabled = false;
    const only = tree.root.children.length === 1 && tree.root.children[0].kind === "folder" ? tree.root.children[0] : null;
    browser.show(tree.root, { name: label, size: state.inputs.reduce((total, input) => total + input.size, 0) }, only);
    renderPackageBar();
    const methods = formats();
    const cabs = state.setups.length ? `, ${state.setups.length} CE CAB${state.setups.length === 1 ? "" : "s"}` : "";
    setStatus(`${label}: ${unpacked.length} file${unpacked.length === 1 ? "" : "s"}${methods.length ? ` from ${methods.join(", ")}` : ", nothing to unpack"}${cabs}.`);
}

function setup() {
    elements["save-all"].addEventListener("click", saveAll);
    elements["package-details"].addEventListener("click", () => browser.showProperties(null));
    setupDesktop({ readmeKey: "package-explorer-readme" });
}

setup();
