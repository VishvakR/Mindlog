import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { Schema } from '@/lib/collections';
import { applyCompletion, collectionsApi, issueSpans } from '@/lib/collections';

interface RuleEditorProps {
  label: string;
  tenant: string;
  draft: Schema;
  value: string | null;
  onChange: (value: string | null) => void;
}

/** One rule slot: locked, open to anyone, or an expression with live checks and completion. */
export function RuleEditor({ label, tenant, draft, value, onChange }: RuleEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState<number | undefined>();
  const [debounced, setDebounced] = useState({ value, cursor });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced({ value, cursor });
    }, 150);
    return () => {
      clearTimeout(t);
    };
  }, [value, cursor]);
  const check = useQuery({
    queryKey: ['rule-check', tenant, draft.name, debounced.value, debounced.cursor, draft.fields],
    queryFn: () =>
      collectionsApi.checkRule(tenant, {
        collection: draft.name,
        rule: debounced.value ?? '',
        ...(debounced.cursor === undefined ? {} : { cursor: debounced.cursor }),
        draft,
      }),
    enabled: debounced.value !== null && debounced.value !== '',
    retry: false,
  });
  if (value === null) {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          Superusers only
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onChange('');
            }}
          >
            Unlock
          </Button>
        </span>
      </div>
    );
  }
  const text = value;
  const issue = text === '' ? undefined : check.data?.issues[0];
  const [before, bad, after] = issueSpans(text, issue);
  const items = !dismissed && cursor !== undefined ? (check.data?.completions?.items ?? []) : [];
  const accept = (itemLabel: string) => {
    const completions = check.data?.completions;
    if (!completions) return;
    const next = applyCompletion(text, completions, itemLabel);
    onChange(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() => area.current?.setSelectionRange(next.cursor, next.cursor));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {text === '' ? 'Anyone' : 'When the rule matches'}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(null);
            }}
          >
            Lock
          </Button>
        </span>
      </div>
      <div className="relative">
        <pre
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap text-transparent"
        >
          {before}
          <span className="underline decoration-destructive decoration-wavy">{bad}</span>
          {after}
        </pre>
        <Textarea
          ref={area}
          aria-label={label}
          aria-invalid={issue !== undefined}
          rows={2}
          spellCheck={false}
          value={text}
          placeholder="Leave empty to allow anyone. Type to see fields."
          className="bg-transparent font-mono"
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart);
            setActive(0);
            setDismissed(false);
          }}
          onBlur={() => {
            setCursor(undefined);
          }}
          onKeyDown={(e) => {
            if (items.length === 0) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
              setActive((active + step) % items.length);
            } else if (e.key === 'Tab' || e.key === 'Enter') {
              e.preventDefault();
              accept(items[active]?.label ?? '');
            } else if (e.key === 'Escape') setDismissed(true);
          }}
        />
        {items.length > 0 && (
          <ul
            role="listbox"
            aria-label={`${label} completions`}
            className="absolute z-20 mt-1 max-h-48 w-72 overflow-auto rounded-md border bg-popover p-1 shadow-md"
          >
            {items.map((item, i) => (
              <li key={`${item.label}-${item.detail}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={`flex w-full justify-between rounded-sm px-2 py-1 text-left font-mono text-xs ${i === active ? 'bg-accent' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(item.label);
                  }}
                >
                  {item.label}
                  <span className="text-muted-foreground">{item.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {issue && <p className="text-xs text-destructive">{issue.message}</p>}
    </div>
  );
}
