import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { FieldDraft, FieldType, IndexDraft, Schema } from '@/lib/collections';
import { FIELD_TYPES } from '@/lib/collections';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '');
const count = (v: unknown) => (typeof v === 'number' ? String(v) : '1');

function TypeOptions({
  field,
  collections,
  set,
}: {
  field: FieldDraft;
  collections: string[];
  set: (patch: Record<string, unknown>) => void;
}) {
  const maxSelect = (
    <Input
      aria-label={`${field.name} maximum values`}
      type="number"
      min={1}
      className="w-20"
      value={count(field['maxSelect'])}
      onChange={(e) => {
        set({ maxSelect: Number(e.target.value) || 1 });
      }}
    />
  );
  if (field.type === 'select')
    return (
      <>
        <Input
          aria-label={`${field.name} values`}
          placeholder="a, b, c"
          value={text(field['values'])}
          onChange={(e) => {
            set({ values: list(e.target.value) });
          }}
        />
        {maxSelect}
      </>
    );
  if (field.type === 'relation')
    return (
      <>
        <Select
          value={text(field['collection'])}
          onValueChange={(v) => {
            set({ collection: v });
          }}
        >
          <SelectTrigger aria-label={`${field.name} target`} className="w-40">
            <SelectValue placeholder="Collection" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {collections.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {maxSelect}
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={field['cascadeDelete'] === true}
            onChange={(e) => {
              set({ cascadeDelete: e.target.checked });
            }}
          />
          Cascade
        </label>
      </>
    );
  if (field.type === 'file')
    return (
      <>
        {maxSelect}
        <Input
          aria-label={`${field.name} thumbnails`}
          className="w-40"
          placeholder="100x100, 400x0f"
          value={text(field['thumbs'])}
          onChange={(e) => {
            set({ thumbs: list(e.target.value) });
          }}
        />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={field['protected'] === true}
            onChange={(e) => {
              set({ protected: e.target.checked });
            }}
          />
          Protected
        </label>
      </>
    );
  if (field.type === 'vector')
    return (
      <Input
        aria-label={`${field.name} source field`}
        placeholder="Source field"
        value={text(field['source'])}
        onChange={(e) => {
          set({ source: e.target.value });
        }}
      />
    );
  return null;
}

/** Fields and indexes of a draft schema; a view also edits its JSON pipeline (PLAN 16.7). */
export function SchemaEditor({
  draft,
  collections,
  onChange,
}: {
  draft: Schema;
  collections: string[];
  onChange: (next: Schema) => void;
}) {
  const setField = (i: number, patch: Record<string, unknown>) => {
    onChange({ ...draft, fields: draft.fields.map((f, n) => (n === i ? { ...f, ...patch } : f)) });
  };
  const setIndex = (i: number, patch: Partial<IndexDraft>) => {
    onChange({
      ...draft,
      indexes: draft.indexes.map((x, n) => (n === i ? { ...x, ...patch } : x)),
    });
  };
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Fields</h3>
        {draft.fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Field ${String(i + 1)} name`}
              className="w-40"
              value={f.name}
              onChange={(e) => {
                setField(i, { name: e.target.value });
              }}
            />
            <Select
              value={f.type}
              onValueChange={(v) => {
                const fields = draft.fields.map((x, n) =>
                  n === i
                    ? { name: x.name, required: x.required ?? false, type: v as FieldType }
                    : x,
                );
                onChange({ ...draft, fields });
              }}
            >
              <SelectTrigger aria-label={`${f.name} type`} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <TypeOptions
              field={f}
              collections={collections}
              set={(p) => {
                setField(i, p);
              }}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={f.required === true}
                onChange={(e) => {
                  setField(i, { required: e.target.checked });
                }}
              />
              Required
            </label>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${f.name}`}
              onClick={() => {
                onChange({ ...draft, fields: draft.fields.filter((_, n) => n !== i) });
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const name = `field${String(draft.fields.length + 1)}`;
              onChange({ ...draft, fields: [...draft.fields, { name, type: 'text' }] });
            }}
          >
            <Plus /> Add field
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Indexes</h3>
        {draft.indexes.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Index ${String(i + 1)} name`}
              className="w-40"
              value={x.name}
              onChange={(e) => {
                setIndex(i, { name: e.target.value });
              }}
            />
            <Input
              aria-label={`${x.name} fields`}
              className="w-64"
              placeholder="field1, field2"
              value={x.fields.join(', ')}
              onChange={(e) => {
                setIndex(i, { fields: list(e.target.value) });
              }}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={x.unique === true}
                onChange={(e) => {
                  setIndex(i, { unique: e.target.checked });
                }}
              />
              Unique
            </label>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove index ${x.name}`}
              onClick={() => {
                onChange({ ...draft, indexes: draft.indexes.filter((_, n) => n !== i) });
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const name = `idx${String(draft.indexes.length + 1)}`;
              onChange({ ...draft, indexes: [...draft.indexes, { name, fields: [] }] });
            }}
          >
            <Plus /> Add index
          </Button>
        </div>
      </section>
      {draft.type === 'view' && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">View pipeline (JSON)</h3>
          <Textarea
            aria-label="View pipeline"
            rows={8}
            className="font-mono"
            defaultValue={JSON.stringify(draft.view ?? {}, null, 2)}
            onBlur={(e) => {
              try {
                onChange({ ...draft, view: JSON.parse(e.target.value) as unknown });
              } catch {
                e.target.setCustomValidity('Not valid JSON');
                e.target.reportValidity();
              }
            }}
            onChange={(e) => {
              e.target.setCustomValidity('');
            }}
          />
        </section>
      )}
    </div>
  );
}
