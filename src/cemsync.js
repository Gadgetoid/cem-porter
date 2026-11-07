import { BeLink, isSupported, NAND_BASE, NAND_TOTAL, SECTOR } from "./belink.js";
import { looksLikeCbea, readCbea, cbeaPlatform } from "./cbea.js";
import { planInstall } from "./cbeainstall.js";
import { unpackFiles, fileData } from "./unpack.js";
import { saveBytes, setupDesktop } from "./desktop.js";

const TARGETS = [
    {
        id: "be300",
        name: "Casio BE-300",
        link: "PC Connect over USB",
        vendor: 0x07cf,
        product: 0x2002,
        installRoot: "\\Nand Disk",
        nand: { base: NAND_BASE, total: NAND_TOTAL },
        can: { install: true, send: true, backup: true, reset: true },
    },
];

function targetFor(device) {
    return TARGETS.find((entry) =>
        entry.vendor === device.vendorId && entry.product === device.productId) || null;
}

const elements = Object.fromEntries([
    "connect", "disconnect", "status", "size",
    "drop", "drop-title", "drop-hint", "file-input",
    "info", "members", "install", "progress", "progress-box", "log", "log-panel",
    "connect-panel", "device-panel", "package-panel", "device-legend", "supported",
    "tools-button", "tools-menu", "tool-files", "tool-backup", "tool-reset", "tool-log",
    "connect", "disconnect", "drop", "drop-title", "drop-hint", "file-input", "status", "size",
    "browser", "browser-title", "browser-path", "browser-list", "browser-up", "browser-close",
    "browser-refresh", "browser-upload", "browser-download", "browser-status",
].map((id) => [id, document.getElementById(id)]));

const state = { link: null, target: null, file: null, packages: [] };

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
    const can = (state.target && state.target.can) || {};
    elements["connect-panel"].hidden = connected;
    elements["device-panel"].hidden = !connected;
    elements["tool-backup"].disabled = !connected || !can.backup;
    elements["tool-reset"].disabled = !connected || !can.reset;
    elements["tool-files"].disabled = !connected || !can.send;
    elements["package-panel"].hidden = connected && !can.install;
    elements.install.disabled = !connected || !can.install || !state.file;
    elements["device-legend"].textContent = state.target ? state.target.name : "Device";
}

function renderSupported() {
    elements.supported.innerHTML = "";
    for (const entry of TARGETS) {
        const row = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = entry.name;
        const link = document.createElement("td");
        link.className = "hide-narrow";
        link.textContent = entry.link;
        row.append(name, link);
        elements.supported.appendChild(row);
    }
}

function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progress.style.width = `${value}%`;
    elements["progress-box"].setAttribute("aria-valuenow", String(value));
}

function setBusy(busy) {
    document.body.classList.toggle("busy", busy);
    elements.drop.classList.toggle("busy", busy);
}

function settle() {
    return new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function showTools(open) {
    elements["tools-menu"].hidden = !open;
    elements["tools-button"].setAttribute("aria-expanded", String(open));
}

function renderInfo(info) {
    const rows = [
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
    link.filters = TARGETS.map((entry) => ({ vendorId: entry.vendor, productId: entry.product }));
    try {
        setStatus("Choose the device...");
        const device = await link.request();
        state.target = targetFor(device);
        if (!state.target) throw new Error("that device is not one CEMSync knows");
        log(`${state.target.name} chosen`);
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
        state.target = null;
        setConnected(false);
    }
}

async function disconnect() {
    if (state.link) await state.link.close();
    state.link = null;
    state.target = null;
    state.packages = [];
    state.file = null;
    renderPackages();
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
    renderPackages();

    const list = [...files];
    const total = list.reduce((sum, file) => sum + file.size, 0);
    const label = list.length === 1 ? list[0].name : `${list.length} files`;
    elements["drop-title"].textContent = `Reading ${label}...`;
    elements["drop-hint"].textContent = total > 4 * 1048576
        ? `${formatSize(total)} - this can take a moment`
        : formatSize(total);
    setStatus(`Reading ${label}...`);
    setProgress(5);
    setBusy(true);
    await settle();

    try {
        for (const [index, file] of list.entries()) {
            setStatus(`Opening ${file.name} (${index + 1} of ${list.length})...`);
            setProgress(5 + (index / list.length) * 80);
            await settle();
            const [result] = await unpackFiles([file]);
            const direct = new Uint8Array(await file.arrayBuffer());
            if (looksLikeCbea(direct)) {
                await addPackage(file.name, direct);
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

    setBusy(false);
    setProgress(100);
    elements["drop-title"].textContent = label;
    if (!state.packages.length) {
        elements["drop-hint"].textContent = "No .cbea packages inside";
        log(`no .cbea packages found in ${label}`);
        setStatus("No packages found");
    } else {
        elements["drop-hint"].textContent =
            `${state.packages.length} package${state.packages.length === 1 ? "" : "s"} found`;
        log(`found ${state.packages.length} package(s) in ${label}`);
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

const listingCache = new Map();
let browser = { path: "\\", selected: null };

function browserStatus(text) {
    elements["browser-status"].textContent = text || "\u00a0";
}

function openBrowser() {
    elements.browser.hidden = false;
    browser.path = state.target.installRoot;
    showListing();
}

async function showListing({ refresh = false } = {}) {
    const path = browser.path || "\\";
    elements["browser-path"].textContent = path;
    elements["browser-up"].disabled = path === "\\";
    browser.selected = null;
    elements["browser-download"].disabled = true;

    if (refresh) listingCache.delete(path);
    let entries = listingCache.get(path);
    if (!entries) {
        renderListing(null);
        browserStatus("Reading...");
        try {
            entries = await state.link.listDirectory(path);
            listingCache.set(path, entries);
        } catch (error) {
            browserStatus(error.message);
            renderListing([]);
            return;
        }
    }
    renderListing(entries);
    const files = entries.filter((entry) => !entry.directory).length;
    const dirs = entries.length - files;
    browserStatus(`${dirs} folder${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`);
}

function renderListing(entries) {
    const body = elements["browser-list"];
    body.innerHTML = "";
    if (entries === null) {
        body.appendChild(emptyRow("Reading..."));
        return;
    }
    if (!entries.length) {
        body.appendChild(emptyRow("Empty"));
        return;
    }
    for (const entry of entries) {
        const row = document.createElement("tr");
        row.tabIndex = 0;
        const name = document.createElement("td");
        name.className = entry.directory ? "name folder" : "name file";
        name.textContent = entry.name;
        const size = document.createElement("td");
        size.className = "right";
        size.textContent = entry.directory ? "" : formatSize(entry.size);
        row.append(name, size);
        row.addEventListener("click", () => {
            if (entry.directory) {
                browser.path = join(browser.path, entry.name);
                showListing();
                return;
            }
            browser.selected = entry;
            elements["browser-download"].disabled = false;
            for (const other of body.children) other.classList.remove("selected");
            row.classList.add("selected");
        });
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); row.click(); }
        });
        body.appendChild(row);
    }
}

function emptyRow(text) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = 2;
    cell.textContent = text;
    row.appendChild(cell);
    return row;
}

function join(base, name) {
    return `${base.replace(/\\+$/, "")}\\${name}`;
}

async function uploadHere() {
    const [file] = await pickFile();
    if (!file) return;
    const path = join(browser.path, file.name);
    try {
        elements["browser-upload"].disabled = true;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await state.link.sendFile(path, bytes, (sent, total) => {
            browserStatus(`Sending ${formatSize(sent)} of ${formatSize(total)}`);
            setProgress((sent / total) * 100);
        });
        browserStatus(`Sent ${file.name}`);
        log(`uploaded ${path}`);
        listingCache.delete(browser.path);
        showListing();
    } catch (error) {
        browserStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements["browser-upload"].disabled = false;
    }
}

async function downloadSelected() {
    if (!browser.selected) return;
    const entry = browser.selected;
    const path = join(browser.path, entry.name);
    try {
        elements["browser-download"].disabled = true;
        const bytes = await state.link.receiveFile(path, entry.size, (got, total) => {
            browserStatus(`Reading ${formatSize(got)}${total ? ` of ${formatSize(total)}` : ""}`);
            if (total) setProgress((got / total) * 100);
        });
        saveBytes(bytes, entry.name);
        browserStatus(`Saved ${entry.name}`);
        log(`downloaded ${path} (${bytes.length} bytes)`);
    } catch (error) {
        browserStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements["browser-download"].disabled = false;
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
elements["browser-close"].addEventListener("click", () => { elements.browser.hidden = true; });
elements["browser-refresh"].addEventListener("click", () => showListing({ refresh: true }));
elements["browser-upload"].addEventListener("click", uploadHere);
elements["browser-download"].addEventListener("click", downloadSelected);
elements["browser-up"].addEventListener("click", () => {
    const cut = browser.path.replace(/\\+$/, "").lastIndexOf("\\");
    browser.path = cut > 0 ? browser.path.slice(0, cut) : "\\";
    showListing();
});
elements["tool-files"].addEventListener("click", () => { showTools(false); openBrowser(); });
elements["tool-backup"].addEventListener("click", () => { showTools(false); backup(); });
elements["tool-reset"].addEventListener("click", () => { showTools(false); softReset(); });
elements["tool-log"].addEventListener("click", () => {
    const shown = elements["log-panel"].hidden;
    elements["log-panel"].hidden = !shown;
    elements["tool-log"].innerHTML = shown ? "Hide <u>L</u>og" : "<u>L</u>og";
    showTools(false);
});
document.addEventListener("click", (event) => {
    if (!elements["tools-menu"].hidden
        && !elements["tools-menu"].contains(event.target)
        && event.target !== elements["tools-button"]) showTools(false);
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements["tools-menu"].hidden) {
        showTools(false);
        elements["tools-button"].focus();
    }
});
elements["tools-button"].addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
        event.preventDefault();
        showTools(true);
        elements["tools-menu"].querySelector("button:not(:disabled)")?.focus();
    }
});


renderPackages();
renderSupported();
setConnected(false);
setStatus(isSupported() ? "Ready. Connect the cradle and press Connect." : "No WebUSB: use Chrome or Edge.");
