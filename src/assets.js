const JSON_ASSETS = {
    coredllTables: "data/coredll_ordinals.json",
    dllTables: "data/dll_ordinals.json",
    sh3Tables: "data/sh3_ordinals.json",
    velo1: "data/velo1_rom_exports.json",
    hp300lx: "data/hp300lx_rom_exports.json",
    trapNames: "data/ce2-mips-traps.json",
};

const BINARY_ASSETS = {
    velocrt: "VELOCRT.DLL",
    veloshim: "VELOSHIM.DLL",
    stub: "ceinstall.exe",
    ce1compat: "CE1COMPAT.DLL",
};

export async function loadAssets(readBytes) {
    const decoder = new TextDecoder();
    const json = async (path) => JSON.parse(decoder.decode(await readBytes(path)));
    const text = async (path) => decoder.decode(await readBytes(path));
    const assets = { romExports: {}, crtExports: {}, velocrt: {}, veloshim: {}, stub: {}, ce1compat: {} };
    assets.compatExports = (await text("data/ce1compat-exports.txt")).split(/\s+/).filter(Boolean);
    const [coredllTables, dllTables, sh3Tables, velo1, hp300lx, trapNames] = await Promise.all(Object.values(JSON_ASSETS).map(json));
    Object.assign(assets, { coredllTables, dllTables, sh3Tables, trapNames });
    assets.romExports = { velo1, hp300lx };
    for (const cpu of ["mips", "sh3"]) {
        assets.crtExports[cpu] = (await text(`data/${cpu}/velocrt-exports.txt`)).split(/\s+/).filter(Boolean);
        for (const [key, file] of Object.entries(BINARY_ASSETS)) assets[key][cpu] = await readBytes(`data/${cpu}/${file}`);
    }
    return assets;
}

export function fetchBytes(base) {
    return async (path) => {
        const response = await fetch(new URL(path, base));
        if (!response.ok) throw new Error(`couldn't load ${path}`);
        return new Uint8Array(await response.arrayBuffer());
    };
}
