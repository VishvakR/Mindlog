import { AsyncLocalStorage } from 'node:async_hooks';
import type { Clock } from '@mindlog/core';

/** The tenant a model call is made for; the model port itself has no tenant parameter. */
export const modelTenant = new AsyncLocalStorage<string>();

/** Wraps a model client so each call's duration is charged to the tenant making it. */
export function meterModels<T extends object>(
  inner: T,
  clock: Clock,
  spend: (tenant: string, ms: number) => void,
): T {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return async (...args: unknown[]) => {
        const tenant = modelTenant.getStore();
        const started = clock.monotonic();
        try {
          return await fn.apply(target, args);
        } finally {
          if (tenant !== undefined) spend(tenant, Number(clock.monotonic() - started) / 1e6);
        }
      };
    },
  });
}
