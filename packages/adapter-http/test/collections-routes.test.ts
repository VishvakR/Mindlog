import { describe, expect, test } from 'vitest';
import { httpNode } from './support/http-node.js';

const routes: [string, string, unknown?][] = [
  ['GET', '/api/collections'],
  ['POST', '/api/collections', {}],
  ['POST', '/api/collections/rules/check', { collection: 'c', rule: '' }],
  ['GET', '/api/collections/c'],
  ['PATCH', '/api/collections/c', { schema: {}, version: '1' }],
  ['DELETE', '/api/collections/c'],
  ['GET', '/api/collections/c/records'],
  ['GET', '/api/collections/c/records/r'],
  ['POST', '/api/collections/c/records', {}],
  ['PATCH', '/api/collections/c/records/r', {}],
  ['DELETE', '/api/collections/c/records/r'],
  ['POST', '/api/collections/c/auth-with-password', { identity: 'a', password: 'b' }],
  ['POST', '/api/collections/c/auth-refresh', {}],
  ['POST', '/api/collections/c/request-otp', { email: 'a' }],
  ['POST', '/api/collections/c/auth-with-otp', { otpId: 'a', password: 'b' }],
  ['POST', '/api/collections/c/auth-with-oauth2', { provider: 'a', code: 'b', state: 'c' }],
  ['POST', '/api/collections/c/request-verification', { email: 'a' }],
  ['POST', '/api/collections/c/confirm-verification', { token: 'a' }],
  ['POST', '/api/collections/c/request-password-reset', { email: 'a' }],
  [
    'POST',
    '/api/collections/c/confirm-password-reset',
    { token: 'a', password: 'b', passwordConfirm: 'b' },
  ],
  ['GET', '/api/collections/c/auth-methods'],
  ['POST', '/api/auth/delegate', { userToken: 'a' }],
  ['POST', '/api/files/token'],
  ['GET', '/api/files/c/r/f.png'],
  ['GET', '/api/realtime'],
  ['POST', '/api/realtime', { clientId: 'a', subscriptions: [] }],
];

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe('a node without full-stack services', () => {
  test.each(routes)('%s %s answers 501', async (method, url, payload) => {
    const node = await httpNode();
    const res = await node.app.inject({
      method: method as Method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    expect(res.statusCode).toBe(501);
  });
});

test('the OAuth2 redirect page cannot be turned into script', async () => {
  const node = await httpNode();
  const res = await node.app.inject({
    method: 'GET',
    url: '/api/oauth2-redirect?code=%3C/script%3E%3Cb%3E&state=s',
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain('</script><b>');
  expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  const none = await node.app.inject({ method: 'GET', url: '/api/oauth2-redirect' });
  expect(none.body).toContain('"code":""');
});

test('the memory stream still needs a superuser', async () => {
  const node = await httpNode();
  expect((await node.app.inject({ method: 'GET', url: '/api/realtime?user=a' })).statusCode).toBe(
    401,
  );
});
