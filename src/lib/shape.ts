/**
 * Output shaping, pagination and client-side search helpers shared by the tool modules.
 *
 * Why this exists (live-tested against the v2 API):
 *  - Raw list pages are huge (100 features ≈ 670 KB; custom fields keyed by UUID), so list
 *    tools return compact rows and get tools return fields under their display names.
 *  - Responses must stay under CHARACTER_LIMIT. JSON output is never cut mid-string: list
 *    items are dropped instead, and the returned cursor points at the first dropped item so
 *    nothing is silently lost.
 *  - A pageCursor sent alone drops all filters, so every page request re-sends the full
 *    original query (GET params or POST body) plus the cursor.
 *  - The public API only filters by exact values joined with AND. Operators such as
 *    "contains" or "in the last 7 days" are evaluated here over pages fetched from the API.
 */

import { z } from 'zod';
import { pbFetch, withRetry } from '../services/pbClient.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { ResponseFormat, jsonArrayArg } from '../schemas/common.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

// ── Tool results ──────────────────────────────────────────────────────────────

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

// ── HTML → text / markdown ────────────────────────────────────────────────────

export const isHtml = (v: unknown): v is string => typeof v === 'string' && /<\/?[a-z][^>]*>/i.test(v);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

/** Flatten HTML to plain text, optionally clipped to `max` characters. */
export function stripHtml(html: string, max = Number.MAX_SAFE_INTEGER): string {
  const text = decodeEntities(
    html.replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Rich text → readable markdown (headings, lists, links, emphasis, code, tables as rows). */
export function htmlToMarkdown(html: string, max = 50_000): string {
  if (!html) return '';
  let s = html
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${'#'.repeat(Number(n))} `).replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href, text) => `[${text || href}](${href})`)
    .replace(/<img [^>]*src="([^"]*)"[^>]*>/gi, (_m, src) => `![image](${src})`)
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>(.*?)<\/\1>/gi, '_$2_')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`').replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n')
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ').replace(/<tr[^>]*>/gi, '\n| ').replace(/<\/tr>/gi, ' |')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<(br|hr)[^>]*>/gi, '\n').replace(/<\/(p|div|blockquote)>/gi, '\n\n');
  s = stripHtml(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated at ${max} characters]` : s;
}

/** {id,name} → name, {email} → email, {value} → value, arrays mapped; HTML flattened to text. */
export function simple(v: Json, maxText = 20_000): Json {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => simple(x, maxText));
  if (typeof v === 'string') return isHtml(v) ? htmlToMarkdown(v, maxText) : v;
  if (typeof v !== 'object') return v;
  if ('name' in v && typeof v.name === 'string') return v.name;
  if ('email' in v && typeof v.email === 'string') return v.email;
  if ('value' in v) return simple(v.value, maxText);
  if ('startDate' in v || 'endDate' in v) {
    return { startDate: v.startDate ?? null, endDate: v.endDate ?? null, ...(v.granularity ? { granularity: v.granularity } : {}) };
  }
  if ('status' in v && 'mode' in v && ('lastUpdatedAt' in v || 'previousStatus' in v)) return healthValue(v);
  return v;
}

/**
 * Health field → readable object. The public API exposes only the current and previous status
 * (no history — the Productboard UI/official MCP read history from an internal API).
 */
export function healthValue(h: Json) {
  return {
    status: h.status,
    mode: h.mode,
    comment: typeof h.comment === 'string' ? htmlToMarkdown(h.comment) || null : null,
    previous_status: h.previousStatus ?? null,
    updated_at: h.lastUpdatedAt ?? null,
    updated_by: h.createdBy?.email ?? null,
  };
}

const clip = (v: Json, n = 300) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);

// ── Compact rows ──────────────────────────────────────────────────────────────

export const entityRow = (e: Json) => ({
  id: e.id,
  type: e.type,
  name: e.fields?.name,
  status: simple(e.fields?.status) ?? undefined,
  owner: simple(e.fields?.owner) ?? undefined,
  teams: Array.isArray(e.fields?.teams) && e.fields.teams.length ? simple(e.fields.teams) : undefined,
  archived: e.fields?.archived,
  url: e.links?.html,
});

export const noteRow = (n: Json) => ({
  id: n.id,
  type: n.type,
  title: n.fields?.name,
  preview: typeof n.fields?.content === 'string' ? stripHtml(n.fields.content, 140).replace(/\s+/g, ' ') : undefined,
  owner: simple(n.fields?.owner) ?? undefined,
  creator: simple(n.fields?.creator) ?? undefined,
  tags: Array.isArray(n.fields?.tags) && n.fields.tags.length ? simple(n.fields.tags) : undefined,
  processed: n.fields?.processed,
  archived: n.fields?.archived ? true : undefined,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt && n.updatedAt !== n.createdAt ? n.updatedAt : undefined,
  url: n.links?.html,
});

// KNOWN API ISSUE — dependency direction: the public API reports isBlocking/isBlockedBy INVERTED
// relative to the Productboard UI (verified 2026-10-12 in the UI and with the official PB MCP on two
// independent pairs: API says Playback "isBlocking" the accessible player; the UI says Playback is
// blocked by it). Every READ translates to the UI meaning, and relationship-type filters are
// translated back before being sent to the API. WRITES are deliberately NOT translated — the write
// direction is unverified (see pb_create_entity_relationship / pb_delete_entity_relationship).
const UI_DIRECTION: Record<string, string> = { isBlocking: 'isBlockedBy', isBlockedBy: 'isBlocking' };
/** API relationship type ↔ UI relationship type (the mapping is its own inverse). */
export const flipDependency = <T extends string | undefined>(t: T): T => (t ? (UI_DIRECTION[t] ?? t) : t) as T;

export const relRow = (r: Json) => ({ type: flipDependency(r.type as string), target_type: r.target?.type, target_id: r.target?.id });

/** Max distinct related entities whose names are looked up per call (one GET each — no bulk lookup exists). */
export const MAX_NAME_LOOKUPS = 100;

/**
 * Per-request resolver of related-entity names. POST /v2/entities/search rejects `ids`, so each
 * name is one GET /v2/entities/{id}; results are cached, fetched 6 at a time, and capped.
 */
export function entityNameResolver() {
  const cache = new Map<string, Promise<string | null>>();
  const nameOf = (id: string) => {
    if (!cache.has(id)) {
      cache.set(id, withRetry(() => pbFetch<Json>('GET', `/v2/entities/${id}`), `name ${id}`)
        .then((d) => d.data?.fields?.name ?? null).catch(() => null));
    }
    return cache.get(id)!;
  };
  return async <R extends { target_id?: string }>(rows: R[]) => {
    const ids = [...new Set(rows.map((r) => r.target_id).filter(Boolean))] as string[];
    const batch = ids.slice(0, MAX_NAME_LOOKUPS);
    const lookup = new Set(batch);
    for (let i = 0; i < batch.length; i += 6) await Promise.all(batch.slice(i, i + 6).map(nameOf));
    const items = await Promise.all(rows.map(async (r) => ({ ...r, target_name: r.target_id && lookup.has(r.target_id) ? await nameOf(r.target_id) : null })));
    const names_truncated = ids.length > MAX_NAME_LOOKUPS
      ? `Names resolved for the first ${MAX_NAME_LOOKUPS} of ${ids.length} related entities; use pb_get_entity on the others.` : undefined;
    return { items, names_truncated };
  };
}

export function entityRowMd(r: Json): string {
  const bits = [r.type, r.status, r.owner, Array.isArray(r.teams) ? r.teams.join(', ') : r.teams, r.archived ? 'archived' : undefined]
    .filter((x) => x !== undefined && x !== null && x !== '');
  let line = `- **${r.name ?? '(no name)'}** \`${r.id}\` — ${bits.join(' · ')}`;
  if (r.matched) line += ` — matched: ${Object.entries(r.matched).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ')}`;
  if (r.fields) line += ` — ${Object.entries(r.fields).map(([k, v]) => `${k}=${JSON.stringify(clip(v, 200))}`).join('; ')}`;
  if (r.url) line += ` — ${r.url}`;
  return line;
}

export function noteRowMd(r: Json): string {
  const bits = [r.createdAt?.slice(0, 10), r.owner ? `owner ${r.owner}` : 'unassigned', r.processed ? 'processed' : 'unprocessed', r.archived ? 'archived' : undefined,
    r.tags?.length ? `tags: ${r.tags.join(', ')}` : undefined].filter(Boolean);
  let line = `- **${r.title ?? '(no title)'}** \`${r.id}\` — ${bits.join(' · ')}`;
  if (r.preview) line += `\n  > ${String(r.preview).replace(/\s+/g, ' ')}`;
  if (r.matched) line += `\n  matched: ${Object.entries(r.matched).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ')}`;
  return line;
}

// ── Cursors ───────────────────────────────────────────────────────────────────
// A position is (source index, API cursor of the page, offset within that page). When a
// response stops part-way through a page (limit reached, or items dropped to fit the size
// limit), the returned cursor encodes the offset so the next call resumes at the exact item.
// Page-boundary positions on the first source are returned as plain API cursors.

export interface Position { t: number; c?: string; o: number }

const CURSOR_PREFIX = 'pbmcp1.';

export function encodeCursor(p: Position | null): string | null {
  if (!p) return null;
  if (p.t === 0 && p.o === 0 && p.c) return p.c;
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(p)).toString('base64url');
}

/** Accept our own cursors, bare API cursors, or a full links.next URL. */
export function decodeCursor(c?: string | null): Position {
  if (!c) return { t: 0, o: 0 };
  if (c.startsWith(CURSOR_PREFIX)) {
    try {
      const p = JSON.parse(Buffer.from(c.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
      return { t: Number(p.t) || 0, c: p.c || undefined, o: Number(p.o) || 0 };
    } catch {
      throw new Error('Invalid page cursor — pass the cursor exactly as returned by the previous call.');
    }
  }
  if (c.startsWith('http')) {
    try {
      return { t: 0, c: new URL(c).searchParams.get('pageCursor') ?? undefined, o: 0 };
    } catch { /* fall through */ }
  }
  return { t: 0, c, o: 0 };
}

/** pageCursor from a links.next URL. */
export function cursorFromNext(next?: string | null): string | null {
  if (!next) return null;
  try { return new URL(next).searchParams.get('pageCursor'); } catch {
    const m = next.match(/pageCursor=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

// ── Query building ────────────────────────────────────────────────────────────

export type Query = Record<string, string | number | boolean | Array<string> | undefined | null>;

export function buildPath(path: string, query: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    for (const item of Array.isArray(v) ? v : [v]) parts.push(`${k}=${encodeURIComponent(String(item))}`);
  }
  return parts.length ? `${path}${path.includes('?') ? '&' : '?'}${parts.join('&')}` : path;
}

export interface PageResult { data: Json[]; next: string | null }

/** One page fetcher per source. Every call re-sends the full query (fact: a cursor alone drops filters). */
export type PageFetcher = (cursor?: string) => Promise<PageResult>;

export function getPager(path: string, query: Query, label = path): PageFetcher {
  return async (cursor) => {
    const r = await withRetry(() => pbFetch<Json>('GET', buildPath(path, { ...query, pageCursor: cursor })), label);
    return { data: r.data ?? [], next: cursorFromNext(r.links?.next) };
  };
}

export function postPager(path: string, body: unknown, label = path): PageFetcher {
  return async (cursor) => {
    const r = await withRetry(() => pbFetch<Json>('POST', buildPath(path, { pageCursor: cursor }), body), label);
    return { data: r.data ?? [], next: cursorFromNext(r.links?.next) };
  };
}

/** Fetch every page of a source, re-sending the query/body with each cursor. */
export async function fetchAll(pager: PageFetcher, maxPages = 1000): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const p = await pager(cursor);
    out.push(...p.data);
    if (!p.next) break;
    cursor = p.next;
  }
  return out;
}

// ── Scanning ──────────────────────────────────────────────────────────────────

export interface ScanOptions<R> {
  sources: PageFetcher[];
  start?: string | null;
  /** Keep this raw item? (client-side filters). Default: keep everything. */
  test?: (item: Json) => boolean;
  map: (item: Json) => R;
  /** Stop once this many rows are collected (exactly — the cursor resumes at the next item). */
  limit: number;
  maxPages: number;
  /** Stop before the collected rows' JSON exceeds this many characters. */
  budget?: number;
}

export interface ScanResult<R> {
  rows: Array<{ row: R; pos: Position }>;
  /** Position to resume from after all collected rows, or null when the scan is complete. */
  resume: Position | null;
  scanned: number;
  pagesScanned: number;
}

export async function scan<R>(o: ScanOptions<R>): Promise<ScanResult<R>> {
  let pos = decodeCursor(o.start);
  const rows: Array<{ row: R; pos: Position }> = [];
  let scanned = 0, pages = 0, size = 0;

  while (pos.t < o.sources.length) {
    if (pages >= o.maxPages) return { rows, resume: pos, scanned, pagesScanned: pages };
    const page = await o.sources[pos.t](pos.c);
    pages++;
    for (let i = pos.o; i < page.data.length; i++) {
      const here: Position = { t: pos.t, c: pos.c, o: i };
      const item = page.data[i];
      if (!o.test || o.test(item)) {
        const row = o.map(item);
        const len = JSON.stringify(row).length + 1;
        // Too big to add? Leave this item unconsumed so the next call resumes at it.
        if (o.budget && rows.length && size + len > o.budget) return { rows, resume: here, scanned, pagesScanned: pages };
        rows.push({ row, pos: here });
        size += len;
      }
      scanned++;
      if (rows.length >= o.limit) {
        const after = i + 1 < page.data.length
          ? { t: pos.t, c: pos.c, o: i + 1 }
          : page.next ? { t: pos.t, c: page.next, o: 0 } : (pos.t + 1 < o.sources.length ? { t: pos.t + 1, o: 0 } : null);
        return { rows, resume: after, scanned, pagesScanned: pages };
      }
    }
    pos = page.next ? { t: pos.t, c: page.next, o: 0 } : { t: pos.t + 1, o: 0 };
  }
  return { rows, resume: null, scanned, pagesScanned: pages };
}

// ── Size-limited responses ────────────────────────────────────────────────────

function render(format: ResponseFormat, obj: Json, md: (o: Json) => string): string {
  return format === ResponseFormat.JSON ? JSON.stringify(obj) : md(obj);
}

/**
 * Respond with a list, dropping trailing rows (never cutting mid-JSON) until it fits
 * CHARACTER_LIMIT. `build(rows, nextCursor, note)` makes the output object; `cursorAt(k)` is the
 * cursor to return when only the first k rows are shown.
 */
export function respondList<R>(opts: {
  format: ResponseFormat;
  rows: R[];
  cursorAt: (k: number) => string | null;
  build: (rows: R[], next: string | null, note?: string) => Json;
  markdown: (o: Json) => string;
  /** Message when rows are dropped to fit (default: continue with the returned cursor). */
  truncatedNote?: (shown: number, total: number) => string;
}): ToolResult {
  const { format, rows, cursorAt, build, markdown } = opts;
  const truncatedNote = opts.truncatedNote ?? ((shown: number, total: number) =>
    `Showing ${shown} of ${total} items to fit the response size limit; the rest are still available — continue with the returned cursor.`);
  const at = (k: number) => {
    const note = k < rows.length ? truncatedNote(k, rows.length) : undefined;
    const obj = build(rows.slice(0, k), cursorAt(k), note);
    return { obj, text: render(format, obj, markdown) };
  };
  let best = at(rows.length);
  if (best.text.length > CHARACTER_LIMIT) {
    let lo = 0, hi = rows.length - 1;
    best = at(0);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cand = at(mid);
      if (cand.text.length <= CHARACTER_LIMIT) { best = cand; lo = mid + 1; } else hi = mid - 1;
    }
  }
  return respondObject(format, best.obj, () => best.text);
}

/** Recursively shorten strings and arrays until the JSON fits; never produces invalid JSON. */
function shrink(v: Json, maxStr: number, maxArr: number): Json {
  if (typeof v === 'string') return v.length > maxStr ? `${v.slice(0, maxStr)}…[truncated]` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, maxArr).map((x) => shrink(x, maxStr, maxArr));
    if (v.length > maxArr) out.push(`…[${v.length - maxArr} more items truncated]`);
    return out;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, maxStr, maxArr)]));
  return v;
}

/** Respond with a single object. Oversized JSON is shrunk structurally; markdown is cut at a line boundary. */
export function respondObject(format: ResponseFormat, obj: Json, markdown: (o: Json) => string): ToolResult {
  let text = render(format, obj, markdown);
  let out = obj;
  if (text.length > CHARACTER_LIMIT) {
    if (format === ResponseFormat.JSON) {
      for (const [maxStr, maxArr] of [[8000, 200], [4000, 100], [2000, 50], [1000, 25], [400, 10], [150, 5]]) {
        out = { ...shrink(obj, maxStr, maxArr), truncated: 'Some long values or lists were shortened to fit the response size limit; request fewer items or a single record to see everything.' };
        text = JSON.stringify(out);
        if (text.length <= CHARACTER_LIMIT) break;
      }
      if (text.length > CHARACTER_LIMIT) {
        out = { error: 'Response too large to return', truncated: true };
        text = JSON.stringify(out);
      }
    } else {
      const cut = text.lastIndexOf('\n', CHARACTER_LIMIT - 200);
      text = `${text.slice(0, cut > 0 ? cut : CHARACTER_LIMIT - 200)}\n\n…[truncated to fit the response size limit — narrow the request or use response_format='json' with a smaller limit]`;
    }
  }
  return {
    content: [{ type: 'text', text }],
    ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out as Record<string, unknown> } : {}),
  };
}

// ── Field display names ───────────────────────────────────────────────────────

export type FieldNames = Record<string, string>;

/** Per-request cache of entity-type field id → display name (from GET /v2/entities/configurations/{type}). */
export function fieldNameResolver() {
  const cache = new Map<string, Promise<FieldNames>>();
  return (type: string): Promise<FieldNames> => {
    if (!cache.has(type)) {
      cache.set(type, withRetry(() => pbFetch<Json>('GET', `/v2/entities/configurations/${encodeURIComponent(type)}`), `config ${type}`)
        .then((d) => Object.fromEntries(Object.entries(d.data?.fields ?? {}).map(([id, f]: [string, Json]) => [id, f?.name ?? id])))
        .catch(() => ({})));
    }
    return cache.get(type)!;
  };
}

/** Fields keyed by display name (duplicate names are disambiguated with the field id). */
export function namedFields(fields: Json, names: FieldNames, maxText = 20_000): Record<string, Json> {
  const out: Record<string, Json> = {};
  const counts: Record<string, number> = {};
  for (const k of Object.keys(fields ?? {})) { const n = names[k] ?? k; counts[n] = (counts[n] ?? 0) + 1; }
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    const n = names[k] ?? k;
    out[counts[n] > 1 && n !== k ? `${n} (${k})` : n] = simple(v, maxText);
  }
  return out;
}

/** Resolve user-supplied field references (display name or id, case-insensitive) to field ids. */
export function resolveFieldKey(ref: string, names: FieldNames): string | undefined {
  const lc = ref.toLowerCase();
  if (ref in names) return ref;
  return Object.keys(names).find((k) => k.toLowerCase() === lc) ?? Object.keys(names).find((k) => names[k].toLowerCase() === lc);
}

// ── Operator conditions ───────────────────────────────────────────────────────

export const OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty',
  'gt', 'gte', 'lt', 'lte', 'before', 'after', 'in_last', 'in_next'] as const;
export type Operator = typeof OPERATORS[number];

export const conditionSchema = z.object({
  field: z.string().min(1).describe('Field display name or id, e.g. "name", "Status", "Owner", "createdAt", "updatedAt", "timeframe.startDate", or a custom field name'),
  operator: z.enum(OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional()
    .describe('Text, number or ISO date. in/not_in take a list. in_last/in_next take a period like "7 days", "2 weeks", "3 months". Omit for is_empty/is_not_empty.'),
});
export type Condition = z.infer<typeof conditionSchema>;

export const conditionsArg = jsonArrayArg(conditionSchema)
  .describe('Operator conditions, AND-combined: [{field, operator, value}]. Accepts an array or a JSON string.');

/** "7 days" | "2 weeks" | "3 months" | "1 year" | "7" → milliseconds. */
export function periodMs(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid period "${v}" — use e.g. "7 days", "2 weeks", "3 months"`);
  const n = Number(m[1]);
  const u = (m[2] ?? 'd').toLowerCase()[0];
  return n * 86_400_000 * (u === 'w' ? 7 : u === 'm' ? 30 : u === 'y' ? 365 : 1);
}

function toDate(v: Json): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const isEmptyVal = (v: Json) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Evaluate one condition against a (simplified) field value. Arrays match if any element matches. */
export function matches(value: Json, op: Operator, target: Condition['value'], now: number): boolean {
  if (op === 'is_empty') return isEmptyVal(value);
  if (op === 'is_not_empty') return !isEmptyVal(value);
  if (op === 'not_contains' || op === 'not_equals' || op === 'not_in') {
    return !matches(value, op.replace('not_', '') as Operator, target, now);
  }
  if (Array.isArray(value)) return value.some((v) => matches(v, op, target, now));
  if (isEmptyVal(value)) return false;
  const want = (Array.isArray(target) ? target : target === undefined ? [] : [target]).map(String);
  const str = (typeof value === 'object' ? JSON.stringify(value) : String(value)).toLowerCase();
  switch (op) {
    case 'contains': return want.some((w) => str.includes(w.toLowerCase()));
    case 'equals': case 'in': return want.some((w) => str === w.toLowerCase());
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = typeof value === 'number' ? value : Number(value), b = Number(want[0]);
      if (Number.isNaN(a) || Number.isNaN(b) || typeof value === 'boolean') {
        const da = toDate(value), db = toDate(want[0]);
        if (da === null || db === null) return false;
        return op === 'gt' ? da > db : op === 'gte' ? da >= db : op === 'lt' ? da < db : da <= db;
      }
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'before': case 'after': {
      const d = toDate(value), w = toDate(want[0]);
      if (d === null || w === null) return false;
      return op === 'before' ? d < w : d > w;
    }
    case 'in_last': case 'in_next': {
      const d = toDate(value);
      if (d === null) return false;
      const span = periodMs(want[0] ?? '7');
      return op === 'in_last' ? d <= now && d >= now - span : d >= now && d <= now + span;
    }
  }
  return false;
}

/** Read a field from an entity/note by display name, id, or built-in name; supports "field.subkey". */
export function fieldValue(e: Json, field: string, names: FieldNames): Json {
  const [head, ...rest] = field.split('.');
  const key = head.toLowerCase();
  let raw: Json;
  if (key === 'createdat' || key === 'updatedat') raw = e[key === 'createdat' ? 'createdAt' : 'updatedAt'];
  else if (head in (e.fields ?? {})) raw = e.fields[head];
  else {
    const id = resolveFieldKey(head, names);
    raw = id ? e.fields?.[id] : undefined;
    if (raw === undefined) {
      const k = Object.keys(e.fields ?? {}).find((x) => x.toLowerCase() === key);
      if (k) raw = e.fields[k];
    }
  }
  for (const sub of rest) raw = raw?.[sub];
  return isHtml(raw) ? stripHtml(raw) : simple(raw);
}

/** Validate operators up front so a typo fails fast instead of matching nothing. */
export function checkConditions(conds: Condition[]): void {
  for (const c of conds) {
    const empty = c.value === undefined || c.value === '' || (Array.isArray(c.value) && c.value.length === 0);
    if (!['is_empty', 'is_not_empty'].includes(c.operator) && empty) {
      throw new Error(`Condition on "${c.field}" with operator ${c.operator} needs a value`);
    }
    if (c.operator === 'in_last' || c.operator === 'in_next') periodMs(String(Array.isArray(c.value) ? c.value[0] : c.value));
    if (['gt', 'gte', 'lt', 'lte', 'before', 'after'].includes(c.operator) && Array.isArray(c.value)) {
      throw new Error(`Condition on "${c.field}" with operator ${c.operator} takes a single value, not a list`);
    }
  }
}

/** Values of the condition fields for one item, to show why it matched. */
export function matchedValues(item: Json, conds: Condition[], names: FieldNames): Record<string, Json> | undefined {
  if (!conds.length) return undefined;
  return Object.fromEntries(conds.map((c) => [c.field, clip(fieldValue(item, c.field, names))]));
}

/** Notes: "title" is an alias for the note's "name" field. */
export const noteFieldAlias = (c: Condition): Condition => (c.field.toLowerCase() === 'title' ? { ...c, field: 'name' } : c);
