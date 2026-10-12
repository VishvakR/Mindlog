import { CornerDownLeft, Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { session } from '@/lib/api';
import type { Reply } from '@/lib/resp';
import { ReplyDecoder, encodeCommand, formatReply, splitArgs } from '@/lib/resp';
import { cn } from '@/lib/utils';

interface Entry {
  id: number;
  command: string;
  reply?: Reply;
  note?: string;
}

type Status = 'connecting' | 'open' | 'closed';

const HISTORY_KEY = 'mindlog.console.history';
const loadHistory = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};

/** RESP over the authenticated WebSocket (`/api/console`); replies arrive in command order. */
function useConsole(onReply: (reply: Reply) => void) {
  const [status, setStatus] = useState<Status>('connecting');
  const socket = useRef<WebSocket | null>(null);
  const handler = useRef(onReply);
  useEffect(() => {
    handler.current = onReply;
  });

  const connect = () => {
    const token = session.token() ?? '';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/api/console`, [
      'mindlog.resp',
      `bearer.${token}`,
    ]);
    ws.binaryType = 'arraybuffer';
    const decoder = new ReplyDecoder();
    ws.onopen = () => setStatus('open');
    ws.onclose = () => setStatus('closed');
    ws.onmessage = (e) => {
      for (const reply of decoder.push(new Uint8Array(e.data as ArrayBuffer)))
        handler.current(reply);
    };
    socket.current = ws;
  };

  useEffect(() => {
    connect();
    return () => socket.current?.close();
  }, []);

  const send = (args: string[]) => socket.current?.send(encodeCommand(args));
  const reconnect = () => {
    setStatus('connecting');
    connect();
  };
  return { status, send, reconnect };
}

export function ConsolePage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [cursor, setCursor] = useState<number | null>(null);
  const pending = useRef<number[]>([]);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  const { status, send, reconnect } = useConsole((reply) => {
    const id = pending.current.shift();
    setEntries((all) => all.map((e) => (e.id === id ? { ...e, reply } : e)));
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  const submit = () => {
    const command = line.trim();
    if (!command) return;
    setLine('');
    setCursor(null);
    const updated = [...history.filter((h) => h !== command), command].slice(-200);
    setHistory(updated);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    } catch {
      // history then lasts for this page only
    }
    if (command.toLowerCase() === 'clear') {
      setEntries([]);
      return;
    }
    const id = nextId.current++;
    const args = splitArgs(command);
    if (!args) {
      setEntries((all) => [
        ...all,
        { id, command, note: 'Invalid argument(s): close the quote and try again.' },
      ]);
      return;
    }
    if (status !== 'open') {
      setEntries((all) => [
        ...all,
        { id, command, note: 'Not connected. Reconnect, then run it again.' },
      ]);
      return;
    }
    pending.current.push(id);
    setEntries((all) => [...all, { id, command }]);
    send(args);
  };

  const recall = (step: -1 | 1) => {
    if (history.length === 0) return;
    const at = cursor === null ? (step === -1 ? history.length - 1 : null) : cursor + step;
    if (at === null || at >= history.length) {
      setCursor(null);
      setLine('');
      return;
    }
    const clamped = Math.max(0, at);
    setCursor(clamped);
    setLine(history[clamped] ?? '');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2 text-sm text-muted-foreground">
        <span
          className={cn('size-2 rounded-full', status === 'open' ? 'bg-primary' : 'bg-destructive')}
          aria-hidden
        />
        {status === 'open'
          ? 'Connected over RESP'
          : status === 'connecting'
            ? 'Connecting…'
            : 'Disconnected'}
        {status === 'closed' && (
          <Button variant="outline" size="xs" onClick={reconnect}>
            Reconnect
          </Button>
        )}
        <span className="ml-auto hidden sm:inline">
          ↑ ↓ history · clear empties the screen · HELLO 3 switches to RESP3
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear output"
          onClick={() => setEntries([])}
        >
          <Eraser />
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto bg-card px-4 py-3 font-mono text-[13px] leading-relaxed"
        role="log"
        aria-live="polite"
      >
        {entries.length === 0 && (
          <p className="text-muted-foreground">
            Commands run as your superuser against this node. Try PING, SCAN 0 or INFO server.
          </p>
        )}
        {entries.map((e) => (
          <div key={e.id} className="mb-2">
            <div className="flex gap-2">
              <span className="text-primary select-none" aria-hidden>
                ›
              </span>
              <span className="break-all">{e.command}</span>
            </div>
            {e.note && <div className="pl-4 text-destructive">{e.note}</div>}
            {e.reply && (
              <pre
                className={cn(
                  'border-l-2 pl-3 whitespace-pre-wrap break-all',
                  e.reply.kind === 'error'
                    ? 'border-destructive text-destructive'
                    : 'border-border text-foreground/90',
                )}
              >
                {formatReply(e.reply).join('\n')}
              </pre>
            )}
            {!e.reply && !e.note && <div className="pl-4 text-muted-foreground">…</div>}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <span className="font-mono text-primary">›</span>
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            aria-label="Command"
            className="font-mono"
            placeholder="SET greeting hello"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                recall(-1);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                recall(1);
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" aria-label="Run">
              <CornerDownLeft />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
