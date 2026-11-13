# Tenant data export and deletion

**Export** (any time; the tenant keeps working)
1. `POST /api/tenants/<t>/export` as a superuser or tenant admin starts an archive of the tenant's KV data, memories and collections. It is written to the blob store as `exports/<t>/<id>.ndjson.gz`.
2. `GET /api/tenants/<t>/export` reports its state.
3. Hand over the archive. With encryption on, blobs are sealed under a key derived from the master key (ADR-0014). Read the archive through a node's blob store, not from disk; there is no download endpoint yet.

**Deletion**
1. `DELETE /api/tenants/<t>`. The tenant's requests are refused at once.
2. After `tenancy.deleteGraceMs` (default one day), the purger proposes `TenantPurge` on every range that holds the tenant's keys. It then deletes its blobs, and, with encryption on, destroys the tenant's data key (crypto-shred).
3. There is no undelete: once the request is made, the tenant's requests stay refused and the purge follows. Export first if in doubt.

**Verify.**
- The audit log (dashboard Logs & audit) shows the delete and the purge.
- `redis-cli` with a key of that tenant finds nothing.

**Caution.** Old backups still contain the tenant until they age out (`backup.keep`). Restoring one brings the tenant back; record that in the deletion ticket.

**Record.** The request date, the purge date, and which backups still hold the data.
