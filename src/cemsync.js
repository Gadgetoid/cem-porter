import { BeLink, isSupported, NAND_BASE, NAND_TOTAL, SECTOR } from "./belink.js";
import { looksLikeCbea, readCbea, cbeaPlatform } from "./cbea.js";
import { planInstall } from "./cbeainstall.js";
import { unpackFiles, fileData } from "./unpack.js";
import { saveBytes, setupDesktop } from "./desktop.js";

const TARGETS = {
    be300: {
        name: "Casio BE-300",
        vendor: 0x07cf,
        product: 0x2002,
        installRoot: "\\Nand Disk",
        nand: { base: NAND_BASE, total: NAND_TOTAL },
    },
};

const elements = Object.fromEntries([
    "connect", "disconnect", "status", "size", "target",
    "drop", "drop-title", "drop-hint", "file-input",
    "info", "members", "install", "progress", "progress-box", "log", "log-panel",
    "tools-button", "tools-menu", "tool-send", "tool-backup", "tool-reset", "tool-log",
].map((id) => [id, document.getElementById(id)]));

const state = { link: null, target: TARGETS.be300, file: null, packages: [] };

function setStatus(text) {
    elements.status.textContent = text;
}

function log(text) {
    const line = document.createElement("div");
    line.textContent = text;
    elements.log.appendChild(line);
    elements.log.scrollTop = elements.log.scrollHeight;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function setConnected(connected) {
    elements.connect.disabled = connected;
    elements.disconnect.disabled = !connected;
    elements["tool-backup"].disabled = !connected;
    elements["tool-reset"].disabled = !connected;
    elements["tool-send"].disabled = !connected;
    elements.install.disabled = !connected || !state.file;
}

function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progress.style.width = `${value}%`;
    elements["progress-box"].setAttribute("aria-valuenow", String(value));
}

function showTools(open) {
    elements["tools-menu"].hidden = !open;
    elements["tools-button"].setAttribute("aria-expanded", String(open));
}

function renderInfo(info) {
    const rows = [
        ["Device", state.target.name],
        ["Unit ID", info.uuid || "unknown"],
        ["RAPI version", info.version === undefined ? "unknown" : `0x${info.version.toString(16)}`],
        ["System disk", info.systemDisk || "unknown"],
        ["User disk", info.userDisk || "unknown"],
    ];
    elements.info.innerHTML = "";
    for (const [label, value] of rows) {
        const row = document.createElement("tr");
        const head = document.createElement("th");
        head.scope = "row";
        head.textContent = label;
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(head, cell);
        elements.info.appendChild(row);
    }
}

function renderPackages() {
    elements.members.innerHTML = "";
    if (!state.packages.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "empty";
        cell.colSpan = 2;
        cell.colSpan = 4;
        cell.textContent = "Drop an installer, archive, CD image or .cbea.";
        row.appendChild(cell);
        elements.members.appendChild(row);
        return;
    }
    for (const [index, entry] of state.packages.entries()) {
        const row = document.createElement("tr");
        if (state.file === entry) row.className = "selected";
        const name = document.createElement("td");
        name.textContent = entry.name;
        const program = document.createElement("td");
        program.textContent = entry.info.Program || "";
        const version = document.createElement("td");
        version.textContent = entry.info.Version || "";
        const size = document.createElement("td");
        size.textContent = formatSize(entry.bytes.length);
        row.append(name, program, version, size);
        row.tabIndex = 0;
        row.addEventListener("click", () => select(index));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select(index);
            }
        });
        elements.members.appendChild(row);
    }
}

async function connect() {
    if (!isSupported()) {
        setStatus("This browser has no WebUSB. Use Chrome or Edge.");
        return;
    }
    const link = new BeLink();
    link.onLog = log;
    try {
        setStatus("Choose the device...");
        await link.request();
        setStatus("Connecting...");
        await link.connect();
        state.link = link;
        setConnected(true);
        setStatus("Connected");
        const info = await link.deviceInfo();
        link.startHeartbeat();
        log("heartbeat started, link held open");
        try {
            Object.assign(info, await link.diskNames());
        } catch (error) {
            log(`disk names unavailable: ${error.message}`);
        }
        renderInfo(info);
        log(`unit ${info.uuid || "?"}`);
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
        await link.close();
        state.link = null;
        setConnected(false);
    }
}

async function disconnect() {
    if (state.link) await state.link.close();
    state.link = null;
    setConnected(false);
    setStatus("Disconnected");
}

async function addPackage(name, bytes) {
    let info = {};
    let plan = null;
    try {
        plan = planInstall(readCbea(bytes));
        info = plan.info;
    } catch {
        // a .cbea we cannot plan is still installable by the device
    }
    state.packages.push({ name, bytes, info, plan });
}

async function loadFiles(files) {
    state.packages = [];
    state.file = null;
    setStatus(`Opening ${files.length === 1 ? files[0].name : `${files.length} files`}...`);
    try {
        const results = await unpackFiles([...files]);
        for (const [index, result] of results.entries()) {
            const direct = new Uint8Array(await files[index].arrayBuffer());
            if (looksLikeCbea(direct)) {
                await addPackage(files[index].name, direct);
                continue;
            }
            for (const entry of result.log || []) {
                if (!/cbea/i.test(entry.method || "")) continue;
                const data = await fileData(entry);
                if (!data || !looksLikeCbea(data)) continue;
                await addPackage(entry.name || entry.container, data);
            }
        }
    } catch (error) {
        log(`could not open: ${error.message}`);
    }
    if (!state.packages.length) {
        log("no .cbea packages found in that file");
        setStatus("No packages found");
    } else {
        log(`found ${state.packages.length} package(s)`);
        setStatus(`${state.packages.length} package(s) found`);
        select(0);
    }
    renderPackages();
    setConnected(!!state.link);
}

function select(index) {
    state.file = state.packages[index] || null;
    if (!state.file) return;
    elements.size.textContent = formatSize(state.file.bytes.length);
    const plan = state.file.plan;
    if (plan) {
        const bits = [`${plan.copies.length} file${plan.copies.length === 1 ? "" : "s"}`];
        if (plan.dirs.length) bits.push(`${plan.dirs.length} folders`);
        if (plan.registry.length) bits.push(`${plan.registry.length} registry entries`);
        log(`${state.file.name}: ${plan.info.Program || "?"} ${plan.info.Version || ""} - ${bits.join(", ")} into ${plan.installDir}`);
        if (plan.missing.length) log(`  warning: ${plan.missing.length} member(s) named by the INF are not in the package`);
    } else {
        log(`${state.file.name}: selected`);
    }
    renderPackages();
    setConnected(!!state.link);
}

async function send() {
    if (!state.link) return;
    const [file] = await pickFile();
    if (!file) return;
    const folder = state.target.installRoot;
    const path = `${folder}\\${file.name}`;
    state.file = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    log(`sending ${formatSize(state.file.bytes.length)} to ${path}`);
    try {
        elements["tool-send"].disabled = true;
        setStatus(`Sending ${state.file.name}...`);
        await state.link.sendFile(path, state.file.bytes, (sent, total) => {
            setProgress((sent / total) * 100);
            setStatus(`Sending ${formatSize(sent)} of ${formatSize(total)}`);
        });
        setProgress(100);
        setStatus(`Sent to ${path}`);
        log(`wrote ${path}`);
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements["tool-send"].disabled = false;
    }
}

async function backup() {
    if (!state.link) return;
    const link = state.link;
    const { base, total } = state.target.nand;
    const BATCH = 32;
    try {
        elements["tool-backup"].disabled = true;
        const handle = await link.nandOpen();
        const info = await link.nandInfo(handle);
        log(`NAND window ${info.sectors} sectors of ${info.sectorSize} bytes, base ${base}`);
        const image = new Uint8Array(total * SECTOR);
        for (let sector = 0; sector < total; sector += BATCH) {
            const count = Math.min(BATCH, total - sector);
            const data = await link.readSectors(handle, sector, count);
            image.set(data, sector * SECTOR);
            setProgress((sector / total) * 100);
            if (sector % 4096 === 0) setStatus(`Reading sector ${sector} of ${total}`);
        }
        await link.call(0x0340, new Uint8Array([
            (handle >>> 24) & 0xff, (handle >>> 16) & 0xff,
            (handle >>> 8) & 0xff, handle & 0xff,
        ]));
        setProgress(100);
        saveBytes(image, "be300-full-nand.bin");
        setStatus(`Saved ${formatSize(image.length)}`);
        log("full NAND backup saved");
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements["tool-backup"].disabled = false;
    }
}

async function install() {
    if (!state.link || !state.file) return;
    try {
        elements.install.disabled = true;
        setStatus("Staging package...");
        setProgress(10);
        const reply = await state.link.installPackage(state.file.bytes);
        setProgress(100);
        log(`CoInstall.exe dispatched (ret=0x${reply.ret.toString(16)})`);
        setStatus("CoInstall is running on the device; follow the prompts there");
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements.install.disabled = false;
    }
}

function pickFile() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.addEventListener("change", () => resolve([...input.files]), { once: true });
        input.click();
    });
}

function setupDrop() {
    const open = () => elements["file-input"].click();
    elements.drop.addEventListener("click", open);
    elements.drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
        }
    });
    elements["file-input"].addEventListener("change", () => {
        if (elements["file-input"].files.length) loadFiles(elements["file-input"].files);
    });
    for (const name of ["dragenter", "dragover"]) {
        elements.drop.addEventListener(name, (event) => {
            event.preventDefault();
            elements.drop.classList.add("over");
        });
    }
    for (const name of ["dragleave", "drop"]) {
        elements.drop.addEventListener(name, (event) => {
            event.preventDefault();
            elements.drop.classList.remove("over");
        });
    }
    elements.drop.addEventListener("drop", (event) => {
        if (event.dataTransfer.files.length) loadFiles(event.dataTransfer.files);
    });
}

setupDesktop({ readmeKey: "cemsync-readme" });
setupDrop();
elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", disconnect);


elements.install.addEventListener("click", install);
elements["tools-button"].addEventListener("click", () => showTools(elements["tools-menu"].hidden));
elements["tool-send"].addEventListener("click", () => { showTools(false); send(); });
elements["tool-backup"].addEventListener("click", () => { showTools(false); backup(); });
elements["tool-reset"].addEventListener("click", () => { showTools(false); softReset(); });
elements["tool-log"].addEventListener("click", () => {
    const shown = elements["log-panel"].hidden;
    elements["log-panel"].hidden = !shown;
    elements["tool-log"].textContent = shown ? "Hide log" : "Show log";
    showTools(false);
});
document.addEventListener("click", (event) => {
    if (!elements["tools-menu"].hidden
        && !elements["tools-menu"].contains(event.target)
        && event.target !== elements["tools-button"]) showTools(false);
});

elements.target.textContent = state.target.name;

renderPackages();
setConnected(false);
setStatus(isSupported() ? "Ready. Connect the cradle and press Connect." : "No WebUSB: use Chrome or Edge.");
