import { replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { CommandArgument, CommandSpec } from './command-spec.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (value: string): KvReply => replies.bulk(encoder.encode(value));
const flag = (value: string): KvReply => replies.simple(value);

const GROUP_CATEGORIES: Readonly<Record<string, string>> = {
  string: '@string',
  generic: '@keyspace',
  hash: '@hash',
  list: '@list',
  set: '@set',
  'sorted-set': '@sortedset',
  json: '@json',
  connection: '@connection',
  transactions: '@transaction',
};

/** ACL categories derived from flags and group (ACLs arrive in phase 10). */
function categories(spec: CommandSpec): string[] {
  const flags = spec.command_flags;
  const out: string[] = [];
  if (flags.includes('WRITE')) out.push('@write');
  if (flags.includes('READONLY')) out.push('@read');
  out.push(flags.includes('FAST') ? '@fast' : '@slow');
  const group = GROUP_CATEGORIES[spec.group];
  if (group) out.push(group);
  return out;
}

function keySpecs(spec: CommandSpec): KvReply[] {
  const range = spec.key_range;
  if (!range) return [];
  const lastkey = range.last >= 0 ? range.last - range.first : range.last;
  return [
    replies.map([
      [text('flags'), replies.set([flag(spec.command_flags.includes('WRITE') ? 'RW' : 'RO')])],
      [
        text('begin_search'),
        replies.map([
          [text('type'), text('index')],
          [text('spec'), replies.map([[text('index'), replies.integer(range.first)]])],
        ]),
      ],
      [
        text('find_keys'),
        replies.map([
          [text('type'), text('range')],
          [
            text('spec'),
            replies.map([
              [text('lastkey'), replies.integer(lastkey)],
              [text('keystep'), replies.integer(range.step)],
              [text('limit'), replies.integer(0)],
            ]),
          ],
        ]),
      ],
    ]),
  ];
}

function argumentDoc(arg: CommandArgument): KvReply {
  const entries: [KvReply, KvReply][] = [
    [text('name'), text(arg.name)],
    [text('type'), text(arg.type)],
  ];
  if (arg.type !== 'pure-token' && arg.type !== 'oneof' && arg.type !== 'block') {
    entries.push([text('display_text'), text(arg.name)]);
  }
  if (arg.type === 'key') entries.push([text('key_spec_index'), replies.integer(0)]);
  if (arg.token) entries.push([text('token'), text(arg.token)]);
  const flags = [arg.optional && 'optional', arg.multiple && 'multiple'].filter(
    (f): f is string => typeof f === 'string',
  );
  if (flags.length > 0) entries.push([text('flags'), replies.set(flags.map(flag))]);
  if (arg.arguments)
    entries.push([text('arguments'), replies.array(arg.arguments.map(argumentDoc))]);
  return replies.map(entries);
}

/**
 * The RESP command table built from the JSON specs: answers `COMMAND`,
 * `COMMAND COUNT|INFO|DOCS|LIST` in Valkey's reply shapes, so clients such as
 * redis-cli can discover arity, key positions and argument hints.
 */
export class CommandTable {
  readonly #specs: ReadonlyMap<string, CommandSpec>;

  constructor(specs: ReadonlyMap<string, CommandSpec>) {
    this.#specs = specs;
  }

  get size(): number {
    return this.#specs.size;
  }

  get(name: string): CommandSpec | undefined {
    return this.#specs.get(name.toUpperCase());
  }

  names(): string[] {
    return [...this.#specs.keys()];
  }

  /** Handles a `COMMAND ...` request. */
  execute(argv: readonly Uint8Array[]): KvReply {
    const sub = argv[1] ? decoder.decode(argv[1]).toUpperCase() : undefined;
    const names = argv.slice(2).map((a) => decoder.decode(a));
    const spec = sub === undefined ? undefined : this.get('COMMAND')?.subcommands?.[sub];
    if (sub === undefined) return replies.array(this.names().map((n) => this.#infoOf(n)));
    if (!spec) {
      return replies.error(
        'INVALID_ARGUMENT',
        `unknown subcommand '${decoder.decode(argv[1])}'. Try COMMAND HELP.`,
      );
    }
    const ok = spec.arity >= 0 ? argv.length === spec.arity : argv.length >= -spec.arity;
    if (!ok) return replies.errors.arity(`command|${sub}`);
    switch (sub) {
      case 'COUNT':
        return replies.integer(this.size);
      case 'LIST':
        return replies.array(this.names().map((n) => text(n.toLowerCase())));
      case 'INFO':
        return replies.array((names.length > 0 ? names : this.names()).map((n) => this.#infoOf(n)));
      default:
        return this.#docs(names.length > 0 ? names : this.names());
    }
  }

  #infoOf(name: string): KvReply {
    const [head, sub] = name.toUpperCase().split('|');
    const parent = this.get(head ?? '');
    const spec = sub === undefined ? parent : parent?.subcommands?.[sub];
    return spec ? this.#info(name.toLowerCase(), spec) : replies.nil();
  }

  #info(name: string, spec: CommandSpec): KvReply {
    const range = spec.key_range;
    const subcommands = Object.entries(spec.subcommands ?? {});
    return replies.array([
      text(name),
      replies.integer(spec.arity),
      replies.set(spec.command_flags.map((f) => flag(f.toLowerCase()))),
      replies.integer(range?.first ?? 0),
      replies.integer(range?.last ?? 0),
      replies.integer(range?.step ?? 0),
      replies.set(categories(spec).map(flag)),
      replies.array([]),
      replies.array(keySpecs(spec)),
      replies.array(subcommands.map(([sub, s]) => this.#info(`${name}|${sub.toLowerCase()}`, s))),
    ]);
  }

  #docs(names: readonly string[]): KvReply {
    const entries: [KvReply, KvReply][] = [];
    for (const name of names) {
      const spec = this.get(name);
      if (spec) entries.push([text(name.toLowerCase()), this.#doc(name.toLowerCase(), spec)]);
    }
    return replies.map(entries);
  }

  #doc(name: string, spec: CommandSpec): KvReply {
    const entries: [KvReply, KvReply][] = [
      [text('summary'), text(spec.summary)],
      [text('since'), text(spec.since)],
      [text('group'), text(spec.group)],
      [text('complexity'), text(spec.complexity)],
    ];
    if (spec.arguments) {
      entries.push([text('arguments'), replies.array(spec.arguments.map(argumentDoc))]);
    }
    const subcommands = Object.entries(spec.subcommands ?? {});
    if (subcommands.length > 0) {
      entries.push([
        text('subcommands'),
        replies.map(
          subcommands.map(([sub, s]) => {
            const full = `${name}|${sub.toLowerCase()}`;
            return [text(full), this.#doc(full, s)] as const;
          }),
        ),
      ]);
    }
    return replies.map(entries);
  }
}
