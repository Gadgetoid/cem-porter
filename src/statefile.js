import { gunzipSync } from "../vendor/fflate.js";
import { u32 } from "./pe.js";

const PHYSICAL_MASK = 0x1fffffff;
const SH3_DRAM_PA = 0x0c000000;
const SH3_DRAM_AREA = 64 << 20;
const VELO_CARD_PA = 0x02000000;

const FORMATS = [
    {
        magic: "VELO1 STATE v2",
        emulator: "velo-emu",
        cpu: "MIPS R3910",
        hashAt: 16,
        timeAt: 24,
        recordsAt: 32,
        memory(records) {
            const dram = records.get("dram");
            const card = records.get("dram_card");
            const regions = [{ name: "DRAM", pa: 0, data: dram }];
            if (card?.length) regions.push({ name: "DRAM card", pa: VELO_CARD_PA, data: card });
            return { regions, physical: (pa, length) => slice(regions, pa, length) };
        },
    },
    {
        magic: "SH3ODO01",
        emulator: "sh3emu",
        cpu: "Hitachi SH3",
        hashAt: 9,
        timeAt: 17,
        recordsAt: 25,
        memory(records) {
            const dram = records.get("dram");
            const regions = [{ name: "DRAM", pa: SH3_DRAM_PA, data: dram }];
            const physical = (pa, length) => {
                const offset = pa - SH3_DRAM_PA;
                if (offset < 0 || offset >= SH3_DRAM_AREA) return null;
                const start = offset % dram.length;
                return start + length <= dram.length ? dram.subarray(start, start + length) : null;
            };
            return { regions, physical };
        },
    },
];

function slice(regions, pa, length) {
    for (const region of regions) {
        const offset = pa - region.pa;
        if (offset >= 0 && offset + length <= region.data.length) return region.data.subarray(offset, offset + length);
    }
    return null;
}

function startsWith(data, text) {
    for (let index = 0; index < text.length; index++) if (data[index] !== text.charCodeAt(index)) return false;
    return data[text.length] === 0;
}

function readRecords(data, start) {
    const records = new Map();
    const order = [];
    let cursor = start;
    while (cursor < data.length && data[cursor]) {
        const nameLength = data[cursor++];
        if (cursor + nameLength + 4 > data.length) break;
        const name = String.fromCharCode(...data.subarray(cursor, cursor + nameLength));
        cursor += nameLength;
        const size = u32(data, cursor);
        cursor += 4;
        if (cursor + size > data.length) throw new Error(`the ${name} record runs past the end of the file`);
        records.set(name, data.subarray(cursor, cursor + size));
        order.push({ name, size });
        cursor += size;
    }
    return { records, order };
}

function isGzip(data) {
    return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export function readState(raw) {
    const data = isGzip(raw) ? gunzipSync(raw) : raw;
    const format = FORMATS.find((candidate) => startsWith(data, candidate.magic));
    if (!format) throw new Error("not a velo-emu or sh3emu saved state");
    const { records, order } = readRecords(data, format.recordsAt);
    if (!records.get("dram")?.length) throw new Error("this state has no memory in it");
    const hash = new DataView(data.buffer, data.byteOffset).getBigUint64(format.hashAt, true);
    const seconds = new DataView(data.buffer, data.byteOffset).getBigInt64(format.timeAt, true);
    const memory = format.memory(records);
    return {
        format,
        compressed: data !== raw,
        size: data.length,
        romHash: hash,
        savedAt: seconds ? new Date(Number(seconds) * 1000) : null,
        records: order,
        regions: memory.regions,
        read(va, length) {
            return memory.physical((va & PHYSICAL_MASK) >>> 0, length);
        },
    };
}
