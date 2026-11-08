export const BAUD_RATES = [115200, 57600, 38400, 19200, 9600];
const SIGNAL_DROP_MS = 250;

export class WebSerial {
    constructor(port, baudRate) {
        this.port = port;
        this.baudRate = baudRate;
        this.reader = null;
        this.writer = null;
        this.writing = Promise.resolve();
        this.running = false;
        this.onData = null;
        this.onClose = null;
    }

    async open() {
        await this.port.open({ baudRate: this.baudRate, bufferSize: 65536 });
        await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
        await new Promise((resolve) => setTimeout(resolve, SIGNAL_DROP_MS));
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
        this.writer = this.port.writable.getWriter();
        this.running = true;
        this.readLoop();
    }

    async readLoop() {
        while (this.running && this.port.readable) {
            this.reader = this.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value && value.length && this.onData) this.onData(value);
                }
            } catch (error) {
                if (this.running) {
                    this.running = false;
                    if (this.onClose) this.onClose(error);
                }
            } finally {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    write(bytes) {
        if (!this.running) return Promise.reject(new Error("link is closed"));
        const run = this.writing.then(() => this.writer.write(bytes));
        this.writing = run.catch(() => undefined);
        return run;
    }

    async close() {
        this.running = false;
        if (this.reader) await this.reader.cancel().catch(() => undefined);
        if (this.writer) {
            await this.writing;
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
        await this.port.close().catch(() => undefined);
    }
}
