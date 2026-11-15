import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/** Stable for the life of the process: `<host>-<pid>-<random>`. */
export const INSTANCE_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
export const PROCESS_STARTED_AT = Date.now();
