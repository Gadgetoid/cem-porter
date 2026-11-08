const SET_CONTROL_LINE_STATE = 0x22;
const DTR_AND_RTS = 0x0003;
const READ_SIZE = 4096;

function bulkEndpoints(device) {
    for (const iface of device.configuration.interfaces) {
        const alternate = iface.alternates[0];
        const input = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in");
        const output = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
        if (input && output) return { number: iface.interfaceNumber, input: input.endpointNumber, output: output.endpointNumber };
    }
    throw new Error("the device has no bulk serial endpoints");
}

export class UsbSerial {
    constructor(device) {
        this.device = device;
        this.endpoints = null;
        this.running = false;
        this.onData = null;
        this.onClose = null;
    }

    async open() {
        await this.device.open();
        if (!this.device.configuration) await this.device.selectConfiguration(1);
        this.endpoints = bulkEndpoints(this.device);
        await this.device.claimInterface(this.endpoints.number);
        await this.device.controlTransferOut({
            requestType: "class",
            recipient: "interface",
            request: SET_CONTROL_LINE_STATE,
            value: DTR_AND_RTS,
            index: this.endpoints.number,
        });
        this.running = true;
        this.readLoop();
    }

    async readLoop() {
        while (this.running) {
            let result;
            try {
                result = await this.device.transferIn(this.endpoints.input, READ_SIZE);
            } catch (error) {
                if (this.running) {
                    this.running = false;
                    if (this.onClose) this.onClose(error);
                }
                return;
            }
            const data = result.data;
            if (data && data.byteLength && this.onData) {
                this.onData(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
            }
        }
    }

    async write(bytes) {
        if (!this.running) throw new Error("link is closed");
        await this.device.transferOut(this.endpoints.output, bytes);
    }

    async close() {
        this.running = false;
        if (!this.device) return;
        if (this.endpoints) await this.device.releaseInterface(this.endpoints.number).catch(() => undefined);
        await this.device.close().catch(() => undefined);
        this.device = null;
    }
}
