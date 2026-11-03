// Allow-list sanitizer for `editor` fields (PLAN 16.2). The output is canonical:
// sanitizing it again changes nothing, which is what apply checks.

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  p: [],
  br: [],
  hr: [],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  sub: [],
  sup: [],
  span: [],
  div: [],
  blockquote: [],
  code: [],
  pre: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  ul: [],
  ol: [],
  li: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  a: ['href', 'title', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
};
const URL_ATTRS = new Set(['href', 'src']);
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|noscript|template|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const escapeText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeAttr = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function safeUrl(tag: string, value: string): boolean {
  // Browsers ignore control characters and spaces inside a scheme ("java\tscript:").
  let v = '';
  for (const c of value.toLowerCase()) if (c.charCodeAt(0) > 32) v += c;
  if (tag === 'img' && v.startsWith('data:'))
    return /^data:image\/(png|jpeg|gif|webp);base64,/.test(v);
  return /^(https?:|mailto:|\/|#)/.test(v) || !/^[^/?#]*:/.test(v);
}

function attributes(tag: string, raw: string): string {
  const allowed = ALLOWED[tag] ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!allowed.includes(name) || seen.has(name)) continue;
    const value = unescapeAttr(m[2] ?? m[3] ?? m[4] ?? '');
    if (URL_ATTRS.has(name) && !safeUrl(tag, value)) continue;
    if (name === 'target' && value !== '_blank') continue;
    seen.add(name);
    out.push(` ${name}="${escapeAttr(value)}"`);
  }
  if (tag === 'a' && seen.has('target')) out.push(' rel="noopener noreferrer"');
  return out.join('');
}

/** Keeps allow-listed tags and attributes, drops scripts and comments, escapes stray `<` and `>`. */
export function sanitizeHtml(html: string): string {
  const cleaned = html.replace(COMMENT, '').replace(DROP_WITH_CONTENT, '');
  let out = '';
  let last = 0;
  for (const m of cleaned.matchAll(TAG)) {
    out += escapeText(cleaned.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = (m[2] ?? '').toLowerCase();
    if (!(tag in ALLOWED)) continue;
    out += m[1] === '/' ? `</${tag}>` : `<${tag}${attributes(tag, m[3] ?? '')}>`;
  }
  return out + escapeText(cleaned.slice(last));
}
