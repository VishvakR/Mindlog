import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { CollectionInput } from '@mindlog/collections';
import type { CollectionService, RequestContext } from '@mindlog/services';

/** What a migration file's default export receives (PLAN 16.8). */
export interface MigrationApi {
  /** Creates the collection, or replaces it when it exists, so a re-run is harmless. */
  save(input: CollectionInput): Promise<void>;
  delete(name: string): Promise<void>;
}

const SCHEMA: CollectionInput = { name: '_migrations', fields: [{ name: 'file', type: 'text' }] };
const idOf = (file: string): string => createHash('sha256').update(file).digest('hex').slice(0, 15);

class Failed extends Error {
  constructor(readonly error: MindlogError) {
    super(error.message);
  }
}

/** Applies the folder's unapplied migrations in name order and records each in `_migrations`. */
export async function runMigrations(
  dir: string,
  collections: CollectionService,
  tenant: string,
  logger: Logger,
): Promise<Result<void, MindlogError>> {
  if (dir === '') return ok(undefined);
  const ctx: RequestContext = {
    identity: { kind: 'superuser', email: 'system:migrations' },
    tenant,
  };
  const made = await collections.saveCollection(ctx, SCHEMA);
  if (!made.ok && made.error.code !== 'ALREADY_EXISTS' && made.error.code !== 'CONFLICT')
    return made;
  let names: string[];
  try {
    names = await readdir(resolve(dir));
  } catch (cause) {
    return err(mindlogError('CONFIG_INVALID', `cannot read migrations folder ${dir}`, { cause }));
  }
  const api: MigrationApi = {
    async save(input) {
      const current = await collections.getCollection(ctx, input.name);
      if (!current.ok && current.error.code !== 'NOT_FOUND') throw new Failed(current.error);
      const saved = await collections.saveCollection(
        ctx,
        input,
        current.ok ? current.value.version : undefined,
      );
      if (!saved.ok) throw new Failed(saved.error);
    },
    async delete(name) {
      const deleted = await collections.deleteCollection(ctx, name);
      if (!deleted.ok && deleted.error.code !== 'NOT_FOUND') throw new Failed(deleted.error);
    },
  };
  for (const name of names.filter((n) => /\.(ts|js|mjs)$/.test(n) && !n.endsWith('.d.ts')).sort()) {
    const applied = await collections.view(ctx, '_migrations', idOf(name));
    if (applied.ok) continue;
    if (applied.error.code !== 'NOT_FOUND') return applied;
    try {
      const mod = (await import(pathToFileURL(join(resolve(dir), name)).href)) as {
        default: (m: MigrationApi) => unknown;
      };
      await mod.default(api);
    } catch (cause) {
      if (cause instanceof Failed) return err(cause.error);
      return err(
        mindlogError(
          'CONFIG_INVALID',
          `migration ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
    const recorded = await collections.create(ctx, '_migrations', { id: idOf(name), file: name });
    if (!recorded.ok && recorded.error.code !== 'ALREADY_EXISTS') return recorded;
    logger.info('migration applied', { file: name, tenant });
  }
  return ok(undefined);
}
