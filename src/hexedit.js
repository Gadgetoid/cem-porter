import { saveBytes, setupDesktop } from "./desktop.js";
import { formatSize } from "./browser.js";
import { MACHINE_NAMES } from "./pe.js";
import { ANNOTATORS, buildContext, buildLayer, hitsAt, hex } from "./hexannotate.js";
import { takeHandoff } from "./handoff.js";

const ids = ["open", "file-input", "drop", "drop-title", "drop-hint", "view", "space", "rows",
    "toggles", "goto", "find", "find-next", "inspector", "revert", "save", "status", "size", "edit-count"];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const BYTES_PER_ROW = 16;
const state = {
    data: null, name: "file.bin", ctx: null,
    layerCache: new Map(), enabled: new Set(ANNOTATORS.filter((a) => a.defaultOn).map((a) => a.id)),
    edits: new Map(), selection: null, nibble: 0, rowHeight: 18,
};

function setStatus(text) {
    el.status.textContent = text;
}

function activeLayers() {
    const layers = [];
    for (const annotator of ANNOTATORS) {
        if (!state.enabled.has(annotator.id)) continue;
        if (!state.layerCache.has(annotator.id)) state.layerCache.set(annotator.id, buildLayer(annotator, state.ctx));
        layers.push(state.layerCache.get(annotator.id));
    }
    return layers;
}

function narrowestAt(offset, layers) {
    let best = null;
    for (const layer of layers) {
        const hits = hitsAt(layer.intervals, offset);
        const hit = hits[hits.length - 1];
        if (hit && (!best || hit.end - hit.start < best.end - best.start)) best = hit;
    }
    return best;
}

// -- open ------------------------------------------------------------------

async function openFile(file) {
    loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

function loadBytes(data, name) {
    state.data = data;
    state.name = name;
    state.ctx = buildContext(data);
    state.layerCache.clear();
    state.edits.clear();
    state.selection = null;
    el.drop.hidden = true;
    el.view.hidden = false;
    renderToggles();
    el.space.style.height = `${Math.ceil(data.length / BYTES_PER_ROW) * state.rowHeight}px`;
    el.view.scrollTop = 0;
    renderWindow();
    updateEditState();
    el.size.textContent = formatSize(data.length);
    if (state.ctx.isPe) {
        const pe = state.ctx.pe;
        setStatus(`${name}: ${MACHINE_NAMES[pe.machine] ?? "?"} ${pe.dll ? "DLL" : "program"}, ${state.ctx.sections.length} sections.`);
    } else {
        setStatus(`${name}: not a PE file - raw bytes, strings annotation only.`);
    }
    el.inspector.textContent = "Click a byte to inspect it.";
}

function renderToggles() {
    el.toggles.replaceChildren();
    for (const annotator of ANNOTATORS) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = state.enabled.has(annotator.id);
        box.disabled = !state.ctx.isPe && annotator.id !== "strings";
        box.addEventListener("change", () => {
            if (box.checked) state.enabled.add(annotator.id); else state.enabled.delete(annotator.id);
            renderWindow();
        });
        label.append(box, " ", annotator.label);
        label.title = annotator.role;
        el.toggles.append(label);
    }
}

// -- render ----------------------------------------------------------------

function renderWindow() {
    const data = state.data;
    if (!data) return;
    const rows = Math.ceil(data.length / BYTES_PER_ROW);
    const first = Math.max(0, Math.floor(el.view.scrollTop / state.rowHeight) - 4);
    const last = Math.min(rows, Math.ceil((el.view.scrollTop + el.view.clientHeight) / state.rowHeight) + 4);
    el.rows.style.transform = `translateY(${first * state.rowHeight}px)`;
    const layers = activeLayers();
    const frag = document.createDocumentFragment();
    for (let row = first; row < last; row++) frag.append(renderRow(row, layers));
    el.rows.replaceChildren(frag);
}

function renderRow(row, layers) {
    const data = state.data;
    const base = row * BYTES_PER_ROW;
    const line = document.createElement("div");
    line.className = "hexrow";
    const offset = document.createElement("span");
    offset.className = "off";
    offset.textContent = hex(base);
    line.append(offset);
    const bytes = document.createElement("span");
    bytes.className = "bytes";
    const ascii = document.createElement("span");
    ascii.className = "ascii";
    for (let i = 0; i < BYTES_PER_ROW; i++) {
        const at = base + i;
        const cell = document.createElement("span");
        if (at < data.length) {
            const hit = narrowestAt(at, layers);
            cell.className = "b";
            if (hit) cell.classList.add(`c-${hit.cat}`);
            if (at === state.selection) cell.classList.add("sel");
            if (isEdited(at)) cell.classList.add("edited");
            if (i === 8) cell.classList.add("gap");
            cell.dataset.off = String(at);
            cell.textContent = hex(data[at], 2);
            const letter = document.createElement("span");
            letter.textContent = data[at] >= 0x20 && data[at] < 0x7f ? String.fromCharCode(data[at]) : ".";
            letter.dataset.off = String(at);
            if (at === state.selection) letter.className = "sel";
            if (isEdited(at)) letter.classList.add("edited");
            ascii.append(letter);
        } else {
            cell.className = "b blank";
            cell.textContent = "  ";
        }
        bytes.append(cell);
    }
    line.append(bytes, ascii);
    return line;
}

function isEdited(offset) {
    return state.edits.has(offset) && state.data[offset] !== state.edits.get(offset);
}

// -- selection + inspector -------------------------------------------------

function select(offset) {
    if (offset < 0 || offset >= state.data.length) return;
    state.selection = offset;
    state.nibble = 0;
    el.view.focus();
    ensureVisible(offset);
    renderWindow();
    showInspector(offset);
}

function ensureVisible(offset) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    const top = row * state.rowHeight;
    const viewTop = el.view.scrollTop, viewBottom = viewTop + el.view.clientHeight;
    if (top < viewTop) el.view.scrollTop = top;
    else if (top + state.rowHeight > viewBottom) el.view.scrollTop = top - el.view.clientHeight + state.rowHeight;
}

function showInspector(offset) {
    const value = state.data[offset];
    const lines = [`Offset ${hex(offset)}  (${offset})`,
        `Byte ${hex(value, 2)}  dec ${value}  ${value >= 0x20 && value < 0x7f ? `'${String.fromCharCode(value)}'` : "-"}`];
    if (offset + 4 <= state.data.length) {
        const dword = (state.data[offset] | (state.data[offset + 1] << 8) | (state.data[offset + 2] << 16) | (state.data[offset + 3] << 24)) >>> 0;
        lines.push(`u32 LE ${hex(dword)}`);
    }
    lines.push("");
    let any = false;
    for (const layer of activeLayers()) {
        const hits = hitsAt(layer.intervals, offset);
        for (const hit of hits) {
            any = true;
            lines.push(`[${layer.label}] ${hit.label}`);
            if (hit.detail) lines.push(`    ${hit.detail}`);
        }
    }
    if (!any) lines.push("(no annotations here)");
    el.inspector.textContent = lines.join("\n");
}

// -- editing ---------------------------------------------------------------

function writeNibble(digit) {
    const offset = state.selection;
    if (offset === null) return;
    if (!state.edits.has(offset)) state.edits.set(offset, state.data[offset]);
    const current = state.data[offset];
    if (state.nibble === 0) {
        state.data[offset] = (digit << 4) | (current & 0x0f);
        state.nibble = 1;
    } else {
        state.data[offset] = (current & 0xf0) | digit;
        state.nibble = 0;
        if (offset + 1 < state.data.length) state.selection = offset + 1;
    }
    ensureVisible(state.selection);
    renderWindow();
    showInspector(state.selection);
    updateEditState();
}

function revertAll() {
    for (const [offset, original] of state.edits) state.data[offset] = original;
    state.edits.clear();
    renderWindow();
    updateEditState();
    if (state.selection !== null) showInspector(state.selection);
}

function editCount() {
    let count = 0;
    for (const offset of state.edits.keys()) if (isEdited(offset)) count++;
    return count;
}

function updateEditState() {
    const count = editCount();
    el["edit-count"].textContent = count ? `${count} byte${count === 1 ? "" : "s"} changed` : "No changes";
    el.save.disabled = count === 0;
    el.revert.disabled = count === 0;
}

function savePatched() {
    const dot = state.name.lastIndexOf(".");
    const name = dot > 0 ? `${state.name.slice(0, dot)}.patched${state.name.slice(dot)}` : `${state.name}.patched`;
    saveBytes(state.data, name);
    setStatus(`Saved ${name} with ${editCount()} byte(s) changed.`);
}

// -- find + goto -----------------------------------------------------------

function parsePattern(text) {
    text = text.trim();
    if (!text) return null;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return [...text.slice(1, -1)].map((char) => char.charCodeAt(0) & 0xff);
    }
    const parts = text.split(/\s+/);
    const bytes = [];
    for (const part of parts) {
        if (!/^[0-9a-fA-F]{1,2}$/.test(part)) return null;
        bytes.push(parseInt(part, 16));
    }
    return bytes;
}

function findNext() {
    const pattern = parsePattern(el.find.value);
    if (!pattern || !state.data) { setStatus('Find: enter hex bytes like "01 00 a0 e3" or text in quotes.'); return; }
    const data = state.data;
    const from = (state.selection ?? -1) + 1;
    for (let start = from; start <= data.length - pattern.length; start++) {
        let match = true;
        for (let i = 0; i < pattern.length; i++) if (data[start + i] !== pattern[i]) { match = false; break; }
        if (match) { select(start); setStatus(`Found at ${hex(start)}.`); return; }
    }
    setStatus("Not found (searched from the selection to the end).");
}

function gotoOffset() {
    const text = el.goto.value.trim();
    if (!text || !state.data) return;
    const offset = text.toLowerCase().startsWith("0x") ? parseInt(text.slice(2), 16) : parseInt(text, /^[0-9]+$/.test(text) ? 10 : 16);
    if (Number.isNaN(offset) || offset < 0 || offset >= state.data.length) { setStatus("Go to: offset out of range."); return; }
    select(offset);
}

// -- wiring ----------------------------------------------------------------

function setup() {
    el.open.addEventListener("click", () => el["file-input"].click());
    el.drop.addEventListener("click", () => el["file-input"].click());
    el.drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); el["file-input"].click(); }
    });
    el["file-input"].addEventListener("change", () => {
        if (el["file-input"].files[0]) openFile(el["file-input"].files[0]);
    });
    el.drop.addEventListener("dragover", (event) => { event.preventDefault(); el.drop.classList.add("over"); });
    el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
    el.drop.addEventListener("drop", (event) => {
        event.preventDefault();
        el.drop.classList.remove("over");
        if (event.dataTransfer.files[0]) openFile(event.dataTransfer.files[0]);
    });
    el.view.addEventListener("scroll", () => requestAnimationFrame(renderWindow));
    el.view.addEventListener("click", (event) => {
        const off = event.target.dataset?.off;
        if (off !== undefined) select(Number(off));
    });
    el.view.addEventListener("keydown", (event) => {
        if (state.selection === null) return;
        const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -BYTES_PER_ROW, ArrowDown: BYTES_PER_ROW };
        if (event.key in moves) {
            event.preventDefault();
            select(Math.min(Math.max(state.selection + moves[event.key], 0), state.data.length - 1));
        } else if (/^[0-9a-fA-F]$/.test(event.key)) {
            event.preventDefault();
            writeNibble(parseInt(event.key, 16));
        }
    });
    el["find-next"].addEventListener("click", findNext);
    el.find.addEventListener("keydown", (event) => { if (event.key === "Enter") findNext(); });
    el.goto.addEventListener("keydown", (event) => { if (event.key === "Enter") gotoOffset(); });
    el.revert.addEventListener("click", revertAll);
    el.save.addEventListener("click", savePatched);
    window.addEventListener("resize", () => requestAnimationFrame(renderWindow));
    setupDesktop({ readmeKey: "hex-editor-readme" });
    setStatus("Open an executable to annotate it.");
    takeHandoff()
        .then((handoff) => {
            if (handoff) loadBytes(handoff.data instanceof Uint8Array ? handoff.data : new Uint8Array(handoff.data), handoff.name);
        })
        .catch(() => {});
}

setup();
