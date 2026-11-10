/** Dependency-injection tokens for infrastructure that is not a class. */
export const API_CONFIG = Symbol('API_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');
/** `() => number` (epoch ms). Tests inject a controllable clock. */
export const CLOCK = Symbol('CLOCK');
export type Clock = () => number;
