import { facts, table } from "./browser.js";
import { charsetName, readBitmapFonts, readBuzzer, readTrueType } from "../fonts/fontfile.js";
import { englishName } from "../fonts/fontconvert.js";
import { countRegistry, formatValue, keyPath, readRegistryFile, REGISTRY_TYPES } from "../rom/regfile.js";
import { readIcons } from "../pe/romres.js";
import { artIcon } from "./romicons.js";

const SAMPLE = "The quick brown fox jumps over the lazy dog. 0123456789";
const CJK_SAMPLE = " あいうえお 日本語";
const TRUETYPE_SIZES = [9, 10, 12, 16, 24, 36];
const CHARACTERS_PER_ROW = 32;
const BUZZER_VOLUME = 0.08;

function paragraph(text) {
    const element = document.createElement("p");
    element.textContent = text;
    return element;
}

function pixelCanvas(width, height, paint, scale = 2) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const context = canvas.getContext("2d");
    const image = context.createImageData(canvas.width, canvas.height);
    paint(image.data, canvas.width);
    context.putImageData(image, 0, 0);
    canvas.className = "preview-image";
    canvas.style.width = `${canvas.width * scale}px`;
    return canvas;
}

export function iconsPreview(data) {
    const groups = readIcons(data);
    const content = [paragraph(`${groups.length} icon${groups.length === 1 ? "" : "s"}, ${groups.reduce((total, group) => total + group.images.length, 0)} images.`)];
    for (const group of groups) {
        const section = document.createElement("div");
        section.className = "icon-group";
        const title = document.createElement("strong");
        title.textContent = group.id === null || group.id === undefined ? "Named icon" : `Icon ${group.id}`;
        const row = document.createElement("div");
        row.className = "icon-images";
        for (const entry of group.images) {
            const figure = document.createElement("figure");
            const caption = document.createElement("figcaption");
            caption.textContent = `${entry.width}x${entry.height}, ${entry.bits}-bit`;
            if (entry.bitmap) {
                const bitmap = entry.bitmap;
                figure.append(pixelCanvas(bitmap.width, bitmap.height, (pixels) => pixels.set(bitmap.rgba)));
            } else {
                caption.textContent += ", unreadable";
            }
            figure.append(caption);
            row.append(figure);
        }
        section.append(title, row);
        content.push(section);
    }
    return content;
}

function glyphFor(font, code) {
    return font.glyphs.get(code) ?? font.glyphs.get(font.defaultChar) ?? font.glyphs.values().next().value;
}

function bitmapText(font, lines) {
    const rows = lines.map((line) => [...line].map((character) => glyphFor(font, character.charCodeAt(0))).filter(Boolean));
    const width = Math.max(...rows.map((glyphs) => glyphs.reduce((total, glyph) => total + glyph.width, 0)));
    return pixelCanvas(width, font.height * rows.length, (pixels, stride) => {
        pixels.fill(255);
        rows.forEach((glyphs, row) => {
            let left = 0;
            for (const glyph of glyphs) {
                for (let y = 0; y < font.height; y++) {
                    for (let x = 0; x < glyph.width; x++) {
                        if (!glyph.pixels[y * glyph.width + x]) continue;
                        const target = 4 * ((row * font.height + y) * stride + left + x);
                        pixels[target] = pixels[target + 1] = pixels[target + 2] = 0;
                    }
                }
                left += glyph.width;
            }
        });
    });
}

function characterRows(font) {
    const rows = [];
    for (let start = font.firstChar - font.firstChar % CHARACTERS_PER_ROW; start <= font.lastChar; start += CHARACTERS_PER_ROW) {
        let row = "";
        for (let code = Math.max(start, font.firstChar); code < start + CHARACTERS_PER_ROW && code <= font.lastChar; code++) row += String.fromCharCode(code);
        rows.push(row);
    }
    return rows;
}

function fontDescription(font) {
    const style = [font.weight >= 700 ? "bold" : "", font.italic ? "italic" : ""].filter(Boolean);
    return `${font.face || "Unnamed"} ${font.points} pt, ${font.height} px${style.length ? `, ${style.join(", ")}` : ""}`;
}

function bitmapFontPreview(result) {
    const { fonts, unsupported } = result;
    const first = fonts[0];
    const content = [];
    const rows = [["Fonts", String(fonts.length)]];
    if (first) rows.push(["Format", `Windows bitmap font, version ${first.version}`], ["Character set", charsetName(first.charset)], ["Characters", `${first.firstChar} to ${first.lastChar}`], ["Copyright", first.copyright]);
    if (unsupported.length) rows.push(["Not shown", `Fonts in a format this can't read (version ${unsupported.map((version) => `0x${version.toString(16)}`).join(", ")})`]);
    content.push(facts(rows));
    for (const font of fonts) {
        const title = document.createElement("strong");
        title.textContent = fontDescription(font);
        content.push(title);
        if (font.vector) {
            content.push(paragraph("Vector font; not drawn."));
            continue;
        }
        content.push(bitmapText(font, [SAMPLE]), bitmapText(font, characterRows(font)));
    }
    return content;
}

function sampleFor(font) {
    const has = (character) => font.charToGlyphIndex(character) > 0;
    if (!has("a") && has("")) return [...SAMPLE].map((character) => String.fromCharCode(0xf000 + character.charCodeAt(0))).join("");
    return SAMPLE + (has("あ") ? CJK_SAMPLE : "");
}

function trueTypeLine(font, text, size) {
    const scale = window.devicePixelRatio || 1;
    const width = Math.ceil(font.getAdvanceWidth(text, size)) + 4;
    const height = Math.ceil(size * 1.4);
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.style.width = `${width}px`;
    canvas.className = "font-sample";
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    const path = font.getPath(text, 2, Math.round(size * 1.1), size);
    path.fill = "#000";
    path.draw(context);
    const line = document.createElement("div");
    line.className = "font-line";
    line.append(canvas);
    return line;
}

function trueTypePreview(data) {
    const { font, faces } = readTrueType(data);
    const content = [facts([
        ["Family", englishName(font, "fontFamily")],
        ["Style", englishName(font, "fontSubfamily")],
        ["Version", englishName(font, "version")],
        ["Glyphs", String(font.numGlyphs)],
        ["Units per em", String(font.unitsPerEm)],
        ["Collection", faces > 1 ? `${faces} fonts; showing the first` : ""],
        ["Copyright", englishName(font, "copyright")],
    ])];
    const sample = sampleFor(font);
    for (const size of TRUETYPE_SIZES) {
        const label = document.createElement("span");
        label.className = "font-size";
        label.textContent = `${size} px`;
        content.push(label, trueTypeLine(font, sample, size));
    }
    return content;
}

export function fontPreview(data) {
    const bitmap = readBitmapFonts(data);
    if (bitmap) return bitmapFontPreview(bitmap);
    try {
        return trueTypePreview(data);
    } catch (error) {
        return [facts([["Couldn't read this font", error.message]])];
    }
}

let audio = null;

function playTones(tones) {
    audio ??= new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "square";
    let time = audio.currentTime + 0.02;
    for (const tone of tones) {
        oscillator.frequency.setValueAtTime(tone.frequency || 440, time);
        gain.gain.setValueAtTime(tone.frequency ? BUZZER_VOLUME : 0, time);
        time += tone.duration / 1000;
    }
    gain.gain.setValueAtTime(0, time);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(time + 0.01);
}

export function buzzerPreview(data) {
    const tones = readBuzzer(data);
    if (!tones) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Play";
    button.addEventListener("click", () => playTones(tones));
    const total = tones.reduce((sum, tone) => sum + tone.duration, 0);
    return [
        facts([["Format", "Buzzer tones: frequency (Hz) and length (ms) pairs"], ["Tones", String(tones.length)], ["Length", `${total} ms`]]),
        button,
        table(["Frequency", "Length"], tones.map((tone) => [tone.frequency ? `${tone.frequency} Hz` : "Silence", `${tone.duration} ms`]), [0, 1]),
    ];
}

function byName(left, right) {
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function valueRows(body, key) {
    body.replaceChildren();
    const values = [...key.values].sort(byName);
    for (const value of values) {
        const row = body.insertRow();
        const name = row.insertCell();
        name.className = "name";
        const image = document.createElement("img");
        image.alt = "";
        image.src = artIcon(value.type === 1 || value.type === 2 || value.type === 7 ? "text" : "data", 16);
        const label = document.createElement("span");
        label.textContent = value.name || "(Default)";
        name.append(image, label);
        row.insertCell().textContent = REGISTRY_TYPES[value.type] ?? `Type ${value.type}`;
        const cell = row.insertCell();
        cell.className = "data";
        cell.textContent = formatValue(value);
    }
    if (!values.length) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = 3;
        cell.className = "empty";
        cell.textContent = key.parent ? "No values." : "Root key.";
    }
}

export function registryPreview(data) {
    let registry;
    try {
        registry = readRegistryFile(data);
    } catch {
        return null;
    }
    if (!registry?.roots.length) return null;
    const { keys, values } = countRegistry(registry.roots);
    const notes = [registry.damaged ? "some entries couldn't be read" : "", registry.deleted ? `${registry.deleted} deletions not shown` : ""].filter(Boolean);
    const summary = paragraph(`${registry.format}: ${keys} keys, ${values} values${notes.length ? `; ${notes.join(", ")}` : ""}.`);
    const path = document.createElement("div");
    path.className = "reg-path";
    const editor = document.createElement("div");
    editor.className = "regedit";
    const tree = document.createElement("ul");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Keys");
    const list = document.createElement("div");
    list.className = "list";
    const valuesTable = document.createElement("table");
    valuesTable.createTHead().insertRow().append(...["Name", "Type", "Data"].map((text) => {
        const th = document.createElement("th");
        th.textContent = text;
        return th;
    }));
    const body = valuesTable.createTBody();
    list.append(valuesTable);
    editor.append(tree, list);
    const nodes = new Map();
    let selected = null;

    function select(item) {
        if (selected) {
            selected.tabIndex = -1;
            selected.setAttribute("aria-selected", "false");
        }
        selected = item;
        item.tabIndex = 0;
        item.setAttribute("aria-selected", "true");
        const key = nodes.get(item);
        path.textContent = keyPath(key);
        valueRows(body, key);
        list.scrollTop = 0;
    }

    function setExpanded(item, expanded) {
        const key = nodes.get(item);
        if (!key.keys.length) return;
        let group = item.querySelector(":scope > ul");
        if (expanded && !group) {
            group = document.createElement("ul");
            group.setAttribute("role", "group");
            [...key.keys].sort(byName).forEach((child) => group.append(treeItem(child)));
            item.append(group);
        }
        if (group) group.hidden = !expanded;
        item.setAttribute("aria-expanded", String(expanded));
        item.querySelector(":scope > .reg-row .toggle").textContent = expanded ? "-" : "+";
    }

    function treeItem(key) {
        const item = document.createElement("li");
        item.setAttribute("role", "treeitem");
        item.setAttribute("aria-selected", "false");
        item.tabIndex = -1;
        const row = document.createElement("div");
        row.className = "reg-row";
        const toggle = document.createElement("span");
        toggle.className = "toggle";
        toggle.setAttribute("aria-hidden", "true");
        toggle.textContent = key.keys.length ? "+" : "";
        const image = document.createElement("img");
        image.alt = "";
        image.src = artIcon("folder", 16);
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = key.name + (key.damaged ? " (damaged)" : "");
        row.append(toggle, image, label);
        item.append(row);
        if (key.keys.length) item.setAttribute("aria-expanded", "false");
        nodes.set(item, key);
        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            setExpanded(item, item.getAttribute("aria-expanded") !== "true");
        });
        row.addEventListener("click", () => {
            select(item);
            item.focus();
        });
        row.addEventListener("dblclick", () => setExpanded(item, item.getAttribute("aria-expanded") !== "true"));
        return item;
    }

    function visibleItems() {
        return [...tree.querySelectorAll("li")].filter((item) => !item.closest("ul[hidden]"));
    }

    tree.addEventListener("keydown", (event) => {
        if (!selected) return;
        const items = visibleItems();
        const index = items.indexOf(selected);
        const expanded = selected.getAttribute("aria-expanded");
        let next = null;
        if (event.key === "ArrowDown") next = items[index + 1];
        else if (event.key === "ArrowUp") next = items[index - 1];
        else if (event.key === "Home") next = items[0];
        else if (event.key === "End") next = items[items.length - 1];
        else if (event.key === "ArrowRight") {
            if (expanded === "false") setExpanded(selected, true);
            else if (expanded === "true") next = items[index + 1];
        } else if (event.key === "ArrowLeft") {
            if (expanded === "true") setExpanded(selected, false);
            else next = selected.parentElement.closest("li");
        } else if (event.key === "Enter" && expanded) {
            setExpanded(selected, expanded !== "true");
        } else {
            return;
        }
        event.preventDefault();
        if (next) {
            select(next);
            next.focus();
            next.scrollIntoView({ block: "nearest" });
        }
    });

    registry.roots.forEach((root) => tree.append(treeItem(root)));
    select(tree.firstElementChild);
    if (registry.roots.length === 1) setExpanded(tree.firstElementChild, true);
    return [summary, path, editor];
}
