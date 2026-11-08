const HDLC_FLAG = 0x7e;
const HDLC_ESCAPE = 0x7d;
const FCS_GOOD = 0xf0b8;
const FRAME_MAX = 4096;
const HANDSHAKE = "CLIENT";
const HANDSHAKE_REPLY = "CLIENTSERVER";

const PROTOCOL_IP = 0x0021;
const PROTOCOL_LCP = 0xc021;
const PROTOCOL_IPCP = 0x8021;

const CONFIGURE_REQUEST = 1;
const CONFIGURE_ACK = 2;
const CONFIGURE_NAK = 3;
const CONFIGURE_REJECT = 4;
const TERMINATE_REQUEST = 5;
const TERMINATE_ACK = 6;
const PROTOCOL_REJECT = 8;
const ECHO_REQUEST = 9;
const ECHO_REPLY = 10;

const LCP_MRU = 1;
const LCP_ACCM = 2;
const LCP_MAGIC = 5;
const LCP_PFC = 7;
const LCP_ACFC = 8;
const IPCP_ADDRESS = 3;

const FCS_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x8408 : value >>> 1;
        table[index] = value;
    }
    return table;
})();

function fcs16(fcs, bytes) {
    for (const byte of bytes) fcs = (fcs >>> 8) ^ FCS_TABLE[(fcs ^ byte) & 0xff];
    return fcs;
}

function sameAddress(a, b) {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export class PppLink {
    constructor(transport, { hostIp, deviceIp }) {
        this.transport = transport;
        this.hostIp = hostIp;
        this.deviceIp = deviceIp;
        this.pointToPoint = true;
        this.onPacket = null;
        this.onLog = null;
        this.onUp = null;
        this.onDown = null;
        this.reset();
        transport.onData = (bytes) => this.receive(bytes);
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    reset() {
        this.handshaken = false;
        this.handshakeText = "";
        this.frame = [];
        this.inFrame = false;
        this.escaped = false;
        this.transmitAccm = 0xffffffff;
        this.negotiatedAccm = 0xffffffff;
        this.nextId = 1;
        this.lcp = { open: false, peerAcked: false, weAcked: false, requestId: 0 };
        this.ipcp = { open: false, peerAcked: false, weAcked: false, requestId: 0 };
    }

    get up() {
        return this.ipcp.open;
    }

    write(bytes) {
        return this.transport.write(bytes).catch((error) => this.log(`write failed: ${error.message}`));
    }

    escape(byte, out) {
        if (byte === HDLC_FLAG || byte === HDLC_ESCAPE || (byte < 0x20 && (this.transmitAccm & (1 << byte)))) {
            out.push(HDLC_ESCAPE, byte ^ 0x20);
        } else {
            out.push(byte);
        }
    }

    sendFrame(protocol, payload) {
        const header = [0xff, 0x03, protocol >>> 8, protocol & 0xff];
        const fcs = fcs16(fcs16(0xffff, header), payload) ^ 0xffff;
        const out = [HDLC_FLAG];
        for (const byte of header) this.escape(byte, out);
        for (const byte of payload) this.escape(byte, out);
        this.escape(fcs & 0xff, out);
        this.escape(fcs >>> 8, out);
        out.push(HDLC_FLAG);
        return this.write(Uint8Array.from(out));
    }

    sendControl(protocol, code, id, data = []) {
        const length = data.length + 4;
        return this.sendFrame(protocol, [code, id, length >>> 8, length & 0xff, ...data]);
    }

    sendLcpRequest() {
        this.lcp.requestId = this.nextId++;
        this.sendControl(PROTOCOL_LCP, CONFIGURE_REQUEST, this.lcp.requestId);
    }

    sendIpcpRequest() {
        this.ipcp.requestId = this.nextId++;
        this.sendControl(PROTOCOL_IPCP, CONFIGURE_REQUEST, this.ipcp.requestId, [IPCP_ADDRESS, 6, ...this.hostIp]);
    }

    async send(packet) {
        if (!this.ipcp.open) throw new Error("the PPP link is not up");
        await this.sendFrame(PROTOCOL_IP, packet);
    }

    receive(bytes) {
        for (let byte of bytes) {
            if (!this.handshaken) {
                if (byte === HDLC_FLAG) {
                    this.handshaken = true;
                } else {
                    this.handshakeByte(byte);
                    continue;
                }
            }
            if (byte === HDLC_FLAG) {
                const complete = this.inFrame && !this.escaped && this.frame.length;
                const frame = this.frame;
                this.frame = [];
                this.inFrame = true;
                this.escaped = false;
                if (complete) this.receiveFrame(Uint8Array.from(frame));
                continue;
            }
            if (!this.inFrame) {
                if (!this.lcp.open) this.handshakeByte(byte);
                continue;
            }
            if (byte === HDLC_ESCAPE) {
                this.escaped = true;
                continue;
            }
            if (this.escaped) {
                byte ^= 0x20;
                this.escaped = false;
            }
            if (this.frame.length < FRAME_MAX) this.frame.push(byte);
            if (this.frame.length === HANDSHAKE.length && String.fromCharCode(...this.frame) === HANDSHAKE) {
                this.reset();
                this.answerHandshake();
            }
        }
    }

    handshakeByte(byte) {
        this.handshakeText = (this.handshakeText + String.fromCharCode(byte)).slice(-32);
        if (this.handshakeText.includes(HANDSHAKE)) this.answerHandshake();
    }

    answerHandshake() {
        this.handshakeText = "";
        this.handshaken = true;
        this.log("PC Link handshake");
        this.write(Uint8Array.from(HANDSHAKE_REPLY, (character) => character.charCodeAt(0)));
    }

    receiveFrame(frame) {
        if (frame.length < 3 || fcs16(0xffff, frame) !== FCS_GOOD) return;
        let body = frame.subarray(0, frame.length - 2);
        if (body.length >= 2 && body[0] === 0xff && body[1] === 0x03) body = body.subarray(2);
        if (!body.length) return;
        let protocol;
        if (body[0] & 1) {
            protocol = body[0];
            body = body.subarray(1);
        } else {
            if (body.length < 2) return;
            protocol = (body[0] << 8) | body[1];
            body = body.subarray(2);
        }
        if (protocol === PROTOCOL_LCP || protocol === PROTOCOL_IPCP) {
            this.controlPacket(protocol, body);
        } else if (protocol === PROTOCOL_IP) {
            if (this.ipcp.open && this.onPacket) this.onPacket(body.slice());
        } else if (this.lcp.open) {
            this.sendControl(PROTOCOL_LCP, PROTOCOL_REJECT, this.nextId++, [protocol >>> 8, protocol & 0xff, ...body]);
        }
    }

    controlPacket(protocol, packet) {
        if (packet.length < 4) return;
        const code = packet[0];
        const id = packet[1];
        let length = (packet[2] << 8) | packet[3];
        if (length < 4 || length > packet.length) length = packet.length;
        const data = packet.subarray(4, length);
        const isLcp = protocol === PROTOCOL_LCP;
        const state = isLcp ? this.lcp : this.ipcp;
        if (code === CONFIGURE_REQUEST) {
            if (state.open) {
                if (isLcp) this.restartLcp();
                else this.restartIpcp();
                this.log(`${isLcp ? "LCP" : "IPCP"} restarted by the device`);
            }
            if (isLcp) {
                this.lcpRequest(id, data);
                if (!this.lcp.requestId) this.sendLcpRequest();
            } else {
                this.ipcpRequest(id, data);
                if (!this.ipcp.requestId) this.sendIpcpRequest();
            }
        } else if (code === CONFIGURE_ACK) {
            if (id === state.requestId) {
                state.peerAcked = true;
                if (isLcp) this.maybeOpenLcp();
                else this.maybeOpenIpcp();
            }
        } else if (code === CONFIGURE_NAK || code === CONFIGURE_REJECT) {
            if (isLcp) this.sendLcpRequest();
            else this.sendIpcpRequest();
        } else if (code === TERMINATE_REQUEST) {
            this.sendControl(protocol, TERMINATE_ACK, id, [...data]);
            const wasUp = this.ipcp.open;
            if (isLcp) this.reset();
            else this.restartIpcp();
            this.log(`${isLcp ? "LCP" : "IPCP"} terminated by the device`);
            if (wasUp && this.onDown) this.onDown();
        } else if (code === ECHO_REQUEST && isLcp && this.lcp.open) {
            this.sendControl(PROTOCOL_LCP, ECHO_REPLY, id, [0, 0, 0, 0, ...data.subarray(4)]);
        }
    }

    lcpRequest(id, options) {
        const rejected = [];
        for (let index = 0; index + 2 <= options.length;) {
            const type = options[index];
            const length = options[index + 1];
            if (length < 2 || index + length > options.length) break;
            const value = options.subarray(index + 2, index + length);
            let refuse = false;
            if (type === LCP_ACCM && length === 6) {
                this.negotiatedAccm = ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0;
            } else if (type === LCP_MAGIC) {
                refuse = length === 6 && value.every((byte) => byte === 0);
            } else if (type !== LCP_MRU && type !== LCP_PFC && type !== LCP_ACFC && type !== LCP_ACCM) {
                refuse = true;
            }
            if (refuse) rejected.push(...options.subarray(index, index + length));
            index += length;
        }
        if (rejected.length) {
            this.sendControl(PROTOCOL_LCP, CONFIGURE_REJECT, id, rejected);
            return;
        }
        this.sendControl(PROTOCOL_LCP, CONFIGURE_ACK, id, [...options]);
        this.lcp.weAcked = true;
        this.maybeOpenLcp();
    }

    ipcpRequest(id, options) {
        const rejected = [];
        const naked = [];
        for (let index = 0; index + 2 <= options.length;) {
            const type = options[index];
            const length = options[index + 1];
            if (length < 2 || index + length > options.length) break;
            const value = options.subarray(index + 2, index + length);
            if (type === IPCP_ADDRESS && length === 6) {
                if (!sameAddress([...value], [...this.deviceIp])) naked.push(IPCP_ADDRESS, 6, ...this.deviceIp);
            } else {
                rejected.push(...options.subarray(index, index + length));
            }
            index += length;
        }
        if (rejected.length) this.sendControl(PROTOCOL_IPCP, CONFIGURE_REJECT, id, rejected);
        else if (naked.length) this.sendControl(PROTOCOL_IPCP, CONFIGURE_NAK, id, naked);
        else {
            this.sendControl(PROTOCOL_IPCP, CONFIGURE_ACK, id, [...options]);
            this.ipcp.weAcked = true;
            this.maybeOpenIpcp();
        }
    }

    maybeOpenLcp() {
        if (this.lcp.open || !this.lcp.peerAcked || !this.lcp.weAcked) return;
        this.lcp.open = true;
        this.transmitAccm = this.negotiatedAccm;
        this.log("LCP up");
    }

    maybeOpenIpcp() {
        if (this.ipcp.open || !this.ipcp.peerAcked || !this.ipcp.weAcked) return;
        this.ipcp.open = true;
        this.log("IPCP up");
        if (this.onUp) this.onUp();
    }

    restartIpcp() {
        this.ipcp = { open: false, peerAcked: false, weAcked: false, requestId: 0 };
    }

    restartLcp() {
        this.lcp = { open: false, peerAcked: false, weAcked: false, requestId: 0 };
        this.transmitAccm = this.negotiatedAccm = 0xffffffff;
        this.restartIpcp();
    }
}
