import { describe, expect, test } from 'vitest';
import { Session, StaticAuthenticator } from '@mindlog/services';

describe('StaticAuthenticator', () => {
  test('without a password nothing is required and nothing verifies', () => {
    const auth = new StaticAuthenticator();
    expect(auth.required).toBe(false);
    expect(auth.verify('default', 'x')).toBe(false);
  });

  test('accepts only the default user with the right password', () => {
    const auth = new StaticAuthenticator('s3cret');
    expect(auth.required).toBe(true);
    expect(auth.verify('default', 's3cret')).toBe(true);
    expect(auth.verify('default', 's3cre')).toBe(false);
    expect(auth.verify('admin', 's3cret')).toBe(false);
  });
});

describe('Session', () => {
  test('resetTransaction clears MULTI and WATCH state', () => {
    const session = new Session('c1', 'default', true);
    session.transaction = { queued: [[Uint8Array.of(1)]], failed: false };
    session.watches.set('k', { key: Uint8Array.of(1), version: 3n });
    session.resetTransaction();
    expect(session.transaction).toBeUndefined();
    expect(session.watches.size).toBe(0);
  });
});
