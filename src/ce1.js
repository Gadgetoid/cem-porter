import { Image, u32, setU16 } from "./pe.js";
import { ImportSection, readDescriptors } from "./shim.js";
import { detect, sourceNames } from "./ordinals.js";

export function coredllOrdinalNames(data, tables, targetLabel, helpersLabel) {
    const { label } = detect(data, tables, targetLabel);
    if (!label) return new Map();
    return sourceNames(tables, label, helpersLabel);
}

export function ordinalsToNames(data, names) {
    const image = new Image(data);
    const descriptors = readDescriptors(image);
    const slots = [];
    const unknown = [];
    for (const [originalThunk, , , nameRva, firstThunk] of descriptors) {
        if (image.cString(nameRva).toLowerCase() !== "coredll.dll") continue;
        const lookupRva = originalThunk || firstThunk;
        for (let index = 0; ; index++) {
            const entry = image.word(lookupRva + 4 * index);
            if (!entry) break;
            if (!(entry & 0x80000000)) continue;
            const ordinal = entry & 0xffff;
            const name = names.get(ordinal);
            if (!name) {
                unknown.push(ordinal);
                continue;
            }
            slots.push({ name, lookup: lookupRva + 4 * index, bound: originalThunk ? firstThunk + 4 * index : null });
        }
    }
    if (!slots.length) return { data: null, converted: [], unknown };
    const section = new ImportSection(image, descriptors.length);
    for (const slot of slots) {
        const hintRva = section.hintName(slot.name);
        image.setWord(slot.lookup, hintRva);
        if (slot.bound !== null) image.setWord(slot.bound, hintRva);
    }
    return { data: section.finish(descriptors, "", []), converted: slots.map((slot) => slot.name), unknown };
}

export const CE1_RENAMES = {
    CeCreateDatabase: "PegCreateDatabase", CeDeleteDatabase: "PegDeleteDatabase", CeDeleteRecord: "PegDeleteRecord",
    CeFindFirstDatabase: "PegFindFirstDatabase", CeFindNextDatabase: "PegFindNextDatabase", CeReadRecordProps: "PegReadRecordProps",
    CeSeekDatabase: "PegSeekDatabase", CeSetDatabaseInfo: "PegSetDatabaseInfo", CeWriteRecordProps: "PegWriteRecordProps",
    CeRunAppAtTime: "PegRunAppAtTime", SetClassLongW: "SetClassLong", GetClassLongW: "GetClassLong",
    GetUserDefaultLCID: "GetSystemDefaultLCID", GetUserDefaultLangID: "GetSystemDefaultLangID",
};

export function renameImports(data, renames, available) {
    const image = new Image(data);
    const descriptors = readDescriptors(image);
    const slots = [];
    for (const [originalThunk, , , nameRva, firstThunk] of descriptors) {
        if (image.cString(nameRva).toLowerCase() !== "coredll.dll") continue;
        const lookupRva = originalThunk || firstThunk;
        for (let index = 0; ; index++) {
            const entry = image.word(lookupRva + 4 * index);
            if (!entry) break;
            if (entry & 0x80000000) continue;
            const name = image.cString(entry + 2);
            const replacement = renames[name];
            if (replacement && available.has(replacement)) slots.push({ name, replacement, lookup: lookupRva + 4 * index, bound: originalThunk ? firstThunk + 4 * index : null });
        }
    }
    if (!slots.length) return { data: null, renamed: [] };
    const section = new ImportSection(image, descriptors.length);
    for (const slot of slots) {
        const hintRva = section.hintName(slot.replacement);
        image.setWord(slot.lookup, hintRva);
        if (slot.bound !== null) image.setWord(slot.bound, hintRva);
    }
    return { data: section.finish(descriptors, "", []), renamed: slots.map((slot) => slot.name) };
}

export function moveImports(data, fromDll, toDll) {
    const image = new Image(data);
    const descriptors = readDescriptors(image);
    const moved = [];
    const kept = [];
    for (const descriptor of descriptors) {
        const [originalThunk, , , nameRva, firstThunk] = descriptor;
        if (image.cString(nameRva).toLowerCase() !== fromDll) {
            kept.push(descriptor);
            continue;
        }
        const lookupRva = originalThunk || firstThunk;
        for (let index = 0; ; index++) {
            const entry = image.word(lookupRva + 4 * index);
            if (!entry) break;
            if (entry & 0x80000000) return null;
            moved.push([image.cString(entry + 2), firstThunk + 4 * index]);
        }
    }
    if (!moved.length) return null;
    return new ImportSection(image, kept.length + moved.length).finish(kept, toDll, moved);
}

export function markCe1(data) {
    const output = data.slice();
    const header = u32(output, 0x3c);
    const optional = header + 24;
    setU16(output, header + 22, output[header + 22] & ~1 | (output[header + 23] << 8));
    setU16(output, optional + 48, 1);
    setU16(output, optional + 50, 0);
    return output;
}
