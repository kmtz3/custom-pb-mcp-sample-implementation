import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry } from '../services/pbClient.js';
import {
  CHARACTER_LIMIT,
  ENTITY_TYPES,
  ENTITY_TYPES_REQUIRING_PARENT,
  HAS_TIMEFRAME,
  HEALTH_TYPES,
  HAS_PHASE,
} from '../constants.js';
import { paginationSchema, responseFormatSchema, ResponseFormat, jsonObjectArg, jsonArrayArg } from '../schemas/common.js';
import type { PBEntity, PBEntityConfiguration } from '../types.js';
import {
  type Json, type Condition, type PageFetcher,
  errorResult, respondList, respondObject, encodeCursor, scan, getPager, postPager, fetchAll,
  entityRow, entityRowMd, relRow, flipDependency, entityNameResolver, namedFields, fieldNameResolver, resolveFieldKey, htmlToMarkdown, isHtml,
  OPERATORS, conditionsArg, checkConditions, matches, fieldValue, matchedValues,
} from '../lib/shape.js';

function handleError(err: unknown): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) return 'Error: Entity not found. Check the ID is correct.';
    if (pbErr.status === 403) return 'Error: Permission denied. Your token may lack the required scope.';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    if (pbErr.status === 400 || pbErr.status === 422) return `Error: Validation failed — ${pbErr.message}`;
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

const SCAN_BUDGET = Math.floor(CHARACTER_LIMIT * 0.7);

/** All relationship pages, with UI-direction types and related entity names. `type` is in UI terms. */
const relationshipRows = async (id: string, type?: string) => {
  const rows = (await fetchAll(getPager(`/v2/entities/${id}/relationships`, { type: flipDependency(type) }, `relationships ${id}`))).map(relRow);
  return entityNameResolver()(rows);
};

/** Inline relationships on an entity are capped (≈10, with links.next); use the endpoint for the full list. */
const parentIdOf = (e: Json): string | undefined =>
  (e.relationships?.data ?? []).find((r: Json) => r.type === 'parent')?.target?.id;

export function registerEntityTools(server: McpServer): void {

  // ── pb_list_entities ──────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_entities',
    {
      title: 'List Productboard Entities',
      description: `List Productboard entities of one type with cursor pagination. Returns compact rows
(id, name, type, status, owner email, teams, archived, url); use pb_get_entity for all fields.

Supported types: product, component, feature, subfeature, initiative, objective, keyResult, release, releaseGroup, company, user

Args:
  - type (string): Entity type
  - parent_id (string, optional): Only direct children of this entity UUID
  - name (string, optional): Only entities whose name contains this text (server-side)
  - status_name (string, optional): Exact status name, e.g. "In progress" (server-side)
  - owner_email (string, optional): Owner email (server-side)
  - archived (boolean, optional): true = only archived, false = only non-archived. Omit for both.
  - fields (string[], optional): Extra fields to include in each row, by display name or id
    (e.g. ["Effort", "Timeframe"]). Pass ["all"] to include every field (large).
  - limit (number): Max rows to return, 1–200 (default 50)
  - page_cursor (string, optional): next_cursor from a previous response
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: rows[], count, has_more, next_cursor }. Nothing is skipped between pages: when fewer
  rows are returned than the API page holds, next_cursor resumes at the next row.

Examples:
  - "List all products" → type="product"
  - "List features under component X" → type="feature", parent_id="<component-uuid>"
  - "Features with their effort" → type="feature", fields=["Effort"]

For operators (contains, date ranges, custom-field comparisons) use pb_search_entities.`,
      inputSchema: z.object({
        type: z.enum(ENTITY_TYPES).describe('Entity type to list'),
        parent_id: z.string().uuid().optional().describe('Filter to direct children of this parent UUID'),
        name: z.string().min(1).optional().describe('Name contains this text'),
        status_name: z.string().min(1).optional().describe('Exact status name'),
        owner_email: z.string().email().optional().describe('Owner email'),
        archived: z.boolean().optional().describe('true = only archived, false = only non-archived; omit for both'),
        fields: jsonArrayArg(z.string()).optional().describe('Extra fields per row, by display name or id; ["all"] for every field'),
        ...paginationSchema,
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ type, parent_id, name, status_name, owner_email, archived, fields, limit, page_cursor, response_format }) => {
      try {
        const names = fieldNameResolver();
        const fieldNames = fields?.length ? await names(type) : {};
        const all = !!fields?.some((f) => f.toLowerCase() === 'all');
        const extraKeys = all ? [] : (fields ?? []).map((f) => resolveFieldKey(f, fieldNames) ?? f);
        const projection = extraKeys.length
          ? [...new Set(['name', 'status', 'owner', 'teams', 'archived', ...extraKeys])]
          : undefined;

        const pager = getPager('/v2/entities', {
          'type[]': type, 'parent[id]': parent_id, name, 'status[name]': status_name, 'owner[email]': owner_email,
          // archived=false is ignored by GET /v2/entities (live-verified), so it is applied client-side.
          archived: archived === true ? 'true' : undefined, 'fields[]': projection,
        }, `list ${type}`);

        const res = await scan({
          sources: [pager], start: page_cursor, limit, maxPages: Math.ceil(limit / 100) + 2,
          test: archived === undefined ? undefined : (e) => !!e.fields?.archived === archived,
          map: (e) => ({
            ...entityRow(e),
            ...(all ? { fields: namedFields(e.fields, fieldNames, 1000) }
              : extraKeys.length ? { fields: Object.fromEntries(extraKeys.map((k) => [fieldNames[k] ?? k, fieldValue(e, k, fieldNames)])) } : {}),
          }),
        });
        const rows = res.rows.map((r) => r.row);
        return respondList({
          format: response_format, rows,
          cursorAt: (k) => encodeCursor(k < res.rows.length ? res.rows[k].pos : res.resume),
          build: (shown, next, note) => ({ data: shown, count: shown.length, has_more: !!next, next_cursor: next ?? undefined, ...(note ? { truncated: note } : {}) }),
          markdown: (o) => [
            `# Productboard ${type}s (${o.count} results${o.has_more ? ', more available' : ''})`, '',
            ...o.data.map(entityRowMd),
            ...(o.truncated ? ['', `_${o.truncated}_`] : []),
            ...(o.next_cursor ? ['', `_Next page cursor: \`${o.next_cursor}\`_`] : []),
          ].join('\n'),
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_search_entities ────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_entities',
    {
      title: 'Search Productboard Entities',
      description: `Search Productboard entities with exact filters and operator conditions.

Exact filters (status, owner, parent, name, archived=true) are applied by Productboard before
scanning; everything else — including all conditions — is evaluated on each fetched page.
All filters and conditions are combined with AND.

Conditions: [{ field, operator, value }]
  - field: display name or id ("name", "Status", "Owner", "Effort", a custom field name, "createdAt",
    "updatedAt", or a dotted sub-key such as "timeframe.startDate"). Unknown fields are rejected.
  - operator: ${OPERATORS.join(', ')}
  - value: text/number/ISO date; a list for in/not_in; a period like "7 days", "2 weeks",
    "3 months" for in_last/in_next; omit for is_empty/is_not_empty.

Args:
  - types (string[]): Entity types to search (scanned one after another)
  - conditions (array, optional): Operator conditions (see above)
  - name (string, optional): Name contains this text
  - status_name / status_id, owner_email / owner_id, parent_id (optional): Exact filters
  - archived (boolean): false = only non-archived (default), true = only archived
  - ids (string[], optional): Specific entity UUIDs (max 100)
  - source_system / source_record_id (optional): metadata.source filters
  - created_from / created_to / updated_from / updated_to (optional): ISO 8601 bounds
  - limit (number): Stop after this many matches (default 50, max 200)
  - max_pages (number): Max API pages (100 entities each) to scan per call (default 10, max 40)
  - page_cursor (string, optional): resume_cursor from a previous call, to keep scanning
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: rows[] (compact rows + createdAt/updatedAt + "matched" values of the condition fields),
    count, scanned, pages_scanned, complete, resume_cursor }.
  If complete=false, pass resume_cursor as page_cursor to continue; resumed scans neither skip
  nor repeat items.

Examples:
  - Name contains "checkout": types=["feature"], conditions=[{"field":"name","operator":"contains","value":"checkout"}]
  - Updated in the last week: conditions=[{"field":"updatedAt","operator":"in_last","value":"7 days"}]
  - Status in a set: conditions=[{"field":"Status","operator":"in","value":["Planned","In progress"]}]
  - Unowned: conditions=[{"field":"Owner","operator":"is_empty"}]
  - Custom number field: conditions=[{"field":"Effort","operator":"gt","value":5}]`,
      inputSchema: z.object({
        types: jsonArrayArg(z.enum(ENTITY_TYPES)).describe('Entity types to search'),
        conditions: conditionsArg.optional(),
        ids: z.array(z.string().uuid()).max(100).optional().describe('Filter by specific entity UUIDs (max 100)'),
        name: z.string().optional().describe('Name contains this text'),
        owner_email: z.string().email().optional().describe('Filter by owner email'),
        owner_id: z.string().uuid().optional().describe('Filter by owner UUID'),
        status_name: z.string().optional().describe('Filter by exact status name (e.g. "In Progress")'),
        status_id: z.string().uuid().optional().describe('Filter by status UUID'),
        parent_id: z.string().uuid().optional().describe('Filter to direct children of this parent entity UUID'),
        archived: z.boolean().optional().default(false).describe('false = only non-archived (default), true = only archived'),
        created_from: z.string().optional().describe('ISO 8601 datetime — entities created on or after'),
        created_to: z.string().optional().describe('ISO 8601 datetime — entities created on or before'),
        updated_from: z.string().optional().describe('ISO 8601 datetime — entities updated on or after'),
        updated_to: z.string().optional().describe('ISO 8601 datetime — entities updated on or before'),
        source_system: z.string().optional().describe('Filter by metadata.source.system'),
        source_record_id: z.string().optional().describe('Filter by metadata.source.recordId'),
        limit: z.number().int().min(1).max(200).default(50).describe('Stop after this many matches (1–200, default 50)'),
        max_pages: z.number().int().min(1).max(40).default(10).describe('Max API pages to scan per call (default 10)'),
        page_cursor: z.string().optional().describe('resume_cursor from a previous call'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        if (!a.types.length) return errorResult('Error: types must contain at least one entity type');
        const conds: Condition[] = a.conditions ?? [];
        checkConditions(conds);
        const types = [...new Set(a.types)];

        // Field names per type; validate condition fields up front so a typo fails fast.
        const namesFor = fieldNameResolver();
        const namesByType: Record<string, Record<string, string>> = {};
        for (const t of types) namesByType[t] = await namesFor(t);
        if (conds.length) {
          for (const t of types) {
            const names = namesByType[t];
            const known = new Set(['createdat', 'updatedat', ...Object.keys(names).map((k) => k.toLowerCase()), ...Object.values(names).map((n) => n.toLowerCase())]);
            const unknown = conds.map((c) => c.field).filter((f) => !known.has(f.toLowerCase()) && !known.has(f.split('.')[0].toLowerCase()));
            if (unknown.length) {
              return errorResult(`Error: Unknown field(s) for ${t}: ${unknown.join(', ')}. Use pb_get_entity_configurations with types=["${t}"] to see field names.`);
            }
          }
        }

        const postOnly = !!(a.ids?.length || a.source_system || a.source_record_id);
        const sources: PageFetcher[] = types.map((t) => {
          if (postOnly && t !== 'objective') {
            const filter: Record<string, unknown> = { type: [t] };
            if (a.ids?.length) filter['id'] = a.ids;
            if (a.source_system || a.source_record_id) {
              filter['metadata'] = { source: {
                ...(a.source_system ? { system: a.source_system } : {}),
                ...(a.source_record_id ? { recordId: a.source_record_id } : {}),
              } };
            }
            // The body is re-sent with every pageCursor (a cursor alone returns unfiltered results).
            return postPager('/v2/entities/search', { data: { filter } }, `search ${t}`);
          }
          // GET /v2/entities: server-side exact filters. Objectives always use GET because
          // POST /v2/entities/search silently returns nothing for them.
          return getPager('/v2/entities', {
            'type[]': t, name: a.name, 'owner[email]': a.owner_email, 'owner[id]': a.owner_id,
            'status[name]': a.status_name, 'status[id]': a.status_id, 'parent[id]': a.parent_id,
            archived: a.archived === true ? 'true' : undefined,
          }, `search ${t}`);
        });

        const idSet = a.ids?.length ? new Set(a.ids) : null;
        const lc = (s?: string) => (s ?? '').toLowerCase();
        const now = Date.now();
        const test = (e: PBEntity & Json): boolean => {
          const f = (e.fields ?? {}) as Json;
          if (!!f.archived !== !!a.archived) return false;
          if (idSet && !idSet.has(e.id)) return false;
          if (a.name && !lc(f.name).includes(lc(a.name))) return false;
          if (a.owner_email && lc(f.owner?.email) !== lc(a.owner_email)) return false;
          if (a.owner_id && f.owner?.id !== a.owner_id) return false;
          if (a.status_name && lc(f.status?.name) !== lc(a.status_name)) return false;
          if (a.status_id && f.status?.id !== a.status_id) return false;
          if (a.parent_id && postOnly && parentIdOf(e) !== a.parent_id) return false;
          if (a.source_system && e.metadata?.source?.system !== a.source_system) return false;
          if (a.source_record_id && e.metadata?.source?.recordId !== a.source_record_id) return false;
          if (a.created_from && !(e.createdAt && e.createdAt >= a.created_from)) return false;
          if (a.created_to && !(e.createdAt && e.createdAt <= a.created_to)) return false;
          if (a.updated_from && !(e.updatedAt && e.updatedAt >= a.updated_from)) return false;
          if (a.updated_to && !(e.updatedAt && e.updatedAt <= a.updated_to)) return false;
          const names = namesByType[e.type] ?? {};
          return conds.every((c) => matches(fieldValue(e, c.field, names), c.operator, c.value, now));
        };

        const res = await scan({
          sources, start: a.page_cursor, limit: a.limit, maxPages: a.max_pages, budget: SCAN_BUDGET, test,
          map: (e: Json) => ({
            ...entityRow(e), createdAt: e.createdAt, updatedAt: e.updatedAt,
            matched: matchedValues(e, conds, namesByType[e.type] ?? {}),
          }),
        });

        return respondList({
          format: a.response_format, rows: res.rows.map((r) => r.row),
          cursorAt: (k) => encodeCursor(k < res.rows.length ? res.rows[k].pos : res.resume),
          build: (shown, next, note) => ({
            data: shown, count: shown.length, scanned: res.scanned, pages_scanned: res.pagesScanned,
            complete: !next, resume_cursor: next, ...(note ? { truncated: note } : {}),
          }),
          markdown: (o) => [
            `# Search Results (${o.count} matches, ${o.scanned} scanned${o.complete ? ', complete' : ', more to scan'})`, '',
            ...o.data.map(entityRowMd),
            ...(o.truncated ? ['', `_${o.truncated}_`] : []),
            ...(o.resume_cursor ? ['', `_Scan not complete — continue with page_cursor: \`${o.resume_cursor}\`_`] : []),
          ].join('\n'),
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_get_entity ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_entity',
    {
      title: 'Get Productboard Entity',
      description: `Get a single Productboard entity by its UUID, with every field under its display name
(custom fields resolved from UUIDs to names, rich text converted to markdown) and its relationships,
each with the related entity's name.

Health is returned as { status, mode, comment, previous_status, updated_at, updated_by }. Only the
current and previous status are available — the public API has no health history.

Dependencies (isBlocking / isBlockedBy) are reported as the Productboard UI shows them; the raw API
reports them inverted (raw=true returns the API's own, inverted, values).

Args:
  - id (string): The entity UUID
  - fields (string[], optional): Only these fields, by display name or id
  - include_relationships (boolean): Include parent/child/link/blocking relationships (default true)
  - raw (boolean): Return the unmodified API response instead (custom fields keyed by UUID)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { id, type, name, createdAt, updatedAt, url, source, fields: { "Display name": value },
    relationships: [{ type, target_type, target_id, target_name }] }`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        fields: jsonArrayArg(z.string()).optional().describe('Only these fields, by display name or id'),
        include_relationships: z.boolean().default(true).describe('Include relationships'),
        raw: z.boolean().default(false).describe('Return the unmodified API response'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, fields, include_relationships, raw, response_format }) => {
      try {
        const r = await withRetry(() => pbFetch<{ data: PBEntity & Json }>('GET', `/v2/entities/${id}`), `get entity ${id}`);
        const e = r.data;
        if (raw) return respondObject(response_format, r, (o) => '```json\n' + JSON.stringify(o, null, 1) + '\n```');

        const names = await fieldNameResolver()(e.type);
        let f = e.fields ?? {};
        if (fields?.length) {
          const keys = fields.map((x) => resolveFieldKey(x, names) ?? x);
          f = Object.fromEntries(keys.filter((k) => k in f).map((k) => [k, f[k]]));
        }
        const out = {
          id: e.id, type: e.type, name: e.fields?.name, createdAt: e.createdAt, updatedAt: e.updatedAt,
          url: e.links?.html, source: e.metadata?.source,
          fields: namedFields(f, names),
          ...(include_relationships ? await relationshipRows(id).then((r) => ({ relationships: r.items, ...(r.names_truncated ? { names_truncated: r.names_truncated } : {}) })) : {}),
        };
        return respondObject(response_format, out, (o) => {
          const lines = [`# ${o.name ?? o.id} \`${o.id}\``, `- **Type**: ${o.type}`];
          if (o.createdAt) lines.push(`- **Created**: ${o.createdAt}`);
          if (o.updatedAt) lines.push(`- **Updated**: ${o.updatedAt}`);
          if (o.url) lines.push(`- **URL**: ${o.url}`);
          if (o.source?.system) lines.push(`- **Source**: ${o.source.system} / ${o.source.recordId}`);
          lines.push('', '## Fields');
          for (const [k, v] of Object.entries(o.fields as Record<string, Json>)) {
            if (k === 'Name') continue;
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            lines.push(s.includes('\n') ? `- **${k}**:\n\n${s}\n` : `- **${k}**: ${s}`);
          }
          if (o.relationships) {
            lines.push('', `## Relationships (${o.relationships.length})`);
            for (const rel of o.relationships) lines.push(`- ${rel.type} → **${rel.target_name ?? '?'}** \`${rel.target_id}\` (${rel.target_type})`);
            if (o.names_truncated) lines.push(`_${o.names_truncated}_`);
          }
          return lines.join('\n');
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_read_entity_document ───────────────────────────────────────────────
  server.registerTool(
    'pb_read_entity_document',
    {
      title: 'Read Productboard Entity Documents',
      description: `Read the rich-text "documents" stored on an entity — its Description, Specification and any
rich-text custom fields — converted from HTML to markdown.

Standalone Productboard documents (the Docs area) are NOT available through the public API;
this tool only reads rich text attached to a feature, initiative, product, etc.

Args:
  - id (string): Entity UUID
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { id, type, name, url, documents: [{ field, markdown }], empty }`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, response_format }) => {
      try {
        const e = (await withRetry(() => pbFetch<{ data: PBEntity & Json }>('GET', `/v2/entities/${id}`), `get entity ${id}`)).data;
        const names = await fieldNameResolver()(e.type);
        const documents = Object.entries(e.fields ?? {})
          .filter(([k, v]) => typeof v === 'string' && (k === 'description' || k === 'specification' || isHtml(v)))
          .map(([k, v]) => ({ field: names[k] ?? k, markdown: htmlToMarkdown(v as string) }))
          .filter((d) => d.markdown);
        const out = { id: e.id, type: e.type, name: e.fields?.name, url: e.links?.html, documents, empty: documents.length === 0 };
        return respondObject(response_format, out, (o) => [
          `# ${o.name ?? o.id} \`${o.id}\` (${o.type})`, o.url ? `${o.url}` : '', '',
          ...(o.empty ? ['_This entity has no description, specification or rich-text fields._']
            : o.documents.flatMap((d: Json) => [`## ${d.field}`, '', d.markdown, ''])),
        ].join('\n'));
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_create_entity ──────────────────────────────────────────────────────
  server.registerTool(
    'pb_create_entity',
    {
      title: 'Create Productboard Entity',
      description: `Create a new Productboard entity.

Supported types: product, component, feature, subfeature, initiative, objective, keyResult, release, releaseGroup, company, user

PARENT REQUIREMENTS (API rejects without parent_id):
  - feature    → parent can be a product or component UUID
  - subfeature → parent must be a feature UUID
  - component  → parent can be a product or component UUID
  - keyResult  → parent must be an objective UUID
  - release    → parent must be a releaseGroup UUID
  - All other types → no parent required

FIELD SUPPORT BY TYPE:
  - timeframe (start/end/granularity): objective, keyResult, initiative, feature, subfeature, release
  - health (status/comment): objective, keyResult, initiative, feature, subfeature
  - phase: initiative only
  - progress: keyResult only (use pb_update_entity patch for progress fields)
  - status, teams, owner, archived: all hierarchy types

Args:
  - type, name, parent_id: see above
  - email (string, optional): End-user email — only honored for type='user' (sets the user's email field)
  - owner_email (string, optional): Email of the workspace member to set as owner
  - status (string, optional): Status name — must exist in workspace
  - teams (string[], optional): Team names to assign (must exist in workspace)
  - timeframe_start / timeframe_end (YYYY-MM-DD, optional): Date range
  - timeframe_granularity ('day'|'week'|'month'|'quarter'|'year', optional, default 'day')
  - health_status (string, optional): 'onTrack' | 'atRisk' | 'offTrack'
  - health_comment (string, optional): Requires health_status
  - phase (string, optional): Initiative phase name
  - fields (object, optional): Standard or custom fields as key-value pairs. Use the field UUID as
    the key for custom fields. Standard string fields not exposed as named args must also go here:
      - "description": HTML string (REQUIRED — plain text is rejected; wrap in <p> tags,
        e.g. "<p>My description.</p>")
      - "domain": plain string (company entities only, e.g. "acme.com")
    Example: fields={"description": "<p>Enterprise plan customer.</p>", "domain": "acme.com"}
  - source_system, source_record_id, source_url: metadata for dedup/tracking

Returns: The created entity with its assigned UUID.`,
      inputSchema: z.object({
        type: z.enum(ENTITY_TYPES).describe('Entity type'),
        name: z.string().min(1).describe('Entity name'),
        parent_id: z.string().uuid().optional().describe('UUID of the parent entity. Required for feature, subfeature, component, keyResult, release.'),
        email: z.string().email().optional().describe("End-user email address. Only meaningful for type='user' (end-user/customer-contact entity). Sets the user's email field on create."),
        owner_email: z.string().email().optional().describe('Owner email (must be a workspace member)'),
        status: z.string().optional().describe('Status name (must exist in workspace)'),
        teams: z.array(z.string()).optional().describe('Team names to assign'),
        timeframe_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Timeframe start date (YYYY-MM-DD)'),
        timeframe_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Timeframe end date (YYYY-MM-DD)'),
        timeframe_granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional().default('day').describe('Timeframe granularity'),
        health_status: z.string().optional().describe("Health status: 'onTrack' | 'atRisk' | 'offTrack'"),
        health_comment: z.string().optional().describe('Health comment (requires health_status)'),
        phase: z.string().optional().describe('Phase name — initiative type only'),
        fields: jsonObjectArg.optional().describe('Additional fields (key: fieldId or system field name, value: field value). Accepts object or JSON string — some MCP gateways stringify nested args.'),
        source_system: z.string().optional().describe('Metadata source system for dedup'),
        source_record_id: z.string().optional().describe('Metadata source record ID for dedup'),
        source_url: z.string().url().optional().describe('Metadata source URL'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ type, name, parent_id, email, owner_email, status, teams, timeframe_start, timeframe_end, timeframe_granularity, health_status, health_comment, phase, fields, source_system, source_record_id, source_url }) => {
      try {
        if ((ENTITY_TYPES_REQUIRING_PARENT as readonly string[]).includes(type) && !parent_id) {
          return errorResult(`Error: parent_id is required when creating a ${type}`);
        }

        const entityType = type as string;
        const builtFields: Record<string, unknown> = { name, ...(fields ?? {}) };

        if (email && type === 'user') builtFields['email'] = email;
        if (owner_email) builtFields['owner'] = { email: owner_email };
        if (status) builtFields['status'] = { name: status };
        if (teams?.length) builtFields['teams'] = teams.map((t) => ({ name: t }));

        if ((timeframe_start || timeframe_end) && HAS_TIMEFRAME.has(type)) {
          const start = timeframe_start ?? timeframe_end!;
          const end = timeframe_end ?? timeframe_start!;
          builtFields['timeframe'] = { startDate: start, endDate: end, granularity: timeframe_granularity };
        }

        if (health_status && HEALTH_TYPES.has(type)) {
          const health: Record<string, unknown> = { mode: 'manual', status: health_status };
          if (health_comment) health['comment'] = health_comment;
          builtFields['health'] = health;
        }

        if (phase && HAS_PHASE.has(type)) {
          builtFields['phase'] = { name: phase };
        }

        const data: Record<string, unknown> = {
          type: entityType,
          fields: builtFields,
        };

        if (parent_id) {
          data['relationships'] = [{ type: 'parent', target: { id: parent_id } }];
        }

        if (source_system && source_record_id) {
          data['metadata'] = {
            source: {
              system: source_system,
              recordId: source_record_id,
              ...(source_url ? { url: source_url } : {}),
            },
          };
        }

        const r = await withRetry(
          () => pbFetch<{ data: PBEntity }>('POST', '/v2/entities', { data }),
          `create ${type}`
        );

        const entity = r.data;
        const text = `Created ${type} \`${entity.id}\`: **${(entity.fields?.['name'] as string) ?? name}**`;
        return { content: [{ type: 'text', text }], structuredContent: entity as unknown as Record<string, unknown> };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_update_entity ──────────────────────────────────────────────────────
  server.registerTool(
    'pb_update_entity',
    {
      title: 'Update Productboard Entity',
      description: `Update fields on an existing Productboard entity using PATCH.

Supports two update modes:
1. "fields" mode (whole-replace): provide a fields object — replaces every listed field
2. "patch" mode (granular): provide a patch array with ops: set, clear, addItems, removeItems

Use "fields" for simple updates (name, status, teams). Use "patch" for multiselect fields
(addItems/removeItems for tags, teams) or to explicitly clear a field.

Common field shapes:
  - status: { "name": "In Progress" }
  - owner: { "email": "user@example.com" }
  - teams: [{ "name": "Team A" }, { "name": "Team B" }]
  - timeframe: { "startDate": "2024-01-01", "endDate": "2024-03-31", "granularity": "quarter" }
  - health: { "mode": "manual", "status": "onTrack", "comment": "All good" }
  - progress (keyResult): { "startValue": 0, "currentValue": 50, "targetValue": 100 }

Args:
  - id (string): Entity UUID
  - fields (object, optional): Fields to replace as key-value pairs
  - patch (array, optional): Granular patch ops [{ op, path, value? }]

Returns: Confirmation message with entity ID.

Examples:
  - Rename: id="<uuid>", fields={"name": "New Name"}
  - Set status: id="<uuid>", fields={"status": {"name": "Done"}}
  - Add tag: id="<uuid>", patch=[{"op": "addItems", "path": "tags", "value": [{"name": "priority"}]}]
  - Clear description: id="<uuid>", patch=[{"op": "clear", "path": "description"}]`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        fields: jsonObjectArg.optional().describe('Fields to replace (accepts object or JSON string)'),
        patch: jsonArrayArg(z.object({
          op: z.enum(['set', 'clear', 'addItems', 'removeItems']),
          path: z.string().describe('Field path, e.g. "name" or "tags"'),
          value: z.unknown().optional().describe('New value (required for set/addItems/removeItems)'),
        })).optional().describe('Granular patch operations (accepts array or JSON string)'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, fields, patch }) => {
      try {
        if (fields === undefined && (patch === undefined || patch.length === 0)) {
          return errorResult('Error: Provide either fields or patch (at least one op)');
        }

        const body: Record<string, unknown> = { data: {} };
        if (fields) (body['data'] as Record<string, unknown>)['fields'] = fields;
        if (patch) (body['data'] as Record<string, unknown>)['patch'] = patch;

        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/entities/${id}`, body),
          `update entity ${id}`
        );

        return { content: [{ type: 'text', text: `Updated entity \`${id}\` successfully.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_delete_entity ──────────────────────────────────────────────────────
  server.registerTool(
    'pb_delete_entity',
    {
      title: 'Delete Productboard Entity',
      description: `Permanently delete a Productboard entity by UUID.

WARNING: This is irreversible. Deleting a parent entity cascades to all descendants:
  - Deleting a product → cascades to all components, features, subfeatures under it
  - Deleting a component → cascades to features and subfeatures
  - Deleting a feature → cascades to subfeatures
  - Deleting an objective → cascades to keyResults
  - Deleting a releaseGroup → cascades to releases

Always confirm with the user before deleting hierarchy entities.

Args:
  - id (string): Entity UUID to delete

Returns: Confirmation message on success. 404 means the entity was already gone.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID to delete'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('DELETE', `/v2/entities/${id}`),
          `delete entity ${id}`
        );
        return { content: [{ type: 'text', text: `Deleted entity \`${id}\`.` }] };
      } catch (err) {
        const pbErr = err as Error & { status?: number };
        if (pbErr.status === 404) {
          return { content: [{ type: 'text', text: `Entity \`${id}\` not found — already deleted or ID is incorrect.` }] };
        }
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_get_entity_configurations ──────────────────────────────────────────
  server.registerTool(
    'pb_get_entity_configurations',
    {
      title: 'Get Productboard Entity Field Configurations',
      description: `Get field definitions (id, display name, data type) for one or more entity types.

Use this to discover what fields exist and their IDs before creating, updating or searching
entities. Custom fields use UUID identifiers; their display names are what pb_get_entity shows
and what pb_search_entities conditions accept.

Args:
  - types (string[]): Entity types (default: feature, component, product, objective, company)
  - include_schema (boolean): Also include each field's JSON schema and constraints (large; default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: [{ type, fields: [{ id, name, data_type }] }] }

Examples:
  - Discover company fields: types=["company"]`,
      inputSchema: z.object({
        types: jsonArrayArg(z.enum(ENTITY_TYPES)).default(['feature', 'component', 'product', 'objective', 'company']).describe('Entity types'),
        include_schema: z.boolean().default(false).describe('Include JSON schema and constraints per field'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ types, include_schema, response_format }) => {
      try {
        const typeParams = types.map((t) => `type[]=${t}`).join('&');
        const r = await withRetry(
          () => pbFetch<{ data: PBEntityConfiguration[] }>('GET', `/v2/entities/configurations?${typeParams}`),
          'get entity configurations'
        );
        const dataType = (s: Json): string => {
          if (!s) return 'unknown';
          if (s.type === 'array') return `${dataType(s.items)}[]`;
          if (s.format) return s.format;
          if (s.type === 'object' && s.properties?.email) return 'member';
          if (s.type === 'object' && s.properties?.name) return 'select';
          if (s.type === 'object' && s.properties?.startDate) return 'timeframe';
          return s.type ?? s.$ref?.split('/').pop() ?? 'object';
        };
        const data = (r.data ?? []).map((cfg) => ({
          type: cfg.type,
          fields: Object.entries(cfg.fields ?? {}).map(([fieldId, def]) => ({
            id: fieldId, name: def.name, data_type: dataType(def.schema),
            ...(include_schema ? { schema: def.schema, constraints: def.constraints } : {}),
          })),
        }));
        return respondObject(response_format, { data }, (o) => {
          const lines = ['# Entity Field Configurations', ''];
          for (const cfg of o.data) {
            lines.push(`## ${cfg.type} (${cfg.fields.length} fields)`, '');
            for (const f of cfg.fields) {
              lines.push(`- **${f.name}** \`${f.id}\` — ${f.data_type}${f.schema ? ` — schema: \`${JSON.stringify(f.schema)}\`` : ''}`);
            }
            lines.push('');
          }
          return lines.join('\n');
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_list_entity_relationships ──────────────────────────────────────────
  server.registerTool(
    'pb_list_entity_relationships',
    {
      title: 'List Productboard Entity Relationships',
      description: `List all relationships for a Productboard entity (parent, children, links, blocking, blocked-by),
with each related entity's name. All pages are fetched (the inline relationships on an entity are capped at ~10).

isBlocking / isBlockedBy follow the Productboard UI ("A isBlockedBy B" = A is blocked by B). The raw API
reports these inverted; this tool translates both the results and the type filter.

Args:
  - id (string): Entity UUID
  - type (string, optional): Filter by relationship type — parent | child | link | isBlockedBy | isBlocking
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: [{ type, target_type, target_id, target_name }], count }`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        type: z.enum(['parent', 'child', 'link', 'isBlockedBy', 'isBlocking']).optional().describe('Filter by relationship type'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, response_format }) => {
      try {
        const { items: rows, names_truncated } = await relationshipRows(id, type);
        return respondList({
          format: response_format, rows, cursorAt: () => null,
          truncatedNote: (shown, total) => `Showing ${shown} of ${total} relationships to fit the response size limit; filter by type to see the rest.`,
          build: (shown, _next, note) => ({ data: shown, count: shown.length, total: rows.length, ...(names_truncated ? { names_truncated } : {}), ...(note ? { truncated: note } : {}) }),
          markdown: (o) => [
            `# Relationships for \`${id}\` (${o.count}${o.count < o.total ? ` of ${o.total}` : ''})`, '',
            ...o.data.map((rel: Json) => `- **${rel.type}** → ${rel.target_name ?? '?'} \`${rel.target_id}\` (${rel.target_type})`),
            ...(o.names_truncated ? ['', `_${o.names_truncated}_`] : []),
          ].join('\n'),
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );


  // ── pb_create_entity_relationship ─────────────────────────────────────────
  server.registerTool(
    'pb_create_entity_relationship',
    {
      title: 'Create Productboard Entity Relationship',
      description: `Create a relationship between two Productboard entities.

Relationship types:
  - link: associate two entities (e.g. link a feature to an initiative)
  - isBlocking: this entity blocks the target. isBlockedBy: the target blocks this entity.
    Same meaning as the Productboard UI (verified with a live write test).
  - child: add the target as a child of this entity
  - parent: set the parent (use pb_set_entity_parent for replacing the parent)

Args:
  - id (string): Source entity UUID
  - type ('link' | 'isBlockedBy' | 'isBlocking' | 'child' | 'parent'): Relationship type
  - target_id (string): Target entity UUID

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Source entity UUID'),
        type: z.enum(['link', 'isBlockedBy', 'isBlocking', 'child', 'parent']).describe('Relationship type'),
        target_id: z.string().uuid().describe('Target entity UUID'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, type, target_id }) => {
      try {
        // Writes use the UI direction as-is (verified 2026-10-12: POST isBlocking A→B shows in the UI as
        // "A is blocking B"). Only API *reads* are inverted, and those are translated in lib/shape.ts.
        await withRetry(
          () => pbFetch<unknown>('POST', `/v2/entities/${id}/relationships`, {
            data: { type, target: { id: target_id } },
          }),
          `create entity relationship ${id}`
        );
        return { content: [{ type: 'text', text: `Created ${type} relationship from \`${id}\` to \`${target_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_set_entity_parent ──────────────────────────────────────────────────
  server.registerTool(
    'pb_set_entity_parent',
    {
      title: 'Set Productboard Entity Parent',
      description: `Replace (or set) the parent of a Productboard entity using PUT /v2/entities/{id}/relationships/parent.

Use this to move a feature to a different component/product, or a key result to a different objective.
This replaces the existing parent relationship entirely.

Args:
  - id (string): Entity UUID to re-parent
  - parent_id (string): New parent entity UUID

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID to re-parent'),
        parent_id: z.string().uuid().describe('New parent entity UUID'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, parent_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('PUT', `/v2/entities/${id}/relationships/parent`, {
            data: { target: { id: parent_id } },
          }),
          `set entity parent ${id}`
        );
        return { content: [{ type: 'text', text: `Set parent of \`${id}\` to \`${parent_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_delete_entity_relationship ─────────────────────────────────────────
  server.registerTool(
    'pb_delete_entity_relationship',
    {
      title: 'Delete Productboard Entity Relationship',
      description: `Delete a specific relationship between two Productboard entities.

For dependencies, use the same direction pb_list_entity_relationships shows (the UI direction):
isBlocking if this entity blocks the target, isBlockedBy if the target blocks it.

Args:
  - id (string): Source entity UUID
  - type ('link' | 'isBlockedBy' | 'isBlocking' | 'child' | 'parent'): Relationship type to delete
  - target_id (string): Target entity UUID

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Source entity UUID'),
        type: z.enum(['link', 'isBlockedBy', 'isBlocking', 'child', 'parent']).describe('Relationship type'),
        target_id: z.string().uuid().describe('Target entity UUID'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, target_id }) => {
      try {
        // The DELETE path uses the UI direction, matching create (verified 2026-10-12: a dependency created
        // as isBlocking A→B is removed by DELETE /entities/A/relationships/isBlocking/B → 204).
        await withRetry(
          () => pbFetch<unknown>('DELETE', `/v2/entities/${id}/relationships/${type}/${target_id}`),
          `delete entity relationship ${id}`
        );
        return { content: [{ type: 'text', text: `Deleted ${type} relationship from \`${id}\` to \`${target_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );
}
