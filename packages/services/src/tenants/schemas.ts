import { ACTIONS, ROLES } from '@mindlog/auth';
import { isUserTenant } from '@mindlog/core';
import { REDACTION_KINDS } from '@mindlog/memory';
import { z } from 'zod';

const limit = z.number().int().positive().optional();

/** Per-tenant limits (PLAN 18.3); an absent one is unlimited. */
export const quotasSchema = z.strictObject({
  storageBytes: limit,
  keys: limit,
  memories: limit,
  writeQps: limit,
  recallQps: limit,
  modelSecondsPerHour: limit,
  connections: limit,
});
export type Quotas = z.infer<typeof quotasSchema>;

export const redactionSchema = z.strictObject({
  enabled: z.boolean(),
  kinds: z.array(z.enum(REDACTION_KINDS)).default([...REDACTION_KINDS]),
});
export type Redaction = z.infer<typeof redactionSchema>;

/** Roles a key or account of one tenant may hold: never `superuser`. */
export const tenantRoleSchema = z.enum(ROLES).exclude(['superuser', 'app_user']);
export type TenantRole = z.infer<typeof tenantRoleSchema>;

export const policyRowSchema = z.strictObject({
  effect: z.enum(['allow', 'deny']),
  subject: z.string().min(1).max(256),
  actions: z.array(z.enum(ACTIONS)).min(1).max(ACTIONS.length),
  scopes: z.array(z.string().min(1).max(128)).max(64).optional(),
});

export const policiesSchema = z.strictObject({
  policies: z.array(policyRowSchema).max(256),
});

export const tenantNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, _ . - only')
  .refine(isUserTenant, 'reserved tenant');

export const createTenantSchema = z.strictObject({
  name: tenantNameSchema,
  quotas: quotasSchema.optional(),
  redaction: redactionSchema.optional(),
  auditRetentionDays: z.number().int().positive().max(3650).optional(),
});
export type CreateTenant = z.input<typeof createTenantSchema>;

/** What a tenant's admin may change; quotas are the operator's. */
export const tenantSettingsSchema = z.strictObject({
  redaction: redactionSchema.optional(),
  auditRetentionDays: z.number().int().positive().max(3650).optional(),
});
export type TenantSettings = z.input<typeof tenantSettingsSchema>;

export const tenantSchema = z.object({
  name: z.string(),
  /** `deleting` refuses every request; `deleted` keeps the name so it is never reused. */
  status: z.enum(['active', 'deleting', 'deleted']),
  created: z.string(),
  /** When deletion was asked for; the purge starts after the grace period. */
  deletingAt: z.string().optional(),
  quotas: quotasSchema,
  redaction: redactionSchema,
  auditRetentionDays: z.number(),
});
export type TenantInfo = z.infer<typeof tenantSchema>;
