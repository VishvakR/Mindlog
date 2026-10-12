import { useQuery } from '@tanstack/react-query';
import { LogOut, Search } from 'lucide-react';
import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { api, session, setUnauthorizedHandler } from '@/lib/api';
import { CommandPalette } from './command-palette';
import { NAV } from './nav';
import { ThemeToggle } from './theme-toggle';

function NodeStatus() {
  const ready = useQuery({
    queryKey: ['ready'],
    queryFn: async () => (await fetch('/ready')).ok,
    refetchInterval: 5000,
  });
  const up = ready.data === true;
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <span
        className={up ? 'size-2 rounded-full bg-primary' : 'size-2 rounded-full bg-destructive'}
        aria-hidden
      />
      {ready.isPending ? 'Checking node…' : up ? 'Node ready' : 'Node not ready'}
    </span>
  );
}

/** Sidebar layout for every signed-in page. */
export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const page = NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)));

  const logout = () => {
    session.clear();
    void navigate('/login', { replace: true });
  };
  useEffect(() => {
    setUnauthorizedHandler(() => void navigate('/login', { replace: true }));
  }, [navigate]);

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<NavLink to="/" />}>
                <img
                  src={`${import.meta.env.BASE_URL}favicon.svg`}
                  alt=""
                  className="size-8 rounded-md"
                />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Mindlog</span>
                  <span className="text-xs text-muted-foreground">Single node</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      isActive={item === page}
                      render={<NavLink to={item.to} end={item.to === '/'} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Log out" onClick={logout}>
                <LogOut />
                <span className="truncate">{me.data?.email ?? 'Log out'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <h1 className="font-semibold">{page?.label ?? 'Mindlog'}</h1>
          <div className="ml-auto flex items-center gap-2">
            <NodeStatus />
            <Button
              variant="outline"
              size="sm"
              className="hidden text-muted-foreground sm:inline-flex"
              onClick={() =>
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
              }
            >
              <Search data-icon="inline-start" />
              Go to…
              <kbd className="ml-2 rounded border px-1 font-mono text-[0.7rem]">⌘K</kbd>
            </Button>
            <ThemeToggle />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette onLogout={logout} />
    </SidebarProvider>
  );
}
