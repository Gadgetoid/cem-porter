const VENDOR = 0x07cf;
const PRODUCT = 0x2002;
const EP_IN = 1;
const EP_OUT = 2;

const SET_CONTROL_LINE_STATE = 0x22;
const DTR_AND_RTS = 0x0003;

const REQUEST = 0x10;
const REPLY = 0x11;
const HANDSHAKE = 0x55;
const ACK = 0x20;
const HEADER = 10;

export const CMD = {
    version: 0x0301,
    closeHandle: 0x0309,
    createDirectory: 0x030b,
    createFile: 0x030c,
    readFile: 0x0319,
    writeFile: 0x031f,
    getLastError: 0x0316,
    systemDisk: 0x0338,
    innerUserDisk: 0x0339,
    softReset: 0x032a,
    coshExecute: 0x033c,
    nandOpen: 0x033f,
    nandClose: 0x0340,
    nandGetInfo: 0x0341,
    nandReadSector: 0x0342,
    uuid: 0x0346,
};

export const NAND_BASE = 7584;
export const NAND_TOTAL = 32768;
export const SECTOR = 512;

const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;

export function u32be(value) {
    const out = new Uint8Array(4);
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return out;
}

export function wstr(text) {
    const body = new Uint8Array((text.length + 1) * 2);
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        body[index * 2] = (code >>> 8) & 0xff;
        body[index * 2 + 1] = code & 0xff;
    }
    const out = new Uint8Array(2 + body.length);
    out[0] = (body.length >>> 8) & 0xff;
    out[1] = body.length & 0xff;
    out.set(body, 2);
    return out;
}

export function joinBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
        out.set(part, position);
        position += part.length;
    }
    return out;
}

export function buildFrame(command, payload = new Uint8Array(0)) {
    const total = HEADER + payload.length;
    const out = new Uint8Array(total);
    out[0] = REQUEST;
    out[1] = 0;
    out[2] = (total >>> 8) & 0xff;
    out[3] = total & 0xff;
    out[4] = (command >>> 8) & 0xff;
    out[5] = command & 0xff;
    let payloadSum = 0;
    for (const byte of payload) payloadSum = (payloadSum + byte) & 0xffff;
    out[6] = (payloadSum >>> 8) & 0xff;
    out[7] = payloadSum & 0xff;
    let headerSum = 0;
    for (let index = 0; index < 8; index++) headerSum = (headerSum + out[index]) & 0xffff;
    out[8] = (headerSum >>> 8) & 0xff;
    out[9] = headerSum & 0xff;
    out.set(payload, HEADER);
    return out;
}

export function isSupported() {
    return typeof navigator !== "undefined" && !!navigator.usb;
}

export class BeLink {
    constructor() {
        this.device = null;
        this.buffer = [];
        this.onLog = null;
        this.queue = Promise.resolve();
        this.heartbeat = null;
        this.reading = false;
        this.loop = null;
        this.chunkSize = 1024;
        this.splitHeader = true;
    }

    enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    startReader() {
        this.reading = true;
        this.loop = (async () => {
            while (this.reading && this.device) {
                let data;
                try {
                    data = await this.readChunk(512);
                } catch {
                    break;
                }
                for (const byte of data) {
                    if (!this.buffer.length) {
                        if (byte === HANDSHAKE) {
                            this.enqueue(() => this.keepAlive());
                            continue;
                        }
                        if (byte !== REPLY) continue;
                    }
                    this.buffer.push(byte);
                }
            }
        })();
    }

    startHeartbeat(period = 150) {
        this.stopHeartbeat();
        this.startReader();
        this.heartbeat = setInterval(() => {
            if (this.device) this.enqueue(() => this.keepAlive());
        }, period);
    }

    stopHeartbeat() {
        this.reading = false;
        if (this.heartbeat !== null) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    async drain() {
        try {
            const data = await this.readChunk(512);
            for (const byte of data) {
                if (!this.buffer.length && (byte === HANDSHAKE || byte === ACK)) {
                    if (byte === HANDSHAKE) await this.keepAlive();
                    continue;
                }
                this.buffer.push(byte);
            }
        } catch {
            // nothing pending
        }
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    async request() {
        this.device = await navigator.usb.requestDevice({
            filters: (this.filters && this.filters.length)
                ? this.filters
                : [{ vendorId: VENDOR, productId: PRODUCT }],
        });
        return this.device;
    }

    async open() {
        if (!this.device) throw new Error("no device chosen");
        await this.device.open();
        if (!this.device.configuration) await this.device.selectConfiguration(1);
        await this.device.claimInterface(0);
        await this.device.controlTransferOut({
            requestType: "class",
            recipient: "interface",
            request: SET_CONTROL_LINE_STATE,
            value: DTR_AND_RTS,
            index: 0,
        });
    }

    async close() {
        this.stopHeartbeat();
        if (!this.device) return;
        try {
            await this.device.releaseInterface(0);
        } catch {
            // the device commonly vanishes first
        }
        try {
            await this.device.close();
        } catch {
            // as above
        }
        this.device = null;
        this.buffer = [];
    }

    async readChunk(length = 512) {
        const result = await this.device.transferIn(EP_IN, length);
        if (!result.data || !result.data.byteLength) return new Uint8Array(0);
        return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    }

    async writeBytes(bytes) {
        const result = await this.device.transferOut(EP_OUT, bytes);
        if (result && result.status === "stall") {
            await this.device.clearHalt("out", EP_OUT);
            throw new Error("endpoint stalled on write");
        }
    }

    async handshake(attempts = 400) {
        let consecutive = 0;
        for (let round = 0; round < attempts; round++) {
            await this.writeBytes(Uint8Array.of(HANDSHAKE));
            const data = await this.readChunk(64);
            if (!data.length) {
                consecutive = 0;
                continue;
            }
            if (data[data.length - 1] === HANDSHAKE) {
                consecutive++;
                if (consecutive >= 2) return true;
            } else {
                consecutive = 0;
            }
        }
        return false;
    }

    async pump() {
        const data = await this.readChunk(512);
        for (const byte of data) {
            if (!this.buffer.length && (byte === HANDSHAKE || byte === ACK)) {
                if (byte === HANDSHAKE) await this.writeBytes(Uint8Array.of(HANDSHAKE));
                continue;
            }
            this.buffer.push(byte);
        }
    }

    takeFrame() {
        while (this.buffer.length && this.buffer[0] !== REPLY) this.buffer.shift();
        if (this.buffer.length < HEADER) return null;
        const total = (this.buffer[2] << 8) | this.buffer[3];
        if (total < HEADER || this.buffer.length < total) return null;
        const frame = Uint8Array.from(this.buffer.slice(0, total));
        this.buffer = this.buffer.slice(total);
        return frame;
    }

    async receive(timeout = 6000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const frame = this.takeFrame();
            if (frame) return frame;
            if (this.reading) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            } else {
                await this.pump();
            }
        }
        return null;
    }

    call(command, payload) {
        return this.enqueue(async () => {
            this.buffer.length = 0;
            return this.rawCall(command, payload);
        });
    }

    async rawCall(command, payload) {
        if (!this.device) throw new Error("link is closed");
        const request = buildFrame(command, payload);
        if (this.splitHeader && request.length > HEADER) {
            await this.writeBytes(request.subarray(0, HEADER));
            await this.writeBytes(request.subarray(HEADER));
        } else {
            await this.writeBytes(request);
        }
        const frame = await this.receive();
        if (!frame) throw new Error(`no reply to command 0x${command.toString(16)}`);
        if (frame[0] !== REPLY) throw new Error("unexpected frame type");
        const body = frame.subarray(HEADER);
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const reply = {
            ret: body.length >= 4 ? view.getUint32(0, false) : 0,
            err: body.length >= 8 ? view.getUint32(4, false) : 0,
            data: body.subarray(8),
        };
        return reply;
    }

    keepAlive() {
        try {
            return this.writeBytes(Uint8Array.of(HANDSHAKE)).catch(() => undefined);
        } catch {
            return undefined;
        }
    }

    async connect() {
        await this.open();
        this.log("asserted DTR and RTS");
        if (!await this.handshake()) throw new Error("handshake failed; press Connect on the device");
        this.log("connected");
    }

    async deviceInfo() {
        const info = {};
        const version = await this.call(CMD.version, new Uint8Array(0));
        info.version = version.ret;

        const uuid = await this.call(CMD.uuid, new Uint8Array(0));
        if (uuid.data.length >= 16) {
            const hex = [...uuid.data.subarray(0, 16)]
                .map((byte) => byte.toString(16).padStart(2, "0")).join("");
            info.uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }

        return info;
    }

    async diskNames() {
        const disk = await this.call(CMD.systemDisk, joinBytes([u32be(1), u32be(260)]));
        const user = await this.call(CMD.innerUserDisk, joinBytes([u32be(1), u32be(260)]));
        return { systemDisk: decodeWide(disk.data), userDisk: decodeWide(user.data) };
    }

    async nandOpen() {
        const opened = await this.call(CMD.nandOpen, new Uint8Array(0));
        if (!opened.ret) throw new Error("WilNANDOpen failed");
        return opened.ret;
    }

    async nandInfo(handle) {
        const info = await this.call(CMD.nandGetInfo, u32be(handle));
        const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
        return {
            sectors: view.getUint32(0, false),
            sectorSize: view.getUint32(4, false),
        };
    }

    async readSectors(handle, physical, count) {
        const logical = (physical - NAND_BASE) >>> 0;
        const reply = await this.call(CMD.nandReadSector,
            joinBytes([u32be(handle), u32be(logical), u32be(count)]));
        if (reply.data.length !== count * SECTOR) {
            throw new Error(`short read at sector ${physical}`);
        }
        return reply.data;
    }

    async sendFile(path, bytes, onProgress) {
        this.log(`creating ${path}`);
        const created = await this.call(CMD.createFile, joinBytes([
            wstr(path),
            u32be(GENERIC_WRITE),
            u32be(0),
            u32be(CREATE_ALWAYS),
            u32be(FILE_ATTRIBUTE_NORMAL),
        ]));
        const handle = created.ret;
        this.log(`createFile ret=0x${created.ret.toString(16)} err=${created.err}`);
        if (!handle || handle === 0xffffffff) throw new Error(`could not create ${path} (err ${created.err})`);


        let sent = 0;
        while (sent < bytes.length) {
            const slice = bytes.subarray(sent, Math.min(sent + this.chunkSize, bytes.length));
            let written;
            try {
                written = await this.call(CMD.writeFile,
                    joinBytes([u32be(handle), u32be(slice.length), slice]));
            } catch (error) {
                if (this.chunkSize > 128 && /no reply/.test(error.message)) {
                    this.chunkSize = Math.floor(this.chunkSize / 2);
                    this.log(`write stalled, dropping chunk to ${this.chunkSize} and retrying`);
                    continue;
                }
                throw error;
            }
            if (!written.ret) throw new Error(`write failed at offset ${sent} (err ${written.err})`);
            sent += slice.length;
            if (onProgress) onProgress(sent, bytes.length);
        }
        await this.call(CMD.closeHandle, u32be(handle));
        this.log(`closed handle, ${sent} bytes`);
        return sent;
    }

    async softReset() {
        return this.call(CMD.softReset, new Uint8Array(0));
    }

    async createDirectory(path) {
        return this.call(CMD.createDirectory, wstr(path));
    }

    async execute(appName, commandLine = "") {
        return this.call(CMD.coshExecute,
            joinBytes([u32be(1), wstr(appName), wstr(commandLine)]));
    }

    async installPackage(bytes, { card = false, cardDir = "" } = {}) {
        const target = "\\Temp\\install.cbea";
        this.log(`staging package at ${target}`);
        await this.sendFile(target, bytes, null);
        const commandLine = card
            ? `_C \\${cardDir}\\install.cbea`
            : `_M ${target}`;
        this.log(`running CoInstall.exe ${commandLine}`);
        return this.execute("CoInstall.exe", commandLine);
    }
}

export function decodeWide(data) {
    if (data.length < 2) return "";
    const length = (data[0] << 8) | data[1];
    let text = "";
    for (let offset = 2; offset + 1 < 2 + length; offset += 2) {
        const code = (data[offset] << 8) | data[offset + 1];
        if (!code) break;
        text += String.fromCharCode(code);
    }
    return text;
}
