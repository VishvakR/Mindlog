import type { LucideIcon } from 'lucide-react';
import { Braces, Hash, List, ListOrdered, Shapes, Type } from 'lucide-react';
import type { KeyType } from './api';

/** One hue and glyph per Redis type: the dashboard's visual vocabulary for data. */
export const KEY_TYPES: Record<
  KeyType,
  { label: string; icon: LucideIcon; text: string; bg: string }
> = {
  string: { label: 'String', icon: Type, text: 'text-type-string', bg: 'bg-type-string/12' },
  hash: { label: 'Hash', icon: Hash, text: 'text-type-hash', bg: 'bg-type-hash/12' },
  list: { label: 'List', icon: List, text: 'text-type-list', bg: 'bg-type-list/12' },
  set: { label: 'Set', icon: Shapes, text: 'text-type-set', bg: 'bg-type-set/12' },
  zset: { label: 'Sorted set', icon: ListOrdered, text: 'text-type-zset', bg: 'bg-type-zset/12' },
  json: { label: 'JSON', icon: Braces, text: 'text-type-json', bg: 'bg-type-json/12' },
};

export const KEY_TYPE_ORDER: KeyType[] = ['string', 'hash', 'list', 'set', 'zset', 'json'];

/** "3d 4h", "12m 5s", "900 ms": remaining TTL at a glance. */
export function formatTtl(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  const s = Math.floor(ms / 1000);
  const units: [number, string][] = [
    [86_400, 'd'],
    [3600, 'h'],
    [60, 'm'],
    [1, 's'],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [size, unit] of units) {
    if (rest >= size && parts.length < 2) {
      parts.push(`${String(Math.floor(rest / size))}${unit}`);
      rest %= size;
    }
  }
  return parts.join(' ');
}

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i] ?? 'B'}`;
}
