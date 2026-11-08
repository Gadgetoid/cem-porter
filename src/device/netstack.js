const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_ARP = 0x0806;
const PROTOCOL_ICMP = 1;
const PROTOCOL_TCP = 6;
const PROTOCOL_UDP = 17;

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;

const MSS = 1400;
const WINDOW = 0xffff;
const RETRANSMIT_MS = 400;
const MAX_RETRANSMITS = 12;

const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function ipToString(bytes) {
    return Array.from(bytes).join(".");
}

export function parseIp(text) {
    return new Uint8Array(text.split(".").map(Number));
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
    return true;
}

function checksum(parts) {
    let sum = 0;
    for (const part of parts) {
        for (let index = 0; index < part.length; index += 2) {
            sum += (part[index] << 8) | (index + 1 < part.length ? part[index + 1] : 0);
        }
    }
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
    return (~sum) & 0xffff;
}

function pseudoHeader(source, destination, protocol, length) {
    const bytes = new Uint8Array(12);
    bytes.set(source, 0);
    bytes.set(destination, 4);
    bytes[9] = protocol;
    bytes[10] = length >>> 8;
    bytes[11] = length & 0xff;
    return bytes;
}

function seqAfter(a, b) {
    return ((a - b) | 0) > 0;
}

export class TcpSocket {
    constructor(stack, localPort, remoteIp, remotePort) {
        this.stack = stack;
        this.localPort = localPort;
        this.remoteIp = remoteIp;
        this.remotePort = remotePort;
        this.state = "closed";
        this.sendNext = (Math.random() * 0xffffffff) >>> 0;
        this.sendUnacked = this.sendNext;
        this.receiveNext = 0;
        this.remoteWindow = 0;
        this.outgoing = [];
        this.unacked = [];
        this.received = [];
        this.receivedLength = 0;
        this.readers = [];
        this.retransmitTimer = null;
        this.retransmits = 0;
        this.finSent = false;
        this.remoteClosed = false;
        this.onData = null;
        this.onClose = null;
        this.established = null;
    }

    get key() {
        return `${this.localPort}:${ipToString(this.remoteIp)}:${this.remotePort}`;
    }

    segment(flags, payload = new Uint8Array(0), sequence = this.sendNext) {
        this.stack.sendTcp(this, flags, sequence, payload);
    }

    write(bytes) {
        if (this.state !== "established" && this.state !== "close-wait") {
            throw new Error("socket is not connected");
        }
        for (let offset = 0; offset < bytes.length; offset += MSS) {
            this.outgoing.push(bytes.slice(offset, offset + MSS));
        }
        this.flush();
    }

    flush() {
        while (this.outgoing.length) {
            const inFlight = (this.sendNext - this.sendUnacked) >>> 0;
            const next = this.outgoing[0];
            if (inFlight + next.length > Math.max(this.remoteWindow, MSS)) break;
            this.outgoing.shift();
            this.unacked.push({ sequence: this.sendNext, payload: next, flags: TCP_ACK | TCP_PSH });
            this.segment(TCP_ACK | TCP_PSH, next);
            this.sendNext = (this.sendNext + next.length) >>> 0;
        }
        if (this.finPending && !this.outgoing.length && !this.finSent) {
            this.finSent = true;
            this.unacked.push({ sequence: this.sendNext, payload: new Uint8Array(0), flags: TCP_ACK | TCP_FIN });
            this.segment(TCP_ACK | TCP_FIN);
            this.sendNext = (this.sendNext + 1) >>> 0;
        }
        this.armRetransmit();
    }

    armRetransmit() {
        if (this.retransmitTimer || !this.unacked.length) return;
        this.retransmitTimer = setTimeout(() => {
            this.retransmitTimer = null;
            if (!this.unacked.length) return;
            if (++this.retransmits > MAX_RETRANSMITS) {
                this.abort(new Error("connection timed out"));
                return;
            }
            for (const entry of this.unacked) this.segment(entry.flags, entry.payload, entry.sequence);
            this.armRetransmit();
        }, RETRANSMIT_MS * Math.min(8, 1 << Math.min(this.retransmits, 3)));
    }

    acknowledge(ack) {
        if (!seqAfter(ack, this.sendUnacked)) return;
        this.sendUnacked = ack;
        this.retransmits = 0;
        this.unacked = this.unacked.filter((entry) =>
            seqAfter((entry.sequence + entry.payload.length + (entry.flags & TCP_FIN ? 1 : 0)) >>> 0, ack));
        if (this.retransmitTimer) {
            clearTimeout(this.retransmitTimer);
            this.retransmitTimer = null;
        }
        this.flush();
    }

    deliver(payload) {
        if (!payload.length) return;
        if (this.onData) {
            this.onData(payload);
            return;
        }
        this.received.push(payload);
        this.receivedLength += payload.length;
        this.wakeReaders();
    }

    wakeReaders() {
        while (this.readers.length) {
            const reader = this.readers[0];
            if (this.receivedLength < reader.length) {
                if (this.remoteClosed || this.state === "closed") {
                    this.readers.shift();
                    clearTimeout(reader.timer);
                    reader.reject(new Error("connection closed"));
                    continue;
                }
                return;
            }
            this.readers.shift();
            clearTimeout(reader.timer);
            reader.resolve(this.take(reader.length));
        }
    }

    take(length) {
        const out = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
            const head = this.received[0];
            const count = Math.min(head.length, length - filled);
            out.set(head.subarray(0, count), filled);
            filled += count;
            if (count === head.length) this.received.shift();
            else this.received[0] = head.subarray(count);
        }
        this.receivedLength -= length;
        return out;
    }

    read(length, timeout = 10000) {
        if (this.receivedLength >= length) return Promise.resolve(this.take(length));
        if (this.remoteClosed || this.state === "closed") return Promise.reject(new Error("connection closed"));
        return new Promise((resolve, reject) => {
            const reader = { length, resolve, reject, timer: null };
            reader.timer = setTimeout(() => {
                this.readers = this.readers.filter((entry) => entry !== reader);
                reject(new Error(`timed out waiting for ${length} bytes`));
            }, timeout);
            this.readers.push(reader);
        });
    }

    close() {
        if (this.state === "closed" || this.finPending) return;
        this.finPending = true;
        this.flush();
    }

    closed(timeout = 2000) {
        this.close();
        if (this.state === "closed") return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, timeout);
            const previous = this.onClose;
            this.onClose = (error) => {
                clearTimeout(timer);
                if (previous) previous(error);
                resolve();
            };
        });
    }

    abort(error) {
        if (this.state === "closed") return;
        if (!error) this.segment(TCP_RST | TCP_ACK);
        this.finish(error);
    }

    finish(error) {
        this.state = "closed";
        if (this.retransmitTimer) clearTimeout(this.retransmitTimer);
        this.retransmitTimer = null;
        this.stack.sockets.delete(this.key);
        this.wakeReaders();
        if (this.established) this.established.reject(error || new Error("connection refused"));
        this.established = null;
        if (this.onClose) this.onClose(error);
    }
}

export class NetStack {
    constructor(link, { mac, ip = "0.0.0.0" } = {}) {
        this.link = link;
        this.mac = mac || new Uint8Array([0x02, 0x00, 0x43, 0x45, 0x4d, 0x53]);
        this.ip = parseIp(ip);
        this.arpCache = new Map();
        this.arpWaiters = new Map();
        this.udpHandlers = new Map();
        this.listeners = new Map();
        this.sockets = new Map();
        this.ipId = 1;
        this.nextPort = 49152 + Math.floor(Math.random() * 1000);
        this.onLog = null;
        if (link.pointToPoint) link.onPacket = (packet) => this.receiveIp(packet, null);
        else link.onFrame = (frame) => this.receiveFrame(frame);
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    sendEthernet(destination, etherType, payload) {
        const frame = new Uint8Array(Math.max(60, 14 + payload.length));
        frame.set(destination, 0);
        frame.set(this.mac, 6);
        frame[12] = etherType >>> 8;
        frame[13] = etherType & 0xff;
        frame.set(payload, 14);
        this.link.send(frame).catch((error) => this.log(`send failed: ${error.message}`));
    }

    receiveFrame(frame) {
        if (frame.length < 14) return;
        const destination = frame.subarray(0, 6);
        if (!sameBytes(destination, this.mac) && !(destination[0] & 1)) return;
        const etherType = (frame[12] << 8) | frame[13];
        const payload = frame.subarray(14);
        if (etherType === ETHERTYPE_ARP) this.receiveArp(payload);
        else if (etherType === ETHERTYPE_IPV4) this.receiveIp(payload, frame.subarray(6, 12));
    }

    receiveArp(packet) {
        if (packet.length < 28) return;
        const operation = (packet[6] << 8) | packet[7];
        const senderMac = packet.slice(8, 14);
        const senderIp = packet.slice(14, 18);
        const targetIp = packet.subarray(24, 28);
        const senderKey = ipToString(senderIp);
        if (senderKey !== "0.0.0.0") {
            this.arpCache.set(senderKey, senderMac);
            const waiters = this.arpWaiters.get(senderKey);
            if (waiters) {
                this.arpWaiters.delete(senderKey);
                for (const resolve of waiters) resolve(senderMac);
            }
        }
        if (operation === 1 && sameBytes(targetIp, this.ip) && !sameBytes(senderIp, this.ip)) {
            const reply = new Uint8Array(28);
            reply.set([0, 1, 8, 0, 6, 4, 0, 2]);
            reply.set(this.mac, 8);
            reply.set(this.ip, 14);
            reply.set(senderMac, 18);
            reply.set(senderIp, 24);
            this.sendEthernet(senderMac, ETHERTYPE_ARP, reply);
        }
    }

    resolve(ip) {
        const key = ipToString(ip);
        if (key === "255.255.255.255" || ip[3] === 255) return Promise.resolve(BROADCAST_MAC);
        const known = this.arpCache.get(key);
        if (known) return Promise.resolve(known);
        return new Promise((resolve, reject) => {
            const waiters = this.arpWaiters.get(key) || [];
            waiters.push(resolve);
            this.arpWaiters.set(key, waiters);
            let attempts = 0;
            const ask = () => {
                if (!this.arpWaiters.has(key)) return;
                if (attempts++ >= 5) {
                    this.arpWaiters.delete(key);
                    reject(new Error(`no ARP reply from ${key}`));
                    return;
                }
                const request = new Uint8Array(28);
                request.set([0, 1, 8, 0, 6, 4, 0, 1]);
                request.set(this.mac, 8);
                request.set(this.ip, 14);
                request.set(ip, 24);
                this.sendEthernet(BROADCAST_MAC, ETHERTYPE_ARP, request);
                setTimeout(ask, 500);
            };
            ask();
        });
    }

    async sendIp(destination, protocol, payload, destinationMac = null) {
        const mac = this.link.pointToPoint ? null : destinationMac || await this.resolve(destination);
        const packet = new Uint8Array(20 + payload.length);
        packet[0] = 0x45;
        packet[2] = packet.length >>> 8;
        packet[3] = packet.length & 0xff;
        const id = this.ipId++ & 0xffff;
        packet[4] = id >>> 8;
        packet[5] = id & 0xff;
        packet[6] = 0x40;
        packet[8] = 64;
        packet[9] = protocol;
        packet.set(this.ip, 12);
        packet.set(destination, 16);
        const sum = checksum([packet.subarray(0, 20)]);
        packet[10] = sum >>> 8;
        packet[11] = sum & 0xff;
        packet.set(payload, 20);
        if (this.link.pointToPoint) {
            this.link.send(packet).catch((error) => this.log(`send failed: ${error.message}`));
            return;
        }
        this.sendEthernet(mac, ETHERTYPE_IPV4, packet);
    }

    receiveIp(packet, sourceMac) {
        if (packet.length < 20 || (packet[0] >>> 4) !== 4) return;
        const headerLength = (packet[0] & 15) * 4;
        const totalLength = (packet[2] << 8) | packet[3];
        if ((packet[6] & 0x3f) || packet[7]) return;
        const source = packet.slice(12, 16);
        const destination = packet.subarray(16, 20);
        const unconfigured = !this.ip[0] && !this.ip[1] && !this.ip[2] && !this.ip[3];
        const forUs = unconfigured || sameBytes(destination, this.ip) || destination[3] === 255 || destination[0] >= 224;
        if (!forUs) return;
        if (sourceMac && ipToString(source) !== "0.0.0.0") this.arpCache.set(ipToString(source), sourceMac.slice());
        const payload = packet.subarray(headerLength, Math.min(totalLength, packet.length));
        if (packet[9] === PROTOCOL_ICMP) this.receiveIcmp(source, payload);
        else if (packet[9] === PROTOCOL_UDP) this.receiveUdp(source, payload, sourceMac);
        else if (packet[9] === PROTOCOL_TCP && sameBytes(destination, this.ip)) this.receiveTcp(source, payload);
    }

    receiveIcmp(source, payload) {
        if (payload[0] !== 8) return;
        const reply = payload.slice();
        reply[0] = 0;
        reply[2] = 0;
        reply[3] = 0;
        const sum = checksum([reply]);
        reply[2] = sum >>> 8;
        reply[3] = sum & 0xff;
        this.sendIp(source, PROTOCOL_ICMP, reply);
    }

    bindUdp(port, handler) {
        this.udpHandlers.set(port, handler);
    }

    sendUdp(destination, sourcePort, destinationPort, payload, destinationMac = null) {
        const datagram = new Uint8Array(8 + payload.length);
        datagram[0] = sourcePort >>> 8;
        datagram[1] = sourcePort & 0xff;
        datagram[2] = destinationPort >>> 8;
        datagram[3] = destinationPort & 0xff;
        datagram[4] = datagram.length >>> 8;
        datagram[5] = datagram.length & 0xff;
        datagram.set(payload, 8);
        const sum = checksum([pseudoHeader(this.ip, destination, PROTOCOL_UDP, datagram.length), datagram]) || 0xffff;
        datagram[6] = sum >>> 8;
        datagram[7] = sum & 0xff;
        return this.sendIp(destination, PROTOCOL_UDP, datagram, destinationMac);
    }

    receiveUdp(source, datagram, sourceMac) {
        if (datagram.length < 8) return;
        const sourcePort = (datagram[0] << 8) | datagram[1];
        const destinationPort = (datagram[2] << 8) | datagram[3];
        const handler = this.udpHandlers.get(destinationPort);
        if (handler) handler(datagram.subarray(8), source, sourcePort, sourceMac);
    }

    async dhcp(timeout = 10000) {
        const transaction = (Math.random() * 0xffffffff) >>> 0;
        const build = (type, extra) => {
            const message = new Uint8Array(240);
            message.set([1, 1, 6, 0]);
            new DataView(message.buffer).setUint32(4, transaction);
            message[10] = 0x80;
            message.set(this.mac, 28);
            message.set([99, 130, 83, 99], 236);
            const options = [53, 1, type, 61, 7, 1, ...this.mac, ...extra, 255];
            const out = new Uint8Array(message.length + options.length);
            out.set(message);
            out.set(options, message.length);
            return out;
        };
        const parse = (message) => {
            if (message.length < 240 || message[0] !== 2) return null;
            if (new DataView(message.buffer, message.byteOffset).getUint32(4) !== transaction) return null;
            const options = {};
            for (let offset = 240; offset < message.length;) {
                const code = message[offset++];
                if (code === 255) break;
                if (code === 0) continue;
                const length = message[offset++];
                options[code] = message.slice(offset, offset + length);
                offset += length;
            }
            return { address: message.slice(16, 20), options };
        };
        const replies = [];
        let wake = null;
        this.bindUdp(68, (payload) => {
            const reply = parse(payload);
            if (!reply) return;
            replies.push(reply);
            if (wake) wake();
        });
        const awaitReply = async (type) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const index = replies.findIndex((reply) => reply.options[53] && reply.options[53][0] === type);
                if (index >= 0) return replies.splice(index, 1)[0];
                await new Promise((resolve) => {
                    wake = resolve;
                    setTimeout(resolve, 1000);
                });
            }
            return null;
        };
        const broadcast = parseIp("255.255.255.255");
        try {
            let offer = null;
            for (let attempt = 0; attempt < 4 && !offer; attempt++) {
                this.sendUdp(broadcast, 68, 67, build(1, [55, 3, 1, 3, 6]), BROADCAST_MAC);
                offer = await awaitReply(2).catch(() => null);
            }
            if (!offer) throw new Error("no DHCP offer");
            const server = offer.options[54] ? Array.from(offer.options[54]) : [];
            this.sendUdp(broadcast, 68, 67, build(3, [50, 4, ...offer.address, ...(server.length ? [54, 4, ...server] : [])]), BROADCAST_MAC);
            const ack = await awaitReply(5);
            if (!ack) throw new Error("no DHCP acknowledgement");
            this.ip = ack.address;
            return {
                address: ipToString(ack.address),
                server: server.length ? ipToString(server) : null,
                router: ack.options[3] ? ipToString(ack.options[3].slice(0, 4)) : null,
            };
        } finally {
            this.udpHandlers.delete(68);
        }
    }

    listen(port, onAccept) {
        this.listeners.set(port, onAccept);
    }

    unlisten(port) {
        this.listeners.delete(port);
    }

    connect(ip, port, timeout = 8000) {
        const socket = new TcpSocket(this, this.nextPort++, typeof ip === "string" ? parseIp(ip) : ip, port);
        if (this.nextPort > 65000) this.nextPort = 49152;
        this.sockets.set(socket.key, socket);
        socket.state = "syn-sent";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => socket.finish(new Error(`connect to port ${port} timed out`)), timeout);
            socket.established = {
                resolve: () => {
                    clearTimeout(timer);
                    resolve(socket);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            socket.unacked.push({ sequence: socket.sendNext, payload: new Uint8Array(0), flags: TCP_SYN });
            socket.segment(TCP_SYN);
            socket.sendNext = (socket.sendNext + 1) >>> 0;
            socket.armRetransmit();
        });
    }

    sendTcp(socket, flags, sequence, payload) {
        const options = flags & TCP_SYN ? [2, 4, MSS >>> 8, MSS & 0xff] : [];
        const headerLength = 20 + options.length;
        const segment = new Uint8Array(headerLength + payload.length);
        const view = new DataView(segment.buffer);
        view.setUint16(0, socket.localPort);
        view.setUint16(2, socket.remotePort);
        view.setUint32(4, sequence);
        view.setUint32(8, flags & TCP_ACK ? socket.receiveNext : 0);
        segment[12] = (headerLength / 4) << 4;
        segment[13] = flags;
        view.setUint16(14, WINDOW);
        segment.set(options, 20);
        segment.set(payload, headerLength);
        const sum = checksum([pseudoHeader(this.ip, socket.remoteIp, PROTOCOL_TCP, segment.length), segment]);
        view.setUint16(16, sum);
        this.sendIp(socket.remoteIp, PROTOCOL_TCP, segment).catch((error) => this.log(error.message));
    }

    sendReset(source, sourcePort, destinationPort, sequence, ack) {
        const socket = new TcpSocket(this, destinationPort, source, sourcePort);
        socket.receiveNext = ack;
        this.sendTcp(socket, TCP_RST | TCP_ACK, sequence, new Uint8Array(0));
    }

    receiveTcp(source, segment) {
        if (segment.length < 20) return;
        const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
        const sourcePort = view.getUint16(0);
        const destinationPort = view.getUint16(2);
        const sequence = view.getUint32(4);
        const ack = view.getUint32(8);
        const headerLength = (segment[12] >>> 4) * 4;
        const flags = segment[13];
        const window = view.getUint16(14);
        const payload = segment.slice(headerLength);
        const key = `${destinationPort}:${ipToString(source)}:${sourcePort}`;
        let socket = this.sockets.get(key);

        if (!socket) {
            if (flags & TCP_RST) return;
            const onAccept = this.listeners.get(destinationPort);
            if ((flags & TCP_SYN) && !(flags & TCP_ACK) && onAccept) {
                socket = new TcpSocket(this, destinationPort, source, sourcePort);
                socket.state = "syn-received";
                socket.receiveNext = (sequence + 1) >>> 0;
                socket.remoteWindow = window;
                socket.onAccept = onAccept;
                this.sockets.set(socket.key, socket);
                socket.unacked.push({ sequence: socket.sendNext, payload: new Uint8Array(0), flags: TCP_SYN | TCP_ACK });
                socket.segment(TCP_SYN | TCP_ACK);
                socket.sendNext = (socket.sendNext + 1) >>> 0;
                socket.armRetransmit();
                return;
            }
            this.sendReset(source, sourcePort, destinationPort, flags & TCP_ACK ? ack : 0,
                (sequence + payload.length + (flags & TCP_SYN ? 1 : 0)) >>> 0);
            return;
        }

        if (flags & TCP_RST) {
            socket.finish(new Error("connection reset"));
            return;
        }
        socket.remoteWindow = window;

        if (socket.state === "syn-sent") {
            if ((flags & TCP_SYN) && (flags & TCP_ACK)) {
                socket.receiveNext = (sequence + 1) >>> 0;
                socket.acknowledge(ack);
                socket.state = "established";
                socket.segment(TCP_ACK);
                if (socket.established) socket.established.resolve(socket);
                socket.established = null;
            }
            return;
        }

        if (flags & TCP_ACK) socket.acknowledge(ack);

        if (socket.state === "syn-received" && (flags & TCP_ACK) && !seqAfter(socket.sendNext, socket.sendUnacked)) {
            socket.state = "established";
            const onAccept = socket.onAccept;
            socket.onAccept = null;
            if (onAccept) onAccept(socket);
        }

        if (sequence !== socket.receiveNext) {
            if (payload.length || (flags & TCP_FIN)) socket.segment(TCP_ACK);
            return;
        }

        if (payload.length) {
            socket.receiveNext = (socket.receiveNext + payload.length) >>> 0;
            socket.segment(TCP_ACK);
            socket.deliver(payload);
        }

        if (flags & TCP_FIN) {
            socket.receiveNext = (socket.receiveNext + 1) >>> 0;
            socket.remoteClosed = true;
            socket.segment(TCP_ACK);
            if (socket.state === "established") socket.state = "close-wait";
            socket.wakeReaders();
            if (!socket.finPending) socket.close();
        }

        if (socket.finSent && !socket.unacked.length && (socket.remoteClosed || socket.state === "closed")) {
            socket.finish();
        }
    }

    async closeAll() {
        for (const socket of [...this.sockets.values()]) socket.abort();
    }
}
