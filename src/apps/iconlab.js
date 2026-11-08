import { unpack } from "../archive/unpack.js";
import { isPe } from "../pe/pe.js";
import { decodeDib } from "../pe/romres.js";
import { readResources, replaceResources } from "../pe/resources.js";
import { DEPTHS, defaultLanguage, encodeIconImage, iconGroups, isPng, nextGroupName, putIconGroup, readIco, removeIconGroup, writeIco } from "../pe/iconcodec.js";
import { saveBytes, setupDesktop } from "../ui/desktop.js";
import { takeHandoff } from "../ui/handoff.js";
import { formatSize } from "../ui/browser.js";

const ids = ["target-drop", "target-title", "target-hint", "target-input", "target-file-row", "target-file", "target-groups", "target-note", "source-drop", "source-title", "source-hint", "source-input", "source-group-row", "source-group", "source-images", "sizes", "depths", "dither", "copy", "preview", "replace", "add", "remove", "revert", "save-ico", "save", "status", "size"];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const state = { target: null, files: [], entries: [], selected: null, changes: 0, source: null, output: [] };
const IMAGE_TYPES = { png: "image/png", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", webp: "image/webp" };
const PE_EXTENSIONS = new Set(["exe", "dll", "cpl"]);

function setStatus(text) {
    elements.status.textContent = text;
}

function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseName(name) {
    return name.split(/[\\/]/).pop();
}

function iconCanvas(image, scale) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
    canvas.style.width = `${image.width * scale}px`;
    canvas.style.height = `${image.height * scale}px`;
    return canvas;
}

function figure(image, scale, caption) {
    const element = document.createElement("figure");
    element.append(image.rgba ? iconCanvas(image, scale) : document.createTextNode("?"));
    if (caption) {
        const label = document.createElement("figcaption");
        label.textContent = caption;
        element.append(label);
    }
    return element;
}

function depthName(bits) {
    return DEPTHS[bits] ?? `${bits}-bit`;
}

function decodeStored(image) {
    const bitmap = isPng(image.data) ? null : decodeDib(image.data, image.width);
    return { width: image.width, height: image.height, bits: image.bits, data: image.data, rgba: bitmap?.rgba ?? null };
}

function peFiles(name, data) {
    if (isPe(data)) return [{ name: baseName(name), data }];
    let files = [];
    try {
        files = unpack(name, data).files;
    } catch {
        return [];
    }
    return files.filter((file) => PE_EXTENSIONS.has(extensionOf(file.path)) && isPe(file.data)).map((file) => ({ name: file.path, data: file.data }));
}

function groupLabel(group, index) {
    const name = typeof group.name === "string" ? `"${group.name}"` : group.name;
    return `Icon ${name}${index === 0 ? " (program icon)" : ""}`;
}

function sameGroup(group, selected) {
    return selected && group.name === selected.name && group.language === selected.language;
}

function renderTarget() {
    const list = elements["target-groups"];
    list.replaceChildren();
    const groups = iconGroups(state.entries);
    list.hidden = !state.target;
    if (state.target && !groups.length) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No icons. Add one.";
        list.append(empty);
    }
    if (state.selected && !groups.some((group) => sameGroup(group, state.selected))) state.selected = null;
    if (!state.selected && groups.length) state.selected = { name: groups[0].name, language: groups[0].language };
    groups.forEach((group, index) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "target-group";
        radio.checked = sameGroup(group, state.selected);
        radio.addEventListener("change", () => {
            state.selected = { name: group.name, language: group.language };
            renderTarget();
        });
        label.append(radio, document.createTextNode(groupLabel(group, index)));
        const images = document.createElement("div");
        images.className = "images";
        for (const image of group.images) images.append(figure(decodeStored(image), 1, `${image.width}x${image.height} ${image.bits}-bit`));
        item.append(label, images);
        list.append(item);
    });
    elements["target-note"].textContent = state.target ? `${plural(groups.length, "icon")}${state.changes ? `, ${plural(state.changes, "change")} not saved` : ""}.` : "";
    updateButtons();
}

function updateButtons() {
    const hasOutput = state.output.length > 0;
    elements.replace.disabled = !state.target || !state.selected || !hasOutput;
    elements.add.disabled = !state.target || !hasOutput;
    elements.remove.disabled = !state.target || !state.selected;
    elements.revert.disabled = !state.changes;
    elements.save.disabled = !state.target || !state.changes;
    elements["save-ico"].disabled = !hasOutput;
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function useTargetFile(index) {
    const file = state.files[index];
    state.target = file;
    state.entries = readResources(file.data);
    state.selected = null;
    state.changes = 0;
    renderTarget();
    setStatus(`${file.name}: ${plural(iconGroups(state.entries).length, "icon")}, ${plural(state.entries.length, "resource")}.`);
}

function loadTarget(name, data) {
    const files = peFiles(name, data);
    elements["target-title"].textContent = baseName(name);
    elements["target-hint"].textContent = formatSize(data.length);
    if (!files.length) {
        state.target = null;
        state.entries = [];
        renderTarget();
        setStatus(`${baseName(name)} isn't a Windows CE program, and has none inside.`);
        return;
    }
    state.files = files;
    elements["target-file-row"].hidden = files.length < 2;
    elements["target-file"].replaceChildren(...files.map((file, index) => new Option(`${file.name} (${formatSize(file.data.length)})`, String(index))));
    useTargetFile(0);
}

async function decodePicture(data, type) {
    const bitmap = await createImageBitmap(new Blob([data], { type }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, bits: 32, rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

async function decodeIconImages(images) {
    return Promise.all(images.map(async (image) => {
        if (isPng(image.data)) return { ...(await decodePicture(image.data, "image/png")), data: null };
        return decodeStored(image);
    }));
}

async function loadSource(name, data) {
    elements["source-title"].textContent = baseName(name);
    elements["source-hint"].textContent = formatSize(data.length);
    const extension = extensionOf(name);
    let groups = [];
    try {
        if (extension === "ico" || readIco(data)?.length && !isPe(data)) {
            groups = [{ label: baseName(name), images: await decodeIconImages(readIco(data) ?? []) }];
        } else if (IMAGE_TYPES[extension] || !peFiles(name, data).length) {
            groups = [{ label: baseName(name), images: [await decodePicture(data, IMAGE_TYPES[extension] ?? "")] }];
        } else {
            for (const file of peFiles(name, data)) {
                iconGroups(readResources(file.data)).forEach((group, index) => groups.push({ label: `${baseName(file.name)}: ${groupLabel(group, index)}`, images: group.images.map(decodeStored) }));
            }
        }
    } catch (error) {
        setStatus(`Couldn't read ${baseName(name)}: ${error.message}`);
        return;
    }
    groups = groups.filter((group) => group.images.some((image) => image.rgba));
    if (!groups.length) {
        setStatus(`${baseName(name)} has no picture or icon this can read.`);
        return;
    }
    state.source = { name: baseName(name), groups, index: 0 };
    elements["source-group-row"].hidden = groups.length < 2;
    elements["source-group"].replaceChildren(...groups.map((group, index) => new Option(group.label, String(index))));
    renderSource();
}

function sourceImages() {
    return state.source ? state.source.groups[state.source.index].images.filter((image) => image.rgba) : [];
}

function renderSource() {
    elements["source-images"].replaceChildren(...sourceImages().map((image) => figure(image, image.width > 64 ? 64 / image.width : 1, `${image.width}x${image.height}${image.bits === 32 && !image.data ? "" : ` ${image.bits}-bit`}`)));
    buildOutput();
}

function checkedValues(container) {
    return [...container.querySelectorAll("input:checked")].map((input) => Number(input.value));
}

function bestSource(images, size) {
    const exact = images.filter((image) => image.width === size && image.height === size).sort((left, right) => right.bits - left.bits);
    if (exact.length) return exact[0];
    const larger = images.filter((image) => image.width > size).sort((left, right) => left.width - right.width || right.bits - left.bits);
    return larger[0] ?? [...images].sort((left, right) => right.width - left.width)[0];
}

function buildOutput() {
    const images = sourceImages();
    const sizes = checkedValues(elements.sizes).sort((left, right) => right - left);
    const depths = checkedValues(elements.depths).sort((left, right) => left - right);
    const dither = elements.dither.checked;
    const copy = elements.copy.checked;
    state.output = [];
    for (const size of sizes) {
        for (const bits of depths) {
            const own = copy && images.find((image) => image.data && image.width === size && image.height === size && image.bits === bits);
            const data = own ? own.data : encodeIconImage(bestSource(images, size), size, bits, dither);
            state.output.push({ width: size, height: size, bits, data, copied: Boolean(own) });
        }
    }
    renderPreview();
    updateButtons();
}

function renderPreview() {
    const preview = elements.preview;
    if (!state.output.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = state.source ? "Pick at least one size and one colour depth." : "Open a new icon to see it here.";
        preview.replaceChildren(empty);
        return;
    }
    const decoded = state.output.map((image) => ({ ...image, rgba: decodeDib(image.data, image.width)?.rgba }));
    const rows = [["white", 1, true], ["desktop", 1, false], ["grey", 1, false], ["white", 3, false]];
    preview.replaceChildren(...rows.map(([backdrop, scale, captions]) => {
        const row = document.createElement("div");
        row.className = `backdrop ${backdrop}`;
        for (const image of decoded) {
            const caption = `${image.width} ${depthName(image.bits)}${image.copied ? ", kept" : ""}`;
            const item = figure(image, scale, captions ? caption : "");
            item.title = caption;
            row.append(item);
        }
        return row;
    }));
    const bytes = state.output.reduce((total, image) => total + image.data.length, 0);
    elements.size.textContent = `${state.output.length} images, ${formatSize(bytes)}`;
}

function outputImages() {
    return state.output.map(({ width, height, bits, data }) => ({ width, height, bits, data }));
}

function replaceSelected() {
    state.entries = putIconGroup(state.entries, state.selected.name, state.selected.language, outputImages());
    state.changes++;
    renderTarget();
    setStatus(`Replaced icon ${state.selected.name} with ${state.output.length} images. Save the program to keep it.`);
}

function addNew() {
    const name = nextGroupName(state.entries);
    const language = state.selected?.language ?? defaultLanguage(state.entries);
    state.entries = putIconGroup(state.entries, name, language, outputImages());
    state.selected = { name, language };
    state.changes++;
    renderTarget();
    setStatus(`Added icon ${name}. Save the program to keep it.`);
}

function removeSelected() {
    const name = state.selected.name;
    state.entries = removeIconGroup(state.entries, state.selected.name, state.selected.language);
    state.selected = null;
    state.changes++;
    renderTarget();
    setStatus(`Removed icon ${name}. Save the program to keep it.`);
}

function revert() {
    useTargetFile(Number(elements["target-file"].value) || 0);
}

function saveProgram() {
    try {
        const result = replaceResources(state.target.data, state.entries);
        const name = baseName(state.target.name);
        saveBytes(result.data, name);
        const index = state.files.indexOf(state.target);
        state.files[index] = { name: state.target.name, data: result.data };
        const selected = state.selected;
        useTargetFile(index);
        state.selected = selected;
        renderTarget();
        setStatus(`Saved ${name} (${formatSize(result.data.length)}): ${plural(iconGroups(state.entries).length, "icon")}, resources ${result.newSection ? "moved to a new section" : "rewritten in place"}.`);
    } catch (error) {
        setStatus(`Couldn't save: ${error.message}`);
    }
}

function saveIco() {
    const name = `${(state.source?.name ?? "icon").replace(/\.[^.]*$/, "")}.ico`;
    saveBytes(writeIco(outputImages()), name);
    setStatus(`Saved ${name}.`);
}

async function readFile(file) {
    return new Uint8Array(await file.arrayBuffer());
}

function setupDrop(prefix, open) {
    const drop = elements[`${prefix}-drop`];
    const input = elements[`${prefix}-input`];
    const handle = async (file) => {
        if (!file) return;
        try {
            await open(file.name, await readFile(file));
        } catch (error) {
            setStatus(`Couldn't open ${file.name}: ${error.message}`);
        }
    };
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            input.click();
        }
    });
    input.addEventListener("change", () => {
        handle(input.files[0]);
        input.value = "";
    });
    drop.addEventListener("dragover", (event) => {
        event.preventDefault();
        drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (event) => {
        event.preventDefault();
        drop.classList.remove("over");
        handle(event.dataTransfer.files[0]);
    });
}

function setup() {
    setupDrop("target", async (name, data) => loadTarget(name, data));
    setupDrop("source", loadSource);
    elements["target-file"].addEventListener("change", () => useTargetFile(Number(elements["target-file"].value)));
    elements["source-group"].addEventListener("change", () => {
        state.source.index = Number(elements["source-group"].value);
        renderSource();
    });
    for (const input of [...elements.sizes.querySelectorAll("input"), ...elements.depths.querySelectorAll("input"), elements.dither, elements.copy]) {
        input.addEventListener("change", () => state.source && buildOutput());
    }
    elements.replace.addEventListener("click", replaceSelected);
    elements.add.addEventListener("click", addNew);
    elements.remove.addEventListener("click", removeSelected);
    elements.revert.addEventListener("click", revert);
    elements.save.addEventListener("click", saveProgram);
    elements["save-ico"].addEventListener("click", saveIco);
    setupDesktop({ readmeKey: "ce-porter-icons-readme" });
    takeHandoff("icons")
        .then((handoff) => {
            if (handoff) loadTarget(handoff.name, handoff.data instanceof Uint8Array ? handoff.data : new Uint8Array(handoff.data));
        })
        .catch(() => {});
}

setup();
