import {Duplex} from 'readable-stream';

import {expect, describe, it, vi, bench} from 'vitest';

import {FLAGS, TYPES, VERSION, initialStreamWindow} from '../src/constants';
import {Header} from '../src/header';
import {Session} from '../src/session';
import {defaultConfig} from '../src/mux';

const testConfig = {
    ...defaultConfig,
    enableKeepAlive: false,
    keepAliveInterval: 0.1, // In seconds
    connectionWriteTimeout: 0.5, // In seconds
};
const testConfigWithKeepAlive = {
    ...testConfig,
    enableKeepAlive: true,
};

const getServerAndClient = (
    serverConfig = testConfig,
    clientConfig = testConfig,
    onStream?: (duplex: Duplex) => void,
    stream?: Duplex
) => {
    const server = new Session(false, serverConfig, onStream);
    const client = new Session(true, clientConfig);
    if (!stream) {
        client.pipe(server).pipe(client);
    } else {
        stream.pipe(server).pipe(stream);
        stream.pipe(client).pipe(stream);
    }

    return {client, server};
};

function withResolvers<T = void>(
    timeout?: number
): [Promise<T>, (value: T | PromiseLike<T>) => void, (reason?: unknown) => void] {
    const resolvers: [(value: T | PromiseLike<T>) => void, (reason?: unknown) => void] = [
        (value: T | PromiseLike<T>) => {},
        (reason?: unknown) => {},
    ];
    const promise = new Promise<T>((resolve, reject) => {
        resolvers[0] = resolve;
        resolvers[1] = reject;
    });
    if (timeout) {
        setTimeout(() => {
            resolvers[1](new Error(`timeout after ${timeout}ms`));
        }, timeout);
    }
    return [promise, resolvers[0], resolvers[1]];
}

describe('Server session', () => {
    it('sends pings if keepalive is configured', async () => {
        const server = new Session(false, testConfigWithKeepAlive);
        const expectedPings = [
            // first ping
            new Uint8Array([0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
            // second ping
            new Uint8Array([0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]),
            // Third ping
            new Uint8Array([0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2]),
        ];
        const [promise, resolve, reject] = withResolvers();
        server.on('data', (data) => {
            if (expectedPings.length === 0) {
                server.removeAllListeners('data');
                server.close();
                return resolve();
            }
            const expectedPing = expectedPings.shift()!;
            expect(new Uint8Array(data)).toEqual(expectedPing);
        });
        await promise;
        server.removeAllListeners();
        server.close();
    });

    it('errors if pings time out', async () => {
        const server = new Session(false, testConfigWithKeepAlive);
        const [promise, resolve, reject] = withResolvers(testConfigWithKeepAlive.keepAliveInterval * 1000 * 10);
        server.on('error', (err) => {
            server.removeAllListeners();
            server.close();
            reject(err);
        });
        await expect(promise).rejects.toThrow('keepalive timeout');
    });

    it('accepts streams', async () => {
        const nbStreams = 10;
        const expectedOutput = new Set();

        const {client} = getServerAndClient(
            {...testConfig, connectionWriteTimeout: 2},
            {...testConfig, connectionWriteTimeout: 2},
            (stream) => {
                stream.on('data', (data) => {
                    const received = new TextDecoder().decode(data);
                    expect(expectedOutput.has(received)).toBe(true);
                    // Send it back
                    stream.write(new TextEncoder().encode(received));
                });
            }
        );
        const [promise, resolve, reject] = withResolvers(2000);
        for (let i = 0; i < nbStreams; i++) {
            const message = 'echo-' + i;
            expectedOutput.add(message);

            const stream = client.open();
            stream.on('data', (data) => {
                const received = new TextDecoder().decode(data);
                expect(expectedOutput.has(received)).toBe(true);
                expectedOutput.delete(received);
                if (expectedOutput.size === 0) {
                    resolve();
                }
            });
            // Send the message and wait to get it back
            stream.write(new TextEncoder().encode(message));
        }
        await promise;
        client.removeAllListeners();
        client.close();
    });

    it('supports sending big data chunks', async () => {
        const nbStreams = 2;
        const expectedOutput = new Set();

        const {client} = getServerAndClient(testConfig, testConfig, (stream) => {
            stream.on('data', (data) => {
                const received = new TextDecoder().decode(data);
                expect(expectedOutput.has(received)).toBe(true);
                // Send it back
                stream.write(new TextEncoder().encode(received));
            });
        });

        const [promise, resolve] = withResolvers(2000);
        for (let i = 0; i < nbStreams; i++) {
            const message = ('echo-' + i).repeat(10000);
            expectedOutput.add(message);

            const stream = client.open();
            expect(stream).not.toBeUndefined();
            stream!.on('data', (data) => {
                const received = data.toString();
                expect(expectedOutput.has(received)).toBe(true);
                expectedOutput.delete(received);
                if (expectedOutput.size === 0) {
                    resolve();
                }
            });
            // Send the message and wait to get it back
            stream!.write(message);
        }
        await promise;
        client.removeAllListeners();
        client.close();
    });

    it('updates the receive window', async () => {
        const expectedOutput: Uint8Array[] = [];

        const {client, server} = getServerAndClient(testConfig, testConfig, (stream) => {
            stream.on('data', (data) => {
                const received = new Uint8Array(data);
                expect(expectedOutput[0]).toEqual(received);
                // Send it back
                stream.write(data);
            });
        });

        const message = new Uint8Array(1024).fill(0x42);
        expectedOutput.push(message);

        const stream = client.open();
        expect(stream).not.toBeUndefined();
        const [promise, resolve] = withResolvers();
        stream.on('data', (data) => {
            expect(stream['recvWindow']).toBe(initialStreamWindow - 1024);
            resolve();
        });
        stream.write(message);
        await promise;
    });

    it('updates the receive window - and resets it when needed', async () => {
        const expectedOutput: Uint8Array[] = [];

        const {client, server} = getServerAndClient(testConfig, testConfig, (stream) => {
            stream.on('data', (data) => {
                const received = new Uint8Array(data);
                expect(expectedOutput[0]).toEqual(received);
                // Send it back
                stream.write(data);
            });
        });

        const message = new Uint8Array(200 * 1024).fill(0x42);
        expectedOutput.push(message);

        const stream = client.open();
        expect(stream).not.toBeUndefined();

        const [promise, resolve] = withResolvers();
        stream.on('data', (data) => {
            expect(stream['recvWindow']).toBe(initialStreamWindow);
            resolve();
        });

        // Send the message and wait to get it back
        stream.write(message);
        await promise;
    });

    it('handles Go away', async () => {
        const {server, client} = getServerAndClient(testConfig, testConfig);
        const [promise, resolve] = withResolvers();
        client.on('error', (err) => {
            expect(err.toString()).toBe('Error: remote end is not accepting connections');
            resolve();
        });
        server.close();
        const stream = client.open();
        await promise;
        // expect(stream).toBeUndefined();
    });

    it('handles many streams', async () => {
        const nbStreams = 1000;
        const expectedOutput = new Set();

        const {client} = getServerAndClient(
            {...testConfig, acceptBacklog: 1000, connectionWriteTimeout: 2},
            {...testConfig, connectionWriteTimeout: 2},
            (stream) => {
                stream.on('data', (data) => {
                    const received = data.toString();
                    expect(expectedOutput.has(received)).toBe(true);
                    // Send it back
                    stream.write(data);
                });
            }
        );
        const [promise, resolve, reject] = withResolvers(2000);
        client.on('error', (err) => {
            reject(err);
        });
        for (let i = 0; i < nbStreams; i++) {
            const message = 'echo-' + i;
            expectedOutput.add(message);

            const stream = client.open();
            expect(stream).not.toBeUndefined();
            stream!.on('data', (data) => {
                const received = data.toString();
                expect(expectedOutput.has(received)).toBe(true);
                expectedOutput.delete(received);
                if (expectedOutput.size === 0) {
                    resolve();
                }
            });
            // Send the message and wait to get it back
            stream!.write(message);
        }
        await promise;
        client.removeAllListeners();
        client.close();
    });

    it('handles correctly window updates', async () => {
        const {client} = getServerAndClient(testConfig, testConfig, (stream) => {
            // Write back the data
            stream.on('data', stream.write);
        });

        let hasReceivedMessageBeforeWindowUpdate = false;

        const stream = client.open();
        stream.on('data', (data) => {
            const received = new TextDecoder().decode(data);

            if (!hasReceivedMessageBeforeWindowUpdate) {
                expect(received).toBe('Data before window update');
                hasReceivedMessageBeforeWindowUpdate = true;
            } else {
                expect(received).toBe('Data after window update');
            }
        });

        stream.write(new TextEncoder().encode('Data before window update'));

        const stream2 = client.open();
        const [promise, resolve] = withResolvers();

        stream2.on('data', (data) => {
            const received = new TextDecoder().decode(data);
            expect(received).toBe('unrelated data');
            resolve();
        });

        const dataWithHeader = (streamID: number, data: string) =>
            new Uint8Array([
                ...new Header(VERSION, TYPES.Data, 0, streamID, data.length).encode(),
                ...new TextEncoder().encode(data),
            ]);

        // Update the window (size += 1)
        const hdr = new Header(VERSION, TYPES.WindowUpdate, FLAGS.ACK, stream.ID(), 1);
        // Send additional data along with the window update, for both streams
        client.send(
            hdr,
            new Uint8Array([
                ...dataWithHeader(stream.ID(), 'Data after window update'),
                ...dataWithHeader(stream2.ID(), 'unrelated data'),
            ])
        );
        await promise;
    });
});

describe('Server/client', () => {
    it('handles close before ack', async () => {
        const server = new Session(false, testConfig, (stream) => {
            stream.end(); // Close the stream immediately
        });
        const client = new Session(true, testConfig);
        client.pipe(server).pipe(client);
        await new Promise<void>((resolve) => {
            client.open();
            setTimeout(resolve, 0);
        });
    });
});
