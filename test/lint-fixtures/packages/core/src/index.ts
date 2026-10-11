// ILLEGAL: core (lowest layer) imports storage (a higher layer) through a relative path.
import { storageValue } from '../../storage/src/index.js';

export const coreValue = storageValue + 1;
