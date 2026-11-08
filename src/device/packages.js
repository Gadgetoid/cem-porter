import { looksLikeCbea, readCbea } from "../archive/cbea.js";
import { listCabinet, readCabinet } from "../archive/cabread.js";
import { isSetup, readSetup } from "../port/cesetup.js";
import { planInstall } from "./cbeainstall.js";

export const ARCHITECTURE_ANY = 0;

const ARCHITECTURES = {
    0: "any CPU",
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
    return {
        program: setup.app,
        version: "",
        summary: `${setup.provider ? `${setup.provider}, ` : ""}${plural(files, "file")}, for ${cpu}`,
        warnings: [],
        architecture: setup.architecture,
    };
}

export const PACKAGE_KINDS = {
    cbea: {
        label: ".cbea",
        method: /cbea/i,
        detect: looksLikeCbea,
        describe: describeCbea,
        install: async (link, entry, onProgress) => {
            const reply = await link.installPackage(entry.bytes, { onProgress });
            return `CoInstall.exe dispatched (ret=0x${reply.ret.toString(16)})`;
        },
    },
    cab: {
        label: "CE .cab",
        method: /^cab$/i,
        detect: looksLikeCeCab,
        describe: describeCab,
        install: async (link, entry, onProgress) => {
            const reply = await link.installCab(entry.name, entry.bytes, { onProgress });
            return `wceload.exe started (process ${reply.processId.toString(16)})`;
        },
    },
};

export function architectureName(architecture) {
    return ARCHITECTURES[architecture] || `CPU ${architecture}`;
}

export function compatibility(target, entry) {
    if (!target.packages.includes(entry.kind)) {
        return `the ${target.name} does not take ${PACKAGE_KINDS[entry.kind].label} packages`;
    }
    const architecture = entry.architecture;
    if (architecture === null || architecture === undefined || architecture === ARCHITECTURE_ANY) return null;
    if (target.architectures && !target.architectures.includes(architecture)) {
        return `built for ${architectureName(architecture)}; the ${target.name} runs ${target.architectures.map(architectureName).join(" or ")}`;
    }
    return null;
}

export function recognise(kinds, name, bytes) {
    for (const kind of kinds) {
        const handler = PACKAGE_KINDS[kind];
        if (!handler.detect(bytes)) continue;
        return { name, bytes, kind, ...handler.describe(bytes) };
    }
    return null;
}
