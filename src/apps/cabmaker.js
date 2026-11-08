import { zipSync } from "../../vendor/fflate.js";
import { unpackFiles } from "../archive/unpack.js";
import { findBuilds, loadPlanSources } from "../port/analyze.js";
import { buildCab, buildSelfInstaller } from "../port/convert.js";
import { fetchBytes } from "../port/assets.js";
import { safeFolderName } from "../port/installplan.js";
import { saveBytes, setupDesktop } from "../ui/desktop.js";

const elements = Object.fromEntries(["drop", "drop-title", "drop-hint", "file-input", "cabs", "save-all", "status", "size"].map((id) => [id, document.getElementById(id)]));
const state = { name: "", rows: [] };
const KIND_LABELS = { cab: "As shipped", load: "Built from .load script", files: "Built from program files" };
const STUB_CPUS = ["mips", "sh3", "arm"];
const readBytes = fetchBytes(new URL("../../", import.meta.url));
const stubs = new Map();

function setStatus(text) {
    elements.status.textContent = text;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function leafName(path) {
    return path.split(/[\\/]/).pop();
}

function cpuLabel(build) {
    return String(build.cpu ?? "?").toUpperCase();
}

function stubFor(cpu) {
    if (!stubs.has(cpu)) stubs.set(cpu, readBytes(`data/${cpu}/ceinstall.exe`));
    return stubs.get(cpu);
}

function unported(plan, sources) {
    const files = new Map();
    const missing = [];
    for (const operation of plan.operations) {
        if (operation.kind !== "file") continue;
        const data = sources.get(operation.source);
        if (data) files.set(operation, data);
        else missing.push(leafName(operation.path));
    }
    const setupDlls = (plan.setupDlls ?? []).filter((setupDll) => sources.has(setupDll.source)).map((setupDll) => ({ ...setupDll, data: sources.get(setupDll.source) }));
    return { ported: { files, support: [], setupDlls, modulePaths: new Set(), reports: [] }, missing };
}

function output(name, make, size = null) {
    let data = null;
    return { name, size, make: async () => (data ??= await make()) };
}

function shippedRow(build, container) {
    return { build, notes: [], outputs: [output(leafName(container.name), () => container.data, container.data.length)] };
}

function builtRow(build, files) {
    const plan = build.plan();
    const paths = new Set(files.map((file) => file.path));
    const missing = plan.operations.filter((operation) => operation.kind === "file" && !paths.has(operation.source)).map((operation) => leafName(operation.path));
    let loading = null;
    const ported = () => (loading ??= loadPlanSources(plan, files).then((sources) => unported(plan, sources).ported));
    const notes = [...plan.warnings, ...missing.map((name) => `${name} missing from the package`)];
    const stubCpu = String(build.cpu).toLowerCase();
    const hasStub = STUB_CPUS.includes(stubCpu);
    if (build.ce < 2) notes.push(hasStub ? "CE 1.0 has no CAB installer; use Setup" : "CE 1.0 has no CAB installer");
    if (plan.setupDlls?.length > 1) notes.push(`a CAB holds one setup DLL: ${plan.setupDlls[0].app}'s runs`);
    const base = safeFolderName(build.title.replace(/\.d\b/g, ""));
    const outputs = [output(`${base}.${cpuLabel(build)}.CAB`, async () => buildCab(plan, await ported(), { cpu: build.cpu }))];
    if (hasStub) outputs.push(output(`${base} Setup.${cpuLabel(build)}.exe`, async () => buildSelfInstaller(plan, await ported(), { cpu: stubCpu }, { stub: { [stubCpu]: await stubFor(stubCpu) } })));
    return { build, notes, outputs };
}

function rowsFor(name, unpacked) {
    const files = unpacked.files;
    const containers = new Map(unpacked.log.map((entry) => [entry.container.toLowerCase(), entry]));
    const rows = [];
    const problems = [];
    for (const build of findBuilds(name, files)) {
        if (build.merged) continue;
        try {
            const container = build.kind === "cab" ? containers.get(build.source.toLowerCase()) : null;
            rows.push(container ? shippedRow(build, container) : builtRow(build, files));
        } catch (error) {
            problems.push(`${build.title}: ${error.message}`);
        }
    }
    return { rows, problems };
}

function cell(row, text, className) {
    const td = row.insertCell();
    td.textContent = text;
    if (className) td.className = className;
    return td;
}

function emptyRow(text) {
    const body = elements.cabs;
    body.replaceChildren();
    const td = cell(body.insertRow(), text, "empty");
    td.colSpan = 6;
}

async function make(row, item) {
    try {
        const data = await item.make();
        item.size = data.length;
        return data;
    } catch (error) {
        row.notes.push(`couldn't build ${item.name}: ${error.message}`);
        return null;
    }
}

async function save(row, item) {
    const data = await make(row, item);
    renderRows();
    if (!data) {
        setStatus(`Couldn't make ${item.name}.`);
        return;
    }
    saveBytes(data, item.name);
    setStatus(`Saved ${item.name} (${formatSize(data.length)}).`);
}

function renderRows() {
    if (!state.rows.length) {
        emptyRow(state.name ? "No Windows CE programs found in this package." : "Open a package to see its CABs.");
        return;
    }
    const body = elements.cabs;
    body.replaceChildren();
    for (const row of state.rows) {
        const tr = body.insertRow();
        const program = row.build.title;
        const name = tr.insertCell();
        name.className = "path";
        name.append(row.outputs[0].name);
        for (const note of row.notes) {
            const span = document.createElement("span");
            span.className = "problem";
            span.textContent = note;
            name.append(document.createElement("br"), span);
        }
        cell(tr, program, "hide-narrow");
        cell(tr, cpuLabel(row.build));
        cell(tr, row.build.ceLabel || "");
        cell(tr, KIND_LABELS[row.build.kind], "hide-narrow");
        const action = tr.insertCell();
        action.className = "size";
        row.outputs.forEach((item, index) => {
            const button = document.createElement("button");
            button.type = "button";
            const label = index ? "Setup" : "Save";
            button.textContent = item.size === null ? label : `${label} (${formatSize(item.size)})`;
            button.setAttribute("aria-label", `Save ${item.name}`);
            button.addEventListener("click", () => save(row, item));
            if (index) action.append(" ");
            action.append(button);
        });
    }
}

function uniqueNames(items) {
    const used = new Set();
    return items.map((item) => {
        let name = item.name;
        for (let number = 2; used.has(name.toLowerCase()); number++) name = item.name.replace(/(\.[^.]*)?$/, ` (${number})$1`);
        used.add(name.toLowerCase());
        return name;
    });
}

function saveAll() {
    setStatus("Making a zip of every CAB...");
    setTimeout(async () => {
        const items = state.rows.flatMap((row) => row.outputs.map((item) => ({ row, item })));
        const names = uniqueNames(items.map(({ item }) => item));
        const entries = {};
        for (const [index, { row, item }] of items.entries()) {
            const data = await make(row, item);
            if (data) entries[names[index]] = [data, { level: 0 }];
        }
        renderRows();
        const name = `${state.name.replace(/\.[^.]*$/, "") || "cabs"} CABs.zip`;
        const data = zipSync(entries);
        saveBytes(data, name);
        const count = Object.keys(entries).length;
        setStatus(`Saved ${name}: ${count} file${count === 1 ? "" : "s"}, ${formatSize(data.length)}.`);
    }, 0);
}

async function openFiles(files) {
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    setStatus(`Unpacking ${label}...`);
    elements["drop-title"].textContent = label;
    elements["drop-hint"].textContent = formatSize(total);
    elements.size.textContent = " ";
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const results = await unpackFiles(files);
        const rows = [];
        const problems = [];
        for (const [index, result] of results.entries()) {
            const found = rowsFor(files[index].name, result);
            rows.push(...found.rows);
            problems.push(...found.problems);
        }
        Object.assign(state, { name: files[0].name, rows });
        renderRows();
        const shipped = rows.filter((row) => row.build.kind === "cab").length;
        const built = rows.length - shipped;
        const counts = [shipped ? `${shipped} shipped` : "", built ? `${built} to build` : ""].filter(Boolean).join(", ");
        setStatus(rows.length ? `${rows.length} CAB${rows.length === 1 ? "" : "s"}: ${counts}.${problems.length ? ` Problems: ${problems.join("; ")}.` : ""}` : `No Windows CE programs in ${label}.`);
    } catch (error) {
        Object.assign(state, { name: files[0].name, rows: [] });
        renderRows();
        setStatus(`Couldn't read ${label}: ${error.message}`);
    }
    elements["save-all"].disabled = !state.rows.length;
}

function setup() {
    const pick = () => elements["file-input"].click();
    elements.drop.addEventListener("click", pick);
    elements.drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick();
        }
    });
    elements["file-input"].addEventListener("change", () => {
        if (elements["file-input"].files.length) openFiles([...elements["file-input"].files]);
        elements["file-input"].value = "";
    });
    elements.drop.addEventListener("dragover", (event) => {
        event.preventDefault();
        elements.drop.classList.add("over");
    });
    elements.drop.addEventListener("dragleave", () => elements.drop.classList.remove("over"));
    elements.drop.addEventListener("drop", (event) => {
        event.preventDefault();
        elements.drop.classList.remove("over");
        if (event.dataTransfer.files.length) openFiles([...event.dataTransfer.files]);
    });
    elements["save-all"].addEventListener("click", saveAll);
    setupDesktop({ readmeKey: "cab-maker-readme" });
    setStatus("Ready.");
}

setup();
