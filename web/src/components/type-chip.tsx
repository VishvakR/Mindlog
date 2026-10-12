import type { KeyType } from '@/lib/api';
import { KEY_TYPES } from '@/lib/key-types';
import { cn } from '@/lib/utils';

/** The type's glyph on its hue; with `label`, its name too. */
export function TypeChip({
  type,
  label = false,
  className,
}: {
  type: KeyType;
  label?: boolean;
  className?: string;
}) {
  const meta = KEY_TYPES[type];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium',
        meta.bg,
        meta.text,
        className,
      )}
      title={meta.label}
    >
      <Icon className="size-3.5" aria-hidden />
      {label ? meta.label : <span className="sr-only">{meta.label}</span>}
    </span>
  );
}
