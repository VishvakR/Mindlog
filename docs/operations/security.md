---
description: TLS and mutual TLS, encryption at rest, secrets, the production profile, and how untrusted content is handled.
---

# Security

## Checklist

| Area | Default | Production |
|---|---|---|
| Transport | Plain TCP | `tls.enabled: true`: TLS on RESP, HTTP and MCP; mutual TLS between nodes, the PD and the model sidecar |
| Profile | `dev` | `profile: production` refuses to start without TLS or with readable secret files |
| Secrets | Inline | Files: `${file:/path}` in YAML, or `MINDLOG_…_FILE` variables, `chmod 600` |
| Data at rest | Plain | `storage.encryption.masterKey` on new data directories |
| MCP | Localhost only | Keep it local, or bind with `allowedHosts` and TLS |
| Access | `default` tenant, anonymous RESP | Tenants, API keys with the least role needed, policies, quotas ([guide](../guides/tenants-and-access.md)) |

## TLS and mutual TLS

```yaml
profile: production
tls:
  enabled: true
  ca: /etc/mindlog/tls/ca.crt
  cert: /etc/mindlog/tls/node.crt
  key: /etc/mindlog/tls/node.key
  reloadMs: 5000
listen:
  resp: { tls: true }
```

* Client-facing listeners (RESP, HTTP and the dashboard, MCP) use TLS. Internal links (Raft on `:7000`, PD on `:7100`, the model sidecar on `:50051`) use **mutual** TLS, so a node only talks to peers holding certificates from your CA.
* Certificates are re-read every `reloadMs`, so rotation needs no restart. A broken pair is logged and ignored, and the old one stays in use. See the [certificate rotation runbook](../runbooks/rotate-certificates.md).
* The model service takes `MODEL_SERVICE_TLS_CA`, `_CERT` and `_KEY`.

## Encryption at rest

```bash
head -c 32 /dev/urandom | base64 > /run/secrets/mindlog-master-key && chmod 600 /run/secrets/mindlog-master-key
MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE=/run/secrets/mindlog-master-key mindlog-server …
```

* Values are sealed with **AES-256-GCM** under a per-tenant data key; Raft entries and range-local rows use a node key. Each value's key is its associated data, so a ciphertext cannot be moved to another key.
* Data keys are per node, wrapped by the master key, and never replicated. Snapshots travel decrypted over mutual TLS and are re-encrypted on arrival.
* Blobs (files, cold tier, backups, exports) use a per-tenant key derived from the master key.
* Keys stay in plaintext so they keep their order. Index terms in keys (for example BM25 terms) are therefore visible to someone with disk access.
* Encryption applies to **new** data directories only.
* Deleting a tenant destroys its data key once its data is purged (**crypto-shredding**).
* Rotate the master key with `mindlog-server keys rotate-master --new-key-file <path>` ([runbook](../runbooks/rotate-master-key.md)).

## Authentication and authorization

* Every request is authorized in the application layer, including the dashboard and MCP, with one decision function. See [Tenants and access control](../guides/tenants-and-access.md).
* API keys (`mlk_…`) are stored hashed and can be pinned to a user, limited to scope patterns, and given an expiry.
* Superuser and member passwords use scrypt; app-user passwords use argon2id. Sign-in endpoints are rate-limited per address.
* Agents never hold admin roles. Delegated tokens record both the user (principal) and the agent (actor).
* Every refusal is audited with its reason.

## Untrusted content and prompt injection

* Content from `web` sources, unlisted tools and untrusted domains is stored **quarantined** and is left out of recall unless explicitly requested ([Trust](../guides/memory/trust.md)).
* Untrusted text is passed to models only as quoted data, never as instructions. MCP tool descriptions tell hosts that recalled memories are data.
* A bad source can be removed with everything derived from it: `MEM.FORGET <scope> SOURCE <ref>`.

## Secrets hygiene

* Secrets never appear in logs, errors or traces; the logger redacts known secret paths.
* `GET /api/admin/settings` replaces secrets in the effective configuration.
* Offline by default: no telemetry, no model downloads at runtime, and no outbound calls unless you configure an endpoint (tracing, S3, SMTP, OAuth2).

## Supply chain

CI runs `pnpm audit` and `pip-audit`, and `scripts/sbom.sh` produces a software bill of materials, which is attached to each release. Report vulnerabilities as described in the [security policy](https://github.com/VishvakR/Mindlog/blob/main/SECURITY.md).
