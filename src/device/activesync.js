import { RndisLink, RNDIS_TARGETS } from "./rndis.js";
import { NetStack, parseIp } from "./netstack.js";
import { Reader, Writer, decodeUtf16, utf16, sleep, words } from "./wire.js";

const DEVICE_IP = "169.254.2.1";
const HOST_IP = "169.254.2.2";
const CONTROL_PORT = 990;
const TRIGGER_PORT = 5679;
const TRIGGER = 0x7f;
const ADDRESS_WAIT_MS = 20000;
const STALE_SESSION = "the device is still in its last session; unplug it and plug it back in";
const NO_NETWORK = "the device did not answer on the USB network; unplug it and plug it back in";

const RAPI = {
    findAllFiles: 0x1a,
    createFile: 0x16,
    readFile: 0x17,
    writeFile: 0x18,
    closeHandle: 0x19,
    regOpenKey: 0x2f,
    regCreateKey: 0x31,
    regCloseKey: 0x32,
    regQueryValue: 0x37,
    regSetValue: 0x38,
    createDirectory: 0x28,
    createProcess: 0x2a,
    deleteFile: 0x2d,
    getSystemInfo: 0x3d,
    getVersionEx: 0x43,
};

export const HKEY = {
    HKCR: 0x80000000,
    HKCU: 0x80000001,
    HKLM: 0x80000002,
    HKU: 0x80000003,
};

const REG_SZ = 1;
const REG_DWORD = 4;
const REG_DATA_MAX = 4096;

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

const CHUNK = 65536;

const PROCESSORS = {
    386: "x86", 486: "x86", 586: "x86",
    4000: "MIPS R4000", 3910: "MIPS R3910",
    10003: "SH3", 10004: "SH4",
    2577: "ARM", 1824: "ARM 720", 2080: "ARM 820", 2336: "ARM 920", 70001: "ARM 7TDMI",
};

export function scanWide(bytes, minLen = 4) {
    const runs = [];
    let current = "";
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        const code = bytes[offset] | (bytes[offset + 1] << 8);
        if (code >= 0x20 && code <= 0x7e) {
            current += String.fromCharCode(code);
        } else {
            if (current.length >= minLen) runs.push(current);
            current = "";
        }
    }
    if (current.length >= minLen) runs.push(current);
    return [...new Set(runs)].sort((a, b) => b.length - a.length);
}

export function hex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
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
        this.trace = false;
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
        this.log("USB device opened");
        try {
            await this.openNetwork();
        } catch (error) {
            this.log(`the link failed to start: ${error.message}`);
            const interfaces = (this.device.configuration || this.device.configurations[0]).interfaces.map((entry) => {
                const alternate = entry.alternates[0];
                const endpoints = alternate.endpoints.map((endpoint) => `${endpoint.type} ${endpoint.direction} ${endpoint.endpointNumber}`).join(", ");
                return `${entry.interfaceNumber}: ${[alternate.interfaceClass, alternate.interfaceSubclass, alternate.interfaceProtocol].map((code) => code.toString(16).padStart(2, "0")).join("/")} [${endpoints}]`;
            });
            this.log(`USB interfaces: ${interfaces.join("; ")}`);
            throw new Error(`${error.message}; unplug the device and plug it back in`);
        }
        if (this.rndis.stale) throw new Error(STALE_SESSION);
        if (!await this.addressAnswers(ADDRESS_WAIT_MS)) throw new Error(NO_NETWORK);
        this.log("device network up; asking it to connect");
        this.control = await this.trigger();
        this.log("device connected");
        this.info = await this.handshake(this.control);
        this.log(`${this.info.name} (${this.info.model}) Windows CE ${this.info.osMajor}.${this.info.osMinor}`);
        if (this.info.passwordKey) throw new Error("the device is password protected; unlock it and remove the password to connect");
        this.rapi = await this.openRapi(1);
        this.log("RAPI connected");
    }

    async openNetwork() {
        this.lost = null;
        this.connections = [];
        this.rndis = new RndisLink(this.device);
        this.rndis.onLog = (text) => this.log(text);
        this.rndis.onClose = (error) => {
            this.lost = error;
            if (this.connectionWaiter) this.connectionWaiter();
        };
        await this.rndis.open();
        this.log("RNDIS up");
        this.stack = new NetStack(this.rndis, { ip: HOST_IP });
        this.stack.onLog = (text) => this.log(text);
        this.stack.trace = this.trace;
        this.stack.listen(CONTROL_PORT, (socket) => {
            this.connections.push(socket);
            if (this.connectionWaiter) this.connectionWaiter();
        });
    }

    async addressAnswers(timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline && !this.lost) {
            try {
                await this.stack.resolve(parseIp(DEVICE_IP));
                return true;
            } catch {
                this.log(`waiting for the device's network to come up (${this.rndis.pendingSends} USB sends pending)`);
            }
        }
        return false;
    }

    nextConnection(timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.connectionWaiter = null;
                reject(new Error("the device did not connect"));
            }, timeout);
            const check = () => {
                if (this.lost) {
                    clearTimeout(timer);
                    this.connectionWaiter = null;
                    reject(new Error(`the USB link was lost: ${this.lost.message}`));
                    return;
                }
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
            if (socket) socket.abort();
        }
        this.rapi = null;
        this.control = null;
        if (this.rndis) {
            await sleep(200);
            await this.rndis.close();
        } else if (this.device) {
            await this.device.close().catch(() => undefined);
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
            osMajor: os.major,
            osMinor: os.minor,
            processor: PROCESSORS[processor] || `type ${processor}`,
            processorType: processor,
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

    async openRegKey(root, subKey, create = false) {
        const command = create ? RAPI.regCreateKey : RAPI.regOpenKey;
        const reply = await this.call(command, (writer) => {
            writer.u32(root).string(subKey);
            if (create) writer.string("");
            return writer;
        });
        const status = reply.u32();
        const key = reply.u32();
        if (status !== 0 || !key) {
            throw new Error(`could not ${create ? "create" : "open"} registry key ${subKey} (status ${status})`);
        }
        return key;
    }

    closeRegKey(key) {
        return this.call(RAPI.regCloseKey, (writer) => writer.u32(key));
    }

    async readRegValue(root, subKey, name) {
        const key = await this.openRegKey(root, subKey);
        try {
            const reply = await this.call(RAPI.regQueryValue, (writer) => writer
                .u32(key).string(name).u32(0).u32(REG_DATA_MAX));
            const status = reply.u32();
            if (status !== 0) {
                return { found: false, status, type: 0, size: 0, data: new Uint8Array(0), value: "" };
            }
            const type = reply.u32();
            const size = reply.u32();
            const data = reply.take(Math.min(size, reply.bytes.length - reply.position)).slice();
            const value = type === REG_SZ ? decodeUtf16(data) : "";
            return { found: true, status, type, size, data, value };
        } finally {
            await this.closeRegKey(key);
        }
    }

    readRegString(root, subKey, name) {
        return this.readRegValue(root, subKey, name).then((result) => result.value);
    }

    async setRegValue(key, name, type, data) {
        const reply = await this.call(RAPI.regSetValue, (writer) => writer
            .u32(key).string(name).u32(type).u32(data.length).bytes(data));
        const status = reply.u32();
        if (status !== 0) throw new Error(`could not set registry value ${name} (status ${status})`);
    }

    async writeRegString(root, subKey, name, text) {
        const key = await this.openRegKey(root, subKey, true);
        try {
            await this.setRegValue(key, name, REG_SZ, utf16(text));
        } finally {
            await this.closeRegKey(key);
        }
    }

    async writeRegDword(root, subKey, name, value) {
        const key = await this.openRegKey(root, subKey, true);
        try {
            const data = new Uint8Array(4);
            new DataView(data.buffer).setUint32(0, value >>> 0, true);
            await this.setRegValue(key, name, REG_DWORD, data);
        } finally {
            await this.closeRegKey(key);
        }
    }

    async execute(application, commandLine = "") {
        const reply = await this.call(RAPI.createProcess, (writer) => writer
            .string(application).string(commandLine)
            .u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0));
        const ret = reply.u32();
        return { ret, err: reply.lastError, processId: ret ? (reply.skip(8), reply.u32()) : 0 };
    }
}
