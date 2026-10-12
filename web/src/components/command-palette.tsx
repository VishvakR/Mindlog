import { KeyRound, LogOut, Moon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { NAV } from './nav';

/** ⌘K / Ctrl+K: jump to a page, open a key by name, switch theme or log out. */
export function CommandPalette({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    setSearch('');
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Go to"
      description="Jump to a page or a key"
    >
      <CommandInput
        placeholder="Page, action or key name…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV.map((item) => (
            <CommandItem key={item.to} onSelect={() => run(() => void navigate(item.to))}>
              <item.icon />
              {item.label}
              <span className="text-muted-foreground">{item.description}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {search.trim() && (
          <CommandGroup heading="Keys">
            <CommandItem
              value={`open key ${search}`}
              onSelect={() =>
                run(() => void navigate(`/data?key=${encodeURIComponent(search.trim())}`))
              }
            >
              <KeyRound />
              Open key <span className="font-mono">{search.trim()}</span>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}
          >
            <Moon />
            Switch theme
          </CommandItem>
          <CommandItem onSelect={() => run(onLogout)}>
            <LogOut />
            Log out
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex justify-end border-t px-3 py-2 text-xs text-muted-foreground">
        <CommandShortcut>Esc to close</CommandShortcut>
      </div>
    </CommandDialog>
  );
}
