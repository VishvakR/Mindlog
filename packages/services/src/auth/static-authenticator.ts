import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/**
 * Phase 1 authentication: one `default` user with an optional password
 * (`auth.password`). With no password every session starts authenticated.
 * Comparison is constant-time over SHA-256 digests, so length leaks nothing.
 */
export class StaticAuthenticator {
  readonly #expected: Buffer | undefined;
  readonly #required: boolean;

  /** `requireAuth` keeps sessions unauthenticated even with no password: only API keys get in. */
  constructor(password?: string, requireAuth = false) {
    this.#expected = password === undefined ? undefined : digest(password);
    this.#required = requireAuth || password !== undefined;
  }

  /** Whether sessions must authenticate before running commands. */
  get required(): boolean {
    return this.#required;
  }

  verify(username: string, password: string): boolean {
    if (!this.#expected || username !== 'default') return false;
    return timingSafeEqual(digest(password), this.#expected);
  }
}
