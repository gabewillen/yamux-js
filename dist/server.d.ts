import { Duplex } from 'readable-stream';
import { Config } from './mux';
import { Session } from './session';
export declare class Server extends Session {
    constructor(onStream: (duplex: Duplex) => void, config?: Config);
}
