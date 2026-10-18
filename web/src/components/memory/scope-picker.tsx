import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { ScopeValue } from '@/lib/memory';
import { formatScope, parseScope } from '@/lib/memory';

/** Tenant and `user[/agent[/session]]`, with the tenant's known user scopes as suggestions. */
export function ScopePicker({
  value,
  onChange,
}: {
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
}) {
  const scopes = useQuery({
    queryKey: ['memory-scopes', value.tenant],
    queryFn: () => api.memoryScopes(value.tenant),
    enabled: value.tenant !== '',
    retry: false,
  });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex w-40 flex-col gap-1.5">
        <Label htmlFor="memory-tenant">Tenant</Label>
        <Input
          id="memory-tenant"
          value={value.tenant}
          onChange={(e) => onChange({ ...value, tenant: e.target.value.trim() })}
        />
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
        <Label htmlFor="memory-scope">Scope</Label>
        <Input
          id="memory-scope"
          list="memory-scope-users"
          placeholder="user/agent/session (empty: tenant-wide)"
          value={value.text}
          onChange={(e) =>
            onChange({ ...value, text: e.target.value, scope: parseScope(e.target.value) })
          }
        />
        <datalist id="memory-scope-users">
          {(scopes.data?.users ?? []).map((u) => (
            <option key={u} value={u}>
              {formatScope({ user: u })}
            </option>
          ))}
        </datalist>
      </div>
      {scopes.data && (
        <p className="pb-2 text-xs text-muted-foreground">
          {scopes.data.users.length} scope{scopes.data.users.length === 1 ? '' : 's'} with memory
        </p>
      )}
    </div>
  );
}
