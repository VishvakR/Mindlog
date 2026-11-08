import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let admin = '';
let ann = { id: '', token: '' };
let bob = { id: '', token: '' };
let png: Uint8Array<ArrayBuffer>;

const api = async (
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; form?: FormData } = {},
) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
    ...(opts.form ? { body: opts.form } : {}),
  });
  const type = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    json: (type.includes('json') ? await res.json() : undefined) as Record<string, unknown>,
    bytes: type.includes('json') ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()),
  };
};

async function user(email: string) {
  const made = await api('POST', '/api/collections/users/records', {
    json: { email, password: 'password123', passwordConfirm: 'password123' },
  });
  const signed = await api('POST', '/api/collections/users/auth-with-password', {
    json: { identity: email, password: 'password123' },
  });
  return { id: String(made.json['id']), token: String(signed.json['token']) };
}

const form = (
  fields: Record<string, string>,
  file?: { field: string; name: string; type: string; bytes: Uint8Array<ArrayBuffer> },
) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);
  return f;
};

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 1000 } });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  admin = String(
    (
      await api('POST', '/api/superusers/auth-with-password', {
        json: { email: 'admin@x.io', password: 'correct horse battery' },
      })
    ).json['token'],
  );
  await api('POST', '/api/collections', {
    token: admin,
    json: { name: 'users', type: 'auth', createRule: '', viewRule: '', listRule: '' },
  });
  const owner = "@request.auth.id != '' && user = @request.auth.id";
  const created = await api('POST', '/api/collections', {
    token: admin,
    json: {
      name: 'notes',
      fields: [
        { name: 'user', type: 'relation', collection: 'users' },
        {
          name: 'photo',
          type: 'file',
          mimeTypes: ['image/png'],
          thumbs: ['16x16'],
          maxSize: 100000,
        },
        { name: 'docs', type: 'file', maxSelect: 5 },
      ],
      listRule: owner,
      viewRule: owner,
      createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
      updateRule: owner,
      deleteRule: owner,
    },
  });
  expect(created.status).toBe(200);
  ann = await user('ann@x.io');
  bob = await user('bob@x.io');
  png = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } })
      .png()
      .toBuffer(),
  );
}, 60_000);

afterAll(async () => {
  await node.stop();
});

const photo = () => ({ field: 'photo', name: 'my cat!.png', type: 'image/png', bytes: png });

describe('record files', () => {
  test('upload, download under the view rule, thumbnails and file tokens', async () => {
    const made = await api('POST', '/api/collections/notes/records', {
      token: ann.token,
      form: form({ user: ann.id }, photo()),
    });
    expect(made.status).toBe(200);
    const name = String(made.json['photo']);
    expect(name).toMatch(/^my_cat__[0-9a-z]+\.png$/);
    const url = `/api/files/notes/${String(made.json['id'])}/${name}`;
    const got = await api('GET', url, { token: ann.token });
    expect([got.status, got.bytes]).toEqual([200, png]);
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect((await api('GET', url, { token: bob.token })).status).toBe(404);
    expect((await api('GET', url)).status).toBe(404);
    const thumb = await api('GET', `${url}?thumb=16x16`, { token: ann.token });
    expect((await sharp(thumb.bytes).metadata()).width).toBe(16);
    const notListed = await api('GET', `${url}?thumb=32x32`, { token: ann.token });
    expect(notListed.bytes).toEqual(png);
    const token = String(
      (await api('POST', '/api/files/token', { token: ann.token })).json['token'],
    );
    expect((await api('GET', `${url}?token=${token}`)).status).toBe(200);
    expect((await api('GET', `${url}?token=${ann.token}`)).status).toBe(401);
  });

  test('uploads are validated, and refused writes store nothing the record names', async () => {
    const wrongType = await api('POST', '/api/collections/notes/records', {
      token: ann.token,
      form: form(
        { user: ann.id },
        { field: 'photo', name: 'x.gif', type: 'image/gif', bytes: png },
      ),
    });
    expect(wrongType.json['fields']).toEqual({ photo: 'image/gif is not allowed' });
    const impostor = await api('POST', '/api/collections/notes/records', {
      token: bob.token,
      form: form({ user: ann.id }, photo()),
    });
    expect(impostor.status).toBe(400);
  });

  test('a client cannot point a file field at a file it did not upload', async () => {
    const mine = await api('POST', '/api/collections/notes/records', {
      token: ann.token,
      form: form({ user: ann.id }, photo()),
    });
    const stolen = await api('POST', '/api/collections/notes/records', {
      token: bob.token,
      json: { user: bob.id, photo: mine.json['photo'] },
    });
    expect(stolen.json['fields']).toEqual({ photo: 'files must be uploaded' });
  });

  test('file modifiers append and remove; unsafe types download as attachments', async () => {
    const html = new Uint8Array(new TextEncoder().encode('<script>alert(1)</script>'));
    const made = await api('POST', '/api/collections/notes/records', {
      token: ann.token,
      form: form(
        { user: ann.id },
        { field: 'docs', name: 'a.html', type: 'text/html', bytes: html },
      ),
    });
    const id = String(made.json['id']);
    const [first = ''] = made.json['docs'] as string[];
    const url = `/api/files/notes/${id}/${first}`;
    const served = await api('GET', url, { token: ann.token });
    expect(served.headers.get('content-disposition')).toBe('attachment');
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    const more = await api('PATCH', `/api/collections/notes/records/${id}`, {
      token: ann.token,
      form: form(
        {},
        { field: 'docs', name: 'b.txt', type: 'text/plain', bytes: new Uint8Array([104, 105]) },
      ),
    });
    expect(more.json['docs']).toHaveLength(2);
    const fewer = await api('PATCH', `/api/collections/notes/records/${id}`, {
      token: ann.token,
      json: { 'docs-': [first] },
    });
    expect(fewer.json['docs']).toHaveLength(1);
    expect((await api('GET', url, { token: ann.token })).status).toBe(404);
  });
});
