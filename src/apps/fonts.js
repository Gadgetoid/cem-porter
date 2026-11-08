import { zipSync } from "../../vendor/fflate.js";
import { fetchBytes } from "../port/assets.js";
import { unpack } from "../archive/unpack.js";
import { ARCHITECTURE_ANY, Package } from "../port/cabwrite.js";
import { selfInstaller } from "../port/selfinstall.js";
import { saveBytes, setupDesktop } from "../ui/desktop.js";
import { CHARACTER_SETS, CODEPAGES, chosenCodepoints } from "../fonts/fontsets.js";
import { RIBBI, openFont, describeFont, defaultNaming, convertTtf, convertFnt, ttfCells, fntCells } from "../fonts/fontconvert.js";

const FONT_FILE = /\.(ttf|otf|woff)$/i;
const FNT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];
const DEFAULT_SIZES = new Set([8, 9, 10, 12, 14]);
const DEFAULT_SETS = new Set(["cp1252"]);
const INSTALL_FOLDER = "\\Windows\\Fonts";
const CAB_FOLDER = "%CE15%";
const UPDATE_DELAY = 250;
const ids = ["drop", "drop-title", "drop-hint", "file-input", "fonts", "instance", "instance-label", "axes", "axes-label", "family", "style", "weight", "format", "package", "detail", "units", "codepage", "sizes", "hinting", "characters-set", "sets", "extra", "characters-note", "sample", "preview-size", "zoom", "preview", "preview-note", "save", "status", "size"];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const state = { fonts: [], selected: -1, font: null, coordinates: null, output: null, timer: 0 };
const readBytes = fetchBytes(new URL("../../", import.meta.url));

function setStatus(text) {
    elements.status.textContent = text;
}

function formatSize(bytes) {
    return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function plural(count, word) {
    return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function cell(row, text, className) {
    const td = row.insertCell();
    td.textContent = text;
    if (className) td.className = className;
    return td;
}

function format() {
    return elements.format.value;
}

function chosenSizes() {
    return [...elements.sizes.querySelectorAll("input:checked")].map((input) => Number(input.value));
}

function chosenSets() {
    return [...elements.sets.querySelectorAll("input:checked")].map((input) => input.value);
}

function fileBase() {
    const family = elements.family.value.replace(/[^A-Za-z0-9]/g, "") || "Font";
    const style = elements.style.value === "Regular" ? "" : elements.style.value.replace(/\s/g, "");
    return { family, style };
}

function renderFonts() {
    const body = elements.fonts;
    body.replaceChildren();
    if (!state.fonts.length) {
        const td = cell(body.insertRow(), "No fonts found.", "empty");
        td.colSpan = 4;
        return;
    }
    state.fonts.forEach((entry, index) => {
        const row = body.insertRow();
        row.tabIndex = 0;
        row.setAttribute("aria-selected", String(index === state.selected));
        cell(row, entry.path.split("/").pop(), "path");
        cell(row, entry.description?.family ?? "");
        cell(row, entry.error ? entry.error : entry.description.axes.length ? `Variable (${entry.description.axes.map((axis) => axis.tag).join(", ")})` : entry.description.style, entry.error ? "problem" : "");
        cell(row, entry.description?.outlines ?? "", "hide-narrow");
        const choose = () => selectFont(index);
        row.addEventListener("click", choose);
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose();
            }
        });
    });
}

function renderAxes(description) {
    const variable = description.axes.length > 0;
    for (const id of ["instance", "instance-label", "axes", "axes-label"]) elements[id].hidden = !variable;
    elements.axes.replaceChildren();
    elements.instance.replaceChildren();
    if (!variable) return;
    description.instances.forEach((instance, index) => elements.instance.add(new Option(instance.name || `Instance ${index + 1}`, String(index))));
    elements.instance.add(new Option("Custom", "custom"));
    for (const axis of description.axes) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(axis.min);
        input.max = String(axis.max);
        input.step = "any";
        input.value = String(axis.value);
        input.dataset.tag = axis.tag;
        input.style.width = "70px";
        input.addEventListener("change", () => {
            elements.instance.value = "custom";
            readAxes();
            schedule();
        });
        label.append(`${axis.name} (${axis.min}-${axis.max})`, input);
        elements.axes.append(label);
    }
    const regular = description.instances.findIndex((instance) => instance.name === "Regular");
    elements.instance.value = String(regular >= 0 ? regular : 0);
    applyInstance();
}

function readAxes() {
    state.coordinates = Object.fromEntries([...elements.axes.querySelectorAll("input")].map((input) => {
        const value = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) || 0));
        input.value = String(value);
        return [input.dataset.tag, value];
    }));
}

function applyNaming(instanceName) {
    const naming = defaultNaming(state.font, instanceName, state.coordinates);
    elements.family.value = naming.family;
    elements.style.value = naming.style;
    elements.weight.value = String(naming.weight);
}

function applyInstance() {
    const description = describeFont(state.font);
    const instance = description.instances[Number(elements.instance.value)];
    if (instance) {
        for (const input of elements.axes.querySelectorAll("input")) {
            if (instance.coordinates[input.dataset.tag] !== undefined) input.value = String(instance.coordinates[input.dataset.tag]);
        }
    }
    readAxes();
    applyNaming(instance?.name);
}

function selectFont(index) {
    const entry = state.fonts[index];
    if (!entry || entry.error) return;
    state.selected = index;
    state.font = entry.font;
    state.coordinates = null;
    renderFonts();
    const description = entry.description;
    renderAxes(description);
    if (!description.axes.length) applyNaming(description.style);
    for (const id of ["family", "style", "weight"]) elements[id].disabled = false;
    schedule();
}

async function openFile(file) {
    setStatus(`Opening ${file.name}...`);
    elements["drop-title"].textContent = file.name;
    elements["drop-hint"].textContent = formatSize(file.size);
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const data = new Uint8Array(await file.arrayBuffer());
        const files = FONT_FILE.test(file.name) ? [{ path: file.name, data }] : unpack(file.name, data).files.filter((entry) => FONT_FILE.test(entry.path));
        state.fonts = files.map((entry) => {
            try {
                const font = openFont(entry.data);
                return { path: entry.path, font, description: describeFont(font) };
            } catch (error) {
                return { path: entry.path, error: `can't read: ${error.message}` };
            }
        }).sort((first, second) => Number(Boolean(first.description?.axes.length)) - Number(Boolean(second.description?.axes.length)) || first.path.localeCompare(second.path));
        state.selected = -1;
        state.font = null;
        state.output = null;
        renderFonts();
        const readable = state.fonts.filter((entry) => !entry.error);
        if (!readable.length) {
            setStatus(state.fonts.length ? "None of the fonts in this file could be read." : `No .ttf, .otf or .woff fonts in ${file.name}.`);
            updateButtons();
            return;
        }
        const preferred = state.fonts.findIndex((entry) => !entry.error && /^(Regular|Book|Normal)$/i.test(entry.description.style) && !entry.description.axes.length);
        selectFont(preferred >= 0 ? preferred : state.fonts.indexOf(readable[0]));
    } catch (error) {
        state.fonts = [];
        renderFonts();
        setStatus(`Couldn't read ${file.name}: ${error.message}`);
    }
}

function schedule() {
    clearTimeout(state.timer);
    state.output = null;
    updateButtons();
    state.timer = setTimeout(convert, UPDATE_DELAY);
}

function updateFormatControls() {
    const chosen = format();
    for (const element of document.querySelectorAll("[data-format]")) element.hidden = element.dataset.format !== chosen;
    const bitmap = chosen === "fnt";
    for (const input of elements["characters-set"].querySelectorAll("input")) input.disabled = bitmap;
    elements["characters-note"].hidden = !bitmap;
    elements["characters-set"].toggleAttribute("disabled", bitmap);
    renderPreviewSizes();
}

function renderPreviewSizes() {
    const current = Number(elements["preview-size"].value) || 9;
    const sizes = format() === "fnt" ? chosenSizes() : FNT_SIZES;
    elements["preview-size"].replaceChildren(...sizes.map((size) => new Option(`${size} pt`, String(size))));
    if (sizes.includes(current)) elements["preview-size"].value = String(current);
}

function naming() {
    const weight = Math.min(1000, Math.max(1, Math.round(Number(elements.weight.value) || 400)));
    return { family: elements.family.value.trim() || "Font", style: elements.style.value, weight };
}

function convert() {
    if (!state.font) return;
    try {
        if (format() === "ttf") {
            const codepoints = chosenCodepoints(chosenSets(), elements.extra.value);
            if (!codepoints.length) throw new Error("pick some characters");
            const result = convertTtf(state.font, { codepoints, coordinates: state.coordinates, unitsPerEm: Number(elements.units.value), detail: Number(elements.detail.value), ...naming() });
            state.output = { kind: "ttf", result };
            const missing = result.missing.length ? `, ${plural(result.missing.length, "character")} not in the font` : "";
            setStatus(`${plural(result.glyphs.length - 1, "character")}${missing}. ${plural(result.points, "point")}, from ${result.sourcePoints.toLocaleString()}.`);
            elements.size.textContent = formatSize(result.data.length);
        } else {
            const sizes = chosenSizes();
            if (!sizes.length) throw new Error("pick at least one size");
            const results = convertFnt(state.font, { sizes, codepage: Number(elements.codepage.value), coordinates: state.coordinates, hinting: elements.hinting.checked, ...naming() });
            state.output = { kind: "fnt", results };
            const missing = results[0].missing.length;
            const unhinted = Math.max(...results.map((result) => result.unhinted));
            const notes = [missing && `${plural(missing, "character")} not in the font`, unhinted && `${plural(unhinted, "character")} drawn without hinting`].filter(Boolean);
            setStatus(`${plural(sizes.length, "size")}${notes.length ? `; ${notes.join(", ")}` : ""}.`);
            elements.size.textContent = formatSize(results.reduce((total, result) => total + result.data.length, 0));
        }
    } catch (error) {
        state.output = null;
        setStatus(`Couldn't convert: ${error.message}`);
        elements.size.textContent = " ";
    }
    renderPreview();
    updateButtons();
}

function previewCells() {
    const points = Number(elements["preview-size"].value);
    if (state.output.kind === "ttf") return ttfCells(state.output.result, points);
    const result = state.output.results.find((item) => item.points === points) ?? state.output.results[0];
    return fntCells(result);
}

function renderPreview() {
    const canvas = elements.preview;
    const context = canvas.getContext("2d");
    if (!state.output) {
        canvas.width = canvas.height = 1;
        context.clearRect(0, 0, 1, 1);
        elements["preview-note"].textContent = "";
        return;
    }
    const { height, cells, fallback } = previewCells();
    const glyphs = [...elements.sample.value].map((character) => cells.get(character.codePointAt(0)) ?? fallback);
    const width = Math.max(1, glyphs.reduce((total, glyph) => total + glyph.width, 0)) + 4;
    const image = context.createImageData(width, height + 4);
    image.data.fill(255);
    let x = 2;
    for (const glyph of glyphs) {
        for (let y = 0; y < height; y++) {
            for (let column = 0; column < glyph.width; column++) {
                if (!glyph.bitmap[y * glyph.width + column]) continue;
                const offset = ((y + 2) * width + x + column) * 4;
                image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 0;
            }
        }
        x += glyph.width;
    }
    canvas.width = width;
    canvas.height = height + 4;
    context.putImageData(image, 0, 0);
    const zoom = Number(elements.zoom.value);
    canvas.style.width = `${width * zoom}px`;
    canvas.style.height = `${(height + 4) * zoom}px`;
    elements["preview-note"].textContent = state.output.kind === "ttf" ? "Drawn here without hinting or smoothing; the device's own rasterizer may differ slightly." : "These are the bitmaps saved in the .fnt files.";
}

function outputFiles() {
    const { family, style } = fileBase();
    if (state.output.kind === "ttf") return [{ name: `${family}${style ? "-" + style : ""}.ttf`, data: state.output.result.data }];
    return state.output.results.map((result) => ({ name: `${family}${style}${result.points}.fnt`, data: result.data }));
}

async function save() {
    const files = outputFiles();
    const kind = elements.package.value;
    const { family, style } = fileBase();
    const title = `${elements.family.value.trim()} ${elements.style.value === "Regular" ? "" : elements.style.value} font`.replace(/\s+/g, " ").trim();
    try {
        if (kind === "files") {
            if (files.length === 1) saveBytes(files[0].data, files[0].name);
            else saveBytes(zipSync(Object.fromEntries(files.map((file) => [file.name, file.data]))), `${family}${style}.zip`);
        } else if (kind === "cab") {
            const cab = new Package(title, "", { architecture: ARCHITECTURE_ANY });
            const folder = cab.setup.wholeDirectory(CAB_FOLDER);
            for (const file of files) cab.addFile(folder, file.name, file.data);
            saveBytes(cab.build(), `${family}${style}.CAB`);
        } else {
            const cpu = kind === "setup-sh3" ? "sh3" : "mips";
            setStatus("Building the installer...");
            const stub = await readBytes(`data/${cpu}/ceinstall.exe`);
            const operations = files.map((file) => ({ kind: "file", path: `${INSTALL_FOLDER}\\${file.name}`, data: file.data }));
            saveBytes(selfInstaller(stub, title, operations), `${family}${style} Setup.${cpu.toUpperCase()}.exe`);
            setStatus("Saved. Run it on the device, then soft reset.");
        }
    } catch (error) {
        setStatus(`Couldn't save: ${error.message}`);
    }
}

function updateButtons() {
    elements.save.disabled = !state.output;
}

function setup() {
    for (const set of CHARACTER_SETS) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = set.key;
        input.checked = DEFAULT_SETS.has(set.key);
        input.addEventListener("change", schedule);
        label.append(input, ` ${set.label}`);
        elements.sets.append(label);
    }
    for (const size of FNT_SIZES) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = String(size);
        input.checked = DEFAULT_SIZES.has(size);
        input.addEventListener("change", () => {
            renderPreviewSizes();
            schedule();
        });
        label.append(input, ` ${size} pt`);
        elements.sizes.append(label);
    }
    for (const [codepage, settings] of Object.entries(CODEPAGES)) elements.codepage.add(new Option(settings.label, codepage));
    elements.codepage.value = "1252";
    elements.style.replaceChildren(...RIBBI.map((style) => new Option(style, style)));
    elements.format.addEventListener("change", () => {
        updateFormatControls();
        schedule();
    });
    elements.instance.addEventListener("change", () => {
        if (elements.instance.value !== "custom") applyInstance();
        schedule();
    });
    for (const id of ["family", "style", "weight", "detail", "units", "codepage", "hinting", "extra"]) {
        elements[id].addEventListener(id === "family" || id === "extra" ? "input" : "change", schedule);
    }
    elements.sample.addEventListener("input", () => state.output && renderPreview());
    elements["preview-size"].addEventListener("change", () => state.output && renderPreview());
    elements.zoom.addEventListener("change", () => state.output && renderPreview());
    elements.save.addEventListener("click", save);
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
    updateFormatControls();
    setupDesktop({ readmeKey: "ce-porter-fonts-readme" });
}

setup();
