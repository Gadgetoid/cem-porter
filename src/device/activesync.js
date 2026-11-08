import { RndisLink, RNDIS_TARGETS } from "./rndis.js";
import { NetStack, parseIp } from "./netstack.js";

const DEVICE_IP = "169.254.2.1";
const HOST_IP = "169.254.2.2";
const CONTROL_PORT = 990;
const TRIGGER_PORT = 5679;
const TRIGGER = 0x7f;

const RAPI = {
    findAllFiles: 0x1a,
    createFile: 0x16,
    readFile: 0x17,
    writeFile: 0x18,
    closeHandle: 0x19,
    createDirectory: 0x28,
    createProcess: 0x2a,
    deleteFile: 0x2d,
    getSystemInfo: 0x3d,
    getVersionEx: 0x43,
};

const FAF_ATTRIBUTES = 0x01;
const FAF_SIZE_LOW = 0x20;
const FAF_NAME = 0x80;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE = 0xffffffff;

const CHUNK = 16384;

const PROCESSORS = {
    386: "x86", 486: "x86", 586: "x86",
    4000: "MIPS R4000", 3910: "MIPS R3910",
    10003: "SH3", 10004: "SH4",
    2577: "ARM", 1824: "ARM 720", 2080: "ARM 820", 2336: "ARM 920", 70001: "ARM 7TDMI",
};

class Writer {
    constructor() {
        this.parts = [];
    }

    u32(value) {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        this.parts.push(bytes);
        return this;
    }

    bytes(data) {
        this.parts.push(data);
        return this;
    }

    string(text) {
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            bytes[index * 2] = code & 0xff;
            bytes[index * 2 + 1] = code >>> 8;
        }
        return this.u32(bytes.length).bytes(bytes);
    }

    build() {
        const total = this.parts.reduce((sum, part) => sum + part.length, 0);
        const out = new Uint8Array(total);
        let position = 0;
        for (const part of this.parts) {
            out.set(part, position);
            position += part.length;
        }
        return out;
    }
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.position = 0;
    }

    u32() {
        const value = this.view.getUint32(this.position, true);
        this.position += 4;
        return value;
    }

    take(length) {
        const out = this.bytes.subarray(this.position, this.position + length);
        this.position += length;
        return out;
    }

    skip(length) {
        this.position += length;
    }

    wide(length) {
        return decodeUtf16(this.take(length));
    }

    ascii(length) {
        return String.fromCharCode(...this.take(length));
    }
}

function decodeUtf16(bytes) {
    let text = "";
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        const code = bytes[offset] | (bytes[offset + 1] << 8);
        if (!code) break;
        text += String.fromCharCode(code);
    }
    return text;
}

function words(...values) {
    const writer = new Writer();
    for (const value of values) writer.u32(value);
    return writer.build();
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseDeviceInfo(bytes) {
    const reader = new Reader(bytes);
    const guid = [...reader.take(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const osMajor = reader.u32();
    const osMinor = reader.u32();
    const nameLength = reader.u32();
    const name = reader.wide(nameLength * 2);
    reader.skip(2);
    const version = reader.u32();
    const cpuType = reader.u32();
    reader.skip(4);
    const partnerId = reader.u32();
    const deviceId = reader.u32();
    const platforms = reader.ascii(reader.u32()).split("\0").filter(Boolean);
    const model = reader.ascii(reader.u32()).replace(/\0+$/, "");
    reader.skip(1);
    reader.skip(reader.u32() * 8);
    const passwordKey = reader.u32();
    return { guid, osMajor, osMinor, name, version, cpuType, partnerId, deviceId, platforms, model, passwordKey };
}

export class ActiveSyncLink {
    constructor() {
        this.device = null;
        this.filters = RNDIS_TARGETS;
        this.rndis = null;
        this.stack = null;
        this.control = null;
        this.rapi = null;
        this.info = null;
        this.connections = [];
        this.connectionWaiter = null;
        this.queue = Promise.resolve();
        this.onLog = null;
        this.chunkSize = CHUNK;
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    async request() {
        this.device = await navigator.usb.requestDevice({ filters: this.filters });
        return this.device;
    }

    async connect() {
        if (!this.device) throw new Error("no device chosen");
        await this.device.open();
        if (this.device.configuration) {
            this.log("device was left configured by an earlier session; resetting it");
            await this.device.reset();
            await sleep(1000);
        }
        this.rndis = new RndisLink(this.device);
        this.rndis.onLog = (text) => this.log(text);
        await this.rndis.open();
        this.stack = new NetStack(this.rndis, { ip: HOST_IP });
        this.stack.onLog = (text) => this.log(text);
        this.stack.listen(CONTROL_PORT, (socket) => {
            this.connections.push(socket);
            if (this.connectionWaiter) this.connectionWaiter();
        });
        await this.waitForAddress();
        this.control = await this.trigger();
        this.info = await this.handshake(this.control);
        this.log(`${this.info.name} (${this.info.model}) Windows CE ${this.info.osMajor}.${this.info.osMinor}`);
        if (this.info.passwordKey) throw new Error("the device is password protected; unlock it and remove the password to connect");
        this.rapi = await this.openRapi(1);
        this.log("RAPI connected");
    }

    async waitForAddress(timeout = 20000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            try {
                await this.stack.resolve(parseIp(DEVICE_IP));
                return;
            } catch {
                this.log("waiting for the device's network to come up");
            }
        }
        throw new Error("the device did not answer on the USB network; unplug it and plug it back in");
    }

    nextConnection(timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.connectionWaiter = null;
                reject(new Error("the device did not connect"));
            }, timeout);
            const check = () => {
                if (!this.connections.length) {
                    this.connectionWaiter = check;
                    return;
                }
                clearTimeout(timer);
                this.connectionWaiter = null;
                resolve(this.connections.shift());
            };
            check();
        });
    }

    async trigger(timeout = 30000) {
        const device = parseIp(DEVICE_IP);
        const send = () => this.stack.sendUdp(device, TRIGGER_PORT, TRIGGER_PORT, Uint8Array.of(TRIGGER))
            .catch((error) => this.log(`trigger: ${error.message}`));
        send();
        const repeat = setInterval(send, 500);
        try {
            return await this.nextConnection(timeout);
        } finally {
            clearInterval(repeat);
        }
    }

    async handshake(socket) {
        for (let guard = 0; guard < 16; guard++) {
            const request = new Reader(await socket.read(4)).u32();
            if (request === 0) {
                socket.write(words(3));
            } else if (request === 6) {
                socket.write(words(7, 8, 4, 5));
            } else if (request === 4) {
                const length = new Reader(await socket.read(4)).u32();
                return parseDeviceInfo(await socket.read(length));
            } else {
                throw new Error(`unexpected control request ${request}`);
            }
        }
        throw new Error("the device never sent its details");
    }

    async openRapi(requestId) {
        this.control.write(words(5, 4, requestId));
        const socket = await this.nextConnection(10000);
        const echoed = new Reader(await socket.read(4)).u32();
        if (echoed !== requestId) throw new Error(`RAPI connection answered request ${echoed}, not ${requestId}`);
        return socket;
    }

    async close() {
        for (const socket of [this.rapi, this.control]) {
            if (socket) socket.close();
        }
        this.rapi = null;
        this.control = null;
        if (this.rndis) {
            await sleep(200);
            await this.rndis.close();
        } else if (this.device) {
            try {
                await this.device.close();
            } catch {
                // already gone
            }
        }
        this.rndis = null;
        this.stack = null;
        this.device = null;
    }

    call(command, build = (writer) => writer) {
        const run = this.queue.then(async () => {
            if (!this.rapi) throw new Error("link is closed");
            const body = build(new Writer().u32(command)).build();
            this.rapi.write(new Writer().u32(body.length).bytes(body).build());
            const length = new Reader(await this.rapi.read(4, 30000)).u32();
            const reply = new Reader(await this.rapi.read(length, 30000));
            reply.lastError = reply.u32();
            return reply;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    async deviceInfo() {
        const version = await this.call(RAPI.getVersionEx);
        version.u32();
        version.u32();
        version.u32();
        const os = { major: version.u32(), minor: version.u32(), build: version.u32() };
        const system = await this.call(RAPI.getSystemInfo, (writer) => writer.u32(1).u32(36).u32(0));
        system.skip(24);
        const processor = system.u32();
        return {
            name: this.info.name,
            model: this.info.model,
            platform: this.info.platforms.join(", "),
            os: `Windows CE ${os.major}.${os.minor} build ${os.build}`,
            processor: PROCESSORS[processor] || `type ${processor}`,
        };
    }

    async listDirectory(path) {
        const pattern = `${path.replace(/\\+$/, "")}\\*`;
        const flags = FAF_ATTRIBUTES | FAF_SIZE_LOW | FAF_NAME;
        const reply = await this.call(RAPI.findAllFiles, (writer) => writer.string(pattern).u32(flags));
        reply.u32();
        const count = reply.u32();
        const entries = [];
        for (let index = 0; index < count; index++) {
            const nameSize = reply.u32();
            const attributes = reply.u32();
            const size = reply.u32();
            const name = reply.wide(nameSize);
            entries.push({ name, size, attributes, directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 });
        }
        entries.sort((a, b) => (b.directory - a.directory) || a.name.localeCompare(b.name));
        return entries;
    }

    async openFile(path, access, creation) {
        const reply = await this.call(RAPI.createFile, (writer) => writer
            .string(path).u32(access).u32(access === GENERIC_READ ? 1 : 0)
            .u32(creation).u32(FILE_ATTRIBUTE_NORMAL).u32(0));
        const handle = reply.u32();
        if (!handle || handle === INVALID_HANDLE) throw new Error(`could not open ${path} (err ${reply.lastError})`);
        return handle;
    }

    closeHandle(handle) {
        return this.call(RAPI.closeHandle, (writer) => writer.u32(handle));
    }

    async sendFile(path, bytes, onProgress) {
        const handle = await this.openFile(path, GENERIC_WRITE, CREATE_ALWAYS);
        let sent = 0;
        try {
            while (sent < bytes.length) {
                const slice = bytes.subarray(sent, Math.min(sent + this.chunkSize, bytes.length));
                const reply = await this.call(RAPI.writeFile, (writer) => writer.u32(handle).u32(slice.length).bytes(slice));
                const ok = reply.u32();
                const written = reply.u32();
                if (!ok || !written) throw new Error(`write failed at offset ${sent} (err ${reply.lastError})`);
                sent += written;
                if (onProgress) onProgress(sent, bytes.length);
            }
        } finally {
            await this.closeHandle(handle);
        }
        this.log(`wrote ${sent} bytes to ${path}`);
        return sent;
    }

    async receiveFile(path, size, onProgress) {
        const handle = await this.openFile(path, GENERIC_READ, OPEN_EXISTING);
        const parts = [];
        let total = 0;
        try {
            for (;;) {
                const reply = await this.call(RAPI.readFile, (writer) => writer.u32(handle).u32(this.chunkSize));
                const ok = reply.u32();
                const read = reply.u32();
                if (!ok) throw new Error(`read failed at offset ${total} (err ${reply.lastError})`);
                if (!read) break;
                parts.push(reply.take(read).slice());
                total += read;
                if (onProgress) onProgress(total, size || 0);
            }
        } finally {
            await this.closeHandle(handle);
        }
        const out = new Uint8Array(total);
        let position = 0;
        for (const part of parts) {
            out.set(part, position);
            position += part.length;
        }
        return out;
    }

    async deleteFile(path) {
        const reply = await this.call(RAPI.deleteFile, (writer) => writer.string(path));
        return { ret: reply.u32(), err: reply.lastError };
    }

    async createDirectory(path) {
        const reply = await this.call(RAPI.createDirectory, (writer) => writer.string(path));
        return { ret: reply.u32(), err: reply.lastError };
    }

    async execute(application, commandLine = "") {
        const reply = await this.call(RAPI.createProcess, (writer) => writer
            .string(application).string(commandLine)
            .u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0));
        const ret = reply.u32();
        return { ret, err: reply.lastError, processId: ret ? (reply.skip(8), reply.u32()) : 0 };
    }
}
