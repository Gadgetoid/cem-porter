import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openRom } from "../src/rom/romimage.js";
import { cpuFamily } from "../src/rom/romcheck.js";
import { readExports } from "../src/pe/romres.js";

const LIBRARY = /\.(dll|cpl|drv|ocx)$/i;
const MAX_ROM_SIZE = 512 * 1024 * 1024;
const [bundlesDirectory, outputDirectory = join(import.meta.dirname, "../data/compat")] = process.argv.slice(2);
if (!bundlesDirectory) throw new Error("usage: node tools/compat-tables.mjs <cerf-bundles directory> [output directory]");

const NAME_WORDS = { hp: "HP", ipaq: "iPAQ", nec: "NEC", ibm: "IBM", lxe: "LXE", hmi: "HMI", omap: "OMAP", evm: "EVM", smdk: "SMDK", devemu: "Device Emulator", mobilepro: "MobilePro", workpad: "WorkPad", simpad: "SIMpad", smartbook: "SmartBook", zune: "Zune", sync: "SYNC" };
const UPPER_WORDS = /^(ce|hpc|ppc|wm|sp|xp|qvga|vga|wvga|wqvga|xaml|expl|wwe|mips|sl4|mk\d+)\d*/;

function nameFromId(id) {
    const words = id.split("_").filter(Boolean);
    return words.map((word, index) => {
        if (NAME_WORDS[word]) return NAME_WORDS[word];
        if (index === words.length - 1 && /^[a-z]{2}$/.test(word)) return word.toUpperCase();
        const modelNumber = /^([a-z]{4,})(\d+)$/.exec(word);
        if (modelNumber) return `${modelNumber[1][0].toUpperCase()}${modelNumber[1].slice(1)} ${modelNumber[2]}`;
        if (/\d|-/.test(word) || UPPER_WORDS.test(word)) return word.toUpperCase();
        return word[0].toUpperCase() + word.slice(1);
    }).join(" ");
}

function ceVersion(region, libraries) {
    if (region.layout === "ce1") return libraries.get("coredll.dll")?.some((entry) => entry[1] === "AFS_CreateFileW") ? [1, 1] : [1, 0];
    return region.version;
}

function ceLabel([major, minor]) {
    if (minor === 0) return `CE ${major}.0`;
    if (major >= 4 && minor % 10 === 0) return `CE ${major}.${minor / 10}`;
    return `CE ${major}.${String(minor).padStart(2, "0")}`;
}

function compactExports(entries) {
    return entries.map((entry) => (entry.name ? [entry.ordinal, entry.name] : entry.ordinal)).sort((left, right) => (left[0] ?? left) - (right[0] ?? right));
}

function romLibraries(rom) {
    const libraries = new Map();
    const regions = [...rom.groups[0], ...rom.regions.filter((region) => !rom.groups[0].includes(region))].filter((region) => region.layout !== "imgfs");
    for (const region of regions) {
        const items = [
            ...region.modules.map((module) => ({ name: module.name, data: () => region.moduleData(module) })),
            ...region.files.filter((file) => LIBRARY.test(file.name)).map((file) => ({ name: file.name, data: () => region.fileData(file) })),
        ];
        for (const item of items) {
            const key = item.name.toLowerCase();
            if (libraries.has(key) || !LIBRARY.test(key)) continue;
            try {
                libraries.set(key, compactExports(readExports(item.data())));
            } catch {
                libraries.set(key, null);
            }
        }
    }
    for (const module of rom.imgfs?.modules ?? []) {
        const key = module.name.toLowerCase();
        if (libraries.has(key) || !LIBRARY.test(key)) continue;
        try {
            libraries.set(key, compactExports(rom.imgfs.exports(module)));
        } catch {
            libraries.set(key, null);
        }
    }
    return libraries;
}

function romCandidates(config) {
    const others = Object.entries(config.rom ?? {}).filter(([key, value]) => key !== "primary" && typeof value === "string" && !/eeprom|erase/i.test(key)).map(([, value]) => value);
    return [config.rom?.primary ?? "", ...others];
}

function bestRom(bundleDirectory, config) {
    let first = null;
    let firstError = null;
    for (const candidate of romCandidates(config)) {
        const romPath = join(bundleDirectory, "rom", candidate);
        try {
            if (!existsSync(romPath)) continue;
            if (statSync(romPath).size > MAX_ROM_SIZE) throw new Error(`${candidate} is over ${MAX_ROM_SIZE / 1048576} MB`);
            const rom = openRom(new Uint8Array(readFileSync(romPath)), candidate);
            const libraries = romLibraries(rom);
            const version = ceVersion(rom.primary, libraries);
            const found = { romPath, rom, libraries, version };
            if (!config.meta.os?.ver_major || version[0] === config.meta.os.ver_major) return found;
            first ??= found;
        } catch (error) {
            firstError ??= error;
        }
    }
    if (first) return first;
    throw firstError ?? new Error("no ROM file in the bundle");
}

function readDevice(bundleDirectory) {
    const name = basename(bundleDirectory);
    const config = JSON.parse(readFileSync(join(bundleDirectory, "cerf.json"), "utf8"));
    const device = { id: name, name: config.meta.device_name ?? nameFromId(name), os: config.meta.os, year: config.meta.device_year ?? null, screen: config.board?.configurable_screen_width ? [config.board.configurable_screen_width, config.board.configurable_screen_height] : null };
    const tables = {};
    try {
        const { romPath, rom, libraries, version } = bestRom(bundleDirectory, config);
        device.rom = basename(romPath);
        const primary = rom.primary;
        if (!libraries.has("coredll.dll")) throw new Error("no COREDLL.DLL found in the ROM");
        device.machine = primary.machine;
        device.family = cpuFamily(primary.machine);
        device.ce = version[0] + version[1] / 100;
        device.ceLabel = ceLabel(version);
        device.format = rom.format;
        device.libraries = {};
        for (const [library, table] of libraries) {
            if (!table) {
                device.libraries[library] = null;
                continue;
            }
            const hash = createHash("sha1").update(JSON.stringify(table)).digest("hex").slice(0, 12);
            tables[library] = { [hash]: table };
            device.libraries[library] = hash;
        }
    } catch (error) {
        device.error = error.message;
    }
    return { device, tables };
}

if (bundlesDirectory === "--one") {
    writeFileSync(process.argv[4], JSON.stringify(readDevice(outputDirectory)));
    process.exit(0);
}

const devices = [];
const tables = new Map();
const scratch = mkdtempSync(join(tmpdir(), "compat-tables-"));
const resultPath = join(scratch, "device.json");
for (const name of readdirSync(bundlesDirectory).sort()) {
    const bundleDirectory = join(bundlesDirectory, name);
    if (!existsSync(join(bundleDirectory, "cerf.json"))) continue;
    rmSync(resultPath, { force: true });
    const child = spawnSync(process.execPath, ["--max-old-space-size=6000", import.meta.filename, "--one", bundleDirectory, resultPath], { stdio: "ignore" });
    let result;
    try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch {
        result = { device: { id: name, error: `reading the ROM failed (exit ${child.status ?? child.signal})` }, tables: {} };
    }
    const { device } = result;
    for (const [library, variants] of Object.entries(result.tables)) {
        if (!tables.has(library)) tables.set(library, new Map());
        for (const [hash, table] of Object.entries(variants)) tables.get(library).set(hash, table);
    }
    devices.push(device);
    console.log(device.error ? `${name}: ${device.error}` : `${name}: ${Object.keys(device.libraries).length} libraries, ${device.ceLabel}, machine 0x${device.machine.toString(16)}`);
}

rmSync(scratch, { recursive: true, force: true });
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(join(outputDirectory, "libraries"), { recursive: true });
writeFileSync(join(outputDirectory, "devices.json"), JSON.stringify(devices));
for (const [library, variants] of tables) writeFileSync(join(outputDirectory, "libraries", `${library}.json`), JSON.stringify(Object.fromEntries(variants)));
console.log(`${devices.length} devices, ${tables.size} libraries, ${[...tables.values()].reduce((sum, variants) => sum + variants.size, 0)} distinct export tables`);
