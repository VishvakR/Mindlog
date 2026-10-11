// ILLEGAL: deep import into another package instead of its public entry.
import { ok } from '@mindlog/core/src/result/result.js';

export const wrapped = ok;
