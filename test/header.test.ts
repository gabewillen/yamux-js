import {expect, describe, it} from 'vitest';

import {VERSION, TYPES, FLAGS} from '../src/constants';
import {Header} from '../src/header';

describe('Header', () => {
    it('has the correct length', () => {
        expect(Header.LENGTH).to.equal(12);
    });

    it('can parse and re-encode an encoded header', () => {
        const encodedHeader = new Uint8Array([0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07]);
        const header = Header.parse(encodedHeader);

        expect(header.version).to.equal(VERSION);
        expect(header.type).to.equal(TYPES.Ping);
        expect(header.flags).to.equal(FLAGS.SYN);
        expect(header.streamID).to.equal(0);
        expect(header.length).to.equal(7);

        const encodedBuffer = header.encode();
        expect(encodedBuffer).to.deep.equal(encodedHeader);
    });
});
