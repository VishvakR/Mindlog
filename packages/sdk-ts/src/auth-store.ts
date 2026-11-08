export type AuthRecord = Record<string, unknown> & { id: string };

/** What `localStorage` offers; any object with these two methods persists the session. */
export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'mindlog_auth';

function decodeExp(token: string): number {
  const part = token.split('.')[1] ?? '';
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp : 0;
  } catch {
    return 0;
  }
}

/** The signed-in user; in memory, or in `storage` (browsers pass `localStorage`). */
export class AuthStore {
  token = '';
  refreshToken = '';
  record: AuthRecord | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly storage?: AuthStorage) {
    const saved = storage?.getItem(KEY);
    if (!saved) return;
    try {
      const s = JSON.parse(saved) as {
        token: string;
        refreshToken: string;
        record: AuthRecord | null;
      };
      Object.assign(this, { token: s.token, refreshToken: s.refreshToken, record: s.record });
    } catch {
      storage?.removeItem(KEY);
    }
  }

  /** Whether there is a token that has not expired. */
  get isValid(): boolean {
    return this.token !== '' && decodeExp(this.token) > Date.now() / 1000;
  }

  save(token: string, record: AuthRecord | null, refreshToken = this.refreshToken): void {
    Object.assign(this, { token, record, refreshToken });
    this.storage?.setItem(KEY, JSON.stringify({ token, refreshToken, record }));
    for (const l of this.#listeners) l();
  }

  clear(): void {
    Object.assign(this, { token: '', refreshToken: '', record: null });
    this.storage?.removeItem(KEY);
    for (const l of this.#listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
