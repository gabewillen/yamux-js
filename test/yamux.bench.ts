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

describe('yamux benchmarks', () => {
    bench(
        'sending message',
        async () => {
            const {client} = getServerAndClient(testConfig, testConfig, (stream) => {
                stream.on('data', (data) => {
                    stream.write(data);
                });
            });
            const [promise, resolve] = withResolvers();
            const stream = client.open();
            const message = 'echo'.repeat(10000);
            stream.on('data', resolve);
            stream.write(message);
            await promise;
        },
        {
            iterations: 1000,
        }
    );
});
