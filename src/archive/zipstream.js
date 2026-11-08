import { Zip, deflateSync } from "../../vendor/fflate.js";
import { crc32 } from "./zip.js";

const PENDING_LIMIT = 16 * 1024 * 1024;

export function zipWriter(level = 6) {
    let blob = new Blob([]);
    let parts = [];
    let pending = 0;
    let failure = null;
    const flush = () => {
        blob = new Blob([blob, ...parts]);
        parts = [];
        pending = 0;
    };
    const zip = new Zip((error, chunk) => {
        if (error) {
            failure = error;
            return;
        }
        parts.push(chunk);
        pending += chunk.length;
        if (pending > PENDING_LIMIT) flush();
    });
    return {
        add(path, data, mtime) {
            const entry = { filename: path, compression: 8, mtime, size: data.length, crc: crc32(data), terminate() {} };
            zip.add(entry);
            entry.ondata(null, deflateSync(data, { level }), true);
            if (failure) throw failure;
        },
        finish() {
            zip.end();
            if (failure) throw failure;
            flush();
            return blob;
        },
    };
}
