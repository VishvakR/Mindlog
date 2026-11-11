import { describe, expect, test } from 'vitest';
import type { MindlogConfig, MindlogError, Result } from '@mindlog/core';
import { resolveConfig } from '@mindlog/core';

function value(result: Result<MindlogConfig, MindlogError>): MindlogConfig {
  if (!result.ok) expect.fail(JSON.stringify(result.error));
  return result.value;
}

function failure(result: Result<MindlogConfig, MindlogError>): MindlogError {
  if (result.ok) expect.fail('expected the config to be rejected');
  return result.error;
}

describe('resolveConfig', () => {
  test('defaults follow PLAN Appendix B, with tracing off', () => {
    const config = value(resolveConfig());
    expect(config.listen.resp).toEqual({ host: '0.0.0.0', port: 6379, tls: false });
    expect(config.listen.http.port).toBe(8090);
    expect(config.listen.grpc.port).toBe(9090);
    expect(config.listen.internal.port).toBe(7000);
    expect(config.listen.mcp).toEqual({
      http: { host: '127.0.0.1', port: 8765, allowedHosts: [] },
      stdio: true,
    });
    expect(config.observability.tracing.endpoint).toBeUndefined();
    expect(config.profile).toBe('dev');
  });

  test('layers: file < env < flags', () => {
    const config = value(
      resolveConfig({
        fileText: 'node:\n  id: from-file\n  zone: zone-file\nlisten:\n  resp:\n    port: 7001\n',
        env: { MINDLOG_NODE__ID: 'from-env', MINDLOG_LISTEN__RESP__PORT: '7002' },
        flags: { node: { id: 'from-flags' } },
      }),
    );
    expect(config.node.id).toBe('from-flags');
    expect(config.node.zone).toBe('zone-file');
    expect(config.listen.resp.port).toBe(7002);
  });

  test('env names map to camelCase paths and typed values', () => {
    const config = value(
      resolveConfig({
        env: {
          MINDLOG_NODE__DATA_DIR: '/var/lib/mindlog',
          MINDLOG_LISTEN__RESP__TLS: 'true',
          MINDLOG_OBSERVABILITY__TRACING__SAMPLE_RATIO: '0.5',
          MINDLOG_PROFILE: 'production',
          MINDLOG_TLS__ENABLED: 'true',
          MINDLOG_TLS__CA: '/etc/mindlog/ca.pem',
          MINDLOG_TLS__CERT: '/etc/mindlog/node.pem',
          MINDLOG_TLS__KEY: '/etc/mindlog/node.key',
        },
      }),
    );
    expect(config.node.dataDir).toBe('/var/lib/mindlog');
    expect(config.listen.resp.tls).toBe(true);
    expect(config.observability.tracing.sampleRatio).toBe(0.5);
    expect(config.profile).toBe('production');
  });

  test('env vars outside config sections are ignored', () => {
    expect(resolveConfig({ env: { MINDLOG_JOIN_TOKEN: 'secret', PATH: '/bin' } }).ok).toBe(true);
  });

  test('interpolates ${VAR} in file values', () => {
    const config = value(
      resolveConfig({
        fileText: 'node:\n  id: ${NODE_NAME}-a\n',
        env: { NODE_NAME: 'edge' },
      }),
    );
    expect(config.node.id).toBe('edge-a');
  });

  test('an unset interpolation variable is an error naming the field', () => {
    const error = failure(resolveConfig({ fileText: 'node:\n  id: ${MISSING}\n' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.fields).toEqual({ 'node.id': 'references unset variable MISSING' });
  });

  test('typos and bad values report their field paths', () => {
    const error = failure(
      resolveConfig({ fileText: 'listen:\n  resp:\n    prot: 1\n  http:\n    port: 70000\n' }),
    );
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(['listen.http.port', 'listen.resp']);
  });

  test('raft and cluster defaults follow PLAN 7.4; leases must be shorter than elections', () => {
    const config = value(resolveConfig());
    expect(config.node.raftId).toBe(1);
    expect(config.cluster).toEqual({
      peers: [],
      join: false,
      maxClockOffsetMs: 500,
      pdEndpoints: [],
    });
    expect(config.pd).toMatchObject({
      enabled: false,
      listen: { port: 7100 },
      deadAfterMs: 300_000,
    });
    expect(config.ranges).toMatchObject({ maxBytes: 64 * 1024 * 1024, replicas: 3 });
    expect(config.features).toEqual({ crossRangeTxn: false, semanticSplit: false });
    expect(config.raft).toMatchObject({ tickMs: 100, electionTicks: [10, 20], leaseTicks: 9 });
    const peers = value(
      resolveConfig({ fileText: 'cluster:\n  peers:\n    - { id: 1, address: "a:7000" }\n' }),
    );
    expect(peers.cluster.peers).toEqual([{ id: 1, address: 'a:7000' }]);
    const error = failure(resolveConfig({ fileText: 'raft:\n  leaseTicks: 10\n' }));
    expect(error.message + JSON.stringify(error.fields)).toMatch(/leaseTicks/);
  });

  test('rejects malformed YAML and non-mapping documents', () => {
    expect(failure(resolveConfig({ fileText: 'node: [unclosed' })).code).toBe('CONFIG_INVALID');
    expect(failure(resolveConfig({ fileText: '- a\n- b\n' })).code).toBe('CONFIG_INVALID');
  });
});

describe('resolveConfig models', () => {
  test('no model service by default; the endpoint comes from the environment', () => {
    expect(value(resolveConfig()).models).toEqual({
      endpoint: undefined,
      timeoutMs: 2000,
      breakerFailures: 5,
      breakerOpenMs: 10_000,
    });
    const config = value(
      resolveConfig({ env: { MINDLOG_MODELS__ENDPOINT: 'model-service:50051' } }),
    );
    expect(config.models.endpoint).toBe('model-service:50051');
  });
});

describe('resolveConfig ports', () => {
  test('port 0 binds any free port; out-of-range ports are rejected', () => {
    expect(
      value(resolveConfig({ flags: { listen: { resp: { port: 0 } } } })).listen.resp.port,
    ).toBe(0);
    const error = failure(resolveConfig({ flags: { listen: { resp: { port: 65_536 } } } }));
    expect(Object.keys(error.fields ?? {})).toEqual(['listen.resp.port']);
  });
});

describe('resolveConfig limits and auth', () => {
  test('defaults follow Valkey limits and leave auth off', () => {
    const config = value(resolveConfig());
    expect(config.limits.maxBulkBytes).toBe(512 * 1024 * 1024);
    expect(config.limits.maxInlineBytes).toBe(64 * 1024);
    expect(config.limits.idleTimeoutMs).toBe(0);
    expect(config.limits.maxPipelineCommands).toBe(1024);
    expect(config.auth.password).toBeUndefined();
  });

  test('a password comes from the environment', () => {
    const config = value(resolveConfig({ env: { MINDLOG_AUTH__PASSWORD: 's3cret' } }));
    expect(config.auth.password).toBe('s3cret');
  });

  test('limits must be positive', () => {
    const error = failure(resolveConfig({ flags: { limits: { maxClients: 0 } } }));
    expect(Object.keys(error.fields ?? {})).toEqual(['limits.maxClients']);
  });
});
