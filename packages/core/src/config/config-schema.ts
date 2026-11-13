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
      // Raft member id: non-zero and never reused (ADR-0006).
      raftId: z.number().int().min(1).default(1),
      dataDir: z.string().min(1).default('./data'),
      zone: z.string().min(1).default('local-a'),
    })
    .prefault({}),
  cluster: z
    .strictObject({
      // Initial members of a new cluster (phase 3 static bootstrap, before PD).
      peers: z
        .array(z.strictObject({ id: z.number().int().min(1), address: z.string().min(1) }))
        .default([]),
      // Start with no membership and wait to be added as a learner.
      join: z.boolean().default(false),
      maxClockOffsetMs: z.number().int().min(1).default(500),
      // Placement driver endpoints (`host:port`, the `pd.listen` addresses). Empty: this node
      // runs its own PD (single-node) or has none and keeps its static layout.
      pdEndpoints: z.array(z.string().min(1)).default([]),
      // The `host:port` other nodes reach this node's `listen.internal` at, for a node that is not
      // in `peers` (one that joins later). Members use their entry in `peers`.
      advertise: z.string().min(1).optional(),
    })
    .prefault({}),
  // Placement driver role (ADR-0010): this process serves a PD replica from its own data directory.
  pd: z
    .strictObject({
      enabled: z.boolean().default(false),
      listen: listener(7100),
      // Defaults to `<node.dataDir>/pd`.
      dataDir: z.string().min(1).optional(),
      // The PD group's members (id and `host:port` of their `pd.listen`); empty means one voter.
      peers: z
        .array(z.strictObject({ id: z.number().int().min(1), address: z.string().min(1) }))
        .default([]),
      storeHeartbeatMs: z.number().int().min(10).default(10_000),
      rangeHeartbeatMs: z.number().int().min(10).default(2_000),
      deadAfterMs: z.number().int().min(100).default(300_000),
      schedulerIntervalMs: z.number().int().min(10).default(1_000),
      tsoWindowMs: z.number().int().min(100).default(3_000),
    })
    .prefault({}),
  // Range sizing and splitting (ADR-0009).
  ranges: z
    .strictObject({
      maxBytes: z
        .number()
        .int()
        .min(1)
        .default(64 * 1024 * 1024),
      mergeBelowBytes: z
        .number()
        .int()
        .min(0)
        .default(16 * 1024 * 1024),
      splitQps: z.number().min(1).default(2500),
      splitQpsWindowMs: z.number().int().min(1).default(60_000),
      replicas: z.number().int().min(1).default(3),
    })
    .prefault({}),
  models: z
    .strictObject({
      // `host:port` of the model service (PLAN 14); unset runs memory in degraded mode (PLAN 21).
      endpoint: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1).default(2000),
      breakerFailures: z.number().int().min(1).default(5),
      breakerOpenMs: z.number().int().min(1).default(10_000),
    })
    .prefault({}),
  memory: z
    .strictObject({
      // Conflict detection before commit (ADR-0015).
      conflicts: z
        .strictObject({
          // Contradiction probability that raises a conflict (θ_c); above 0.5 it is the NLI top label.
          threshold: z.number().min(0.5).max(1).default(0.95),
          // Cosine a fact needs to a new one to be compared (unrelated facts about one person are not).
          minSimilarity: z.number().min(0).max(1).default(0.5),
          policy: z
            .enum(['quarantine_new', 'newest_wins', 'ask_human', 'prefer_verified'])
            .default('quarantine_new'),
        })
        .prefault({}),
      // Trust by source (PLAN 13.4): content from other tools and domains is quarantined.
      trust: z
        .strictObject({
          tools: z.array(z.string().min(1)).default([]),
          domains: z.array(z.string().min(1)).default([]),
        })
        .prefault({}),
      // Consolidation workers and their per-scope tick (PLAN 12.6, ADR-0033).
      consolidation: z
        .strictObject({
          enabled: z.boolean().default(true),
          // Between ticks of a scope with work left; the first tick waits `idleMs` after a write.
          tickMs: z
            .number()
            .int()
            .min(1000)
            .default(15 * 60_000),
          idleMs: z
            .number()
            .int()
            .min(0)
            .default(10 * 60_000),
          // Sleep-time: after this many new memories once idle, or every `sleepEveryMs`.
          sleepAfter: z.number().int().min(1).default(20),
          sleepEveryMs: z
            .number()
            .int()
            .min(1)
            .default(24 * 3_600_000),
          // A sleep branch raising more conflicts than this is dropped, not merged.
          maxConflicts: z.number().int().min(0).default(3),
          // Model time each tenant's workers may use per hour (node-local budget).
          modelSecondsPerHour: z.number().min(0).default(600),
        })
        .prefault({}),
      // Forgetting curve (PLAN 13.7): retention below `coldBelow` moves to the cold tier.
      // Semantic split (PLAN 8.5, ADR-0039): a scope or cluster this big splits in two; 0 never splits.
      split: z
        .strictObject({
          maxMemories: z.number().int().min(0).default(100_000),
          driftRatio: z.number().min(1).default(1.5),
          // Clusters a recall searches when the query has an embedding (PLAN 8.5: top-2).
          recallClusters: z.number().int().min(1).max(8).default(2),
        })
        .prefault({}),
      forgetting: z
        .strictObject({
          coldBelow: z.number().min(0).max(1).default(0.2),
          // Tenants that allow deleting (forgetting) memories with retention below `deleteBelow`.
          hardForgetTenants: z.array(z.string().min(1)).default([]),
          deleteBelow: z.number().min(0).max(1).default(0.02),
        })
        .prefault({}),
    })
    .prefault({}),
  // Cold memory tier (PLAN 10.4) on the default blob store.
  storage: z
    .strictObject({
      coldTier: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
      // Encryption at rest (ADR-0014): base64 of 32 bytes, best from a file
      // (`MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE`). Only for new data directories.
      encryption: z.strictObject({ masterKey: z.string().min(1).optional() }).prefault({}),
    })
    .prefault({}),
  blob: z
    .strictObject({
      default: z
        .discriminatedUnion('type', [
          // Relative paths are under node.dataDir.
          z.strictObject({ type: z.literal('local'), path: z.string().min(1).default('blobs') }),
          z.strictObject({
            type: z.literal('s3'),
            endpoint: z.url(),
            bucket: z.string().min(1),
            region: z.string().min(1).default('us-east-1'),
            accessKeyId: z.string().min(1),
            secretAccessKey: z.string().min(1),
          }),
        ])
        .default({ type: 'local', path: 'blobs' }),
    })
    .prefault({}),
  features: z
    .strictObject({
      // Cross-range transactions (ADR-0030): off until the simulator has exercised them.
      crossRangeTxn: z.boolean().default(false),
      semanticSplit: z.boolean().default(false),
    })
    .prefault({}),
  raft: z
    .strictObject({
      tickMs: z.number().int().min(1).default(100),
      electionTicks: z.tuple([z.number().int().min(1), z.number().int().min(2)]).default([10, 20]),
      heartbeatTicks: z.number().int().min(1).default(1),
      leaseTicks: z.number().int().min(0).default(9),
      maxInflightMsgs: z.number().int().min(1).default(256),
      maxInflightBytes: z
        .number()
        .int()
        .min(0)
        .default(16 * 1024 * 1024),
      maxEntryBatchBytes: z
        .number()
        .int()
        .min(1)
        .default(1024 * 1024),
      snapshotEntries: z.number().int().min(1).default(10_000),
      trailingEntries: z.number().int().min(0).default(1_000),
      snapshotChunkBytes: z
        .number()
        .int()
        .min(1)
        .default(1024 * 1024),
    })
    .refine(
      (r) => r.electionTicks[1] > r.electionTicks[0],
      'raft.electionTicks must be [min, max) with max > min',
    )
    .refine(
      (r) => r.leaseTicks < r.electionTicks[0],
      'raft.leaseTicks must be below electionTicks[0] (ADR-0007)',
    )
    .refine(
      (r) => r.heartbeatTicks < r.electionTicks[0],
      'raft.heartbeatTicks must be below electionTicks[0]',
    )
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
          // Localhost by default (DNS-rebinding protection); other binds must list their host names.
          http: z
            .strictObject({
              host: host.default('127.0.0.1'),
              port: port.default(8765),
              allowedHosts: z.array(z.string().min(1)).default([]),
            })
            .prefault({}),
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
      // Sign-in and auth requests per client address: a burst, then a steady rate (PLAN 16.4).
      authBurst: z.number().int().min(1).default(20),
      authPerMinute: z.number().int().min(1).default(30),
    })
    .prefault({}),
  auth: z
    .strictObject({
      // Single static user for phase 1 (`AUTH <password>` / `AUTH default <password>`).
      password: z.string().min(1).optional(),
      // Opt-in OAuth2 providers for auth collections (ADR-0035): google, github, or any OIDC issuer.
      oauth2: z
        .array(
          z.strictObject({
            name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
            clientId: z.string().min(1),
            clientSecret: z.string().min(1),
            // OIDC issuer for generic providers; google and github have presets.
            issuer: z.url().optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  // Full-stack collections (PLAN 16, ADR-0034).
  collections: z
    .strictObject({
      enabled: z.boolean().default(true),
      // Tenants with collections on; empty means every user tenant.
      tenants: z.array(z.string().min(1)).default([]),
      // Tenant of requests that name none (no token claim, no X-Mindlog-Tenant header).
      defaultTenant: z.string().min(1).default('default'),
      // Public URL of the app, for links in verification and reset mail.
      appUrl: z.string().default(''),
      migrationsDir: z.string().default(''),
      hooksDir: z.string().default(''),
    })
    .prefault({}),
  // Opt-in mail for OTP, verification and password reset (ADR-0035); off by default.
  mail: z
    .strictObject({
      mode: z.enum(['off', 'console', 'smtp']).default('off'),
      from: z.string().default('noreply@mindlog.local'),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(587),
      tls: z.boolean().default(false),
      requireTls: z.boolean().default(true),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .prefault({}),
  tls: z
    .strictObject({
      // TLS on RESP, HTTP and MCP; mutual TLS between nodes, PD and the model sidecar.
      enabled: z.boolean().default(false),
      ca: z.string().min(1).optional(),
      cert: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      // How often certificate files are checked for rotation.
      reloadMs: z.number().int().min(10).default(5_000),
    })
    .prefault({}),
  tenancy: z
    .strictObject({
      // A deleted tenant's data is purged this long after deletion is asked for (PLAN 18.3).
      deleteGraceMs: z.number().int().min(0).default(86_400_000),
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
