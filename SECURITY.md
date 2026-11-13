# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/VishvakR/Mindlog/security/advisories/new), not in public issues. Include a description, the affected version, and steps to reproduce. A fix and an advisory follow once the issue is confirmed.

## Supported versions

Only the latest release receives security fixes.

## Hardening

- Run with `profile: production`. It refuses to start without TLS or with secret files other users can read.
- Turn on encryption at rest (`storage.encryption.masterKey`, ADR-0014) for new data directories.
- Give agents API keys with the narrowest role (ADR-0036). Agents never hold admin roles.
- Content from the web and from unknown tools is stored quarantined. It is passed to models only as quoted data.
- The CI `supply-chain` job runs `pnpm audit` and `pip-audit`, and builds SBOMs (`scripts/sbom.sh`).
