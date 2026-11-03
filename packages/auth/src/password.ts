import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/** OWASP's argon2id minimum: 19 MiB, 2 passes, 1 lane (ADR-0035). */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

function derive(
  password: string,
  nonce: Buffer,
  p: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce, ...p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** An argon2id PHC string: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  const { memory, passes, parallelism } = PARAMS;
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Hashed once at startup: a failed lookup verifies against it so it takes as long as a real one. */
let dummy: Promise<string> | undefined;

/** Checks a password against a stored hash in constant time; an empty hash checks against a dummy. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const phc = stored === '' ? await (dummy ??= hashPassword('mindlog-dummy-password')) : stored;
  const m = PHC.exec(phc);
  if (m === null) return false;
  const expected = Buffer.from(m[5] ?? '', 'base64url');
  const actual = await derive(password, Buffer.from(m[4] ?? '', 'base64url'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return stored !== '' && actual.length === expected.length && timingSafeEqual(actual, expected);
}
