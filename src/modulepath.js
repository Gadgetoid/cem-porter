import { Image, align, setU16, setU32, u32 } from "./pe.js";
import { redirect } from "./shim.js";
import { appendSection } from "./traps.js";

export const PATH_MARKER = "CEPATH01";
const PATH_CHARACTERS = 260;
const SETTER = "CePorterSetModulePath";
const COMPAT_DLL = "CE1COMPAT.DLL";

function split(value) {
    const low = value & 0xffff;
    return { high: ((value >>> 16) + (low >= 0x8000 ? 1 : 0)) & 0xffff, low };
}

function mipsStub(slot, path, entry) {
    const words = [];
    const slotParts = split(slot);
    const pathParts = split(path);
    const entryParts = split(entry);
    words.push(0x27bdffd8, 0xafa40010, 0xafa50014, 0xafa60018, 0xafa7001c, 0xafbf0020);
    words.push(0x3c190000 | slotParts.high, 0x8f390000 | slotParts.low);
    words.push(0x3c040000 | pathParts.high, 0x24840000 | pathParts.low);
    words.push(0x0320f809, 0);
    words.push(0x8fa40010, 0x8fa50014, 0x8fa60018, 0x8fa7001c, 0x8fbf0020, 0x27bd0028);
    words.push(0x3c190000 | entryParts.high, 0x27390000 | entryParts.low, 0x03200008, 0);
    const code = new Uint8Array(4 * words.length);
    words.forEach((word, index) => setU32(code, 4 * index, word >>> 0));
    return code;
}

function sh3Stub(slot, path, entry, stubVa) {
    const instructions = [
        0x4f22, 0x2f46, 0x2f56, 0x2f66, 0x2f76, 0x7ff0,
        "slot", 0x6112, "path", 0x410b, 0x0009,
        0x7f10, 0x67f6, 0x66f6, 0x65f6, 0x64f6, 0x4f26,
        "entry", 0x412b, 0x0009,
    ];
    const literalsOffset = align(2 * instructions.length, 4);
    const literals = { slot, path, entry };
    const literalOrder = ["slot", "path", "entry"];
    const code = new Uint8Array(literalsOffset + 4 * literalOrder.length);
    instructions.forEach((instruction, index) => {
        let word = instruction;
        if (typeof instruction === "string") {
            const register = instruction === "path" ? 4 : 1;
            const literalAddress = stubVa + literalsOffset + 4 * literalOrder.indexOf(instruction);
            const pc = stubVa + 2 * index;
            const displacement = (literalAddress - ((pc & ~3) + 4)) / 4;
            word = 0xd000 | (register << 8) | displacement;
        }
        setU16(code, 2 * index, word);
    });
    literalOrder.forEach((name, index) => setU32(code, literalsOffset + 4 * index, literals[name] >>> 0));
    return code;
}

export function embedModulePath(data, cpu, path) {
    const image = new Image(data);
    const sectionEnds = image.sections.map((section) => section.virtualAddress + Math.max(section.virtualSize, section.rawSize));
    const sectionVa = align(Math.max(...sectionEnds), image.sectionAlignment);
    const pathOffset = PATH_MARKER.length;
    const slotOffset = pathOffset + 2 * PATH_CHARACTERS;
    const stubOffset = slotOffset + 4;
    const base = image.imageBase + sectionVa;
    const entry = image.imageBase + u32(data, image.optional + 16);
    const stub = cpu === "sh3" ? sh3Stub(base + slotOffset, base + pathOffset, entry, base + stubOffset) : mipsStub(base + slotOffset, base + pathOffset, entry);
    const contents = new Uint8Array(stubOffset + stub.length);
    for (let index = 0; index < PATH_MARKER.length; index++) contents[index] = PATH_MARKER.charCodeAt(index);
    for (let index = 0; index < Math.min(path.length, PATH_CHARACTERS - 1); index++) setU16(contents, pathOffset + 2 * index, path.charCodeAt(index));
    contents.set(stub, stubOffset);
    const output = appendSection(data, contents, sectionVa, ".cepath");
    setU32(output, image.optional + 16, sectionVa + stubOffset);
    return redirect(output, COMPAT_DLL, [[SETTER, sectionVa + slotOffset]]);
}
