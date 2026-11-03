import { createHash } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNet } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryLogger } from '@mindlog/core';
import type { OAuth2Provider, TokenClaims } from '@mindlog/auth';
import {
  ConsoleMailer,
  RateLimiter,
  SmtpMailer,
  authorizeUrl,
  discoverOidc,
  exchangeCode,
  hashPassword,
  otpCode,
  pkce,
  readJwt,
  recordId,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '@mindlog/auth';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe('passwords', () => {
  test('argon2id hashes verify, wrong passwords and empty hashes do not', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
    expect(await verifyPassword('$2b$10$bcrypt', 'x')).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(hash);
  });
});

describe('JWT', () => {
  const claims: TokenClaims = {
    sub: 'u1',
    col: 'users',
    ten: 't',
    typ: 'access',
    iat: 100,
    exp: 200,
  };

  test('signs and verifies until expiry', () => {
    const token = signJwt(claims, 'k1', 'secret+tokenKey');
    expect(readJwt(token)).toEqual({ kid: 'k1', claims });
    expect(verifyJwt(token, 'secret+tokenKey', 150)).toBe(true);
    expect(verifyJwt(token, 'secret+tokenKey', 200)).toBe(false);
    expect(verifyJwt(token, 'secret+otherKey', 150)).toBe(false);
  });

  test('rejects tampered payloads and other algorithms', () => {
    const token = signJwt(claims, 'k1', 'key');
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    expect(verifyJwt(`${h ?? ''}.${forged}.${s ?? ''}`, 'key', 150)).toBe(false);
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    expect(readJwt(`${none}.${forged}.`)).toBeUndefined();
    expect(readJwt('not.a.jwt')).toBeUndefined();
  });
});

test('rate limiter refills and stays bounded', () => {
  const limit = new RateLimiter({ burst: 2, perSecond: 1, maxKeys: 2 });
  expect([limit.take('a', 0), limit.take('a', 0), limit.take('a', 0)]).toEqual([true, true, false]);
  expect(limit.take('a', 1000)).toBe(true);
  limit.take('b', 0);
  limit.take('c', 0);
  // 'a' was dropped as the oldest key, so it starts with a full bucket.
  expect([limit.take('a', 1000), limit.take('a', 1000)]).toEqual([true, true]);
});

test('ids and codes', () => {
  expect(recordId()).toMatch(/^[a-z0-9]{15}$/);
  expect(otpCode(6)).toMatch(/^\d{6}$/);
  const { verifier, challenge } = pkce();
  expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
});

describe('mailers', () => {
  test('the console mailer logs the message', async () => {
    const logger = new MemoryLogger();
    await new ConsoleMailer(logger).send({ to: 'a@b.io', subject: 'Code', text: '123456' });
    expect(logger.entries.at(-1)?.fields).toMatchObject({ to: 'a@b.io', text: '123456' });
  });

  test('the SMTP client talks to a server, with auth and dot-stuffing', async () => {
    const seen: string[] = [];
    const server = createNet((socket) => {
      socket.setEncoding('utf8');
      let data = false;
      let buffer = '';
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          seen.push(line);
          if (data) {
            if (line === '.') {
              data = false;
              socket.write('250 queued\r\n');
            }
            continue;
          }
          const verb = line.split(' ')[0]?.toUpperCase();
          if (verb === 'EHLO') socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
          else if (verb === 'AUTH') socket.write('235 ok\r\n');
          else if (verb === 'DATA') {
            data = true;
            socket.write('354 go\r\n');
          } else if (verb === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const mailer = new SmtpMailer({
      host: '127.0.0.1',
      port,
      tls: false,
      requireTls: false,
      username: 'u',
      password: 'p',
      from: 'noreply@mindlog.local',
      timeoutMs: 2000,
    });
    const sent = await mailer.send({ to: 'a@b.io', subject: 'Héllo', text: 'line\n.dot' });
    expect(sent.ok).toBe(true);
    expect(seen).toContain(`AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`);
    expect(seen).toContain('RCPT TO:<a@b.io>');
    expect(seen).toContain('..dot');
    expect(seen.find((l) => l.startsWith('Subject:'))).toBe(
      `Subject: =?UTF-8?B?${Buffer.from('Héllo').toString('base64')}?=`,
    );
    const injected = await mailer.send({ to: 'a@b.io\r\nBcc: x@y.io', subject: 's', text: 't' });
    expect(injected.ok).toBe(false);
  });

  test('requireTls refuses a server without STARTTLS', async () => {
    const server = createNet((socket) => {
      socket.write('220 fake\r\n');
      socket.on('data', () => socket.write('250 fake\r\n'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const mailer = new SmtpMailer({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      tls: false,
      requireTls: true,
      from: 'a@b.io',
      timeoutMs: 2000,
    });
    const sent = await mailer.send({ to: 'x@y.io', subject: 's', text: 't' });
    expect(!sent.ok && sent.error.message).toContain('no STARTTLS');
  });
});

describe('OAuth2 against a fake provider', () => {
  test('discovery, PKCE-checked code exchange and user info', async () => {
    let challenge = '';
    const server = createHttp((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            authorization_endpoint: `${base}/auth`,
            token_endpoint: `${base}/token`,
            userinfo_endpoint: `${base}/me`,
          }),
        );
      } else if (url.pathname === '/token') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const okPkce =
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url') === challenge;
          res.statusCode = okPkce && form.get('code') === 'good' ? 200 : 400;
          res.end(
            JSON.stringify(
              res.statusCode === 200 ? { access_token: 'at' } : { error: 'invalid_grant' },
            ),
          );
        });
      } else if (url.pathname === '/me' && req.headers.authorization === 'Bearer at') {
        res.end(
          JSON.stringify({ sub: 'ext-1', email: 'Ann@X.io', email_verified: true, name: 'Ann' }),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const found = await discoverOidc('fake', issuer, { clientId: 'cid', clientSecret: 'cs' });
    if (!found.ok) throw new Error(found.error.message);
    const provider: OAuth2Provider = found.value;
    const pair = pkce();
    challenge = pair.challenge;
    const url = new URL(
      authorizeUrl(provider, {
        state: 's1',
        challenge: pair.challenge,
        redirectUri: 'http://app/cb',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      code_challenge_method: 'S256',
      state: 's1',
      client_id: 'cid',
    });
    const user = await exchangeCode(provider, {
      code: 'good',
      verifier: pair.verifier,
      redirectUri: 'http://app/cb',
    });
    expect(user).toEqual({
      ok: true,
      value: { id: 'ext-1', email: 'ann@x.io', name: 'Ann', verified: true },
    });
    const badVerifier = await exchangeCode(provider, {
      code: 'good',
      verifier: 'wrong',
      redirectUri: 'http://app/cb',
    });
    expect(!badVerifier.ok && badVerifier.error.code).toBe('INVALID_CREDENTIALS');
  });
});
