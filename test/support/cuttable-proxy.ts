import type { Socket } from 'node:net';
import { connect, createServer } from 'node:net';

/** A TCP proxy to a local port whose link can be cut and restored, as a network partition would. */
export async function cuttableProxy(target: number) {
  const open = new Set<Socket>();
  let cut = false;
  const server = createServer((client) => {
    if (cut) {
      client.destroy();
      return;
    }
    const upstream = connect(target, '127.0.0.1');
    for (const s of [client, upstream]) {
      open.add(s);
      s.on('close', () => open.delete(s));
      s.on('error', () => s.destroy());
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    cut() {
      cut = true;
      for (const s of open) s.destroy();
    },
    restore() {
      cut = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
