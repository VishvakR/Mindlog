import { useMutation, useQuery } from '@tanstack/react-query';
import { TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, session } from '@/lib/api';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const exists = useQuery({ queryKey: ['superuser-exists'], queryFn: api.superuserExists });
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: ({ token, superuser }) => {
      session.save(token);
      session.saveTenant(superuser.tenant);
      void navigate('/', { replace: true });
    },
  });
  if (session.token()) return <Navigate to="/" replace />;

  return (
    <main className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            className="size-9 rounded-lg"
          />
          <div>
            <p className="font-semibold">Mindlog</p>
            <p className="text-sm text-muted-foreground">Admin dashboard</p>
          </div>
        </div>
        {exists.data?.exists === false && (
          <Alert>
            <TerminalSquare />
            <AlertTitle>Create the first superuser</AlertTitle>
            <AlertDescription>
              <p>Stop the server, then run:</p>
              <code className="mt-1 block rounded bg-muted px-2 py-1.5 font-mono text-xs break-all text-foreground">
                mindlog-server superuser upsert you@example.com 'a long password'
              </code>
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <CardHeader>
              <CardTitle>Log in</CardTitle>
              <CardDescription>Use a superuser account for this node.</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field data-invalid={login.isError || undefined}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    aria-invalid={login.isError || undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {login.isError && <FieldError>{login.error.message}</FieldError>}
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="pt-4">
              <Button type="submit" className="w-full" disabled={login.isPending}>
                {login.isPending && <Spinner data-icon="inline-start" />}
                Log in
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </main>
  );
}
