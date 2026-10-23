const PALETTE = {
    k: [0, 0, 0], w: [255, 255, 255], g: [192, 192, 192], d: [128, 128, 128], y: [255, 255, 0], o: [128, 128, 0],
    b: [0, 0, 170], c: [0, 170, 170], r: [192, 0, 0], n: [0, 128, 0],
};

const PAGE = [
    "..kkkkkkkk......",
    "..kwwwwwwkk.....",
    "..kwwwwwwkwk....",
    "..kwwwwwwkkkk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kwwwwwwwwwk...",
    "..kkkkkkkkkkk...",
    "................",
];

function onPage(rows) {
    return PAGE.map((line, index) => {
        const overlay = rows[index - 4];
        if (!overlay) return line;
        return line.slice(0, 3) + overlay.padEnd(9, "w").slice(0, 9) + line.slice(12);
    });
}

const ART = {
    folder: [
        "................",
        "................",
        "................",
        ".kkkkk..........",
        "kyyyyyk.........",
        "kywywyykkkkkkk..",
        "kwyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "kyyyyyyyyyyyyok.",
        "koooooooooooook.",
        ".kkkkkkkkkkkkkk.",
        "................",
    ],
    file: PAGE,
    text: onPage(["wdddddddw", "wwwwwwwww", "wdddddddw", "wwwwwwwww", "wddddddww", "wwwwwwwww", "wdddddddw", "wwwwwwwww", "wdddddww"]),
    settings: onPage(["wwwwwwwww", "wwkkkkkww", "wwkgggkww", "wwkgdgkww", "wwkgggkww", "wwkkkkkww", "wwwwwwwww", "wdddddddw"]),
    help: onPage(["wwwbbbwww", "wwbwwwbww", "wwwwwwbww", "wwwwwbwww", "wwwwbwwww", "wwwwbwwww", "wwwwwwwww", "wwwwbwwww"]),
    sound: onPage(["wwwwwkwww", "wwwwwkkww", "wwwwwkwkw", "wwwwwkwww", "wwwwwkwww", "wwwkkkwww", "wwkkkkwww", "wwwkkwwww"]),
    image: onPage(["wwwwwwwww", "wcccccccw", "wcccyyccw", "wcccyyccw", "wcnccccnw", "wnnncnnnw", "wnnnnnnnw", "wwwwwwwww"]),
    font: onPage(["wwwwwwwww", "wwwwrwwww", "wwwrwrwww", "wwrwwwrww", "wwrrrrrww", "wwrwwwrww", "wwrwwwrww", "wwwwwwwww"]),
    data: onPage(["wwwwwwwww", "wkkkkkkkw", "wkgkgkgkw", "wkkkkkkkw", "wkgkgkgkw", "wkkkkkkkw", "wkgkgkgkw", "wkkkkkkkw"]),
    library: onPage(["wwwwwwwww", "wwwkkkwww", "wwkgggkww", "wkgkdkgkw", "wkgdwdgkw", "wkgkdkgkw", "wwkgggkww", "wwwkkkwww"]),
    application: [
        "................",
        "................",
        "kkkkkkkkkkkkkkkk",
        "kbbbbbbbbbbbbbbk",
        "kbwwbbbbbbbbbbbk",
        "kkkkkkkkkkkkkkkk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kwwwwwwwwwwwwwwk",
        "kkkkkkkkkkkkkkkk",
        "................",
        "................",
    ],
};

const ARROW = [
    "kkkkkkk",
    "kwwwwwk",
    "kwwkkkk",
    "kwkwkwk",
    "kkwwkwk",
    "kwwwwwk",
    "kkkkkkk",
];

const EXTENSION_ICONS = {
    exe: "application", dll: "library", cpl: "library", drv: "library", ocx: "library", txt: "text", ini: "settings", inf: "settings", reg: "settings",
    htc: "help", htp: "help", htm: "text", html: "text", wav: "sound", mid: "sound", bmp: "image", "2bp": "image", gif: "image", jpg: "image", ico: "image",
    ttf: "font", ttc: "font", fnt: "font", fon: "font", dat: "data", fdf: "data", nls: "data", db: "data", tlb: "data",
};

export function iconKind(node, extension) {
    if (node.kind === "folder") return "folder";
    return EXTENSION_ICONS[extension] ?? "file";
}

const cache = new Map();

function canvas(size) {
    const element = document.createElement("canvas");
    element.width = size;
    element.height = size;
    return element;
}

function paintArt(context, art, scale, offsetX = 0, offsetY = 0) {
    art.forEach((line, row) => {
        [...line].forEach((key, column) => {
            const colour = PALETTE[key];
            if (!colour) return;
            context.fillStyle = `rgb(${colour.join(",")})`;
            context.fillRect(offsetX + column * scale, offsetY + row * scale, scale, scale);
        });
    });
}

function paintOverlay(context, size) {
    const scale = size >= 32 ? 2 : 1;
    paintArt(context, ARROW, scale, 0, size - ARROW.length * scale);
}

export function artIcon(kind, size, shortcut = false) {
    const key = `${kind}:${size}:${shortcut}`;
    if (cache.has(key)) return cache.get(key);
    const element = canvas(size);
    const context = element.getContext("2d");
    paintArt(context, ART[kind] ?? ART.file, size / 16);
    if (shortcut) paintOverlay(context, size);
    const url = element.toDataURL();
    cache.set(key, url);
    return url;
}

export function bitmapIcon(icon, size, shortcut = false) {
    const element = canvas(size);
    const context = element.getContext("2d");
    const source = canvas(icon.width);
    source.height = icon.height;
    source.getContext("2d").putImageData(new ImageData(icon.rgba, icon.width, icon.height), 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, size, size);
    if (shortcut) paintOverlay(context, size);
    return element.toDataURL();
}
