export type Segment = string | number;

export interface JsonPath {
  /** `$`-style JSONPath (replies are arrays of matches) or legacy `.`-style. */
  readonly jsonPath: boolean;
  readonly segments: readonly Segment[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Parses the supported path subset: `$`, `.`, `.a.b`, `$.a.b`, `$['a']`,
 * `$["a"]`, `$.list[0]`, `$.list[-1]`. Wildcards and filters are not supported.
 */
export function parseJsonPath(text: string): JsonPath | undefined {
  let jsonPath = false;
  let rest = text;
  if (rest.startsWith('$')) {
    jsonPath = true;
    rest = rest.slice(1);
  } else if (rest === '.') {
    return { jsonPath: false, segments: [] };
  } else if (!rest.startsWith('.') && !rest.startsWith('[')) {
    rest = `.${rest}`;
  }
  const segments: Segment[] = [];
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const match = IDENT.exec(rest.slice(1));
      if (!match) return undefined;
      segments.push(match[0]);
      rest = rest.slice(1 + match[0].length);
    } else if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close < 0) return undefined;
      const inner = rest.slice(1, close).trim();
      if (/^-?[0-9]+$/.test(inner)) segments.push(Number(inner));
      else if (/^'.*'$|^".*"$/.test(inner)) segments.push(inner.slice(1, -1));
      else return undefined;
      rest = rest.slice(close + 1);
    } else {
      return undefined;
    }
  }
  return { jsonPath, segments };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type { Json };

const isObject = (v: Json | undefined): v is { [key: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function child(parent: Json | undefined, segment: Segment): Json | undefined {
  if (typeof segment === 'number') {
    if (!Array.isArray(parent)) return undefined;
    const i = segment < 0 ? parent.length + segment : segment;
    return parent[i];
  }
  return isObject(parent) && Object.hasOwn(parent, segment) ? parent[segment] : undefined;
}

/** The value at a path, or undefined. */
export function getAt(root: Json, segments: readonly Segment[]): Json | undefined {
  let node: Json | undefined = root;
  for (const segment of segments) node = child(node, segment);
  return node;
}

/** Sets the value at a path whose parent exists; returns false if it cannot. */
export function setAt(root: Json, segments: readonly Segment[], value: Json): boolean {
  const parent = getAt(root, segments.slice(0, -1));
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (typeof last === 'number') {
    if (!Array.isArray(parent)) return false;
    const i = last < 0 ? parent.length + last : last;
    if (i < 0 || i >= parent.length) return false;
    parent[i] = value;
    return true;
  }
  if (!isObject(parent)) return false;
  parent[last] = value;
  return true;
}

/** Removes the value at a path; returns whether something was removed. */
export function deleteAt(root: Json, segments: readonly Segment[]): boolean {
  const parent = getAt(root, segments.slice(0, -1));
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (typeof last === 'number') {
    if (!Array.isArray(parent)) return false;
    const i = last < 0 ? parent.length + last : last;
    if (i < 0 || i >= parent.length) return false;
    parent.splice(i, 1);
    return true;
  }
  if (!isObject(parent) || !Object.hasOwn(parent, last)) return false;
  return Reflect.deleteProperty(parent, last);
}
