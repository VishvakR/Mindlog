import { z } from 'zod';

// 0 binds any free port (tests, side-by-side dev nodes).
const port = z.number().int().min(0).max(65_535);
const host = z.string().min(1);

const listener = (defaultPort: number) =>
  z.strictObject({ host: host.default('0.0.0.0'), port: port.default(defaultPort) }).prefault({});

/**
 * Node configuration schema (PLAN 19.6, Appendix B). Only sections that phase 0
 * code reads are defined; later phases add theirs. Objects are strict so a
 * typo in a file, env var or flag is an error rather than silently ignored.
 */
export const configSchema = z.strictObject({
  node: z
    .strictObject({
      id: z.string().min(1).default('node-1'),
      dataDir: z.string().min(1).default('./data'),
      zone: z.string().min(1).default('local-a'),
    })
    .prefault({}),
  listen: z
    .strictObject({
      resp: z
        .strictObject({
          host: host.default('0.0.0.0'),
          port: port.default(6379),
          tls: z.boolean().default(false),
        })
        .prefault({}),
      http: listener(8090),
      grpc: listener(9090),
      internal: listener(7000),
      mcp: z
        .strictObject({
          http: z.strictObject({ port: port.default(8765) }).prefault({}),
          stdio: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  observability: z
    .strictObject({
      logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      tracing: z
        .strictObject({
          // Unset by default: Mindlog makes no network calls unless asked (ADR-020).
          endpoint: z.url().optional(),
          sampleRatio: z.number().min(0).max(1).default(0.05),
        })
        .prefault({}),
    })
    .prefault({}),
  limits: z
    .strictObject({
      maxClients: z.number().int().min(1).default(10_000),
      // RESP bulk strings and inline requests (Valkey proto-max-bulk-len, 64 KiB inline).
      maxBulkBytes: z
        .number()
        .int()
        .min(1)
        .default(512 * 1024 * 1024),
      maxInlineBytes: z
        .number()
        .int()
        .min(1)
        .default(64 * 1024),
      maxArgs: z
        .number()
        .int()
        .min(1)
        .default(1024 * 1024),
      // A client whose unsent replies exceed this is disconnected.
      outputBufferBytes: z
        .number()
        .int()
        .min(1)
        .default(64 * 1024 * 1024),
      // Close idle connections after this long; 0 disables (Redis `timeout 0`).
      idleTimeoutMs: z.number().int().min(0).default(0),
      // Parsed commands waiting on one connection before it stops reading.
      maxPipelineCommands: z.number().int().min(1).default(1024),
      // Commands queued inside one MULTI.
      maxTransactionCommands: z.number().int().min(1).default(10_000),
      maxPendingProposals: z.number().int().min(1).default(10_000),
    })
    .prefault({}),
  auth: z
    .strictObject({
      // Single static user for phase 1 (`AUTH <password>` / `AUTH default <password>`).
      password: z.string().min(1).optional(),
    })
    .prefault({}),
  profile: z.enum(['dev', 'production']).default('dev'),
});

export type MindlogConfig = z.output<typeof configSchema>;
export type LogLevel = MindlogConfig['observability']['logLevel'];

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Highest-precedence overrides, e.g. parsed CLI flags. */
export type ConfigOverrides = DeepPartial<z.input<typeof configSchema>>;

export const CONFIG_SECTIONS: ReadonlySet<string> = new Set(Object.keys(configSchema.shape));
