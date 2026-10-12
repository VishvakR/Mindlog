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
    expect(config.listen.mcp).toEqual({ http: { port: 8765 }, stdio: true });
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

  test('rejects malformed YAML and non-mapping documents', () => {
    expect(failure(resolveConfig({ fileText: 'node: [unclosed' })).code).toBe('CONFIG_INVALID');
    expect(failure(resolveConfig({ fileText: '- a\n- b\n' })).code).toBe('CONFIG_INVALID');
  });
});

describe('resolveConfig limits and auth', () => {
  test('defaults follow Valkey limits and leave auth off', () => {
    const config = value(resolveConfig());
    expect(config.limits.maxBulkBytes).toBe(512 * 1024 * 1024);
    expect(config.limits.maxInlineBytes).toBe(64 * 1024);
    expect(config.limits.idleTimeoutMs).toBe(0);
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
