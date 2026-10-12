import { SYSTEM_TENANT, isUserTenant } from '@mindlog/core';

/**
 * Tenants whose keyspace KV commands may write: user tenants, and the system
 * tenant for internal services such as superusers (ADR-0024). Only server code
 * opens `$system` sessions; `$node` holds raw, unversioned keys and is refused.
 */
export const isKvTenant = (tenant: string): boolean =>
  isUserTenant(tenant) || tenant === SYSTEM_TENANT;
