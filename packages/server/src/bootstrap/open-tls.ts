import type { Logger, MindlogConfig, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { TlsFiles } from '@mindlog/transport';

/** This node's certificates, watched for rotation; undefined when TLS is off. */
export function openTls(
  config: MindlogConfig,
  logger: Logger,
): Result<TlsFiles | undefined, MindlogError> {
  const { enabled, ca, cert, key, reloadMs } = config.tls;
  if (!enabled || !ca || !cert || !key) return ok(undefined);
  try {
    const files = new TlsFiles({ ca, cert, key }, logger);
    files.watch(reloadMs);
    return ok(files);
  } catch (cause) {
    return err(mindlogError('CONFIG_INVALID', 'cannot load the TLS certificates', { cause }));
  }
}
