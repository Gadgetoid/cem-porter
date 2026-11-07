import { BeLink, isSupported, NAND_BASE, NAND_TOTAL, SECTOR } from "./belink.js";
import { looksLikeCbea, readCbea, cbeaPlatform } from "./cbea.js";
import { planInstall, describePlan } from "./cbeainstall.js";
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
    "info", "members", "send", "dest", "backup", "install", "reset", "progress", "log",
].map((id) => [id, document.getElementById(id)]));

const state = { link: null, target: TARGETS.be300, file: null, members: [], plan: null };

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
    elements.backup.disabled = !connected;
    elements.send.disabled = !connected || !state.file;
    elements.install.disabled = !connected || !state.file;
    elements.reset.disabled = !connected;
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

function renderMembers() {
    elements.members.innerHTML = "";
    if (!state.members.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "empty";
        cell.colSpan = 2;
        cell.textContent = "Drop a .cbea to see what it installs.";
        row.appendChild(cell);
        elements.members.appendChild(row);
        return;
    }
    for (const member of state.members) {
        const row = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = member.name;
        const size = document.createElement("td");
        size.textContent = formatSize(member.data.length);
        row.append(name, size);
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

async function loadFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.file = { name: file.name, bytes };
    state.members = [];
    state.plan = null;
    if (looksLikeCbea(bytes)) {
        try {
            state.members = readCbea(bytes);
            log(`${file.name}: ${cbeaPlatform(bytes)}, ${state.members.length} members`);
            try {
                state.plan = planInstall(state.members, { drive: elements.dest.value.trim() || state.target.installRoot });
                for (const line of describePlan(state.plan)) log(`  ${line}`);
            } catch (error) {
                state.plan = null;
                log(`no install plan: ${error.message}`);
            }
        } catch (error) {
            log(`${file.name}: could not read members (${error.message})`);
        }
    } else {
        log(`${file.name}: not a .cbea, will be copied as a plain file`);
    }
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(bytes.length);
    elements.size.textContent = formatSize(bytes.length);
    renderMembers();
    setConnected(!!state.link);
}

async function send() {
    if (!state.link || !state.file) return;
    const folder = (elements.dest.value.trim() || state.target.installRoot).replace(/\\+$/, "");
    const path = `${folder}\\${state.file.name}`;
    log(`sending ${formatSize(state.file.bytes.length)} to ${path}`);
    try {
        elements.send.disabled = true;
        setStatus(`Sending ${state.file.name}...`);
        await state.link.sendFile(path, state.file.bytes, (sent, total) => {
            elements.progress.value = Math.round((sent / total) * 100);
            setStatus(`Sending ${formatSize(sent)} of ${formatSize(total)}`);
        });
        elements.progress.value = 100;
        setStatus(`Sent to ${path}`);
        log(`wrote ${path}`);
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements.send.disabled = false;
    }
}

async function backup() {
    if (!state.link) return;
    const link = state.link;
    const { base, total } = state.target.nand;
    const BATCH = 32;
    try {
        elements.backup.disabled = true;
        const handle = await link.nandOpen();
        const info = await link.nandInfo(handle);
        log(`NAND window ${info.sectors} sectors of ${info.sectorSize} bytes, base ${base}`);
        const image = new Uint8Array(total * SECTOR);
        for (let sector = 0; sector < total; sector += BATCH) {
            const count = Math.min(BATCH, total - sector);
            const data = await link.readSectors(handle, sector, count);
            image.set(data, sector * SECTOR);
            elements.progress.value = Math.round((sector / total) * 100);
            if (sector % 4096 === 0) setStatus(`Reading sector ${sector} of ${total}`);
        }
        await link.call(0x0340, new Uint8Array([
            (handle >>> 24) & 0xff, (handle >>> 16) & 0xff,
            (handle >>> 8) & 0xff, handle & 0xff,
        ]));
        elements.progress.value = 100;
        saveBytes(image, "be300-full-nand.bin");
        setStatus(`Saved ${formatSize(image.length)}`);
        log("full NAND backup saved");
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements.backup.disabled = false;
    }
}

async function install() {
    if (!state.link || !state.file) return;
    try {
        elements.install.disabled = true;
        setStatus("Staging package...");
        elements.progress.value = 10;
        const reply = await state.link.installPackage(state.file.bytes);
        elements.progress.value = 100;
        log(`CoInstall.exe dispatched (ret=0x${reply.ret.toString(16)})`);
        setStatus("CoInstall is running on the device; follow the prompts there");
    } catch (error) {
        setStatus(error.message);
        log(`error: ${error.message}`);
    } finally {
        elements.install.disabled = false;
    }
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
        const [file] = elements["file-input"].files;
        if (file) loadFile(file);
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
        const [file] = event.dataTransfer.files;
        if (file) loadFile(file);
    });
}

setupDesktop({ readmeKey: "cemsync-readme" });
setupDrop();
elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", disconnect);
elements.send.addEventListener("click", send);
elements.backup.addEventListener("click", backup);
elements.install.addEventListener("click", install);
elements.reset.addEventListener("click", softReset);
elements.target.textContent = state.target.name;
elements.dest.value = state.target.installRoot;
renderMembers();
setConnected(false);
setStatus(isSupported() ? "Ready. Connect the cradle and press Connect." : "No WebUSB: use Chrome or Edge.");
