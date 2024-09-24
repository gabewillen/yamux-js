"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Stream = void 0;
const readable_stream_1 = require("readable-stream");
const constants_1 = require("./constants");
const header_1 = require("./header");
class Stream extends readable_stream_1.Duplex {
    constructor(session, id, state) {
        super();
        this.session = session;
        this.id = id;
        this.state = state;
        this.recvWindow = constants_1.initialStreamWindow;
        this.sendWindow = constants_1.initialStreamWindow;
    }
    ID() {
        return this.id;
    }
    _read(size) {
        if (size > this.recvWindow) {
            this.session.config.logger('[ERR] yamux: receive window exceeded (stream: %d, remain: %d, recv: %d)', this.id, this.recvWindow, size);
            this.emit('error', constants_1.ERRORS.errRecvWindowExceeded);
        }
    }
    _write(chunk, encoding, cb) {
        switch (this.state) {
            case constants_1.STREAM_STATES.LocalClose:
            case constants_1.STREAM_STATES.RemoteClose:
            case constants_1.STREAM_STATES.Closed:
                this.emit('error', constants_1.ERRORS.errStreamClosed);
                break;
            case constants_1.STREAM_STATES.Reset:
                this.emit('error', constants_1.ERRORS.errConnectionReset);
                break;
            default:
                if (this.sendWindow === 0) {
                    setTimeout(() => this._write(chunk, encoding, cb), 100);
                    return;
                }
                const flags = this.sendFlags();
                const packetLength = Math.min(this.sendWindow, chunk.length);
                const sendHdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.Data, flags, this.id, packetLength);
                const buffers = [sendHdr.encode(), chunk];
                const packet = Buffer.concat(buffers);
                const rest = packet.slice(packetLength + header_1.Header.LENGTH);
                const packetToSend = packet.slice(0, packetLength + header_1.Header.LENGTH);
                this.sendWindow -= packetLength;
                const writeTimeout = setTimeout(() => {
                    this.emit('error', constants_1.ERRORS.errConnectionWriteTimeout);
                    clearTimeout(writeTimeout);
                }, this.session.config.connectionWriteTimeout * 1000);
                this.session.push(packetToSend, encoding);
                clearTimeout(writeTimeout);
                if (rest.length > 0) {
                    return this._write(rest, encoding, cb);
                }
                break;
        }
        return cb();
    }
    sendFlags() {
        let flags = 0;
        switch (this.state) {
            case constants_1.STREAM_STATES.Init:
                flags = constants_1.FLAGS.SYN;
                this.state = constants_1.STREAM_STATES.SYNSent;
                break;
            case constants_1.STREAM_STATES.SYNReceived:
                flags = constants_1.FLAGS.ACK;
                this.state = constants_1.STREAM_STATES.Established;
        }
        return flags;
    }
    sendWindowUpdate() {
        const max = this.session.config.maxStreamWindowSize;
        const delta = max - (this.recvBuf ? this.recvBuf.length : 0) - this.recvWindow;
        const flags = this.sendFlags();
        if (delta < max / 2 && flags === 0) {
            return;
        }
        // Update our window
        this.recvWindow += delta;
        // Send the header
        this.controlHdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.WindowUpdate, flags, this.id, delta);
        this.session.send(this.controlHdr);
    }
    updateRecvWindow(receivedSize) {
        this.recvWindow -= receivedSize;
        this.sendWindowUpdate();
    }
    // sendClose is used to send a FIN
    sendClose() {
        const flags = constants_1.FLAGS.FIN;
        this.controlHdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.WindowUpdate, flags, this.id, 0);
        if (!this.session.isClosed()) {
            this.session.send(this.controlHdr);
        }
    }
    close() {
        switch (this.state) {
            // Opened means we need to signal a close
            case constants_1.STREAM_STATES.SYNSent:
            case constants_1.STREAM_STATES.SYNReceived:
            case constants_1.STREAM_STATES.Established:
                this.state = constants_1.STREAM_STATES.LocalClose;
                this.sendClose();
            case constants_1.STREAM_STATES.LocalClose:
            case constants_1.STREAM_STATES.RemoteClose:
                this.state = constants_1.STREAM_STATES.LocalClose;
                this.sendClose();
                this.session.closeStream(this.id);
        }
    }
    forceClose() {
        this.state = constants_1.STREAM_STATES.Closed;
    }
    processFlags(flags) {
        // Close the stream without holding the state lock
        let closeStream = false;
        if (flags === constants_1.FLAGS.ACK) {
            if (this.state === constants_1.STREAM_STATES.SYNSent) {
                this.state = constants_1.STREAM_STATES.Established;
            }
        }
        if (flags === constants_1.FLAGS.SYN) {
            switch (this.state) {
                case constants_1.STREAM_STATES.SYNSent:
                case constants_1.STREAM_STATES.SYNReceived:
                case constants_1.STREAM_STATES.Established:
                    this.state = constants_1.STREAM_STATES.RemoteClose;
                    break;
                case constants_1.STREAM_STATES.LocalClose:
                    this.state = constants_1.STREAM_STATES.Closed;
                    closeStream = true;
                    break;
                default:
                    this.session.config.logger('[ERR] yamux: unexpected FIN flag in state %d', this.state);
                    this.emit('error', constants_1.ERRORS.errUnexpectedFlag);
                    return;
            }
        }
        if (flags === constants_1.FLAGS.RST) {
            this.state = constants_1.STREAM_STATES.Reset;
            closeStream = true;
        }
        if (closeStream) {
            this.session.closeStream(this.id);
        }
    }
    incrSendWindow(hdr) {
        this.processFlags(hdr.flags);
        this.sendWindow += hdr.length;
    }
}
exports.Stream = Stream;