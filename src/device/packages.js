import { looksLikeCbea, readCbea } from "../archive/cbea.js";
import { findCabinets, listCabinet, readCabinet } from "../archive/cabread.js";
import { isSetup, readSetup } from "../port/cesetup.js";
import { planInstall } from "./cbeainstall.js";

export const ARCHITECTURE_ANY = 0;

const CPU_FAMILIES = [
    [3000, 3910, 3912, 4000, 4100, 4111, 4121, 4200, 4300],
    [10003, 10004],
];

const PLATFORM_NAMES = {
    PocketPC: ["PocketPC"],
};

const ARCHITECTURES = {
    0: "any CPU",
    1824: "ARM720",
    2577: "StrongARM",
    4000: "MIPS",
    10003: "SH3",
    10004: "SH3E",
    10005: "SH4",
    70001: "ARM720",
};

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function looksLikeCeCab(data) {
    try {
        return listCabinet(data).files.some((file) => /\.000$/i.test(file.name));
    } catch {
        return false;
    }
}

function describeCbea(bytes) {
    try {
        const plan = planInstall(readCbea(bytes));
        const bits = [plural(plan.copies.length, "file")];
        if (plan.dirs.length) bits.push(`${plan.dirs.length} folders`);
        if (plan.registry.length) bits.push(`${plan.registry.length} registry entries`);
        const warnings = plan.missing.length
            ? [`${plural(plan.missing.length, "member")} named by the INF are not in the package`]
            : [];
        return {
            program: plan.info.Program || "",
            version: plan.info.Version || "",
            summary: `${bits.join(", ")} into ${plan.installDir}`,
            warnings,
            architecture: null,
        };
    } catch {
        return { program: "", version: "", summary: "", warnings: [], architecture: null };
    }
}

function describeCab(bytes) {
    const setupMember = readCabinet(bytes).find((member) => /\.000$/i.test(member.name) && isSetup(member.data));
    const setup = setupMember ? readSetup(setupMember.data) : null;
    if (!setup) return { program: "", version: "", summary: "", warnings: ["no CE setup file inside"], architecture: null };
    const files = Object.keys(setup.files).length;
    const cpu = ARCHITECTURES[setup.architecture] || `CPU ${setup.architecture}`;
    const [minimumMajor, minimumMinor] = setup.versions;
    return {
        program: setup.app,
        version: "",
        summary: `${setup.provider ? `${setup.provider}, ` : ""}${plural(files, "file")}, for ${cpu}`,
        warnings: [],
        architecture: setup.architecture,
        unsupported: setup.unsupported.split(/[,;]/).map((name) => name.trim()).filter(Boolean),
        minimumOs: minimumMajor ? [minimumMajor, minimumMinor] : null,
    };
}

async function installCab(link, entry, onProgress) {
    const base = entry.name.replace(/[^\w.-]+/g, "_").replace(/\.cab$/i, "") || "install";
    const target = `\\Temp\\${base}.cab`;
    await link.createDirectory("\\Temp");
    await link.sendFile(target, entry.bytes, onProgress);
    const reply = await link.execute("wceload.exe", `"${target}"`);
    if (!reply.ret) throw new Error(`could not start wceload.exe (err ${reply.err})`);
    return `wceload.exe "${target}" started`;
}

export const PACKAGE_KINDS = {
    cbea: {
        label: ".cbea",
        extension: ".cbea",
        method: /cbea/i,
        candidates: (method, bytes) => [bytes],
        detect: looksLikeCbea,
        describe: describeCbea,
        install: async (link, entry, onProgress) => {
            const reply = await link.installPackage(entry.bytes, { onProgress });
            return `CoInstall.exe dispatched (ret=0x${reply.ret.toString(16)})`;
        },
    },
    cab: {
        label: "CE .cab",
        extension: ".cab",
        method: /^cab$|^embedded cab at /i,
        candidates: (method, bytes) => /^cab$/i.test(method) ? [bytes] : findCabinets(bytes).map((cabinet) => cabinet.data),
        detect: looksLikeCeCab,
        describe: describeCab,
        install: installCab,
    },
};

export function architectureName(architecture) {
    return ARCHITECTURES[architecture] || `CPU ${architecture}`;
}

function cpuFamily(type) {
    return CPU_FAMILIES.find((family) => family.includes(type)) || [type];
}

export function devicePlatforms(device) {
    if (!device || !device.platform) return [];
    return device.platform.split(",").flatMap((name) => PLATFORM_NAMES[name.trim()] || [name.trim()]);
}

export function compatibility(target, entry, device = null) {
    if (!target.packages.includes(entry.kind)) {
        return `the ${target.name} does not take ${PACKAGE_KINDS[entry.kind].label} packages`;
    }
    const name = target.serial ? "device" : target.name;
    const architecture = entry.architecture;
    const accepted = target.architectures || (device && device.processorType ? cpuFamily(device.processorType) : null);
    if (accepted && architecture && architecture !== ARCHITECTURE_ANY && !accepted.includes(architecture)) {
        const runs = target.architectures ? target.architectures[0] : device.processorType;
        return `built for ${architectureName(architecture)}; the ${name} runs ${architectureName(runs)}`;
    }
    const platforms = devicePlatforms(device).map((platform) => platform.toLowerCase());
    const refused = (entry.unsupported || []).find((platform) => platforms.includes(platform.toLowerCase()));
    if (refused) return `marked as not for ${refused} devices`;
    if (device && device.osMajor && entry.minimumOs) {
        const [major, minor] = entry.minimumOs;
        if (device.osMajor < major || (device.osMajor === major && device.osMinor < minor)) {
            return `needs Windows CE ${major}.${minor}; the ${name} runs ${device.osMajor}.${device.osMinor}`;
        }
    }
    return null;
}

export function recognise(kinds, name, bytes) {
    for (const kind of kinds) {
        const handler = PACKAGE_KINDS[kind];
        if (!handler.detect(bytes)) continue;
        const described = handler.describe(bytes);
        const baseName = name.split(/[\\/]/).pop();
        const named = baseName.toLowerCase().endsWith(handler.extension) || !described.program;
        const fileName = named ? baseName : `${described.program}${handler.extension}`;
        return { name: fileName, bytes, kind, ...described };
    }
    return null;
}

function tryRecognise(kind, name, bytes) {
    try {
        return recognise([kind], name, bytes);
    } catch {
        return null;
    }
}

export function findPackages(kinds, name, method, bytes) {
    const found = [];
    for (const kind of kinds) {
        const handler = PACKAGE_KINDS[kind];
        if (!handler.method.test(method)) continue;
        for (const candidate of handler.candidates(method, bytes)) {
            const entry = tryRecognise(kind, name, candidate);
            if (entry) found.push(entry);
        }
    }
    return found;
}
