import {bench, describe, expect, it, vi} from 'vitest';

import {STREAM_STATES, TYPES, VERSION} from '../src/constants';
import {Header} from '../src/header';
import {Session} from '../src/session';
import {Stream} from '../src/stream';

const createStream = (streamID = 0, state = STREAM_STATES.Init) => {
    const session = new Session(false);
    const stream = new Stream(session, streamID, state);

    return {streamID, stream, session};
};

describe('Stream', () => {
    it('has an ID', () => {
        const {session, streamID, stream} = createStream();
        expect(stream.ID()).toBe(streamID);
        session.close();
    });

    it('can send a window update', () => {
        return new Promise<void>((resolve) => {
            const {stream, session} = createStream();
            session.on('data', (data) => {
                expect(new Uint8Array(data)).toEqual(
                    new Uint8Array([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
                );
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
            stream.sendWindowUpdate();
        });
    });

    it('tracks send window usage', () => {
        return new Promise<void>((resolve) => {
            const {stream, session} = createStream(0, STREAM_STATES.Established);
            stream['sendWindow'] = 1;
            session.on('data', (data) => {
                expect(new Uint8Array(data)).toEqual(
                    new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff])
                );
                expect(stream['sendWindow']).toBe(0);
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
            stream.write(new Uint8Array([0xff]), () => stream.close());
        });
    });

    it('waits for a window update if send window is empty', () => {
        return new Promise<void>((resolve) => {
            const {stream, session} = createStream(0, STREAM_STATES.Established);
            const startTime = Date.now();
            stream['sendWindow'] = 0;
            session.on('data', (data) => {
                expect(new Uint8Array(data)).toEqual(
                    new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff])
                );
                expect(stream['sendWindow']).toBe(0);
                expect(Date.now() - startTime).toBeGreaterThan(50);
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
            stream.write(new Uint8Array([0xff]), () => stream.close());
            const hdr = new Header(VERSION, TYPES.WindowUpdate, 0, stream.ID(), 1);
            setTimeout(() => stream.incrSendWindow(hdr), 50);
        });
    });

    it('does not send packets larger than send window', () => {
        return new Promise<void>((resolve) => {
            const {stream, session} = createStream(0, STREAM_STATES.Established);
            let numberOfDataPackets = 0;
            stream['sendWindow'] = 1;
            session.on('data', (data) => {
                if (new Uint8Array(data)[1] === 0) {
                    // packet is of type Data
                    numberOfDataPackets++;
                    expect(new Uint8Array(data)).toEqual(
                        new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff])
                    );
                    expect(stream['sendWindow']).toBe(0);
                    const hdr = new Header(VERSION, TYPES.WindowUpdate, 0, stream.ID(), 1);
                    stream.incrSendWindow(hdr);
                }
            });
            stream.write(new Uint8Array([0xff, 0xff]), () => {
                expect(numberOfDataPackets).toBe(2);
                stream.close();
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
        });
    });

    it('can close when established', () => {
        return new Promise<void>((resolve) => {
            // Established stream
            let {stream, session} = createStream(0, STREAM_STATES.Established);
            session.on('data', (data) => {
                expect(new Uint8Array(data)).toEqual(
                    new Uint8Array([0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
                );
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
            stream.close();
        });
    });

    it('can close when connection is already closed', () => {
        return new Promise<void>((resolve) => {
            const {stream, session} = createStream(0, STREAM_STATES.RemoteClose);
            session.on('data', (data) => {
                expect(new Uint8Array(data)).toEqual(
                    new Uint8Array([0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
                );
                session.removeAllListeners('data');
                session.close();
                resolve();
            });
            stream.close();
        });
    });
});
