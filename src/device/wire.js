export function utf16(text) {
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        bytes[index * 2] = code & 0xff;
        bytes[index * 2 + 1] = code >>> 8;
    }
    return bytes;
}

export class Writer {
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
        const bytes = utf16(text);
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

export class Reader {
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

export function decodeUtf16(bytes) {
    let text = "";
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        const code = bytes[offset] | (bytes[offset + 1] << 8);
        if (!code) break;
        text += String.fromCharCode(code);
    }
    return text;
}

export function words(...values) {
    const writer = new Writer();
    for (const value of values) writer.u32(value);
    return writer.build();
}

export function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
