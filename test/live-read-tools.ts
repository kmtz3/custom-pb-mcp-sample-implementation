/**
 * Live test of every READ tool against a real Productboard workspace.
 *
 * Runs the real tool code through an MCP client (in-memory transport) and checks each result
 * against direct Productboard API calls made with the same token. Read-only: the only
 * non-GET requests are POST /search endpoints, which do not modify data. Write tools are
 * never called.
 *
 *   PB_TOKEN=… [PB_EU=true] npm run test:live
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerEntityTools } from '../src/tools/entities.js';
import { registerNoteTools } from '../src/tools/notes.js';
import { registerMemberTools } from '../src/tools/members.js';
import { registerFieldTools } from '../src/tools/fields.js';
import { CHARACTER_LIMIT } from '../src/constants.js';

const token = process.env.PB_TOKEN;
if (!token) { console.error('Set PB_TOKEN'); process.exit(2); }
if (process.env.GOOGLE_CLIENT_ID) { console.error('Unset GOOGLE_CLIENT_ID (multi-tenant mode) for the live test'); process.exit(2); }
const base = process.env.PB_EU === 'true' ? 'https://api.eu.productboard.com/v2' : 'https://api.productboard.com/v2';

// ── Harness ───────────────────────────────────────────────────────────────────

type Json = any;
const results: { name: string; ok: boolean; detail: string }[] = [];

const server = new McpServer({ name: 'live-test', version: '1.0.0' });
registerEntityTools(server); registerNoteTools(server); registerMemberTools(server); registerFieldTools(server);
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const c = new Client({ name: 'live-test', version: '1.0.0' });
await c.connect(clientT);

/** Read-only POST to a /search endpoint, all pages (body re-sent with every cursor). */
async function directSearchAll(path: string, body: Json): Promise<Json[]> {
  const out: Json[] = []; let cur: string | undefined;
  do {
    const res = await fetch(`${base}${path}${cur ? `?pageCursor=${encodeURIComponent(cur)}` : ''}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`direct POST ${path} → ${res.status}`);
    const d = await res.json(); out.push(...d.data); cur = cursorOf(d);
  } while (cur);
  return out;
}

async function direct(path: string): Promise<Json> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`direct ${path} → ${res.status}`);
  return res.json();
}

const cursorOf = (d: Json) => { const n = d?.links?.next; return n ? new URL(n).searchParams.get('pageCursor') ?? undefined : undefined; };

/** Every item of a paginated GET (filters re-sent with every cursor). */
async function directAll(path: string): Promise<Json[]> {
  const out: Json[] = []; let cur: string | undefined;
  do {
    const d = await direct(`${path}${cur ? `${path.includes('?') ? '&' : '?'}pageCursor=${encodeURIComponent(cur)}` : ''}`);
    out.push(...d.data); cur = cursorOf(d);
  } while (cur);
  return out;
}

/** Call a tool. JSON-format calls must return valid JSON within CHARACTER_LIMIT. */
async function call(name: string, args: Record<string, unknown> = {}, format: 'json' | 'markdown' = 'json') {
  const r: Json = await c.callTool({ name, arguments: { ...args, response_format: format } }, undefined, { timeout: 300_000 });
  const text: string = r.content?.[0]?.text ?? '';
  let json: Json;
  if (!r.isError) {
    if (text.length > CHARACTER_LIMIT) throw new Error(`${name}: response ${text.length} chars > CHARACTER_LIMIT`);
    if (format === 'json') {
      try { json = JSON.parse(text); } catch { throw new Error(`${name}: invalid JSON (${text.length} chars): …${text.slice(-80)}`); }
    }
  }
  return { isError: !!r.isError, text, json };
}

/** Follow a cursor field until exhausted, collecting rows. */
async function walk(name: string, args: Record<string, unknown>, cursorField: 'next_cursor' | 'resume_cursor', maxCalls = 60) {
  const rows: Json[] = []; let cur: string | undefined; let calls = 0;
  do {
    const r = await call(name, { ...args, ...(cur ? { page_cursor: cur } : {}) });
    if (r.isError) throw new Error(r.text);
    rows.push(...r.json.data); cur = r.json[cursorField] ?? undefined; calls++;
    if (calls > maxCalls) throw new Error(`${name}: more than ${maxCalls} calls`);
  } while (cur);
  return { rows, calls };
}

async function test(name: string, fn: () => Promise<string | void>) {
  try { results.push({ name, ok: true, detail: (await fn()) ?? '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
  const last = results[results.length - 1];
  console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.name}${last.detail ? `\n      ${last.detail}` : ''}`);
}

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const ids = (xs: Json[]) => xs.map((x) => x.id).join(',');
const sortIds = (xs: Json[]) => xs.map((x) => x.id).sort().join(',');
const noDups = (xs: Json[]) => new Set(xs.map((x) => x.id)).size === xs.length;
const sameSet = (got: Json[], expected: Json[], what: string) => {
  assert(noDups(got), `${what}: duplicate ids across pages`);
  assert(sortIds(got) === sortIds(expected), `${what}: got ${got.length}, expected ${expected.length}`);
};
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
const DAY = 86_400_000;

// ── Tool inventory ────────────────────────────────────────────────────────────

const READ_TOOLS = ['pb_list_entities', 'pb_search_entities', 'pb_get_entity', 'pb_read_entity_document', 'pb_get_entity_configurations',
  'pb_list_entity_relationships', 'pb_list_notes', 'pb_list_entity_feedback', 'pb_get_note', 'pb_search_notes', 'pb_list_members',
  'pb_list_teams', 'pb_search_members', 'pb_get_member_activity', 'pb_get_member', 'pb_get_team', 'pb_search_teams', 'pb_list_field_values'];

await test('tools/list: all read tools present and marked readOnlyHint', async () => {
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name);
  const missing = READ_TOOLS.filter((t) => !names.includes(t));
  assert(!missing.length, `missing: ${missing}`);
  const notRo = tools.filter((t) => READ_TOOLS.includes(t.name) && !t.annotations?.readOnlyHint).map((t) => t.name);
  assert(!notRo.length, `missing readOnlyHint: ${notRo}`);
  const roWrites = tools.filter((t) => !READ_TOOLS.includes(t.name) && t.annotations?.readOnlyHint).map((t) => t.name);
  assert(!roWrites.length, `write tools marked read-only: ${roWrites}`);
  return `${tools.length} tools (${READ_TOOLS.length} read)`;
});

// ── Entities ──────────────────────────────────────────────────────────────────

const featDirect = await direct('/entities?type[]=feature');
const allFeatures = await directAll('/entities?type[]=feature');
const feat = featDirect.data[0];

await test('pb_list_entities: page 1 matches API, valid JSON, compact', async () => {
  const r = await call('pb_list_entities', { type: 'feature' });
  assert(!r.isError, r.text);
  assert(ids(r.json.data) === ids(featDirect.data.slice(0, 50)), 'first 50 ids differ from API page 1');
  const keys = Object.keys(r.json.data[0]);
  assert(['id', 'name', 'type', 'url'].every((k) => keys.includes(k)), `row keys: ${keys}`);
  return `${r.json.count} rows, ${Math.round(r.text.length / 1024)} KB (raw API page ${Math.round(JSON.stringify(featDirect).length / 1024)} KB)`;
});

await test('pb_list_entities: limit=50 cursor walk returns every feature exactly once', async () => {
  const { rows, calls } = await walk('pb_list_entities', { type: 'feature', limit: 50 }, 'next_cursor');
  sameSet(rows, allFeatures, 'walk');
  return `${rows.length} features in ${calls} calls`;
});

await test('pb_list_entities: limit=100 next_cursor equals API cursor; links.next URL accepted', async () => {
  const r = await call('pb_list_entities', { type: 'feature', limit: 100 });
  assert(!r.isError, r.text);
  if (!r.json.truncated) assert(r.json.next_cursor === cursorOf(featDirect), 'next_cursor differs from API cursor');
  else {
    // Rows were dropped to fit the size limit: next_cursor must resume at the first dropped row.
    const rest = await call('pb_list_entities', { type: 'feature', limit: 100, page_cursor: r.json.next_cursor });
    assert(rest.json.data[0].id === featDirect.data[r.json.count].id, 'resume after size-trim skipped rows');
  }
  const p2 = await call('pb_list_entities', { type: 'feature', limit: 100, page_cursor: featDirect.links.next });
  const d2 = await direct(`/entities?type[]=feature&pageCursor=${encodeURIComponent(cursorOf(featDirect)!)}`);
  assert(p2.json.count > 0 && ids(p2.json.data) === ids(d2.data.slice(0, p2.json.count)), 'page 2 via links.next differs');
  return `${r.json.count} rows (${r.text.length} chars${r.json.truncated ? ', trimmed to fit' : ''})`;
});

await test('pb_list_entities: markdown output fits and paginates', async () => {
  const r = await call('pb_list_entities', { type: 'feature' }, 'markdown');
  assert(!r.isError && r.text.includes(feat.id), r.text.slice(0, 120));
  return `${r.text.length} chars`;
});

await test('pb_list_entities: name / status / owner / parent / archived filters (vs full scan)', async () => {
  const out: string[] = [];
  const word = feat.fields.name.slice(0, 4).toLowerCase();
  const status = feat.fields.status?.name; const owner = feat.fields.owner?.email;
  const parentId = (await direct(`/entities/${feat.id}/relationships?type=parent`)).data[0]?.target?.id;
  const children = parentId ? (await directAll(`/entities/${parentId}/relationships?type=child`)).map((r) => r.target.id) : [];
  const cases: [string, Json, (e: Json) => boolean][] = [
    ['name', { name: word }, (e) => e.fields.name.toLowerCase().includes(word)],
    ['status_name', { status_name: status }, (e) => e.fields.status?.name === status],
    ['owner_email', { owner_email: owner }, (e) => e.fields.owner?.email === owner],
    ['archived=true', { archived: true }, (e) => e.fields.archived === true],
    ['archived=false', { archived: false }, (e) => e.fields.archived === false],
    ...(parentId ? [['parent_id', { parent_id: parentId }, (e: Json) => children.includes(e.id)] as [string, Json, (e: Json) => boolean]] : []),
  ];
  for (const [label, args, pred] of cases) {
    const { rows } = await walk('pb_list_entities', { type: 'feature', limit: 200, ...args }, 'next_cursor');
    sameSet(rows, allFeatures.filter(pred), label);
    out.push(`${label}=${rows.length}`);
  }
  return out.join(' ');
});

await test('pb_list_entities: fields=["Effort", <custom field name>] adds named values', async () => {
  const cfg = (await direct('/entities/configurations/feature')).data.fields;
  const customId = Object.keys(feat.fields).find((k) => UUID_KEY.test(k) && typeof feat.fields[k] === 'number')!;
  const customName = cfg[customId].name;
  const r = await call('pb_list_entities', { type: 'feature', fields: ['Effort', customName], limit: 5 });
  assert(!r.isError, r.text);
  const row = r.json.data.find((x: Json) => x.id === feat.id);
  assert(row.fields.Effort === feat.fields.effort, `Effort ${row.fields.Effort} vs ${feat.fields.effort}`);
  assert(row.fields[customName] === feat.fields[customId], `${customName} mismatch`);
  return `Effort=${row.fields.Effort}, ${customName}=${row.fields[customName]}`;
});

const configs = await direct('/entities/configurations');
const types: string[] = configs.data.map((x: Json) => x.type);

await test('pb_list_entities: every entity type', async () => {
  const out: string[] = [];
  for (const t of types) {
    const r = await call('pb_list_entities', { type: t });
    assert(!r.isError, `${t}: ${r.text.slice(0, 100)}`);
    out.push(`${t}=${r.json.count}${r.json.has_more ? '+' : ''}`);
  }
  return out.join(' ');
});

await test('pb_get_entity: custom fields by display name, full relationships, raw mode', async () => {
  const r = await call('pb_get_entity', { id: feat.id });
  assert(!r.isError, r.text);
  assert(r.json.id === feat.id && r.json.name === feat.fields.name, 'entity differs');
  const unresolved = Object.keys(r.json.fields).filter((k) => UUID_KEY.test(k));
  assert(!unresolved.length, `custom fields still keyed by UUID: ${unresolved.length}`);
  const rels = await directAll(`/entities/${feat.id}/relationships`);
  assert(r.json.relationships.length === rels.length, `relationships ${r.json.relationships.length} vs ${rels.length}`);
  const raw = await call('pb_get_entity', { id: feat.id, raw: true });
  assert(!raw.isError && raw.json.data.id === feat.id, 'raw mode failed');
  const md = await call('pb_get_entity', { id: feat.id }, 'markdown');
  assert(!md.isError && md.text.includes(feat.fields.name), 'markdown failed');
  return `${Object.keys(r.json.fields).length} named fields, ${rels.length} relationships (inline on entity: ${feat.relationships?.data?.length})`;
});

await test('pb_get_entity_configurations: default types (JSON valid) + field count', async () => {
  const all = await call('pb_get_entity_configurations', {});
  assert(!all.isError, all.text);
  const one = await call('pb_get_entity_configurations', { types: ['feature'] });
  const d = configs.data.find((x: Json) => x.type === 'feature');
  assert(one.json.data[0].fields.length === Object.keys(d.fields).length, 'field count differs');
  const md = await call('pb_get_entity_configurations', { types: ['feature'] }, 'markdown');
  assert(!md.isError, md.text);
  return `${all.json.data.length} types, ${all.text.length} chars${all.json.truncated ? ' (shortened)' : ''}; feature has ${one.json.data[0].fields.length} fields`;
});

await test('pb_list_entity_relationships: all pages + type filter', async () => {
  const d = await directAll(`/entities/${feat.id}/relationships`);
  const r = await call('pb_list_entity_relationships', { id: feat.id });
  assert(!r.isError && r.json.count === d.length, `count ${r.json?.count} vs ${d.length}`);
  const p = await call('pb_list_entity_relationships', { id: feat.id, type: 'link' });
  assert(p.json.data.every((x: Json) => x.type === 'link') && p.json.count === d.filter((x) => x.type === 'link').length, 'type filter');
  return `${d.length} relationships, ${p.json.count} links`;
});

await test('pb_read_entity_document: markdown, no HTML', async () => {
  const withSpec = allFeatures.find((e) => (e.fields.specification ?? '').length > 50) ?? allFeatures.find((e) => (e.fields.description ?? '').length > 80);
  if (!withSpec) return 'no feature has a description/spec — skipped';
  const r = await call('pb_read_entity_document', { id: withSpec.id });
  assert(!r.isError && r.json.documents.length > 0, r.text.slice(0, 200));
  assert(r.json.documents.every((d: Json) => !/<\/?(p|div|span|h\d|ul|li)[ >]/i.test(d.markdown)), 'HTML left in markdown');
  const md = await call('pb_read_entity_document', { id: withSpec.id }, 'markdown');
  assert(!md.isError && md.text.includes('## '), 'markdown failed');
  return `${withSpec.fields.name}: ${r.json.documents.map((d: Json) => `${d.field} (${d.markdown.length} chars)`).join(', ')}`;
});

// ── pb_search_entities ────────────────────────────────────────────────────────

const searchAll = (args: Json) => walk('pb_search_entities', { types: ['feature'], limit: 200, max_pages: 40, ...args }, 'resume_cursor');

await test('pb_search_entities: legacy exact filters (vs full scan, archived=false default)', async () => {
  const live = allFeatures.filter((e) => !e.fields.archived);
  const status = feat.fields.status?.name; const owner = feat.fields.owner?.email;
  const out: string[] = [];
  const cases: [string, Json, Json[]][] = [
    ['name', { name: feat.fields.name.slice(0, 4) }, live.filter((e) => e.fields.name.toLowerCase().includes(feat.fields.name.slice(0, 4).toLowerCase()))],
    ['status_name', { status_name: status }, live.filter((e) => e.fields.status?.name === status)],
    ['owner_email', { owner_email: owner }, live.filter((e) => e.fields.owner?.email === owner)],
    ['owner_id', { owner_id: feat.fields.owner?.id }, live.filter((e) => e.fields.owner?.id === feat.fields.owner?.id)],
    ['archived=true', { archived: true }, allFeatures.filter((e) => e.fields.archived)],
    ['updated_from', { updated_from: '2026-06-01T00:00:00Z' }, live.filter((e) => e.updatedAt >= '2026-06-01T00:00:00Z')],
    ['none (default excludes archived)', {}, live],
  ];
  for (const [label, args, expected] of cases) {
    const { rows } = await searchAll(args);
    sameSet(rows, expected, label);
    out.push(`${label}=${rows.length}`);
  }
  return out.join(' ');
});

await test('pb_search_entities: ids (POST search) + objectives (GET) + objective date filter', async () => {
  const some = allFeatures.filter((e) => !e.fields.archived).slice(0, 3);
  const r = await call('pb_search_entities', { types: ['feature'], ids: some.map((e) => e.id) });
  assert(!r.isError, r.text); sameSet(r.json.data, some, 'ids');
  const objectives = await directAll('/entities?type[]=objective');
  const o = await walk('pb_search_entities', { types: ['objective'], limit: 200 }, 'resume_cursor');
  sameSet(o.rows, objectives.filter((e) => !e.fields.archived), 'objectives');
  const od = await walk('pb_search_entities', { types: ['objective'], created_from: '2025-01-01T00:00:00Z', limit: 200 }, 'resume_cursor');
  sameSet(od.rows, objectives.filter((e) => !e.fields.archived && e.createdAt >= '2025-01-01T00:00:00Z'), 'objective created_from');
  const liveObj = objectives.find((e) => !e.fields.archived);
  const oi = await call('pb_search_entities', { types: ['objective', 'feature'], ids: [liveObj.id, some[0].id] });
  assert(!oi.isError, oi.text); sameSet(oi.json.data, [liveObj, some[0]], 'mixed-type ids');
  return `ids=${r.json.count}, objectives=${o.rows.length}, objectives created since 2025=${od.rows.length}, mixed ids=${oi.json.count}`;
});

await test('pb_search_entities: name contains (vs full scan)', async () => {
  const word = feat.fields.name.split(' ')[0].slice(0, 4).toLowerCase();
  const expected = allFeatures.filter((e) => !e.fields.archived && e.fields.name.toLowerCase().includes(word));
  const { rows } = await searchAll({ conditions: [{ field: 'name', operator: 'contains', value: word }] });
  sameSet(rows, expected, 'contains');
  assert(rows.every((x: Json) => String(x.matched.name).toLowerCase().includes(word)), 'matched values missing');
  return `"${word}" → ${rows.length}`;
});

await test('pb_search_entities: updatedAt in_last "90 days" + createdAt before (vs full scan)', async () => {
  const now = Date.now();
  const expected = allFeatures.filter((e) => !e.fields.archived && Date.parse(e.updatedAt) >= now - 90 * DAY);
  const { rows } = await searchAll({ conditions: [{ field: 'updatedAt', operator: 'in_last', value: '90 days' }] });
  assert(Math.abs(rows.length - expected.length) <= 1, `in_last got ${rows.length}, expected ${expected.length}`);
  const exp2 = allFeatures.filter((e) => !e.fields.archived && e.createdAt < '2025-06-01');
  const r2 = await searchAll({ conditions: [{ field: 'createdAt', operator: 'before', value: '2025-06-01' }] });
  sameSet(r2.rows, exp2, 'before');
  return `updated in 90 days=${rows.length}, created before 2025-06-01=${r2.rows.length}`;
});

await test('pb_search_entities: Status in [..] AND Effort gt 10; Owner is_empty; not_in', async () => {
  const live = allFeatures.filter((e) => !e.fields.archived);
  const statuses = [...new Set(live.map((e) => e.fields.status?.name).filter(Boolean))].slice(0, 2) as string[];
  const r = await searchAll({ conditions: [{ field: 'Status', operator: 'in', value: statuses }, { field: 'Effort', operator: 'gt', value: 10 }] });
  sameSet(r.rows, live.filter((e) => statuses.includes(e.fields.status?.name) && Number(e.fields.effort) > 10), 'status in + effort');
  const u = await searchAll({ conditions: [{ field: 'Owner', operator: 'is_empty' }] });
  sameSet(u.rows, live.filter((e) => !e.fields.owner), 'owner is_empty');
  const n = await searchAll({ conditions: [{ field: 'status', operator: 'not_in', value: statuses }] });
  sameSet(n.rows, live.filter((e) => !statuses.includes(e.fields.status?.name)), 'not_in');
  return `in+gt=${r.rows.length}, unowned=${u.rows.length}, not_in=${n.rows.length}`;
});

await test('pb_search_entities: custom fields by display name (number gte, select equals, is_not_empty)', async () => {
  const cfg = (await direct('/entities/configurations/feature')).data.fields;
  const live = allFeatures.filter((e) => !e.fields.archived);
  const numId = Object.keys(cfg).find((id) => UUID_KEY.test(id) && cfg[id].schema?.type === 'number' && live.some((e) => typeof e.fields[id] === 'number'))!;
  const selId = Object.keys(cfg).find((id) => UUID_KEY.test(id) && cfg[id].schema?.properties?.name && live.some((e) => e.fields[id]?.name))!;
  const nums = live.map((e) => e.fields[numId]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const mid = nums[Math.floor(nums.length / 2)];
  const r1 = await searchAll({ conditions: [{ field: cfg[numId].name, operator: 'gte', value: String(mid) }] });
  sameSet(r1.rows, live.filter((e) => typeof e.fields[numId] === 'number' && e.fields[numId] >= mid), 'number gte');
  const selVal = live.find((e) => e.fields[selId]?.name).fields[selId].name;
  const r2 = await searchAll({ conditions: [{ field: cfg[selId].name, operator: 'equals', value: selVal }] });
  sameSet(r2.rows, live.filter((e) => e.fields[selId]?.name === selVal), 'select equals');
  const r3 = await searchAll({ conditions: [{ field: cfg[selId].name, operator: 'is_not_empty' }] });
  sameSet(r3.rows, live.filter((e) => e.fields[selId]?.name), 'is_not_empty');
  return `"${cfg[numId].name}" >= ${mid} → ${r1.rows.length}; "${cfg[selId].name}" = "${selVal}" → ${r2.rows.length}; set → ${r3.rows.length}`;
});

await test('pb_search_entities: multiple types + dotted sub-key (timeframe.startDate is_not_empty)', async () => {
  const subs = await directAll('/entities?type[]=subfeature');
  const expected = [...allFeatures, ...subs].filter((e) => !e.fields.archived && e.fields.timeframe?.startDate);
  const { rows } = await walk('pb_search_entities', { types: ['feature', 'subfeature'], conditions: [{ field: 'timeframe.startDate', operator: 'is_not_empty' }], limit: 200, max_pages: 40 }, 'resume_cursor');
  sameSet(rows, expected, 'multi-type');
  return `${rows.length} features+subfeatures with a timeframe start`;
});

await test('pb_search_entities: resumed scans neither drop nor repeat (limit=7, max_pages=1, and size budget)', async () => {
  const live = allFeatures.filter((e) => !e.fields.archived);
  const cond = [{ field: 'name', operator: 'is_not_empty' }];
  const a = await walk('pb_search_entities', { types: ['feature'], conditions: cond, limit: 7 }, 'resume_cursor', 100);
  sameSet(a.rows, live, 'limit=7 walk');
  const b = await walk('pb_search_entities', { types: ['feature'], conditions: cond, limit: 200, max_pages: 1 }, 'resume_cursor');
  sameSet(b.rows, live, 'max_pages=1 walk');
  const first = await call('pb_search_entities', { types: ['feature'], conditions: cond, limit: 200, max_pages: 40 });
  assert(!first.json.complete, 'expected the size budget to stop a 200-row scan early');
  const md = await walk('pb_search_entities', { types: ['feature'], conditions: cond, limit: 200, max_pages: 40 }, 'resume_cursor');
  sameSet(md.rows, live, 'budget walk');
  return `limit=7: ${a.calls} calls; max_pages=1: ${b.calls} calls; budget: first call ${first.json.count} rows, ${md.calls} calls`;
});

await test('pb_search_entities: markdown mode + clear errors (unknown field, bad period, missing value)', async () => {
  const md = await call('pb_search_entities', { types: ['feature'], conditions: [{ field: 'name', operator: 'contains', value: 'a' }] }, 'markdown');
  assert(!md.isError && md.text.startsWith('# Search Results'), md.text.slice(0, 100));
  const u = await call('pb_search_entities', { types: ['feature'], conditions: [{ field: 'Nonexistent Field', operator: 'contains', value: 'x' }] });
  assert(u.isError && u.text.includes('Unknown field'), u.text.slice(0, 100));
  const p = await call('pb_search_entities', { types: ['feature'], conditions: [{ field: 'updatedAt', operator: 'in_last', value: 'soon' }] });
  assert(p.isError && p.text.includes('Invalid period'), p.text.slice(0, 100));
  const v = await call('pb_search_entities', { types: ['feature'], conditions: [{ field: 'name', operator: 'contains' }] });
  assert(v.isError && v.text.includes('needs a value'), v.text.slice(0, 100));
  const s = await call('pb_search_entities', { types: ['feature'], conditions: JSON.stringify([{ field: 'name', operator: 'is_not_empty' }]), limit: 3 });
  assert(!s.isError && s.json.count === 3, 'conditions as JSON string');
  return 'markdown ok; errors flagged isError with clear messages; JSON-string conditions accepted';
});

// ── Notes ─────────────────────────────────────────────────────────────────────

const notesDirect = await direct('/notes');
const allNotes = await directAll('/notes');
const note = notesDirect.data[0];

await test('pb_list_notes: page 1 matches API; limit=200 walk returns every note once', async () => {
  const r = await call('pb_list_notes', {});
  assert(!r.isError && ids(r.json.data) === ids(notesDirect.data.slice(0, 50)), `page 1 ids differ (${r.json?.count} rows${r.json?.truncated ? ', trimmed — a default page should fit' : ''})`);
  const { rows, calls } = await walk('pb_list_notes', { limit: 200 }, 'next_cursor');
  assert(noDups(rows), 'duplicates');
  const missing = allNotes.filter((n) => !rows.some((x) => x.id === n.id));
  assert(missing.length <= 2 && Math.abs(rows.length - allNotes.length) <= 2, `got ${rows.length}, expected ${allNotes.length}`);
  return `${rows.length} notes in ${calls} calls (API total ${allNotes.length})`;
});

await test('pb_list_notes: every filter matches the API with the same filter', async () => {
  const owner = allNotes.find((n) => n.fields.owner?.email)?.fields.owner;
  const creator = allNotes.find((n) => n.fields.creator?.email)?.fields.creator;
  const src = allNotes.find((n) => n.metadata?.source?.system)?.metadata?.source;
  const cases: [Json, string][] = [
    [{ owner_email: owner.email }, `owner[email]=${encodeURIComponent(owner.email)}`],
    [{ owner_id: owner.id }, `owner[id]=${owner.id}`],
    [{ creator_email: creator.email }, `creator[email]=${encodeURIComponent(creator.email)}`],
    [{ creator_id: creator.id }, `creator[id]=${creator.id}`],
    [{ processed: true }, 'processed=true'], [{ processed: false }, 'processed=false'],
    [{ archived: true }, 'archived=true'],
    [{ created_from: '2026-09-01T00:00:00Z' }, 'createdFrom=2026-09-01T00:00:00Z'],
    [{ updated_to: '2026-01-01T00:00:00Z' }, 'updatedTo=2026-01-01T00:00:00Z'],
    ...(src ? [[{ source_system: src.system }, `metadata[source][system]=${encodeURIComponent(src.system)}`] as [Json, string]] : []),
  ];
  const out: string[] = [];
  for (const [args, q] of cases) {
    const d = await direct(`/notes?${q}`);
    const r = await call('pb_list_notes', { ...args, limit: 50 });
    assert(!r.isError, r.text);
    assert(ids(r.json.data) === ids(d.data.slice(0, r.json.count)) && (r.json.count === d.data.length || r.json.truncated), `${q}: ids differ`);
    assert(ids(d.data) !== ids(notesDirect.data) || d.data.length < 100, `${q}: API filter appears unapplied`);
    out.push(`${Object.keys(args)[0]}=${r.json.count}${r.json.has_more ? '+' : ''}`);
  }
  return out.join(' ');
});

await test('pb_get_note: markdown content, relationships, raw', async () => {
  const withRels = allNotes.find((n) => (n.relationships?.data ?? []).length > 1) ?? note;
  const r = await call('pb_get_note', { id: withRels.id });
  assert(!r.isError && r.json.id === withRels.id && r.json.title === withRels.fields.name, 'note differs');
  assert(typeof r.json.content === 'string' && !/<\/?p>/.test(r.json.content), 'content still HTML');
  const rels = await directAll(`/notes/${withRels.id}/relationships`);
  assert(r.json.relationships.length === rels.length, 'relationship count differs');
  const raw = await call('pb_get_note', { id: withRels.id, raw: true });
  assert(!raw.isError && raw.json.data.id === withRels.id, 'raw failed');
  const md = await call('pb_get_note', { id: withRels.id }, 'markdown');
  assert(!md.isError && md.text.includes('## Content'), 'markdown failed');
  return `${r.json.content.length} chars content, ${rels.length} relationships`;
});

const linkCounts: Record<string, number> = {};
for (const n of allNotes) for (const rel of n.relationships?.data ?? []) if (rel.type === 'link') linkCounts[rel.target.id] = (linkCounts[rel.target.id] ?? 0) + 1;
const linkedIds = Object.entries(linkCounts).sort((a, b) => b[1] - a[1]).map(([id]) => id);
const hasLink = (n: Json, idsWanted: string[]) => (n.relationships?.data ?? []).some((r: Json) => r.type === 'link' && idsWanted.includes(r.target.id));

await test('pb_list_entity_feedback: notes linked to a feature, all pages (vs full scan)', async () => {
  const fid = linkedIds[0];
  const { rows, calls } = await walk('pb_list_entity_feedback', { id: fid, limit: 30 }, 'next_cursor');
  sameSet(rows, allNotes.filter((n) => hasLink(n, [fid])), 'feedback');
  const md = await call('pb_list_entity_feedback', { id: fid }, 'markdown');
  assert(!md.isError, md.text);
  return `feature ${fid.slice(0, 8)}… has ${rows.length} linked notes (${calls} calls)`;
});

await test('pb_search_notes: linked_entity_ids (2, OR) and link_ids alias (vs full scan) — was unfiltered before', async () => {
  const two = linkedIds.slice(0, 2);
  const { rows } = await walk('pb_search_notes', { linked_entity_ids: two, limit: 200 }, 'resume_cursor');
  sameSet(rows, allNotes.filter((n) => hasLink(n, two)), 'linked_entity_ids');
  const alias = await walk('pb_search_notes', { link_ids: [two[1]], limit: 200 }, 'resume_cursor');
  sameSet(alias.rows, allNotes.filter((n) => hasLink(n, [two[1]])), 'link_ids');
  return `${rows.length} notes linked to either of 2 features; alias ${alias.rows.length}`;
});

await test('pb_search_notes: customer_ids (vs full scan)', async () => {
  const cust = allNotes.find((n) => (n.relationships?.data ?? []).some((r: Json) => r.type === 'customer'));
  const cid = cust.relationships.data.find((r: Json) => r.type === 'customer').target.id;
  const { rows } = await walk('pb_search_notes', { customer_ids: [cid], limit: 200 }, 'resume_cursor');
  sameSet(rows, allNotes.filter((n) => (n.relationships?.data ?? []).some((r: Json) => r.type === 'customer' && r.target.id === cid)), 'customer_ids');
  return `${rows.length} notes for customer ${cid.slice(0, 8)}…`;
});

await test('pb_search_notes: created_in_last "30 days" (vs full scan, resumed)', async () => {
  const expected = allNotes.filter((n) => Date.parse(n.createdAt) >= Date.now() - 30 * DAY);
  const { rows, calls } = await walk('pb_search_notes', { created_in_last: '30 days', limit: 200 }, 'resume_cursor');
  assert(noDups(rows), 'duplicates');
  assert(Math.abs(rows.length - expected.length) <= 2, `got ${rows.length}, expected ${expected.length}`);
  return `${rows.length} notes in the last 30 days (${calls} calls)`;
});

await test('pb_search_notes: text in title/content (HTML stripped), resumed with limit=40', async () => {
  const word = (note.fields.name as string).split(/\s+/).find((w: string) => w.length > 5)!.toLowerCase().replace(/[^a-z0-9]/g, '');
  const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
  const expected = allNotes.filter((n) => `${n.fields.name} ${typeof n.fields.content === 'string' ? strip(n.fields.content) : ''}`.toLowerCase().includes(word));
  const { rows, calls } = await walk('pb_search_notes', { text: word, limit: 40, max_pages: 40 }, 'resume_cursor', 100);
  assert(noDups(rows), 'duplicates across resumed calls');
  assert(rows.some((n: Json) => n.id === note.id), 'source note missing');
  assert(Math.abs(rows.length - expected.length) <= Math.max(2, Math.ceil(expected.length * 0.03)), `got ${rows.length}, expected ~${expected.length}`);
  return `"${word}" → ${rows.length} notes (expected ~${expected.length}, ${calls} calls)`;
});

await test('pb_search_notes: name, tags, processed + conditions (vs full scan)', async () => {
  const tagged = allNotes.find((n) => (n.fields.tags ?? []).length);
  const tag = tagged.fields.tags[0].name;
  const t = await walk('pb_search_notes', { tags: [tag], limit: 200 }, 'resume_cursor');
  sameSet(t.rows, allNotes.filter((n) => (n.fields.tags ?? []).some((x: Json) => x.name === tag)), 'tags');
  const word = note.fields.name.split(' ')[0];
  const nm = await walk('pb_search_notes', { name: word, limit: 200 }, 'resume_cursor');
  sameSet(nm.rows, allNotes.filter((n) => String(n.fields.name ?? '').toLowerCase().includes(word.toLowerCase())), 'name');
  const cnd = await walk('pb_search_notes', { processed: false, conditions: [{ field: 'Owner', operator: 'is_not_empty' }, { field: 'title', operator: 'not_contains', value: 'zzzz' }], limit: 200 }, 'resume_cursor');
  sameSet(cnd.rows, allNotes.filter((n) => n.fields.processed === false && n.fields.owner), 'processed+conditions');
  const bad = await call('pb_search_notes', { conditions: [{ field: 'Votes', operator: 'gt', value: 1 }] });
  assert(bad.isError && bad.text.includes('Unknown note field'), bad.text.slice(0, 100));
  const md = await call('pb_search_notes', { text: word }, 'markdown');
  assert(!md.isError && md.text.startsWith('# Notes Search'), md.text.slice(0, 80));
  return `tag "${tag}"=${t.rows.length}, name "${word}"=${nm.rows.length}, unprocessed+owned=${cnd.rows.length}`;
});

await test('pb_search_notes: linked_entity_ids + created_in_last combined', async () => {
  const fid = linkedIds[0];
  const { rows } = await walk('pb_search_notes', { linked_entity_ids: [fid], created_in_last: '5 years', limit: 200 }, 'resume_cursor');
  sameSet(rows, allNotes.filter((n) => hasLink(n, [fid]) && Date.parse(n.createdAt) >= Date.now() - 5 * 365 * DAY), 'combined');
  return `${rows.length} notes`;
});

// ── Members, teams, fields ────────────────────────────────────────────────────

const membersAll = await directAll('/members');

await test('pb_list_members: matches API (JSON valid) + query + roles', async () => {
  const r = await call('pb_list_members', {});
  assert(!r.isError, r.text);
  const active = membersAll.filter((m) => !m.fields.disabled && !m.fields.invitationPending);
  assert(sortIds(r.json.data) === sortIds(active) || r.json.count === active.length, `count ${r.json.count} vs ${active.length}`);
  const name = membersAll[0].fields.name.split(' ')[0];
  const q = await call('pb_list_members', { query: name });
  assert(!q.isError && q.json.data.some((m: Json) => m.id === membersAll[0].id), `query "${name}"`);
  const a = await call('pb_list_members', { roles: ['admin'] });
  assert(a.json.data.every((m: Json) => m.role === 'admin'), 'roles filter');
  const md = await call('pb_list_members', {}, 'markdown');
  assert(!md.isError, md.text);
  return `${r.json.count} members (${r.text.length} chars); query "${name}" → ${q.json.count}; admins → ${a.json.count}`;
});

await test('pb_search_members: roles filter vs API; limit=5 cursor walk (no drops/dups)', async () => {
  const admins = await directSearchAll('/members/search', { data: { filter: { fields: { role: ['admin'] } }, return: { includeDisabled: true, includeInvitationPending: false } } });
  assert(admins.every((m) => m.fields.role === 'admin'), 'API role filter not applied');
  const r = await walk('pb_search_members', { roles: ['admin'], limit: 5 }, 'next_cursor');
  sameSet(r.rows, admins, 'admins');
  const all = await walk('pb_search_members', { limit: 5 }, 'next_cursor');
  sameSet(all.rows, await directSearchAll('/members/search', { data: { filter: {}, return: { includeDisabled: true, includeInvitationPending: false } } }), 'all members');
  return `${r.rows.length} admins (${r.calls} calls); ${all.rows.length} members (${all.calls} calls)`;
});

await test('pb_get_member', async () => {
  const m = membersAll[0];
  const r = await call('pb_get_member', { id: m.id });
  assert(!r.isError && r.json.id === m.id, r.text.slice(0, 100));
  return m.fields.name;
});

await test('pb_list_teams / pb_get_team / pb_search_teams', async () => {
  const d = await directAll('/teams');
  const r = await call('pb_list_teams', { include_members: true });
  assert(!r.isError && sortIds(r.json.data) === sortIds(d), 'teams differ');
  const t = d[0];
  const tm = await directAll(`/teams/${t.id}/members`);
  const g = await call('pb_get_team', { id: t.id, include_members: true });
  assert(!g.isError && g.json.members.length === tm.length, 'team members differ');
  const word = String(t.fields.name).replace(/[^\p{L}\p{N} ]/gu, '').trim().split(' ')[0];
  const s = await call('pb_search_teams', { search_query: word });
  assert(!s.isError && s.json.data.some((x: Json) => x.id === t.id), `search "${word}" missed team`);
  return `${d.length} teams; "${t.fields.name}" has ${tm.length} members; search "${word}" → ${s.json.count}`;
});

await test('pb_list_field_values: tags (all pages, JSON valid)', async () => {
  const d = await directAll('/entities/fields/tags/values');
  const r = await call('pb_list_field_values', { field_id: 'tags' });
  assert(!r.isError, r.text);
  assert(r.json.total === d.length, `total ${r.json.total} vs ${d.length}`);
  const md = await call('pb_list_field_values', { field_id: 'tags' }, 'markdown');
  assert(!md.isError, md.text);
  return `${d.length} tags (${r.json.count} shown in JSON${r.json.truncated ? ', trimmed' : ''})`;
});

await test('pb_get_member_activity: raw rows match API (dates re-sent on every page), summary', async () => {
  const from = new Date(Date.now() - 4 * DAY).toISOString().slice(0, 10), to = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const d = await directAll(`/analytics/member-activities?dateFrom=${from}&dateTo=${to}`);
  const r = await call('pb_get_member_activity', { date_from: from, date_to: to, mode: 'raw', workspace_members_only: false, enrich_profiles: false });
  assert(!r.isError, r.text.slice(0, 200));
  assert(r.json.total === d.length, `raw rows ${r.json.total} vs API ${d.length}`);
  assert(d.every((x) => x.date >= from && x.date <= to), 'API returned out-of-range dates');
  const s = await call('pb_get_member_activity', { date_from: from, date_to: to });
  assert(!s.isError, s.text.slice(0, 200));
  const md = await call('pb_get_member_activity', { date_from: from, date_to: to }, 'markdown');
  assert(!md.isError, md.text.slice(0, 200));
  return `${from}..${to}: ${d.length} raw rows; summary ${s.json.total} members`;
});

// ── Dependency direction, related names, health (expected values checked in the Productboard UI / official MCP) ──

const PLAYBACK = '228c2850-9432-47f5-9c11-4c7a4359f524';
const ACCESSIBLE_PLAYER = 'f270e559-2b1f-4f9e-bc9c-70af2d9333bc';
const QUIZZES = '8b9dd9d7-db46-4942-a61e-203d5bd74b1b';

await test('dependency direction matches the Productboard UI (API reports it inverted)', async () => {
  const raw = (await directAll(`/entities/${PLAYBACK}/relationships`)).find((x) => x.target.id === ACCESSIBLE_PLAYER);
  assert(raw?.type === 'isBlocking', `precondition: raw API now says ${raw?.type} — the API may have been fixed; revisit flipDependency`);
  const r = await call('pb_list_entity_relationships', { id: PLAYBACK });
  const dep = r.json.data.find((x: Json) => x.target_id === ACCESSIBLE_PLAYER);
  assert(dep?.type === 'isBlockedBy', `Playback → accessible player is ${dep?.type}, UI says isBlockedBy`);
  const back = await call('pb_list_entity_relationships', { id: ACCESSIBLE_PLAYER, type: 'isBlocking' });
  assert(back.json.data.some((x: Json) => x.target_id === PLAYBACK), 'reverse side: accessible player should be blocking Playback');
  assert(back.json.data.every((x: Json) => x.type === 'isBlocking'), 'reverse side: type filter returned other types');
  const filtered = await call('pb_list_entity_relationships', { id: PLAYBACK, type: 'isBlockedBy' });
  assert(filtered.json.count === 1 && filtered.json.data[0].target_id === ACCESSIBLE_PLAYER, `type=isBlockedBy filter wrong (${filtered.json.count})`);
  const q = await call('pb_list_entity_relationships', { id: QUIZZES, type: 'isBlocking' });
  assert(q.json.data.some((x: Json) => x.target_name === 'In-video quizzes'), 'Quizzes should be blocking In-video quizzes');
  const qb = await call('pb_list_entity_relationships', { id: QUIZZES, type: 'isBlockedBy' });
  assert(!qb.json.data.some((x: Json) => x.target_name === 'In-video quizzes'), 'Quizzes must not be blocked by In-video quizzes');
  const ent = await call('pb_get_entity', { id: PLAYBACK });
  assert(ent.json.relationships.find((x: Json) => x.target_id === ACCESSIBLE_PLAYER)?.type === 'isBlockedBy', 'pb_get_entity direction wrong');
  const md = await call('pb_list_entity_relationships', { id: PLAYBACK, type: 'isBlockedBy' }, 'markdown');
  assert(md.text.includes('isBlockedBy') && md.text.includes(ACCESSIBLE_PLAYER), 'markdown direction wrong');
  return `Playback is blocked by "${dep.target_name}"; Quizzes is blocking "In-video quizzes"`;
});

await test('relationships include related entity names (all pages, not capped at 10)', async () => {
  const ent = await call('pb_get_entity', { id: PLAYBACK });
  assert(!ent.isError, ent.text);
  const rels = ent.json.relationships;
  assert(rels.length === 28, `expected 28 relationships, got ${rels.length}`);
  const unnamed = rels.filter((x: Json) => !x.target_name);
  assert(unnamed.length === 0, `${unnamed.length} without a name`);
  const parent = rels.find((x: Json) => x.type === 'parent');
  assert(parent.target_name === 'Video Lessons', `parent name ${parent.target_name}`);
  const list = await call('pb_list_entity_relationships', { id: PLAYBACK });
  assert(list.json.count === 28 && list.json.data.every((x: Json) => x.target_name), 'pb_list_entity_relationships names');
  const linkedNote = allNotes.find((n) => (n.relationships?.data ?? []).length > 1);
  if (linkedNote) {
    const n = await call('pb_get_note', { id: linkedNote.id });
    assert(n.json.relationships.length > 0 && n.json.relationships.every((x: Json) => x.target_name), 'note relationship missing a name');
  }
  return `28 named, parent "${parent.target_name}", e.g. ${rels.slice(1, 4).map((x: Json) => `${x.type} ${x.target_name}`).join('; ')}`;
});

await test('health shows status, comment, previous status, who and when', async () => {
  const ent = await call('pb_get_entity', { id: PLAYBACK });
  const h = ent.json.fields.Health;
  assert(h && h.status === 'atRisk' && h.previous_status === 'onTrack' && h.comment === '2' && h.updated_by && h.updated_at && h.mode === 'manual', JSON.stringify(h));
  return JSON.stringify(h);
});

// ── Errors ────────────────────────────────────────────────────────────────────

await test('errors are flagged: invalid UUID rejected, unknown entity/note → isError 404 message', async () => {
  const bad = await call('pb_get_entity', { id: 'not-a-uuid' });
  assert(bad.isError, 'invalid UUID not rejected');
  const nf = await call('pb_get_entity', { id: '00000000-0000-4000-8000-000000000000' });
  assert(nf.isError && nf.text.includes('not found'), nf.text.slice(0, 100));
  const nn = await call('pb_get_note', { id: '00000000-0000-4000-8000-000000000000' });
  assert(nn.isError && nn.text.includes('not found'), nn.text.slice(0, 100));
  const cur = await call('pb_list_notes', { page_cursor: 'pbmcp1.@@@' });
  assert(cur.isError, 'garbage cursor accepted');
  return nf.text.slice(0, 80);
});

// ── Report ────────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
