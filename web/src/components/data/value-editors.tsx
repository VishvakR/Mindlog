import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** Editable rows of string cells; `columns` names each cell for assistive tech. */
export function RowsEditor({
  columns,
  rows,
  numbered = false,
  onChange,
  disabled,
}: {
  columns: { label: string; mono?: boolean; numeric?: boolean; width?: string }[];
  rows: string[][];
  numbered?: boolean;
  onChange: (rows: string[][]) => void;
  disabled: boolean;
}) {
  const update = (r: number, c: number, value: string) =>
    onChange(
      rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)),
    );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2 px-1 text-xs text-muted-foreground" aria-hidden>
        {numbered && <span className="w-8 text-right">#</span>}
        {columns.map((c) => (
          <span key={c.label} className={c.width ?? 'flex-1'}>
            {c.label}
          </span>
        ))}
        <span className="w-8" />
      </div>
      {rows.map((row, r) => (
        <div key={r} className="flex items-center gap-2">
          {numbered && (
            <span className="w-8 text-right font-mono text-xs text-muted-foreground tabular-nums">
              {r}
            </span>
          )}
          {columns.map((c, j) => (
            <Input
              key={c.label}
              aria-label={`${c.label} ${String(r + 1)}`}
              className={`${c.width ?? 'flex-1'} ${c.mono === false ? '' : 'font-mono'}`}
              inputMode={c.numeric ? 'decimal' : undefined}
              value={row[j] ?? ''}
              disabled={disabled}
              onChange={(e) => update(r, j, e.target.value)}
            />
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove row ${String(r + 1)}`}
            disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, i) => i !== r))}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, columns.map(() => '')])}
        >
          <Plus data-icon="inline-start" />
          Add row
        </Button>
      </div>
    </div>
  );
}

export function TextEditor({
  value,
  onChange,
  disabled,
  invalid,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  invalid?: boolean;
  label: string;
}) {
  return (
    <Textarea
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="min-h-64 font-mono text-[13px]"
      spellCheck={false}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
