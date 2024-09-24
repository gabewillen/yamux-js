"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Session = void 0;
const stream_1 = require("stream");
const constants_1 = require("./constants");
const header_1 = require("./header");
const mux_1 = require("./mux");
const stream_2 = require("./stream");
class Session extends stream_1.Transform {
    constructor(client, config, onStream) {
        super();
        // localGoAway indicates that we should stop accepting futher connections
        this.localGoaway = false;
        // remoteGoAway indicates the remote side does not want futher connections.
        this.remoteGoAway = false;
        // pings is used to track inflight pings
        this.pings = new Map();
        this.pingID = 0;
        // streams maps a stream id to a stream
        this.streams = new Map();
        // shutdown is used to safely close a session
        this.shutdown = false;
        if (client) {
            this.nextStreamID = 1;
        }
        else {
            this.nextStreamID = 2;
        }
        this.onStream = onStream;
        this.config = {
            ...mux_1.defaultConfig,
            ...config,
        };
        if (this.config.enableKeepAlive) {
            this.keepalive();
        }
    }
    _transform(chunk, encoding, cb) {
        let packet = Buffer.alloc(chunk.length, chunk);
        if (!this.currentHeader) {
            if (packet.length >= header_1.Header.LENGTH) {
                this.currentHeader = header_1.Header.parse(packet);
                packet = packet.slice(header_1.Header.LENGTH);
            }
            else {
                // header info is incomplete wait for more data
                return cb();
            }
        }
        let expectedLength = this.currentHeader.length;
        // Verify the version
        if (this.currentHeader.version !== constants_1.VERSION) {
            this.config.logger('[ERR] yamux: Invalid protocol version: %d', this.currentHeader.version);
            return this.close(constants_1.ERRORS.errInvalidVersion);
        }
        switch (this.currentHeader.type) {
            case constants_1.TYPES.Data:
                // we have enough data to handle the packet
                if (packet.length >= expectedLength) {
                    var rest = packet.slice(expectedLength);
                    var fullPacket = packet.slice(0, expectedLength);
                    this.handleStreamMessage(this.currentHeader, fullPacket, encoding);
                    this.currentHeader = undefined;
                    if (rest.length > 0) {
                        return this._transform(rest, encoding, cb);
                    }
                }
                break;
            case constants_1.TYPES.WindowUpdate:
                this.handleStreamMessage(this.currentHeader, packet, encoding);
                this.currentHeader = undefined;
                if (packet.length > 0) {
                    return this._transform(packet, encoding, cb);
                }
                break;
            case constants_1.TYPES.Ping:
                this.handlePing(this.currentHeader);
                this.currentHeader = undefined;
                if (packet.length > 0) {
                    return this._transform(packet, encoding, cb);
                }
                break;
            case constants_1.TYPES.GoAway:
                this.handleGoAway(this.currentHeader);
                this.currentHeader = undefined;
                break;
            default:
                return this.close(constants_1.ERRORS.errInvalidMsgType);
        }
        // done processing for now
        return cb();
    }
    handleStreamMessage(currentHeader, fullPacket, encoding) {
        // Check for a new stream creation
        if (currentHeader.flags == constants_1.FLAGS.SYN) {
            return this.incomingStream(currentHeader.streamID);
        }
        // Get the stream
        const stream = this.streams.get(currentHeader.streamID);
        // If we do not have a stream, likely we sent a RST
        if (!stream) {
            // Drain any data on the wire
            if (currentHeader.type === constants_1.TYPES.Data && currentHeader.length > 0) {
                this.config.logger('[WARN] yamux: Discarding data for stream: %d', currentHeader.streamID);
            }
            else {
                this.config.logger('[WARN] yamux: Discarding data for stream: %d', currentHeader.streamID);
            }
            return;
        }
        // Check if this is a window update
        if (currentHeader.type === constants_1.TYPES.WindowUpdate) {
            stream.incrSendWindow(currentHeader);
            return;
        }
        stream.push(fullPacket, encoding);
        stream.updateRecvWindow(fullPacket.length);
    }
    closeStream(streamID) {
        this.streams.delete(streamID);
    }
    isClosed() {
        return this.shutdown;
    }
    // Close is used to close the session and all streams.
    // Attempts to send a GoAway before closing the connection.
    close(error) {
        if (this.shutdown) {
            return;
        }
        this.goAway(constants_1.GO_AWAY_ERRORS.goAwayNormal);
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }
        this.pings.forEach((responseTimeout) => clearTimeout(responseTimeout));
        this.shutdown = true;
        this.streams.forEach((stream) => {
            stream.forceClose();
            stream.destroy();
        });
        if (error) {
            this.emit('error', error);
        }
        this.end();
    }
    // incomingStream is used to create a new incoming stream
    incomingStream(streamID) {
        // Reject immediately if we are doing a go away
        if (this.localGoaway) {
            const hdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.WindowUpdate, constants_1.FLAGS.RST, streamID, 0);
            return this.send(hdr);
        }
        // Allocate a new stream
        const stream = new stream_2.Stream(this, streamID, constants_1.STREAM_STATES.SYNReceived);
        // Check if stream already exists
        if (this.streams.has(streamID)) {
            this.config.logger('[ERR] yamux: duplicate stream declared');
            this.emit('error', constants_1.ERRORS.errDuplicateStream);
            return this.goAway(constants_1.GO_AWAY_ERRORS.goAwayProtoErr);
        }
        // Register the stream
        this.streams.set(streamID, stream);
        if (this.streams.size > this.config.acceptBacklog) {
            // Backlog exceeded! RST the stream
            this.config.logger('[WARN] yamux: backlog exceeded, forcing connection reset');
            this.streams.delete(streamID);
            const hdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.WindowUpdate, constants_1.FLAGS.RST, streamID, 0);
            return this.send(hdr);
        }
        if (this.onStream) {
            this.onStream(stream);
        }
    }
    // goAway is used to send a goAway message
    goAway(reason) {
        const hdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.GoAway, 0, 0, reason);
        return this.send(hdr);
    }
    // Open is used to create a new stream
    open() {
        const stream = new stream_2.Stream(this, this.nextStreamID, constants_1.STREAM_STATES.Init);
        this.nextStreamID += 2;
        if (this.isClosed()) {
            this.emit('error', constants_1.ERRORS.errSessionShutdown);
            return stream;
        }
        if (this.remoteGoAway) {
            this.emit('error', constants_1.ERRORS.errRemoteGoAway);
            return stream;
        }
        this.streams.set(stream.ID(), stream);
        stream.sendWindowUpdate();
        return stream;
    }
    handlePing(hdr) {
        const pingID = hdr.length;
        if (hdr.flags === constants_1.FLAGS.SYN) {
            const responseHdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.Ping, constants_1.FLAGS.ACK, 0, pingID);
            return this.send(responseHdr);
        }
        // Handle a response
        const responseTimeout = this.pings.get(pingID);
        if (responseTimeout) {
            clearTimeout(responseTimeout);
            this.pings.delete(pingID);
        }
    }
    // Ping is used to measure the RTT response time
    ping() {
        if (this.shutdown) {
            this.emit('error', constants_1.ERRORS.errSessionShutdown);
            return;
        }
        const pingID = this.pingID++;
        const hdr = new header_1.Header(constants_1.VERSION, constants_1.TYPES.Ping, constants_1.FLAGS.SYN, 0, pingID);
        // Wait for a response
        const responseTimeout = setTimeout(() => {
            clearTimeout(responseTimeout); // Ignore it if a response comes later.
            this.emit('error', constants_1.ERRORS.errKeepAliveTimeout);
            this.close(constants_1.ERRORS.errTimeout);
        }, this.config.connectionWriteTimeout * 1000);
        this.pings.set(pingID, responseTimeout);
        this.send(hdr);
    }
    keepalive() {
        this.pingTimer = setInterval(() => this.ping(), this.config.keepAliveInterval * 1000);
    }
    send(header, data) {
        const buffers = [header.encode()];
        if (data) {
            buffers.push(data);
        }
        const toSend = Buffer.concat(buffers);
        if (!this.writableEnded) {
            this.push(toSend);
        }
    }
    handleGoAway(hdr) {
        const code = hdr.length;
        switch (code) {
            case constants_1.GO_AWAY_ERRORS.goAwayNormal:
                this.remoteGoAway = true;
                break;
            case constants_1.GO_AWAY_ERRORS.goAwayProtoErr:
                this.config.logger('[ERR] yamux: received protocol error go away');
                return this.close(new Error('yamux protocol error'));
            case constants_1.GO_AWAY_ERRORS.goAwayInternalErr:
                this.config.logger('[ERR] yamux: received internal error go away');
                return this.close(new Error('remote yamux internal error'));
            default:
                this.config.logger('[ERR] yamux: received unexpected go away');
                return this.close(new Error('unexpected go away received'));
        }
    }
}
exports.Session = Session;