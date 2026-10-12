import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

/** Nested settings as `path → value` rows, leaves only. */
function flatten(value: unknown, path = ''): [string, string][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => flatten(v, path ? `${path}.${k}` : k));
  }
  return [[path, value === null || value === undefined ? 'not set' : JSON.stringify(value)]];
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const sections = Object.entries(settings.data ?? {});
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <p className="max-w-prose text-sm text-muted-foreground">
        The configuration this node is running with, after{' '}
        <span className="font-mono">mindlog.yaml</span>, environment variables and flags. Secrets
        are hidden. Change values in the config file and restart the node.
      </p>
      {settings.isPending && <Skeleton className="h-64 max-w-3xl" />}
      {settings.isError && (
        <p className="text-sm text-destructive">
          Could not load settings: {settings.error.message}
        </p>
      )}
      <div className="grid max-w-5xl items-start gap-4 lg:grid-cols-2">
        {sections.map(([section, value]) => (
          <Card key={section} size="sm">
            <CardHeader>
              <CardTitle className="capitalize">{section}</CardTitle>
              <CardDescription className="font-mono">{section}.*</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                {flatten(value).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="truncate text-muted-foreground" title={k}>
                      {k || section}
                    </dt>
                    <dd className="truncate font-mono" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
