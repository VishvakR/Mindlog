/** PEM material of this node, read from files by the composition root. */
export interface TlsIdentity {
  readonly key: string;
  readonly cert: string;
  readonly ca: string;
}

/**
 * The node's current certificates (PLAN 18.4). `subscribe` fires after a
 * rotated set is loaded and verified; a bad set never reaches subscribers.
 */
export interface TlsProvider {
  identity(): TlsIdentity;
  /** Returns the unsubscribe function. */
  subscribe(listener: (identity: TlsIdentity) => void): () => void;
}

const MIN_VERSION = 'TLSv1.2' as const;

/** What clients of a public listener verify: the server only. */
export const publicServerTls = (i: TlsIdentity) => ({
  key: i.key,
  cert: i.cert,
  minVersion: MIN_VERSION,
});

/** Node-to-node listeners: peers must present a certificate from the cluster CA. */
export const mutualServerTls = (i: TlsIdentity) => ({
  key: i.key,
  cert: i.cert,
  ca: i.ca,
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: MIN_VERSION,
});

/**
 * A node's outbound identity. The cluster CA is the trust anchor, so a peer is
 * accepted by its chain rather than its host name; nodes are addressed by IP.
 */
export const mutualClientTls = (i: TlsIdentity) => ({
  key: i.key,
  cert: i.cert,
  ca: i.ca,
  rejectUnauthorized: true,
  checkServerIdentity: (): undefined => undefined,
  minVersion: MIN_VERSION,
});

/** Connect client options for a node-to-node call: HTTPS with this node's identity under TLS. */
export function grpcClientOptions(address: string, tls: TlsProvider | undefined) {
  return tls
    ? { baseUrl: `https://${address}`, nodeOptions: mutualClientTls(tls.identity()) }
    : { baseUrl: `http://${address}` };
}
