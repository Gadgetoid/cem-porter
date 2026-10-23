import { zipSync } from "../vendor/fflate.js";
import { loadAssets, fetchBytes } from "./assets.js";
import { unpack } from "./unpack.js";
import { isPe } from "./pe.js";
import { findBuilds, matchScore } from "./analyze.js";
import { DEVICES, deviceSettings, portPlan, buildCab, buildSelfInstaller, planOnCard } from "./convert.js";
import { safeFolderName } from "./installplan.js";
import { saveBytes, setupDesktop } from "./desktop.js";

const elements = Object.fromEntries(["drop", "drop-title", "drop-hint", "file-input", "builds", "contents", "select-all", "select-none", "on-card", "output", "ce-version", "device", "four-kb", "port", "save", "report", "status", "size"].map((id) => [id, document.getElementById(id)]));
const state = { assets: null, input: null, files: [], builds: [], selected: -1, output: null, plan: null, excluded: new Set() };
const KIND_LABELS = { cab: "CE CAB", load: "H/PC Explorer", files: "Program files" };

function setStatus(text) {
    elements.status.textContent = text;
}

function formatSize(bytes) {
    return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function device() {
    return elements.device.value;
}

function outputKind() {
    return elements.output.value;
}

function updateInstallerOptions() {
    elements["on-card"].disabled = outputKind() === "zip";
}

function cell(row, text, className) {
    const td = row.insertCell();
    td.textContent = text;
    if (className) td.className = className;
    return td;
}

function emptyRow(body, columns, text) {
    body.replaceChildren();
    const row = body.insertRow();
    const td = cell(row, text, "empty");
    td.colSpan = columns;
}

function renderBuilds() {
    const body = elements.builds;
    if (!state.builds.length) {
        emptyRow(body, 5, state.input ? "No MIPS or SH3 Windows CE programs found in this package." : "Open a package to see what's in it.");
        return;
    }
    body.replaceChildren();
    state.builds.forEach((build, index) => {
        const row = body.insertRow();
        row.className = "selectable" + (index === state.selected ? " selected" : "");
        row.tabIndex = 0;
        row.setAttribute("aria-selected", String(index === state.selected));
        cell(row, build.title);
        cell(row, KIND_LABELS[build.kind]);
        cell(row, (build.cpu ?? "?").toUpperCase());
        cell(row, build.ceLabel || "");
        cell(row, build.source, "hide-narrow");
        const choose = () => {
            state.selected = index;
            renderBuilds();
            loadPlan();
            updateButtons();
        };
        row.addEventListener("click", choose);
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose();
            }
        });
    });
}

function renderReport(result) {
    const body = elements.report;
    if (!result) {
        emptyRow(body, 2, "Nothing ported yet.");
        return;
    }
    body.replaceChildren();
    const lines = [];
    for (const report of result.reports) {
        const changes = [...report.notes.map((text) => ({ text, className: "note" })), ...report.problems.map((text) => ({ text, className: "problem" }))];
        if (!changes.length) changes.push({ text: "unchanged", className: "" });
        lines.push({ name: report.name, changes });
    }
    for (const support of result.support) lines.push({ name: support.path.split("\\").pop(), changes: [{ text: `added: ${support.title}`, className: "note" }] });
    for (const warning of result.warnings) lines.push({ name: "Package", changes: [{ text: warning, className: "problem" }] });
    for (const skipped of result.skipped) lines.push({ name: "Package", changes: [{ text: skipped, className: "" }] });
    for (const line of lines) {
        const row = body.insertRow();
        cell(row, line.name);
        const td = row.insertCell();
        line.changes.forEach((change, index) => {
            if (index) td.append(document.createElement("br"));
            const span = document.createElement("span");
            span.textContent = change.text;
            if (change.className) span.className = change.className;
            td.append(span);
        });
    }
    if (!lines.length) emptyRow(body, 2, "No files to port.");
}

function loadPlan() {
    const build = state.builds[state.selected];
    state.excluded = new Set();
    try {
        state.plan = build ? build.plan() : null;
    } catch (error) {
        state.plan = null;
        setStatus(`Couldn't read the install steps: ${error.message}`);
    }
    renderContents();
    clearOutput();
}

function planFiles() {
    return state.plan ? state.plan.operations.filter((operation) => operation.kind === "file") : [];
}

function renderContents() {
    const body = elements.contents;
    const files = planFiles();
    elements["select-all"].disabled = elements["select-none"].disabled = !files.length;
    if (!files.length) {
        emptyRow(body, 3, state.plan ? "This build installs no files." : "Pick a build to see its files.");
        return;
    }
    const sources = new Map(state.files.map((entry) => [entry.path, entry.data]));
    body.replaceChildren();
    for (const operation of files) {
        const row = body.insertRow();
        const check = row.insertCell();
        check.className = "check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !state.excluded.has(operation);
        box.setAttribute("aria-label", `Include ${operation.path}`);
        box.addEventListener("change", () => {
            if (box.checked) state.excluded.delete(operation);
            else state.excluded.add(operation);
            clearOutput();
        });
        check.append(box);
        cell(row, operation.path, "path");
        const data = sources.get(operation.source);
        cell(row, data ? formatSize(data.length) : "missing", "size");
    }
}

function setAll(included) {
    state.excluded = included ? new Set() : new Set(planFiles());
    renderContents();
    clearOutput();
}

function chosenPlan() {
    const plan = state.plan;
    const kept = plan.operations.filter((operation) => !state.excluded.has(operation));
    const excludedPaths = new Set([...state.excluded].map((operation) => operation.path.toLowerCase()));
    const withoutShortcuts = kept.filter((operation) => operation.kind !== "shortcut" || !excludedPaths.has(operation.target.replace(/^"|"$/g, "").toLowerCase()));
    const used = withoutShortcuts.filter((operation) => operation.kind === "file" || operation.kind === "shortcut").map((operation) => (operation.path ?? operation.link).toLowerCase());
    const operations = withoutShortcuts.filter((operation) => operation.kind !== "mkdir" || used.some((path) => path.startsWith(operation.path.toLowerCase() + "\\")));
    return Object.assign(Object.create(Object.getPrototypeOf(plan)), plan, { operations });
}

function updateButtons() {
    elements.port.disabled = !state.assets || state.selected < 0 || !state.plan || planFiles().length === state.excluded.size;
    elements.save.disabled = !state.output;
}

function sortBuilds() {
    const settings = DEVICES[device()];
    const chosen = state.builds[state.selected];
    state.builds.sort((first, second) => matchScore(second, settings) - matchScore(first, settings));
    state.selected = chosen ? state.builds.indexOf(chosen) : state.builds.length ? 0 : -1;
}

function applyDeviceDefaults() {
    const settings = DEVICES[device()];
    elements["four-kb"].checked = settings.fourKbPages;
    elements["four-kb"].disabled = settings.cpu !== "mips";
    const cab = elements.output.querySelector("option[value=cab]");
    cab.disabled = settings.ce === 1;
    if (outputKind() !== "zip") elements.output.value = settings.ce === 1 ? "setup" : "cab";
    updateInstallerOptions();
    if (state.builds.length) {
        sortBuilds();
        renderBuilds();
    }
    clearOutput();
}

function clearOutput() {
    state.output = null;
    renderReport(null);
    elements.size.textContent = " ";
    updateButtons();
}

async function openFile(file) {
    clearOutput();
    setStatus(`Unpacking ${file.name}...`);
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(file.size);
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const data = new Uint8Array(await file.arrayBuffer());
        const unpacked = unpack(file.name, data);
        const files = unpacked.files.map((entry) => ({ path: entry.path, data: entry.data }));
        if (isPe(data) && !files.some((entry) => entry.data === data)) files.push({ path: file.name, data });
        state.input = { name: file.name, data };
        state.files = files;
        state.builds = findBuilds(file.name, files);
        state.selected = -1;
        sortBuilds();
        renderBuilds();
        loadPlan();
        const methods = [...new Set(unpacked.log.map((entry) => entry.method))];
        setStatus(`${files.length} file${files.length === 1 ? "" : "s"}${methods.length ? `, unpacked: ${methods.join(", ")}` : ""}. ${state.builds.length} build${state.builds.length === 1 ? "" : "s"} found.`);
    } catch (error) {
        state.builds = [];
        renderBuilds();
        setStatus(`Couldn't read ${file.name}: ${error.message}`);
    }
    updateButtons();
}

function portSelected() {
    const build = state.builds[state.selected];
    const settings = { ...deviceSettings(device(), state.assets), fourKbPages: elements["four-kb"].checked };
    const kind = outputKind();
    const chosen = chosenPlan();
    const plan = elements["on-card"].checked && kind !== "zip" ? planOnCard(chosen, kind === "cab" ? "\\Storage Card" : "%CARD%") : chosen;
    const sources = new Map(state.files.map((entry) => [entry.path, entry.data]));
    const ported = portPlan(plan, sources, settings, state.assets);
    ported.warnings = [...plan.warnings];
    if (outputKind() === "cab" && ported.setupDlls.length > 1) ported.warnings.push(`A CAB holds one setup DLL: ${ported.setupDlls[0].app}'s runs, not ${ported.setupDlls.slice(1).map((setupDll) => setupDll.app).join(", ")}'s`);
    ported.skipped = plan.skipped;
    if (build.cpu !== settings.cpu) ported.warnings.unshift(`This build is ${String(build.cpu).toUpperCase()}; the target is ${settings.cpu.toUpperCase()}. Pick a ${settings.cpu.toUpperCase()} build.`);
    const base = safeFolderName(plan.title);
    let data;
    let name;
    if (kind === "cab") {
        data = buildCab(plan, ported, settings);
        name = `${base}.${settings.cpu.toUpperCase()}.CAB`;
    } else if (kind === "setup") {
        data = buildSelfInstaller(plan, ported, settings, state.assets);
        name = `${base} Setup.exe`;
    } else {
        const entries = {};
        for (const [operation, bytes] of ported.files) entries[operation.path.replace(/^\\/, "").replaceAll("\\", "/")] = bytes;
        for (const support of ported.support) entries[support.path.replace(/^\\/, "").replaceAll("\\", "/")] = support.data;
        data = zipSync(entries);
        name = `${base}.${settings.cpu}.zip`;
    }
    state.output = { data, name };
    renderReport(ported);
    const problems = ported.reports.reduce((count, report) => count + report.problems.length, 0) + ported.warnings.length;
    const missingDlls = [...new Set(ported.reports.flatMap((report) => report.problems.map((problem) => /^missing (\S+\.DLL)/.exec(problem)?.[1]).filter(Boolean)))];
    if (missingDlls.length) setStatus(`Won't run: missing ${missingDlls.join(", ")}.`);
    else setStatus(problems ? `Ported with ${problems} problem${problems === 1 ? "" : "s"}; see the report.` : `Ported. Save ${name}.`);
    elements.size.textContent = formatSize(data.length);
    updateButtons();
}

function save() {
    saveBytes(state.output.data, state.output.name);
}

function setup() {
    const fillDevices = (preferred) => {
        const version = Number(elements["ce-version"].value);
        elements.device.replaceChildren(...Object.entries(DEVICES).filter(([, settings]) => settings.ce === version).map(([key, settings]) => new Option(settings.label, key)));
        if (preferred && DEVICES[preferred]?.ce === version) elements.device.value = preferred;
    };
    elements["ce-version"].value = "2";
    fillDevices("velo-ce2");
    elements["ce-version"].addEventListener("change", () => {
        const current = DEVICES[device()];
        const sameMachine = Object.keys(DEVICES).find((key) => DEVICES[key].ce === Number(elements["ce-version"].value) && DEVICES[key].cpu === current.cpu && DEVICES[key].fourKbPages === current.fourKbPages);
        fillDevices(sameMachine);
        applyDeviceDefaults();
    });
    applyDeviceDefaults();
    elements.device.addEventListener("change", applyDeviceDefaults);
    elements["four-kb"].addEventListener("change", clearOutput);
    elements["on-card"].addEventListener("change", clearOutput);
    elements.output.addEventListener("change", () => {
        updateInstallerOptions();
        clearOutput();
    });
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
    elements.port.addEventListener("click", () => {
        try {
            portSelected();
        } catch (error) {
            setStatus(`Couldn't port: ${error.message}`);
        }
    });
    elements.save.addEventListener("click", save);
    elements["select-all"].addEventListener("click", () => setAll(true));
    elements["select-none"].addEventListener("click", () => setAll(false));
    setupDesktop({ readmeKey: "ce-porter-readme" });
    loadAssets(fetchBytes(new URL("../", import.meta.url)))
        .then((assets) => {
            state.assets = assets;
            setStatus("Ready.");
            updateButtons();
        })
        .catch((error) => setStatus(`Couldn't load tables: ${error.message}`));
}

setup();
