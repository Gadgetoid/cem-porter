import { NetStack, parseIp } from "./netstack.js";
import { PppLink } from "./ppp.js";
import { UsbSerial } from "./usbserial.js";
import { BAUD_RATES, WebSerial } from "./webserial.js";
import { Reader, Writer, decodeUtf16, utf16, words } from "./wire.js";

const HOST_IP = "192.168.131.102";
const DEVICE_IP = "192.168.131.201";
const DESKTOP_PORT = 5679;
const RAPI_PORT = 990;
const PING = 0x12345678;
const PING_MS = 1000;
const INFO_MAX = 512;
const BAUD_LISTEN_MS = 3000;
const BAUD_SEARCH_MS = 90000;
const HANDSHAKE = "CLIENT";

const RAPI = {
    createFile: 0x05,
    readFile: 0x06,
    writeFile: 0x07,
    closeHandle: 0x08,
    findAllFiles: 0x09,
    createDirectory: 0x17,
    createProcess: 0x19,
    deleteFile: 0x1c,
    getSystemInfo: 0x2f,
    getVersion: 0x3b,
};

const REJECTED = 1;
const FIND_ATTRIBUTES = 0x01;
const FIND_LAST_WRITE_TIME = 0x08;
const FIND_SIZE_LOW = 0x20;
const FIND_NAME = 0x80;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE = 0xffffffff;
const CHUNK = 8192;

const PROCESSORS = {
    386: "x86", 486: "x86", 586: "x86",
    3000: "MIPS R3000", 3910: "MIPS R3910", 4000: "MIPS R4000", 4100: "MIPS R4100",
    10003: "SH3", 10004: "SH3E", 10005: "SH4",
    2577: "StrongARM", 1824: "ARM720", 2080: "ARM820", 2336: "ARM920", 70001: "ARM7TDMI",
};

export const PC_LINK_TARGETS = [{ vendorId: 0x03f0, productId: 0x2016 }];

function plainString(writer, text) {
    const bytes = utf16(text);
    return writer.u32(1).u32(bytes.length / 2).bytes(bytes);
}

function optionalString(writer, text) {
    if (!text) return writer.u32(0);
    const bytes = utf16(text);
    return writer.u32(1).u32(bytes.length).u32(1).bytes(bytes);
}

function optionalOut(writer, size) {
    return writer.u32(1).u32(size).u32(0);
}

export function parseDesktopInfo(bytes) {
    const reader = new Reader(bytes);
    const osMajor = bytes.length >= 6 ? bytes[4] | (bytes[5] << 8) : 0;
    const nameOffset = bytes.length >= 0x1c ? reader.view.getUint32(0x18, true) : 0;
    const name = nameOffset && nameOffset < bytes.length ? decodeUtf16(bytes.subarray(nameOffset)) : "";
    return { osMajor, name };
}

export class PcLinkLink {
    constructor() {
        this.device = null;
        this.port = null;
        this.baudRate = null;
        this.filters = PC_LINK_TARGETS;
        this.transport = null;
        this.ppp = null;
        this.stack = null;
        this.desktop = null;
        this.rapi = null;
        this.info = null;
        this.ping = null;
        this.desktopWaiter = null;
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

    async openSerial() {
        const deadline = Date.now() + BAUD_SEARCH_MS;
        for (let attempt = 0; Date.now() < deadline; attempt++) {
            const baudRate = BAUD_RATES[attempt % BAUD_RATES.length];
            const transport = new WebSerial(this.port, baudRate);
            const pending = [];
            let text = "";
            transport.onData = (bytes) => {
                pending.push(bytes);
                text = (text + String.fromCharCode(...bytes)).slice(-64);
            };
            await transport.open();
            const listenUntil = Date.now() + BAUD_LISTEN_MS;
            while (Date.now() < listenUntil && !text.includes(HANDSHAKE)) await new Promise((resolve) => setTimeout(resolve, 50));
            if (text.includes(HANDSHAKE)) {
                this.baudRate = baudRate;
                this.log(`PC Link heard at ${baudRate} baud`);
                return { transport, pending };
            }
            await transport.close();
        }
        throw new Error("no PC Link from the serial port; start PC Link on the device and try again");
    }

    async connect() {
        if (!this.device && !this.port) throw new Error("no device chosen");
        let pending = null;
        if (this.port) {
            this.log("listening for PC Link on the serial port");
            ({ transport: this.transport, pending } = await this.openSerial());
        } else {
            this.transport = new UsbSerial(this.device);
        }
        this.ppp = new PppLink(this.transport, { hostIp: parseIp(HOST_IP), deviceIp: parseIp(DEVICE_IP) });
        this.ppp.onLog = (text) => this.log(text);
        this.stack = new NetStack(this.ppp, { ip: HOST_IP });
        this.stack.onLog = (text) => this.log(text);
        const desktop = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the device did not connect; start PC Link on it and try again")), 60000);
            this.desktopWaiter = (socket) => {
                clearTimeout(timer);
                resolve(socket);
            };
        });
        this.stack.listen(DESKTOP_PORT, (socket) => {
            if (this.desktopWaiter) this.desktopWaiter(socket);
            this.desktopWaiter = null;
        });
        this.transport.onClose = () => this.log("the device went away");
        if (pending) {
            for (const bytes of pending) this.ppp.receive(bytes);
        } else {
            await this.transport.open();
            this.log("waiting for PC Link");
        }
        this.desktop = await desktop;
        this.info = await this.readDesktopInfo(this.desktop);
        this.desktop.onData = () => undefined;
        this.ping = setInterval(() => {
            if (this.desktop && this.desktop.state === "established") this.desktop.write(words(PING));
        }, PING_MS);
        this.desktop.write(words(PING));
        this.log(`${this.info.name || "device"} connected, Windows CE ${this.info.osMajor}.x`);
        this.rapi = await this.stack.connect(DEVICE_IP, RAPI_PORT, 15000);
        this.log("RAPI connected");
    }

    async readDesktopInfo(socket) {
        for (;;) {
            const header = new Reader(await socket.read(4, 30000)).u32();
            if (header === 0 || header === PING) continue;
            if (header >= INFO_MAX) throw new Error("the device is password protected; remove the password to connect");
            return parseDesktopInfo(await socket.read(header, 30000));
        }
    }

    async close() {
        if (this.ping) clearInterval(this.ping);
        this.ping = null;
        for (const socket of [this.rapi, this.desktop]) {
            if (socket) socket.close();
        }
        this.rapi = null;
        this.desktop = null;
        if (this.transport) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await this.transport.close();
        } else if (this.device) {
            await this.device.close().catch(() => undefined);
        }
        this.port = null;
        this.transport = null;
        this.ppp = null;
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
            if (reply.u32() === REJECTED) {
                throw new Error(`the device rejected RAPI call 0x${command.toString(16)} (0x${reply.u32().toString(16)})`);
            }
            return reply;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    async callResult(command, build) {
        const reply = await this.call(command, build);
        reply.lastError = reply.u32();
        reply.result = reply.u32();
        return reply;
    }

    async deviceInfo() {
        const reply = await this.callResult(RAPI.getVersion);
        const size = reply.u32();
        const fields = new Reader(reply.take(size));
        fields.u32();
        const os = { major: fields.u32(), minor: fields.u32(), build: fields.u32() };
        const system = await this.call(RAPI.getSystemInfo, (writer) => optionalOut(writer, 36));
        system.u32();
        let processorType = 0;
        if (system.u32() === 1 && system.u32() >= 36 && system.u32() === 1) {
            system.skip(24);
            processorType = system.u32();
        }
        return {
            name: this.info.name,
            platform: this.info.name,
            os: `Windows CE ${os.major}.${os.minor} build ${os.build}`,
            osMajor: os.major,
            osMinor: os.minor,
            processor: PROCESSORS[processorType] || `type ${processorType}`,
            processorType,
            link: this.baudRate ? `serial, ${this.baudRate} baud` : "USB",
        };
    }

    async listDirectory(path) {
        const pattern = `${path.replace(/\\+$/, "")}\\*`;
        const flags = FIND_ATTRIBUTES | FIND_LAST_WRITE_TIME | FIND_SIZE_LOW | FIND_NAME;
        const reply = await this.call(RAPI.findAllFiles, (writer) => plainString(writer, pattern).u32(flags));
        const count = reply.u32();
        const entries = [];
        for (let index = 0; index < count; index++) {
            const nameUnits = reply.u32();
            const attributes = reply.u32();
            reply.skip(8);
            const size = reply.u32();
            const name = reply.wide(nameUnits * 2);
            if (!name || name === "." || name === "..") continue;
            entries.push({ name, size, attributes, directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 });
        }
        entries.sort((a, b) => (b.directory - a.directory) || a.name.localeCompare(b.name));
        return entries;
    }

    async openFile(path, write) {
        const reply = await this.call(RAPI.createFile, (writer) => plainString(writer
            .u32(write ? GENERIC_WRITE : GENERIC_READ).u32(0).u32(write ? CREATE_ALWAYS : OPEN_EXISTING)
            .u32(FILE_ATTRIBUTE_NORMAL).u32(0), path));
        const lastError = reply.u32();
        const handle = reply.u32();
        if (handle === INVALID_HANDLE) throw new Error(`could not open ${path} (err ${lastError})`);
        return handle;
    }

    closeHandle(handle) {
        return this.callResult(RAPI.closeHandle, (writer) => writer.u32(handle));
    }

    async sendFile(path, bytes, onProgress) {
        const handle = await this.openFile(path, true);
        let sent = 0;
        try {
            while (sent < bytes.length) {
                const slice = bytes.subarray(sent, Math.min(sent + this.chunkSize, bytes.length));
                const reply = await this.callResult(RAPI.writeFile, (writer) => writer
                    .u32(handle).u32(1).u32(slice.length).bytes(slice).u32(0));
                const written = reply.u32();
                if (!reply.result || !written) throw new Error(`write failed at offset ${sent} (err ${reply.lastError})`);
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
        const handle = await this.openFile(path, false);
        const parts = [];
        let total = 0;
        try {
            for (;;) {
                const reply = await this.callResult(RAPI.readFile, (writer) => optionalOut(writer.u32(handle), this.chunkSize).u32(0));
                if (!reply.result) throw new Error(`read failed at offset ${total} (err ${reply.lastError})`);
                const read = reply.u32();
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
        const reply = await this.callResult(RAPI.deleteFile, (writer) => optionalString(writer, path));
        return { ret: reply.result, err: reply.lastError };
    }

    async createDirectory(path) {
        const reply = await this.callResult(RAPI.createDirectory, (writer) => optionalString(writer, path).u32(0));
        return { ret: reply.result, err: reply.lastError };
    }

    async execute(application, commandLine = "") {
        const reply = await this.callResult(RAPI.createProcess, (writer) => {
            optionalString(optionalString(writer, application), commandLine);
            for (let index = 0; index < 7; index++) writer.u32(0);
            return optionalOut(writer, 16);
        });
        return { ret: reply.result, err: reply.lastError, processId: 0 };
    }
}
