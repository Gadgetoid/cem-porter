import { BeLink, isSupported, NAND_BASE, NAND_TOTAL, SECTOR } from "../device/belink.js";
import { ActiveSyncLink, HKEY } from "../device/activesync.js";
import { RNDIS_TARGETS } from "../device/rndis.js";
import { PcLinkLink, PC_LINK_TARGETS } from "../device/pclink.js";
import { PACKAGE_KINDS, compatibility, findPackages, recognise } from "../device/packages.js";
import { unpackFiles, fileData } from "../archive/unpack.js";
import { saveBytes, setupDesktop } from "../ui/desktop.js";
import { formatValue, readRegistryFile, REGISTRY_TYPES, registryText } from "../rom/regfile.js";

function describePcLink(info) {
    return [
        ["Model", info.model],
        ["Platform", info.platform],
        ["OS", info.os],
        ["Processor", info.processor],
        ["Link", info.link],
    ].filter(([, value]) => value);
}

const TARGETS = [
    {
        id: "be300",
        name: "Casio BE-300",
        link: "PC Connect over USB",
        filters: [{ vendorId: 0x07cf, productId: 0x2002 }],
        createLink: () => new BeLink(),
        describe: (info) => [
            ["Unit ID", info.uuid || "unknown"],
            ["RAPI version", info.version === undefined ? "unknown" : `0x${info.version.toString(16)}`],
            ["System disk", info.systemDisk || "unknown"],
            ["User disk", info.userDisk || "unknown"],
        ],
        installRoot: "\\Nand Disk",
        packages: ["cbea"],
        nand: { base: NAND_BASE, total: NAND_TOTAL },
        can: { install: true, send: true, backup: true, reset: true },
    },
    {
        id: "wm5",
        name: "Windows Mobile 5 and 6 devices",
        link: "ActiveSync over USB",
        filters: RNDIS_TARGETS,
        createLink: () => new ActiveSyncLink(),
        describe: (info) => [
            ["Name", info.name],
            ["Model", info.model],
            ["Platform", info.platform],
            ["OS", info.os],
            ["Processor", info.processor],
        ],
        installRoot: "\\My Documents",
        packages: ["cab"],
        architectures: [2577],
        autoConnect: true,
        can: { install: true, send: true, backup: false, reset: false, registry: true },
    },
    {
        id: "jornada",
        name: "HP Jornada 720",
        link: "PC Link over USB: press Connect, then dock it",
        filters: PC_LINK_TARGETS,
        createLink: () => new PcLinkLink(),
        describe: describePcLink,
        installRoot: "\\My Documents",
        packages: ["cab"],
        can: { install: true, send: true, backup: false, reset: false },
    },
    {
        id: "serial",
        name: "Windows CE 1.0 to 3.0 devices",
        link: "PC Link over a serial cable",
        serial: true,
        createLink: () => new PcLinkLink(),
        describe: describePcLink,
        installRoot: "\\My Documents",
        packages: ["cab"],
        can: { install: true, send: true, backup: false, reset: false },
    },
];

function matches(filter, device) {
    if (filter.vendorId !== undefined) {
        return filter.vendorId === device.vendorId && filter.productId === device.productId;
    }
    const classes = [[device.deviceClass, device.deviceSubclass, device.deviceProtocol]];
    for (const iface of (device.configuration || device.configurations[0] || { interfaces: [] }).interfaces) {
        const alternate = iface.alternates[0];
        classes.push([alternate.interfaceClass, alternate.interfaceSubclass, alternate.interfaceProtocol]);
    }
    return classes.some(([code, subclass, protocol]) =>
        code === filter.classCode && subclass === filter.subclassCode && protocol === filter.protocolCode);
}

function targetFor(device) {
    return TARGETS.find((entry) => (entry.filters || []).some((filter) => matches(filter, device))) || null;
}

const elements = Object.fromEntries([
    "connect", "connect-serial", "serial-baud", "disconnect", "status", "size",
    "drop", "drop-title", "drop-hint", "file-input",
    "info", "members", "install", "progress", "log", "log-panel",
    "connect-panel", "device-panel", "package-panel", "device-legend", "supported",
    "tools-button", "tools-menu", "tool-files", "tool-registry", "tool-backup", "tool-reset", "tool-log",
    "registry", "registry-path", "registry-up", "registry-refresh", "registry-close", "registry-list", "registry-status",
    "registry-value", "registry-value-title", "registry-value-type", "registry-value-data", "registry-value-close",
    "registry-copy", "registry-export", "registry-import", "registry-stop", "registry-confirm", "registry-confirm-text", "registry-confirm-cancel",
    "connect", "disconnect", "drop", "drop-title", "drop-hint", "file-input", "status", "size",
    "browser", "browser-title", "browser-path", "browser-list", "browser-up", "browser-close",
    "browser-refresh", "browser-upload", "browser-download", "browser-delete", "browser-status",
    "browser-mkdir", "browser-stop", "browser-new-folder", "browser-folder-name", "browser-folder-cancel",
    "browser-progress",
].map((id) => [id, document.getElementById(id)]));

const state = { link: null, target: null, device: null, file: null, packages: [], connecting: false, transfers: 0 };

function setStatus(text) {
    elements.status.textContent = text;
}

const LOG_LINES = 2000;
const pendingLog = [];

function log(text) {
    pendingLog.push(`${(performance.now() / 1000).toFixed(2)} ${text}`);
    if (pendingLog.length === 1) requestAnimationFrame(flushLog);
}

function flushLog() {
    const panel = elements.log;
    const following = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 8;
    const fragment = document.createDocumentFragment();
    for (const text of pendingLog.splice(0).slice(-LOG_LINES)) {
        const line = document.createElement("div");
        line.textContent = text;
        fragment.appendChild(line);
    }
    panel.appendChild(fragment);
    while (panel.childElementCount > LOG_LINES) panel.firstElementChild.remove();
    if (following) panel.scrollTop = panel.scrollHeight;
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
    elements["tool-registry"].disabled = !connected || !can.registry;
    elements["package-panel"].hidden = connected && !can.install;
    elements.install.disabled = !connected || !can.install || !state.file
        || !!compatibility(state.target, state.file, state.device);
    elements["device-legend"].textContent = state.target ? state.target.name : "Device";
}

function packageLabels() {
    return state.target.packages.map((kind) => PACKAGE_KINDS[kind].label).join(" or ");
}

function promptForPackage() {
    const labels = packageLabels();
    elements["drop-title"].textContent = `Drop an installer, archive or ${labels} here`;
    elements["drop-hint"].textContent = `.exe, .zip, .cab, .iso or ${labels}, with any extra volumes. Or tap to open.`;
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
    elements.progress.value = value;
}

function setBusy(busy) {
    document.body.setAttribute("aria-busy", String(busy));
}

function settle() {
    return new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function showTools(open) {
    elements["tools-menu"].hidden = !open;
    elements["tools-button"].setAttribute("aria-expanded", String(open));
}

function renderInfo(rows) {
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
        cell.colSpan = 4;
        cell.textContent = `Drop an installer, archive, CD image or ${state.target ? packageLabels() : "package"}.`;
        row.appendChild(cell);
        elements.members.appendChild(row);
        return;
    }
    for (const [index, entry] of state.packages.entries()) {
        const row = document.createElement("tr");
        row.setAttribute("aria-selected", String(state.file === entry));
        const name = document.createElement("td");
        name.textContent = entry.name;
        const program = document.createElement("td");
        program.textContent = entry.program;
        const version = document.createElement("td");
        version.textContent = entry.version;
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
    try {
        setStatus("Choose the device...");
        const device = await navigator.usb.requestDevice({
            filters: TARGETS.flatMap((entry) => entry.filters || []),
        });
        const target = targetFor(device);
        if (!target) throw new Error("that device is not one CEMSync knows");
        await start(target, (link) => { link.device = device; });
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    }
}

async function connectSerial() {
    if (!navigator.serial) {
        setStatus("This browser has no Web Serial. Use Chrome or Edge.");
        return;
    }
    try {
        setStatus("Choose the serial port...");
        const port = await navigator.serial.requestPort();
        setStatus("Start PC Link on the device...");
        const fixedBaud = Number(elements["serial-baud"].value) || null;
        await start(TARGETS.find((entry) => entry.serial), (link) => {
            link.port = port;
            link.fixedBaud = fixedBaud;
        });
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    }
}

async function start(target, attach) {
    if (state.connecting || state.link) {
        log(`${target.name}: already connecting`);
        return;
    }
    state.connecting = true;
    let link = null;
    state.target = target;
    try {
        log(`${state.target.name} chosen`);
        link = state.target.createLink();
        link.onLog = log;
        link.trace = new URLSearchParams(location.search).has("trace");
        attach(link);
        if (!state.target.serial) setStatus("Connecting...");
        await link.connect();
        state.link = link;
        if (new URLSearchParams(location.search).has("trace")) globalThis.ceLink = link;
        promptForPackage();
        renderPackages();
        setConnected(true);
        setStatus("Connected");
        const info = await link.deviceInfo();
        state.device = info;
        if (link.startHeartbeat) {
            link.startHeartbeat();
            log("heartbeat started, link held open");
        }
        if (link.diskNames) {
            try {
                Object.assign(info, await link.diskNames());
            } catch (error) {
                log(`disk names unavailable: ${error.message}`);
            }
        }
        renderInfo(state.target.describe(info));
        if (info.uuid) log(`unit ${info.uuid}`);
    } catch (error) {
        if (link) await link.close();
        state.link = null;
        state.target = null;
        state.device = null;
        setConnected(false);
        throw error;
    } finally {
        state.connecting = false;
    }
}

async function disconnect() {
    elements["registry-value"].close();
    elements.registry.close();
    registryCache.clear();
    registry.root = null;
    registry.path = "";
    if (state.link) await state.link.close();
    state.link = null;
    state.target = null;
    state.device = null;
    state.packages = [];
    state.file = null;
    renderPackages();
    setConnected(false);
    setStatus("Disconnected");
}

function addPackage(name, bytes) {
    try {
        const entry = recognise(state.target.packages, name, bytes);
        if (entry) state.packages.push(entry);
        return !!entry;
    } catch (error) {
        log(`${name}: ${error.message}`);
        return false;
    }
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
        const results = await unpackFiles(list);
        const methods = state.target.packages.map((kind) => PACKAGE_KINDS[kind].method);
        for (const [index, file] of list.entries()) {
            setStatus(`Opening ${file.name} (${index + 1} of ${list.length})...`);
            setProgress(5 + (index / list.length) * 80);
            await settle();
            const direct = new Uint8Array(await file.arrayBuffer());
            if (addPackage(file.name, direct)) continue;
            for (const entry of results[index].log || []) {
                const method = entry.method || "";
                if (!methods.some((pattern) => pattern.test(method))) continue;
                const data = await fileData(entry);
                if (!data) continue;
                state.packages.push(...findPackages(state.target.packages, entry.name || entry.container, method, data));
            }
        }
    } catch (error) {
        log(`could not open: ${error.message}`);
    }

    setBusy(false);
    setProgress(100);
    elements["drop-title"].textContent = label;
    if (!state.packages.length) {
        elements["drop-hint"].textContent = `No ${packageLabels()} packages inside`;
        log(`no ${packageLabels()} packages found in ${label}`);
        setStatus("No packages found");
    } else {
        elements["drop-hint"].textContent =
            `${state.packages.length} package${state.packages.length === 1 ? "" : "s"} found`;
        log(`found ${state.packages.length} package(s) in ${label}`);
        setStatus(`${state.packages.length} package(s) found`);
        const usable = state.packages.findIndex((entry) => !compatibility(state.target, entry, state.device));
        select(Math.max(0, usable));
    }
    renderPackages();
    setConnected(!!state.link);
}

function select(index) {
    state.file = state.packages[index] || null;
    if (!state.file) return;
    elements.size.textContent = formatSize(state.file.bytes.length);
    const entry = state.file;
    if (entry.summary) {
        log(`${entry.name}: ${entry.program || "?"} ${entry.version} - ${entry.summary}`);
    } else {
        log(`${entry.name}: selected`);
    }
    for (const warning of entry.warnings) log(`  warning: ${warning}`);
    const problem = compatibility(state.target, entry, state.device);
    if (problem) {
        log(`  cannot install: ${problem}`);
        setStatus(`Cannot install ${entry.name}: ${problem}`);
    }
    renderPackages();
    setConnected(!!state.link);
}

async function backup() {
    if (!state.link) return;
    const link = state.link;
    const { base, total } = state.target.nand;
    const BATCH = 32;
    state.transfers++;
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
        state.transfers--;
        elements["tool-backup"].disabled = false;
    }
}

async function install() {
    if (!state.link || !state.file) return;
    state.transfers++;
    try {
        elements.install.disabled = true;
        setStatus("Staging package...");
        setProgress(0);
        const message = await PACKAGE_KINDS[state.file.kind].install(state.link, state.file, (sent, total) => {
            setProgress((sent / total) * 100);
            setStatus(`Staging ${formatSize(sent)} of ${formatSize(total)}`);
        });
        setProgress(100);
        log(message);
        setStatus("The installer is running on the device; follow the prompts there");
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        state.transfers--;
        setConnected(!!state.link);
    }
}

const listingCache = new Map();
let browser = { path: "\\", selected: null, transfer: null };

function browserStatus(text) {
    elements["browser-status"].textContent = text || "\u00a0";
}

function openBrowser() {
    elements.browser.show();
    browser.path = state.target.installRoot;
    showListing();
}

async function showListing({ refresh = false } = {}) {
    const path = browser.path || "\\";
    elements["browser-path"].textContent = path;
    elements["browser-up"].disabled = path === "\\";
    browser.selected = null;
    elements["browser-download"].disabled = true;
    elements["browser-delete"].disabled = true;

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
        name.className = entry.directory ? "folder" : "file";
        name.textContent = entry.name;
        const size = document.createElement("td");
        size.className = "size";
        size.textContent = entry.directory ? "" : formatSize(entry.size);
        row.append(name, size);
        row.addEventListener("click", () => {
            if (entry.directory) {
                browser.path = join(browser.path, entry.name);
                showListing();
                return;
            }
            browser.selected = entry;
            elements["browser-download"].disabled = Boolean(browser.transfer);
            elements["browser-delete"].disabled = Boolean(browser.transfer);
            for (const other of body.children) other.setAttribute("aria-selected", String(other === row));
        });
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); row.click(); }
        });
        body.appendChild(row);
    }
}

async function deleteSelected() {
    if (!browser.selected) return;
    const entry = browser.selected;
    const path = join(browser.path, entry.name);
    try {
        elements["browser-delete"].disabled = true;
        const reply = await state.link.deleteFile(path);
        if (!reply.ret) {
            browserStatus(`could not delete ${entry.name} (err ${reply.err})`);
        } else {
            browserStatus(`Deleted ${entry.name}`);
            log(`deleted ${path}`);
        }
        listingCache.delete(browser.path);
        showListing();
    } catch (error) {
        browserStatus(error.message);
        log(`error: ${error.message}`);
    }
}

function emptyRow(text, columns = 2) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = columns;
    cell.textContent = text;
    row.appendChild(cell);
    return row;
}

function join(base, name) {
    return `${base.replace(/\\+$/, "")}\\${name}`;
}

function setTransferring(transferring) {
    for (const id of ["browser-upload", "browser-mkdir"]) elements[id].disabled = transferring;
    for (const id of ["browser-download", "browser-delete"]) elements[id].disabled = transferring || !browser.selected;
    elements["browser-stop"].hidden = !transferring;
    elements["browser-stop"].disabled = false;
    elements["browser-progress"].hidden = !transferring;
    elements["browser-progress"].value = 0;
}

function beginTransfer(verb) {
    const now = performance.now();
    browser.transfer = { verb, stopped: false, sampleTime: now, sampleDone: 0, rate: 0 };
    state.transfers++;
    setTransferring(true);
}

function endTransfer() {
    browser.transfer = null;
    state.transfers--;
    setTransferring(false);
}

function transferProgress(done, total) {
    const transfer = browser.transfer;
    if (transfer.stopped) throw new Error("Stopped");
    const now = performance.now();
    if (now - transfer.sampleTime >= 1000) {
        transfer.rate = ((done - transfer.sampleDone) * 1000) / (now - transfer.sampleTime);
        transfer.sampleTime = now;
        transfer.sampleDone = done;
    }
    const rate = transfer.rate ? `, ${formatSize(Math.round(transfer.rate))}/s` : "";
    browserStatus(`${transfer.verb} ${formatSize(done)}${total ? ` of ${formatSize(total)}` : ""}${rate}`);
    if (total) elements["browser-progress"].value = (done / total) * 100;
}

function stopTransfer() {
    if (!browser.transfer) return;
    browser.transfer.stopped = true;
    elements["browser-stop"].disabled = true;
    browserStatus("Stopping...");
}

async function uploadHere() {
    const [file] = await pickFile();
    if (!file) return;
    const path = join(browser.path, file.name);
    beginTransfer("Sending");
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await state.link.sendFile(path, bytes, transferProgress);
        browserStatus(`Sent ${file.name}`);
        log(`uploaded ${path}`);
    } catch (error) {
        if (browser.transfer.stopped) {
            await state.link.deleteFile(path).catch(() => undefined);
            browserStatus(`Stopped; removed the partial ${file.name}`);
            log(`upload of ${path} stopped`);
        } else {
            browserStatus(error.message);
            log(`error: ${error.message}`);
        }
    } finally {
        endTransfer();
        listingCache.delete(browser.path);
        showListing();
    }
}

async function downloadSelected() {
    if (!browser.selected) return;
    const entry = browser.selected;
    const path = join(browser.path, entry.name);
    beginTransfer("Reading");
    try {
        const bytes = await state.link.receiveFile(path, entry.size, transferProgress);
        saveBytes(bytes, entry.name);
        browserStatus(`Saved ${entry.name}`);
        log(`downloaded ${path} (${bytes.length} bytes)`);
    } catch (error) {
        if (browser.transfer.stopped) {
            browserStatus(`Stopped reading ${entry.name}`);
            log(`download of ${path} stopped`);
        } else {
            browserStatus(error.message);
            log(`error: ${error.message}`);
        }
    } finally {
        endTransfer();
    }
}

function showNewFolder(show) {
    elements["browser-new-folder"].hidden = !show;
    elements["browser-folder-name"].value = "";
    if (show) elements["browser-folder-name"].focus();
}

async function createFolder(event) {
    event.preventDefault();
    const name = elements["browser-folder-name"].value.trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) {
        browserStatus("Folder names can't contain \\ / : * ? \" < > |");
        return;
    }
    const path = join(browser.path, name);
    showNewFolder(false);
    try {
        const reply = await state.link.createDirectory(path);
        if (!reply.ret) {
            browserStatus(`could not create ${name} (err ${reply.err})`);
            return;
        }
        log(`created ${path}`);
        listingCache.delete(browser.path);
        await showListing();
        browserStatus(`Created ${name}`);
    } catch (error) {
        browserStatus(error.message);
        log(`error: ${error.message}`);
    }
}

const REG_ROOTS = [
    ["HKEY_CLASSES_ROOT", HKEY.HKCR],
    ["HKEY_CURRENT_USER", HKEY.HKCU],
    ["HKEY_LOCAL_MACHINE", HKEY.HKLM],
    ["HKEY_USERS", HKEY.HKU],
];

const registryCache = new Map();
const registry = { root: null, path: "", loading: 0, task: null, pending: null, selected: null };

function registryStatus(text) {
    elements["registry-status"].textContent = text || "\u00a0";
}

function registryRootName(root = registry.root) {
    return REG_ROOTS.find(([, handle]) => handle === root)[0];
}

function registryRootHandle(name) {
    const entry = REG_ROOTS.find(([rootName]) => rootName === name);
    return entry ? entry[1] : null;
}

function registryCacheKey(root, path) {
    return path ? `${registryRootName(root)}\\${path}` : registryRootName(root);
}

function registryLocation() {
    return registry.root === null ? "My Device" : registryCacheKey(registry.root, registry.path);
}

async function loadRegistryListing(root, path, onProgress = null) {
    const cacheKey = registryCacheKey(root, path);
    let listing = registryCache.get(cacheKey);
    if (listing) return listing;
    listing = await state.link.listRegKey(root, path, onProgress);
    listing.keys.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    listing.values.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    registryCache.set(cacheKey, listing);
    return listing;
}

function formatRegValue(value) {
    return formatValue(value) + (value.data.length < value.size ? " ..." : "");
}

function registryValueText(value) {
    const { type, data } = value;
    const text = new TextDecoder("utf-16le").decode(data.subarray(0, data.length & ~1));
    if (type === 1 || type === 2 || type === 6) return text.replace(/\0[\s\S]*$/, "");
    if (type === 7) return text.replace(/\0+$/, "").split("\0").join("\n");
    if ((type === 4 || type === 5) && data.length >= 4) {
        const number = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, type === 4);
        return `0x${number.toString(16).padStart(8, "0")}`;
    }
    return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function hexDump(data) {
    const lines = [];
    for (let offset = 0; offset < data.length; offset += 16) {
        const row = data.subarray(offset, offset + 16);
        const bytes = [...row].map((byte) => byte.toString(16).padStart(2, "0"));
        const hex = `${bytes.slice(0, 8).join(" ")}  ${bytes.slice(8).join(" ")}`.padEnd(48);
        const ascii = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
        lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
    }
    return lines.join("\n");
}

function showRegistryValue(value) {
    const textual = [1, 2, 6, 7].includes(value.type);
    const type = REGISTRY_TYPES[value.type] ?? `Type ${value.type}`;
    const cut = value.data.length < value.size ? `, ${value.data.length} read` : "";
    elements["registry-value-title"].textContent = value.name || "(Default)";
    elements["registry-value-type"].textContent = `${type}, ${value.size} byte${value.size === 1 ? "" : "s"}${cut}`;
    elements["registry-value-data"].textContent = textual ? registryValueText(value) : hexDump(value.data) || "(empty)";
    elements["registry-value"].show();
}

async function copyRegistryValue() {
    const value = registry.selected;
    if (!value) return;
    const name = value.name || "(Default)";
    try {
        await navigator.clipboard.writeText(registryValueText(value));
        registryStatus(`Copied ${name}${value.data.length < value.size ? " (cut short by the device)" : ""}`);
    } catch (error) {
        registryStatus(`Couldn't copy ${name}: ${error.message}`);
    }
}

function openRegistry() {
    elements.registry.show();
    showRegistryKey();
}

function enterRegistryKey(name) {
    if (registry.task) return;
    if (registry.root === null) {
        registry.root = REG_ROOTS.find(([rootName]) => rootName === name)[1];
        registry.path = "";
    } else {
        registry.path = registry.path ? `${registry.path}\\${name}` : name;
    }
    showRegistryKey();
}

function registryUp() {
    if (registry.root === null || registry.task) return;
    if (!registry.path) {
        registry.root = null;
    } else {
        const cut = registry.path.lastIndexOf("\\");
        registry.path = cut > 0 ? registry.path.slice(0, cut) : "";
    }
    showRegistryKey();
}

async function showRegistryKey({ refresh = false } = {}) {
    const location = registryLocation();
    elements["registry-path"].textContent = location;
    elements["registry-up"].disabled = registry.root === null || Boolean(registry.task);
    elements["registry-export"].disabled = registry.root === null || Boolean(registry.task);

    if (registry.root === null) {
        renderRegistry({ keys: REG_ROOTS.map(([name]) => name), values: [] });
        registryStatus(`${REG_ROOTS.length} keys`);
        return;
    }

    const loading = ++registry.loading;
    if (refresh) registryCache.delete(location);
    let listing = registryCache.get(location);
    if (!listing) {
        renderRegistry(null);
        registryStatus("Reading...");
        try {
            listing = await loadRegistryListing(registry.root, registry.path, (done, total) => {
                if (loading === registry.loading) registryStatus(`Reading ${done} of ${total}...`);
            });
        } catch (error) {
            if (loading !== registry.loading) return;
            renderRegistry({ keys: [], values: [] });
            registryStatus(error.message);
            log(`error: ${error.message}`);
            return;
        }
    }
    if (loading !== registry.loading) return;
    renderRegistry(listing);
    const keys = listing.keys.length;
    const values = listing.values.length;
    registryStatus(`${keys} key${keys === 1 ? "" : "s"}, ${values} value${values === 1 ? "" : "s"}`);
}

function setRegistryTask(task) {
    registry.task = task;
    state.transfers += task ? 1 : -1;
    elements["registry-up"].disabled = Boolean(task) || registry.root === null;
    elements["registry-export"].disabled = Boolean(task) || registry.root === null;
    elements["registry-refresh"].disabled = Boolean(task);
    elements["registry-import"].disabled = Boolean(task);
    elements["registry-stop"].hidden = !task;
    elements["registry-stop"].disabled = false;
}

function stopRegistryTask() {
    if (!registry.task) return;
    registry.task.stopped = true;
    elements["registry-stop"].disabled = true;
    registryStatus("Stopping...");
}

function registryKeyNode(name, parent) {
    return { name, className: "", parent, keys: [], values: [] };
}

async function exportRegistryKey() {
    if (registry.root === null || registry.task) return;
    const root = registry.root;
    const parts = registry.path ? registry.path.split("\\") : [];
    let parent = null;
    for (const name of [registryRootName(root), ...parts.slice(0, -1)]) parent = registryKeyNode(name, parent);
    const target = parts.length ? registryKeyNode(parts.at(-1), parent) : parent;
    const task = { stopped: false };
    let keysRead = 0;
    let valuesRead = 0;
    let truncated = 0;

    const readTree = async (node, path) => {
        if (task.stopped) throw new Error("Stopped");
        keysRead++;
        registryStatus(`Reading key ${keysRead}: ${registryCacheKey(root, path)}`);
        const listing = await loadRegistryListing(root, path);
        node.values = listing.values;
        valuesRead += listing.values.length;
        truncated += listing.values.filter((value) => value.data.length < value.size).length;
        for (const name of listing.keys) {
            const child = registryKeyNode(name, node);
            node.keys.push(child);
            await readTree(child, path ? `${path}\\${name}` : name);
        }
    };

    setRegistryTask(task);
    try {
        await readTree(target, registry.path);
        saveBytes(new TextEncoder().encode(registryText([target])), `${target.name}.reg`);
        const note = truncated ? `; ${truncated} value${truncated === 1 ? " was" : "s were"} cut short by the device` : "";
        registryStatus(`Saved ${target.name}.reg: ${keysRead} key${keysRead === 1 ? "" : "s"}, ${valuesRead} value${valuesRead === 1 ? "" : "s"}${note}`);
        log(`exported ${registryCacheKey(root, registry.path)} (${keysRead} keys, ${valuesRead} values)`);
    } catch (error) {
        registryStatus(task.stopped ? "Export stopped" : error.message);
        if (!task.stopped) log(`error: ${error.message}`);
    } finally {
        setRegistryTask(null);
    }
}

function showRegistryConfirm(text) {
    elements["registry-confirm-text"].textContent = text || "";
    elements["registry-confirm"].hidden = !text;
}

async function chooseRegistryImport() {
    if (registry.task) return;
    const [file] = await pickFile();
    if (!file) return;
    let parsed = null;
    try {
        parsed = readRegistryFile(new Uint8Array(await file.arrayBuffer()));
    } catch {
        parsed = null;
    }
    if (!parsed || !parsed.roots.length) {
        registry.pending = null;
        showRegistryConfirm("");
        registryStatus(`${file.name} isn't a registry file this can read`);
        return;
    }
    let keys = 0;
    let values = 0;
    const count = (node, isRoot) => {
        if (!isRoot && (node.values.length || !node.keys.length)) keys++;
        values += node.values.length;
        node.keys.forEach((child) => count(child, false));
    };
    parsed.roots.forEach((root) => count(root, true));
    const notes = [
        parsed.deleted ? `${parsed.deleted} deletion${parsed.deleted === 1 ? "" : "s"} will be skipped` : "",
        parsed.damaged ? "some lines couldn't be read" : "",
    ].filter(Boolean);
    registry.pending = { name: file.name, roots: parsed.roots, deleted: parsed.deleted || 0 };
    showRegistryConfirm(`Write ${keys} key${keys === 1 ? "" : "s"} and ${values} value${values === 1 ? "" : "s"} from ${file.name} to the device?${notes.length ? ` (${notes.join("; ")})` : ""} Existing values are overwritten and this can't be undone; a bad value can stop the device booting. Export the keys first if you might want them back.`);
    registryStatus(parsed.format);
}

async function importRegistry(event) {
    event.preventDefault();
    const pending = registry.pending;
    registry.pending = null;
    showRegistryConfirm("");
    if (!pending || registry.task) return;
    const task = { stopped: false };
    let keysWritten = 0;
    let valuesWritten = 0;

    const writeKey = async (node, root, path) => {
        if (task.stopped) throw new Error("Stopped");
        const create = path && (node.values.length || !node.keys.length);
        if (create || (!path && node.values.length)) {
            const handle = create ? await state.link.openRegKey(root, path, true) : root;
            if (create) keysWritten++;
            try {
                for (const value of node.values) {
                    if (task.stopped) throw new Error("Stopped");
                    registryStatus(`Writing ${registryCacheKey(root, path)}\\${value.name || "(Default)"}`);
                    await state.link.setRegValue(handle, value.name, value.type, value.data);
                    valuesWritten++;
                }
            } finally {
                if (create) await state.link.closeRegKey(handle);
            }
        }
        for (const child of node.keys) await writeKey(child, root, path ? `${path}\\${child.name}` : child.name);
    };

    setRegistryTask(task);
    try {
        for (const rootNode of pending.roots) {
            const root = registryRootHandle(rootNode.name);
            if (root !== null) await writeKey(rootNode, root, "");
        }
        const skipped = pending.deleted ? `; skipped ${pending.deleted} deletion${pending.deleted === 1 ? "" : "s"}` : "";
        registryStatus(`Imported ${pending.name}: ${valuesWritten} value${valuesWritten === 1 ? "" : "s"} in ${keysWritten} key${keysWritten === 1 ? "" : "s"}${skipped}`);
        log(`imported ${pending.name} (${keysWritten} keys, ${valuesWritten} values)`);
    } catch (error) {
        const done = `after ${valuesWritten} value${valuesWritten === 1 ? "" : "s"}`;
        registryStatus(task.stopped ? `Import stopped ${done}` : `${error.message} (${done})`);
        if (!task.stopped) log(`error: ${error.message}`);
    } finally {
        setRegistryTask(null);
        registryCache.clear();
        const status = elements["registry-status"].textContent;
        await showRegistryKey();
        registryStatus(status);
    }
}

function registryRow(cells) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    for (const [text, className] of cells) {
        const cell = document.createElement("td");
        if (className) cell.className = className;
        cell.textContent = text;
        cell.title = text;
        row.appendChild(cell);
    }
    return row;
}

function renderRegistry(listing) {
    const body = elements["registry-list"];
    body.innerHTML = "";
    registry.selected = null;
    elements["registry-copy"].disabled = true;
    if (listing === null) {
        body.appendChild(emptyRow("Reading...", 3));
        return;
    }
    if (!listing.keys.length && !listing.values.length) {
        body.appendChild(emptyRow("Empty", 3));
        return;
    }
    for (const name of listing.keys) {
        const row = registryRow([[name, "folder"], ["", ""], ["", ""]]);
        row.addEventListener("click", () => enterRegistryKey(name));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); row.click(); }
        });
        body.appendChild(row);
    }
    for (const value of listing.values) {
        const textual = [1, 2, 6, 7].includes(value.type);
        const row = registryRow([
            [value.name || "(Default)", textual ? "string" : "binary"],
            [REGISTRY_TYPES[value.type] ?? `Type ${value.type}`, ""],
            [formatRegValue(value), ""],
        ]);
        row.addEventListener("click", () => {
            registry.selected = value;
            elements["registry-copy"].disabled = false;
            for (const other of body.children) other.setAttribute("aria-selected", String(other === row));
        });
        row.addEventListener("dblclick", () => showRegistryValue(value));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                row.click();
                showRegistryValue(value);
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
                event.preventDefault();
                row.click();
                copyRegistryValue();
            }
        });
        body.appendChild(row);
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

function connectRemembered(device) {
    const target = targetFor(device);
    if (!target || !target.autoConnect || state.link || state.connecting) return;
    const id = [device.vendorId, device.productId].map((value) => value.toString(16).padStart(4, "0")).join(":");
    log(`${target.name} found: ${device.manufacturerName || "?"} ${device.productName || "?"} (${id})`);
    start(target, (link) => { link.device = device; }).catch((error) => {
        setStatus(error.message);
        log(`error: ${error.message}`);
    });
}

if (navigator.usb) {
    navigator.usb.addEventListener("connect", (event) => connectRemembered(event.device));
    navigator.usb.getDevices().then((devices) => devices.forEach(connectRemembered));
}
elements["connect-serial"].addEventListener("click", connectSerial);
elements["connect-serial"].hidden = !navigator.serial;
elements["serial-baud"].hidden = !navigator.serial;
elements.disconnect.addEventListener("click", disconnect);


elements.install.addEventListener("click", install);
elements["tools-button"].addEventListener("click", () => showTools(elements["tools-menu"].hidden));
elements["browser-close"].addEventListener("click", () => elements.browser.close());
elements["browser-refresh"].addEventListener("click", () => showListing({ refresh: true }));
elements["browser-upload"].addEventListener("click", uploadHere);
elements["browser-download"].addEventListener("click", downloadSelected);
elements["browser-delete"].addEventListener("click", deleteSelected);
elements["browser-stop"].addEventListener("click", stopTransfer);

window.addEventListener("beforeunload", (event) => {
    if (state.transfers) event.preventDefault();
});
window.addEventListener("pagehide", () => {
    if (state.link && state.link.stack) state.link.stack.closeAll();
});
elements["browser-mkdir"].addEventListener("click", () => showNewFolder(elements["browser-new-folder"].hidden));
elements["browser-folder-cancel"].addEventListener("click", () => showNewFolder(false));
elements["browser-new-folder"].addEventListener("submit", createFolder);
elements["browser-up"].addEventListener("click", () => {
    const cut = browser.path.replace(/\\+$/, "").lastIndexOf("\\");
    browser.path = cut > 0 ? browser.path.slice(0, cut) : "\\";
    showListing();
});
elements["tool-files"].addEventListener("click", () => { showTools(false); openBrowser(); });
elements["tool-registry"].addEventListener("click", () => { showTools(false); openRegistry(); });
elements["registry-close"].addEventListener("click", () => elements.registry.close());
elements["registry-up"].addEventListener("click", registryUp);
elements["registry-refresh"].addEventListener("click", () => showRegistryKey({ refresh: true }));
elements["registry-copy"].addEventListener("click", copyRegistryValue);
elements["registry-value-close"].addEventListener("click", () => elements["registry-value"].close());
elements["registry-export"].addEventListener("click", exportRegistryKey);
elements["registry-import"].addEventListener("click", chooseRegistryImport);
elements["registry-stop"].addEventListener("click", stopRegistryTask);
elements["registry-confirm"].addEventListener("submit", importRegistry);
elements["registry-confirm-cancel"].addEventListener("click", () => {
    registry.pending = null;
    showRegistryConfirm("");
    registryStatus("Import cancelled");
});
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
