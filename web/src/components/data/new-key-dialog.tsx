import { Plus } from 'lucide-react';
import { useState } from 'react';
import { TypeChip } from '@/components/type-chip';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { KeyType } from '@/lib/api';
import { KEY_TYPE_ORDER, KEY_TYPES } from '@/lib/key-types';

/** Asks for a name and type, then opens an empty editor; nothing is written until Create key. */
export function NewKeyDialog({ onCreate }: { onCreate: (name: string, type: KeyType) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<KeyType>('string');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus data-icon="inline-start" />
        New key
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name) return;
            onCreate(name, type);
            setOpen(false);
            setName('');
          }}
        >
          <DialogHeader>
            <DialogTitle>New key</DialogTitle>
            <DialogDescription>Pick a name and a type. You add the value next.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-key-name">Name</FieldLabel>
              <Input
                id="new-key-name"
                className="font-mono"
                placeholder="user:42:profile"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Type</FieldLabel>
              <ToggleGroup
                variant="outline"
                className="flex-wrap justify-start"
                value={[type]}
                onValueChange={(v: string[]) => {
                  const next = v[0] as KeyType | undefined;
                  if (next) setType(next);
                }}
              >
                {KEY_TYPE_ORDER.map((t) => (
                  <ToggleGroupItem key={t} value={t} aria-label={KEY_TYPES[t].label}>
                    <TypeChip type={t} className="bg-transparent p-0" />
                    {KEY_TYPES[t].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!name}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
