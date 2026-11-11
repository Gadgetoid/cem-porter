import { unpackFiles, fileData } from "../archive/unpack.js";
import { isPe, parsePe } from "../pe/pe.js";
import { findBuilds } from "../port/analyze.js";
import { readExports } from "../pe/romres.js";
import { fetchBytes } from "../port/assets.js";
import { checkDevice, describeBinary, detailText, machineLabel, referenceDevice, STATUS_LABELS, STATUS_ORDER } from "../port/compat.js";
import { formatSize } from "../ui/browser.js";
import { setupDesktop } from "../ui/desktop.js";

const elements = Object.fromEntries(["drop", "drop-title", "drop-hint", "file-input", "binaries", "family", "show", "search", "devices", "status", "size"].map((id) => [id, document.getElementById(id)]));
const readBytes = fetchBytes(new URL("../../", import.meta.url));
const decoder = new TextDecoder();
const WINDOWS_CE_SUBSYSTEM = 9;
const MACHINE_X86 = 0x14c;
const CHECK_COLUMNS = ["cpu", "version", "functions", "dlls", "kernel", "pages", "size"];
const SHOW_LIMITS = { all: "red", works: "patch", possible: "amber" };
const state = { devices: [], libraries: new Map(), porter: null, binaries: [], selected: -1, results: [], expanded: new Set() };

function setStatus(text) {
    elements.status.textContent = text;
}

function emptyRow(body, columns, text) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = columns;
    cell.className = "empty";
    cell.textContent = text;
    body.replaceChildren(row);
}

async function loadJson(path) {
    return JSON.parse(decoder.decode(await readBytes(path)));
}

async function loadLibrary(dll) {
    if (!state.libraries.has(dll)) state.libraries.set(dll, loadJson(`data/compat/libraries/${dll}.json`).catch(() => ({})));
    return state.libraries.get(dll);
}

async function loadPorter() {
    const text = async (path) => decoder.decode(await readBytes(path)).split(/\s+/).filter(Boolean);
    const [mips, sh3, compatExports, aygshell] = await Promise.all([text("data/mips/velocrt-exports.txt"), text("data/sh3/velocrt-exports.txt"), text("data/ce1compat-exports.txt"), readBytes("data/mips/AYGSHELL.DLL")]);
    return { crtExports: { mips, sh3 }, compatExports, aygshellExports: new Set(readExports(aygshell).map((entry) => entry.name).filter(Boolean)) };
}

function installedNames(name, files) {
    const names = new Map();
    let builds = [];
    try {
        builds = findBuilds(name, files);
    } catch {
        return names;
    }
    for (const build of builds) {
        try {
            const plan = build.plan();
            for (const operation of plan.operations) if (operation.kind === "file" && !names.has(operation.source)) names.set(operation.source, operation.path.split("\\").pop());
            for (const setupDll of plan.setupDlls ?? []) if (!names.has(setupDll.source)) names.set(setupDll.source, `${setupDll.app} setup DLL`);
        } catch {
            continue;
        }
    }
    return names;
}

function packageBinaries(name, files) {
    const names = installedNames(name, files);
    const binaries = [];
    for (const file of files) {
        if (!file.data || !isPe(file.data)) continue;
        const parsed = parsePe(file.data);
        if (!parsed || (parsed.machine === MACHINE_X86 && parsed.subsystem !== WINDOWS_CE_SUBSYSTEM)) continue;
        const installed = names.get(file.path);
        const binary = describeBinary(installed ?? file.path.split(/[\\/]/).pop(), file.data);
        if (binary?.family) binaries.push({ ...binary, path: installed ?? file.path });
    }
    return binaries;
}

function renderBinaries() {
    const body = elements.binaries;
    if (!state.binaries.length) {
        emptyRow(body, 5, "No Windows CE programs or DLLs in it.");
        return;
    }
    body.replaceChildren();
    state.binaries.forEach((binary, index) => {
        const row = body.insertRow();
        row.tabIndex = 0;
        row.setAttribute("aria-selected", String(index === state.selected));
        for (const [text, className] of [[binary.path, ""], [binary.dll ? "DLL" : "Program", ""], [machineLabel(binary.machine), ""], [`CE ${binary.subsystemVersion}`, ""], [formatSize(binary.size), "hide-narrow"]]) {
            const cell = row.insertCell();
            cell.textContent = text;
            if (className) cell.className = className;
        }
        const choose = () => selectBinary(index);
        row.addEventListener("click", choose);
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose();
            }
        });
    });
}

function hasLibrary(device, dll) {
    return Boolean(device.libraries?.[dll]);
}

async function checkBinary(binary) {
    const devices = state.devices.filter((device) => !device.error);
    const dlls = Object.keys(binary.imports);
    const tables = new Map(await Promise.all(dlls.map(async (dll) => [dll, await loadLibrary(dll)])));
    const library = (device, dll) => {
        const hash = device.libraries?.[dll];
        return hash ? tables.get(dll)?.[hash] ?? null : null;
    };
    const references = (dll) => {
        const reference = referenceDevice(binary, devices, dll, hasLibrary);
        return reference ? library(reference, dll) : null;
    };
    const packageDlls = new Set(state.binaries.filter((other) => other.dll).map((other) => other.name.toLowerCase()));
    return devices.map((device) => checkDevice(binary, device, { library, references, packageDlls, porter: state.porter }));
}

async function selectBinary(index) {
    state.selected = index;
    state.expanded.clear();
    renderBinaries();
    const binary = state.binaries[index];
    setStatus(`Checking ${binary.name}...`);
    try {
        state.results = await checkBinary(binary);
        renderMatrix();
    } catch (error) {
        setStatus(`Couldn't check ${binary.name}: ${error.message}`);
    }
}

function visibleResults() {
    const binary = state.binaries[state.selected];
    const family = elements.family.value;
    const limit = STATUS_ORDER.indexOf(SHOW_LIMITS[elements.show.value]);
    const search = elements.search.value.trim().toLowerCase();
    return state.results.filter(({ device, status }) => {
        if (family === "same" && device.family !== binary.family) return false;
        if (family !== "same" && family !== "all" && device.family !== family) return false;
        if (STATUS_ORDER.indexOf(status) > limit) return false;
        return !search || `${device.name} ${device.os.name} ${device.ceLabel}`.toLowerCase().includes(search);
    });
}

function statusCell(row, status, text, title = "") {
    const cell = row.insertCell();
    cell.className = `status ${status ? `status-${status}` : "status-none"}`;
    cell.textContent = text;
    if (title) cell.title = title;
    return cell;
}

function countText(results) {
    const counts = STATUS_ORDER.map((status) => [status, results.filter((result) => result.status === status).length]).filter(([, count]) => count);
    return counts.map(([status, count]) => `${count} ${STATUS_LABELS[status].toLowerCase()}`).join(", ");
}

function renderDetails(body, result) {
    const row = body.insertRow();
    row.className = "details";
    const cell = row.insertCell();
    cell.colSpan = 2 + CHECK_COLUMNS.length;
    const list = document.createElement("ul");
    const facts = document.createElement("li");
    facts.textContent = `${result.device.name}: ${result.device.os.name} (${result.device.ceLabel}${result.device.os.language ? `, ${result.device.os.language}` : ""}), ${machineLabel(result.device.machine)}, ROM ${result.device.rom}`;
    list.append(facts);
    for (const item of result.checks) {
        const entry = document.createElement("li");
        entry.textContent = `${item.label}: ${STATUS_LABELS[item.status]}. ${item.summary}.`;
        for (const detail of item.details) {
            if (typeof detail === "string") {
                entry.append(` ${detail}`);
                continue;
            }
            entry.append(` ${detail.text} `);
            detail.names.forEach((name, index) => {
                if (index) entry.append(", ");
                const strong = document.createElement("strong");
                strong.textContent = name;
                entry.append(strong);
            });
        }
        list.append(entry);
    }
    cell.append(list);
}

function renderMatrix() {
    const body = elements.devices;
    const binary = state.binaries[state.selected];
    if (!binary) {
        emptyRow(body, 2 + CHECK_COLUMNS.length, "Pick a binary to check it.");
        return;
    }
    const results = visibleResults().sort((left, right) => left.device.ce - right.device.ce || left.device.os.name.localeCompare(right.device.os.name) || left.device.name.localeCompare(right.device.name));
    if (!results.length) {
        emptyRow(body, 2 + CHECK_COLUMNS.length, "No devices match.");
        setStatus(`${binary.name}: no devices match the filters.`);
        return;
    }
    body.replaceChildren();
    const groups = new Map();
    for (const result of results) {
        const key = `${result.device.os.name} (${result.device.ceLabel}, ${machineLabel(result.device.machine)})`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(result);
    }
    for (const [label, members] of groups) {
        const header = body.insertRow();
        header.className = "group";
        const cell = header.insertCell();
        cell.colSpan = 2 + CHECK_COLUMNS.length;
        cell.textContent = `${label}: ${countText(members)}`;
        for (const result of members) {
            const row = body.insertRow();
            row.tabIndex = 0;
            row.setAttribute("aria-expanded", String(state.expanded.has(result.device.id)));
            const name = row.insertCell();
            name.textContent = result.device.name;
            name.title = `${result.device.os.name}${result.device.os.language ? ` ${result.device.os.language}` : ""}, ${machineLabel(result.device.machine)}`;
            statusCell(row, result.status, STATUS_LABELS[result.status]);
            const byId = new Map(result.checks.map((item) => [item.id, item]));
            for (const id of CHECK_COLUMNS) {
                const item = byId.get(id);
                if (item) statusCell(row, item.status, item.summary, item.details.map(detailText).join(" "));
                else statusCell(row, null, "");
            }
            const toggle = () => {
                if (state.expanded.has(result.device.id)) state.expanded.delete(result.device.id);
                else state.expanded.add(result.device.id);
                renderMatrix();
            };
            row.addEventListener("click", toggle);
            row.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                }
            });
            if (state.expanded.has(result.device.id)) renderDetails(body, result);
        }
    }
    setStatus(`${binary.name} on ${results.length} device${results.length === 1 ? "" : "s"}: ${countText(results)}.`);
}

async function openFile(file) {
    setStatus(`Unpacking ${file.name}...`);
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(file.size);
    state.results = [];
    state.selected = -1;
    renderMatrix();
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const [unpacked] = await unpackFiles([file]);
        const files = await Promise.all(unpacked.files.map(async (entry) => ({ path: entry.path, data: await fileData(entry) })));
        if (unpacked.data && isPe(unpacked.data) && !files.some((entry) => entry.data === unpacked.data)) files.push({ path: file.name, data: unpacked.data });
        state.binaries = packageBinaries(file.name, files).sort((left, right) => Number(left.dll) - Number(right.dll) || left.path.localeCompare(right.path));
        renderBinaries();
        if (state.binaries.length) await selectBinary(0);
        else setStatus(`No Windows CE programs or DLLs in ${file.name}.`);
    } catch (error) {
        state.binaries = [];
        renderBinaries();
        setStatus(`Couldn't read ${file.name}: ${error.message}`);
    }
}

function setup() {
    elements.drop.addEventListener("click", () => elements["file-input"].click());
    elements.drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            elements["file-input"].click();
        }
    });
    elements["file-input"].addEventListener("change", () => {
        if (elements["file-input"].files[0]) openFile(elements["file-input"].files[0]);
    });
    elements.drop.addEventListener("dragover", (event) => {
        event.preventDefault();
        elements.drop.classList.add("over");
    });
    elements.drop.addEventListener("dragleave", () => elements.drop.classList.remove("over"));
    elements.drop.addEventListener("drop", (event) => {
        event.preventDefault();
        elements.drop.classList.remove("over");
        if (event.dataTransfer.files[0]) openFile(event.dataTransfer.files[0]);
    });
    for (const id of ["family", "show"]) elements[id].addEventListener("change", renderMatrix);
    elements.search.addEventListener("input", renderMatrix);
    setupDesktop({ readmeKey: "cem-compat-readme" });
    Promise.all([loadJson("data/compat/devices.json"), loadPorter()])
        .then(([devices, porter]) => {
            state.devices = devices;
            state.porter = porter;
            const readable = devices.filter((device) => !device.error).length;
            setStatus(`${readable} device ROMs loaded. Open a program to check it.`);
        })
        .catch((error) => setStatus(`Couldn't load the device tables: ${error.message}`));
}

setup();
