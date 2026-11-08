const EP_NOTIFY = 1;
const EP_IN = 2;
const EP_OUT = 3;
const USB_PACKET = 64;

const SEND_ENCAPSULATED_COMMAND = 0x00;
const GET_ENCAPSULATED_RESPONSE = 0x01;

const MSG_PACKET = 0x00000001;
const MSG_INITIALIZE = 0x00000002;
const MSG_QUERY = 0x00000004;
const MSG_SET = 0x00000005;
const MSG_INDICATE_STATUS = 0x00000007;
const MSG_KEEPALIVE = 0x00000008;
const COMPLETION = 0x80000000;

const OID_802_3_PERMANENT_ADDRESS = 0x01010101;
const OID_GEN_CURRENT_PACKET_FILTER = 0x0001010e;
const PACKET_FILTER = 0x0000002d;
const PACKET_HEADER = 44;
const MAX_TRANSFER = 0x4000;

export const RNDIS_TARGETS = [
    { vendorId: 0x413c, productId: 0x4011 },
    { classCode: 0xef, subclassCode: 0x01, protocolCode: 0x01 },
];

export class RndisLink {
    constructor(device) {
        this.device = device;
        this.requestId = 1;
        this.control = Promise.resolve();
        this.running = false;
        this.onFrame = null;
        this.onLog = null;
        this.onClose = null;
        this.mac = null;
        this.maxTransfer = 8192;
        this.keepAlive = null;
        this.lastSent = 0;
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    async open() {
        await this.device.open();
        if (!this.device.configuration) await this.device.selectConfiguration(1);
        await this.device.claimInterface(0);
        await this.device.claimInterface(1);
        try {
            const init = await this.command(MSG_INITIALIZE, [1, 0, MAX_TRANSFER]);
            if (init.getUint32(12, true) !== 0) throw new Error("RNDIS initialise failed");
            this.maxTransfer = init.getUint32(36, true) || this.maxTransfer;
        } catch {
            this.log("device already initialised, reusing its session");
        }
        this.mac = (await this.query(OID_802_3_PERMANENT_ADDRESS, 48)).slice(0, 6);
        await this.set(OID_GEN_CURRENT_PACKET_FILTER, [PACKET_FILTER]);
        this.running = true;
        this.receiveLoop();
        this.keepAlive = setInterval(() => {
            if (Date.now() - this.lastSent > 4000) this.command(MSG_KEEPALIVE, []).catch(() => undefined);
        }, 5000);
    }

    async close() {
        this.running = false;
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.keepAlive = null;
        if (!this.device) return;
        for (const number of [1, 0]) await this.device.releaseInterface(number).catch(() => undefined);
        await this.device.close().catch(() => undefined);
        this.device = null;
    }

    buildMessage(type, words) {
        const bytes = new Uint8Array(12 + words.length * 4);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, type, true);
        view.setUint32(4, bytes.length, true);
        view.setUint32(8, this.requestId++, true);
        words.forEach((word, index) => view.setUint32(12 + index * 4, word, true));
        return bytes;
    }

    sendControl(type, words) {
        return this.device.controlTransferOut({
            requestType: "class",
            recipient: "interface",
            request: SEND_ENCAPSULATED_COMMAND,
            value: 0,
            index: 0,
        }, this.buildMessage(type, words));
    }

    command(type, words) {
        const run = this.control.then(async () => {
            await this.sendControl(type, words);
            for (let attempt = 0; attempt < 100; attempt++) {
                const result = await this.device.controlTransferIn({
                    requestType: "class",
                    recipient: "interface",
                    request: GET_ENCAPSULATED_RESPONSE,
                    value: 0,
                    index: 0,
                }, 1025);
                const view = result.data;
                if (view && view.byteLength >= 12) {
                    const replyType = view.getUint32(0, true);
                    if (replyType === ((type | COMPLETION) >>> 0)) return view;
                    if (replyType === MSG_KEEPALIVE) await this.answerKeepAlive(view.getUint32(8, true));
                    if (replyType === MSG_INDICATE_STATUS) this.log(`RNDIS status 0x${view.getUint32(8, true).toString(16)}`);
                    continue;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`no RNDIS reply to message 0x${type.toString(16)}`);
        });
        this.control = run.catch(() => undefined);
        return run;
    }

    async answerKeepAlive(id) {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, (MSG_KEEPALIVE | COMPLETION) >>> 0, true);
        view.setUint32(4, 16, true);
        view.setUint32(8, id, true);
        await this.device.controlTransferOut({
            requestType: "class",
            recipient: "interface",
            request: SEND_ENCAPSULATED_COMMAND,
            value: 0,
            index: 0,
        }, bytes);
    }

    async query(oid, bufferLength) {
        const reply = await this.command(MSG_QUERY, [oid, bufferLength, 20, 0, ...new Array(bufferLength / 4).fill(0)]);
        const status = reply.getUint32(12, true);
        if (status !== 0) throw new Error(`RNDIS query 0x${oid.toString(16)} failed: 0x${status.toString(16)}`);
        const length = reply.getUint32(16, true);
        const offset = 8 + reply.getUint32(20, true);
        return new Uint8Array(reply.buffer.slice(reply.byteOffset + offset, reply.byteOffset + offset + length));
    }

    async set(oid, values) {
        const reply = await this.command(MSG_SET, [oid, values.length * 4, 20, 0, ...values]);
        const status = reply.getUint32(12, true);
        if (status !== 0) throw new Error(`RNDIS set 0x${oid.toString(16)} failed: 0x${status.toString(16)}`);
    }

    async receiveLoop() {
        while (this.running) {
            let result;
            try {
                result = await this.device.transferIn(EP_IN, this.maxTransfer);
            } catch (error) {
                if (this.running) {
                    this.log(`link lost: ${error.message}`);
                    this.running = false;
                    if (this.onClose) this.onClose(error);
                }
                return;
            }
            const data = result.data;
            if (!data) continue;
            let offset = 0;
            while (offset + 8 <= data.byteLength) {
                const type = data.getUint32(offset, true);
                const length = data.getUint32(offset + 4, true);
                if (!length) break;
                if (type === MSG_PACKET) {
                    const dataOffset = data.getUint32(offset + 8, true);
                    const dataLength = data.getUint32(offset + 12, true);
                    const start = data.byteOffset + offset + 8 + dataOffset;
                    const frame = new Uint8Array(data.buffer.slice(start, start + dataLength));
                    if (this.onFrame) {
                        try {
                            this.onFrame(frame);
                        } catch (error) {
                            this.log(`frame handler: ${error.message}`);
                        }
                    }
                }
                offset += length;
            }
        }
    }

    async send(frame) {
        if (!this.running) throw new Error("link is closed");
        let total = PACKET_HEADER + frame.length;
        if (total % USB_PACKET === 0) total++;
        const bytes = new Uint8Array(total);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, MSG_PACKET, true);
        view.setUint32(4, total, true);
        view.setUint32(8, PACKET_HEADER - 8, true);
        view.setUint32(12, frame.length, true);
        bytes.set(frame, PACKET_HEADER);
        this.lastSent = Date.now();
        await this.device.transferOut(EP_OUT, bytes);
    }
}
