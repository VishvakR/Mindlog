import type { ProtocolVersion } from '../protocol/resp-writer.js';

const seconds = (ms: bigint): bigint => (ms < 0n ? 0n : ms / 1000n);

/** What CLIENT INFO, CLIENT LIST and INFO report about one connection. */
export class ClientState {
  name = '';
  libName = '';
  libVersion = '';
  protocol: ProtocolVersion = 2;
  /** Last command run, lower case, as in Valkey's `cmd=` field. */
  lastCommand = 'NULL';
  lastActiveMs: bigint;
  /** Commands queued in MULTI, or -1 outside a transaction. */
  multi = -1;

  constructor(
    readonly id: number,
    readonly address: string,
    readonly localAddress: string,
    readonly createdMs: bigint,
  ) {
    this.lastActiveMs = createdMs;
  }

  /** One CLIENT LIST line, Valkey field names, the fields Mindlog tracks. */
  describe(nowMs: bigint): string {
    return [
      `id=${String(this.id)}`,
      `addr=${this.address}`,
      `laddr=${this.localAddress}`,
      `name=${this.name}`,
      `age=${String(seconds(nowMs - this.createdMs))}`,
      `idle=${String(seconds(nowMs - this.lastActiveMs))}`,
      'flags=N',
      'db=0',
      `multi=${String(this.multi)}`,
      `resp=${String(this.protocol)}`,
      `lib-name=${this.libName}`,
      `lib-ver=${this.libVersion}`,
      `cmd=${this.lastCommand}`,
    ].join(' ');
  }
}

/** Open connections on this node, by client id (ids are never reused). */
export class ClientRegistry {
  readonly #clients = new Map<number, ClientState>();
  #nextId = 1;

  get size(): number {
    return this.#clients.size;
  }

  register(address: string, localAddress: string, nowMs: bigint): ClientState {
    const client = new ClientState(this.#nextId++, address, localAddress, nowMs);
    this.#clients.set(client.id, client);
    return client;
  }

  remove(id: number): void {
    this.#clients.delete(id);
  }

  list(): ClientState[] {
    return [...this.#clients.values()];
  }
}
