import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry, fetchPage, fetchAllPages } from '../services/pbClient.js';
import {
  CHARACTER_LIMIT,
  ENTITY_TYPES,
  ENTITY_TYPES_REQUIRING_PARENT,
  HAS_TIMEFRAME,
  HEALTH_TYPES,
  HAS_PHASE,
  ENTITY_CASCADE_ANCESTORS,
} from '../constants.js';
import { paginationSchema, responseFormatSchema, ResponseFormat, jsonObjectArg, jsonArrayArg } from '../schemas/common.js';
import type { PBEntity, PBEntityConfiguration, PBPage, PBNoteRelationship } from '../types.js';

function extractCursor(nextUrl: string | null): string | null {
  if (!nextUrl) return null;
  const m = nextUrl.match(/pageCursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function handleError(err: unknown): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) return 'Error: Entity not found. Check the ID is correct.';
    if (pbErr.status === 403) return 'Error: Permission denied. Your token may lack the required scope.';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    if (pbErr.status === 422) return `Error: Validation failed — ${pbErr.message}`;
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

function entityToMarkdown(e: PBEntity): string {
  const lines: string[] = [
    `### ${(e.fields['name'] as string) ?? e.id} \`${e.id}\``,
    `- **Type**: ${e.type}`,
  ];
  if (e.createdAt) lines.push(`- **Created**: ${e.createdAt}`);
  if (e.updatedAt) lines.push(`- **Updated**: ${e.updatedAt}`);
  for (const [k, v] of Object.entries(e.fields)) {
    if (k === 'name' || v === null || v === undefined) continue;
    const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
    lines.push(`- **${k}**: ${display}`);
  }
  if (e.metadata?.source?.system) {
    lines.push(`- **Source**: ${e.metadata.source.system} / ${e.metadata.source.recordId}`);
  }
  if (e.links?.html) lines.push(`- **URL**: ${e.links.html}`);
  return lines.join('\n');
}

export function registerEntityTools(server: McpServer): void {

  // ── pb_list_entities ──────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_entities',
    {
      title: 'List Productboard Entities',
      description: `List Productboard entities with cursor pagination.

Supported types: product, component, feature, subfeature, initiative, objective, keyResult, release, releaseGroup, company, user

Args:
  - type (string): Entity type
  - parent_id (string, optional): Filter to direct children of this entity UUID.
    Useful for navigating the hierarchy (e.g. list features under a component).
  - fields (string[], optional): Field projection — return only these fields.
    Pass ["all"] to include fields with null values. Pass ["name","status"] to return
    only those fields. Omit to return all non-null fields (default).
    Reduces response size significantly for entities with many custom fields.
  - limit (number): Max results per page, 1–200 (default 50)
  - page_cursor (string, optional): Cursor from a previous response's next_cursor field
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  A list of entities with their fields, plus next_cursor if more pages exist.

Examples:
  - "List all products" → type="product"
  - "List features under component X" → type="feature", parent_id="<component-uuid>"
  - "List all release groups" → type="releaseGroup"
  - "List features, names only" → type="feature", fields=["name"]

NOTE: For objectives, use this tool (not pb_search_entities) — the search endpoint
silently returns empty results for objective type.`,
      inputSchema: z.object({
        type: z.enum(ENTITY_TYPES).describe('Entity type to list'),
        parent_id: z.string().uuid().optional().describe('Filter to direct children of this parent UUID'),
        fields: z.array(z.string()).optional().describe('Field projection: ["all"] for all fields, ["name","status"] for specific fields, omit for non-null fields only'),
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
    async ({ type, parent_id, fields, limit, page_cursor, response_format }) => {
      try {
        const params: string[] = [`type[]=${type}`];
        if (parent_id) params.push(`parent[id]=${encodeURIComponent(parent_id)}`);
        if (fields?.length) fields.forEach((f) => params.push(`fields[]=${encodeURIComponent(f)}`));

        const path = page_cursor
          ? `/v2/entities?${params.join('&')}&pageCursor=${encodeURIComponent(page_cursor)}`
          : `/v2/entities?${params.join('&')}`;

        const { data: rawData, nextUrl } = await fetchPage<PBEntity>(path, `list ${type}`);
        const data = rawData.slice(0, limit);
        const nextCursor = extractCursor(nextUrl);

        const output = {
          data,
          count: data.length,
          has_more: !!nextCursor,
          next_cursor: nextCursor ?? undefined,
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# Productboard ${type}s (${data.length} results${nextCursor ? ', more available' : ''})`,
            '',
          ];
          for (const e of data) lines.push(entityToMarkdown(e), '');
          if (nextCursor) lines.push(`---\n_Next page cursor: \`${nextCursor}\`_`);
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + '\n\n... [truncated — use page_cursor or reduce limit]';
        }

        return { content: [{ type: 'text', text }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_search_entities ────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_entities',
    {
      title: 'Search Productboard Entities',
      description: `Search Productboard entities using POST /v2/entities/search with filters.

Supported types: product, component, feature, subfeature, initiative, keyResult, release, releaseGroup, company, user
NOTE: Do NOT use this for type="objective" — the search endpoint silently returns empty for
objectives. Use pb_list_entities with type="objective" instead.

Args:
  - types (string[]): One or more entity types to search (exclude "objective" — use pb_list_entities)
    NOTE: The API supports one type at a time for POST search; multi-type is best-effort.
  - ids (string[], optional): Fetch specific entities by UUID array (OR logic, max 100)
  - name (string, optional): Filter by partial name match
  - owner_email (string, optional): Filter by owner email (requires members:pii:read scope)
  - owner_id (string, optional): Filter by owner UUID (use instead of email when PII scope unavailable)
  - status_name (string, optional): Filter by status name (e.g. "In Progress", "Done")
  - status_id (string, optional): Filter by status UUID (use when status name is ambiguous)
  - parent_id (string, optional): Filter to direct children of this parent UUID
  - archived (boolean, optional): Include archived entities (default false)
  - created_from (string, optional): ISO 8601 datetime — entities created on or after
  - created_to (string, optional): ISO 8601 datetime — entities created on or before
  - updated_from (string, optional): ISO 8601 datetime — entities updated on or after
  - updated_to (string, optional): ISO 8601 datetime — entities updated on or before
  - source_system (string, optional): Filter by metadata.source.system (e.g. "jira")
  - source_record_id (string, optional): Filter by metadata.source.recordId
  - limit (number): Max results per page (default 50)
  - page_cursor (string, optional): Cursor for next page
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Matching entities with fields (including createdAt/updatedAt), plus next_cursor if more pages exist.
  All filters use AND logic — OR is not supported.

IMPORTANT — date filter limitation (as of May 2026):
  Neither POST /v2/entities/search nor GET /v2/entities support date-based filters
  (createdFrom/updatedFrom are rejected with 400 on GET; silently ignored on POST).
  When created_from, created_to, updated_from, or updated_to are specified, this tool
  auto-paginates all results and filters client-side by the entity's createdAt/updatedAt.
  This works correctly but is slower for large workspaces. Health updates are best filtered
  using health.lastUpdatedAt in the returned fields rather than updated_from.

Examples:
  - "Find features named 'SSO'" → types=["feature"], name="SSO"
  - "Fetch specific entities" → ids=["uuid1","uuid2"]
  - "Features owned by klara@acme.com" → types=["feature"], owner_email="klara@acme.com"
  - "In-Progress features" → types=["feature"], status_name="In Progress"
  - "Features under component X" → types=["feature"], parent_id="<uuid>"
  - "Features created this week" → types=["feature"], created_from="2026-05-03T00:00:00Z"`,
      inputSchema: z.object({
        types: z.array(z.enum(ENTITY_TYPES)).min(1).describe('Entity types to search (avoid "objective" — use pb_list_entities instead)'),
        ids: z.array(z.string().uuid()).max(100).optional().describe('Filter by specific entity UUIDs (OR logic, max 100)'),
        name: z.string().optional().describe('Filter by name (partial match)'),
        owner_email: z.string().email().optional().describe('Filter by owner email (requires members:pii:read scope)'),
        owner_id: z.string().uuid().optional().describe('Filter by owner UUID'),
        status_name: z.string().optional().describe('Filter by status name (e.g. "In Progress")'),
        status_id: z.string().uuid().optional().describe('Filter by status UUID'),
        parent_id: z.string().uuid().optional().describe('Filter to direct children of this parent entity UUID'),
        archived: z.boolean().optional().default(false).describe('Include archived entities'),
        created_from: z.string().optional().describe('ISO 8601 datetime — entities created on or after'),
        created_to: z.string().optional().describe('ISO 8601 datetime — entities created on or before'),
        updated_from: z.string().optional().describe('ISO 8601 datetime — entities updated on or after'),
        updated_to: z.string().optional().describe('ISO 8601 datetime — entities updated on or before'),
        source_system: z.string().optional().describe('Filter by metadata.source.system'),
        source_record_id: z.string().optional().describe('Filter by metadata.source.recordId'),
        ...paginationSchema,
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ types, ids, name, owner_email, owner_id, status_name, status_id, parent_id, archived, created_from, created_to, updated_from, updated_to, source_system, source_record_id, limit, page_cursor, response_format }) => {
      try {
        // April 2026 change: POST /v2/entities/search's legacy flat properties were removed.
        // The new accepted shape inside `data` is:
        //   filter: { type: [...], id?: [...], metadata?: { source: { system?, recordId? } } }
        //   search: { query: <name> }
        // owner / status / parent / archived / name-as-field are no longer accepted by POST and
        // must be filtered via GET /v2/entities (which keeps `owner[*]`, `status[*]`, `parent[id]`,
        // `archived`, `name`). However GET does NOT accept `id[]` or `metadata[source][*]`, so
        // ids/source filters force the POST path with client-side filtering for the rest.
        // Verified live against staging on 2026-05-14.

        const postOnlyFilter = !!(ids?.length || source_system || source_record_id);
        const getOnlyFilter = !!(owner_email || owner_id || status_name || status_id || parent_id || archived === true);
        const hasDateFilter = !!(created_from || created_to || updated_from || updated_to);
        // Objective quirk: POST search returns empty for objectives — always route them through GET.
        const objectiveIncluded = types.includes('objective');
        const nonObjectiveTypes = types.filter((t) => t !== 'objective');

        const applyClientSide = (rows: PBEntity[]): PBEntity[] => rows.filter((e) => {
          const f = (e.fields ?? {}) as Record<string, unknown>;
          if (archived === false && f['archived']) return false;
          if (archived === true && !f['archived']) return false;
          if (owner_id && (f['owner'] as { id?: string } | undefined)?.id !== owner_id) return false;
          if (owner_email && (f['owner'] as { email?: string } | undefined)?.email !== owner_email) return false;
          if (status_id && (f['status'] as { id?: string } | undefined)?.id !== status_id) return false;
          if (status_name && (f['status'] as { name?: string } | undefined)?.name !== status_name) return false;
          if (parent_id && (f['parent'] as { id?: string } | undefined)?.id !== parent_id) return false;
          if (name && !((f['name'] as string | undefined) ?? '').toLowerCase().includes(name.toLowerCase())) return false;
          if (created_from && e.createdAt && e.createdAt < created_from) return false;
          if (created_to && e.createdAt && e.createdAt > created_to) return false;
          if (updated_from && e.updatedAt && e.updatedAt < updated_from) return false;
          if (updated_to && e.updatedAt && e.updatedAt > updated_to) return false;
          return true;
        });

        let allData: PBEntity[] = [];
        let nextCursor: string | null = null;

        // ── POST path: ids[] or metadata.source filters require POST /v2/entities/search.
        if (postOnlyFilter && nonObjectiveTypes.length > 0) {
          const filter: Record<string, unknown> = { type: nonObjectiveTypes };
          if (ids?.length) filter['id'] = ids;
          if (source_system || source_record_id) {
            const source: Record<string, string> = {};
            if (source_system) source['system'] = source_system;
            if (source_record_id) source['recordId'] = source_record_id;
            filter['metadata'] = { source };
          }
          const body: Record<string, unknown> = { data: { filter } };
          if (name) (body['data'] as Record<string, unknown>)['search'] = { query: name };

          // When any GET-only or date filter is also requested, we must consume all pages
          // and filter client-side — otherwise the user's cursor would return wrong-shape data.
          const mustConsumeAll = getOnlyFilter || hasDateFilter;
          let cursor: string | null = page_cursor ?? null;
          do {
            const url = cursor
              ? `/v2/entities/search?pageCursor=${encodeURIComponent(cursor)}`
              : '/v2/entities/search';
            const r = await withRetry(
              () => pbFetch<PBPage<PBEntity>>('POST', url, body),
              'search entities (POST)'
            );
            allData.push(...(r.data ?? []));
            cursor = extractCursor(r.links?.next ?? null);
            if (!mustConsumeAll) { nextCursor = cursor; break; }
          } while (cursor);
          allData = applyClientSide(allData);
        }
        // ── GET path: no ids/source filters → use GET /v2/entities per type (server-side
        // filtering for owner/status/parent/archived/name; date filters still client-side
        // except on objectives which support createdFrom/updatedFrom server-side).
        else if (nonObjectiveTypes.length > 0) {
          for (const t of nonObjectiveTypes) {
            const params: string[] = [`type[]=${encodeURIComponent(t)}`];
            if (archived) params.push('archived=true');
            if (name) params.push(`name=${encodeURIComponent(name)}`);
            if (owner_email) params.push(`owner[email]=${encodeURIComponent(owner_email)}`);
            if (owner_id) params.push(`owner[id]=${encodeURIComponent(owner_id)}`);
            if (status_name) params.push(`status[name]=${encodeURIComponent(status_name)}`);
            if (status_id) params.push(`status[id]=${encodeURIComponent(status_id)}`);
            if (parent_id) params.push(`parent[id]=${encodeURIComponent(parent_id)}`);
            const path = `/v2/entities?${params.join('&')}`;
            const rows = await fetchAllPages<PBEntity>(path, `search ${t}`);
            allData.push(...rows);
          }
          if (hasDateFilter) allData = applyClientSide(allData);
          nextCursor = null; // per-type GET loop consumes all pages
        }

        // ── Objectives: always GET (POST silently returns empty). Date filters are server-side here.
        if (objectiveIncluded) {
          const params: string[] = ['type[]=objective'];
          if (archived) params.push('archived=true');
          if (owner_email) params.push(`owner[email]=${encodeURIComponent(owner_email)}`);
          if (owner_id) params.push(`owner[id]=${encodeURIComponent(owner_id)}`);
          if (status_name) params.push(`status[name]=${encodeURIComponent(status_name)}`);
          if (status_id) params.push(`status[id]=${encodeURIComponent(status_id)}`);
          if (parent_id) params.push(`parent[id]=${encodeURIComponent(parent_id)}`);
          if (name) params.push(`name=${encodeURIComponent(name)}`);
          if (created_from) params.push(`createdFrom=${encodeURIComponent(created_from)}`);
          if (created_to) params.push(`createdTo=${encodeURIComponent(created_to)}`);
          if (updated_from) params.push(`updatedFrom=${encodeURIComponent(updated_from)}`);
          if (updated_to) params.push(`updatedTo=${encodeURIComponent(updated_to)}`);
          const objPath = `/v2/entities?${params.join('&')}`;
          let objRows = await fetchAllPages<PBEntity>(objPath, 'list objectives');
          // ids filter not supported by GET — apply client-side for objectives.
          if (ids?.length) {
            const idSet = new Set(ids);
            objRows = objRows.filter((e) => idSet.has(e.id));
          }
          allData.push(...objRows);
        }

        const data = allData.slice(0, limit);
        const output = {
          data,
          count: data.length,
          has_more: !!nextCursor,
          next_cursor: nextCursor ?? undefined,
          note: objectiveIncluded ? 'Objectives fetched via GET endpoint (POST search quirk)' : undefined,
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Search Results (${data.length}${nextCursor ? ', more available' : ''})`, ''];
          for (const e of data) lines.push(entityToMarkdown(e), '');
          if (nextCursor) lines.push(`---\n_Next page cursor: \`${nextCursor}\`_`);
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + '\n\n... [truncated]';
        }

        return { content: [{ type: 'text', text }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_get_entity ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_entity',
    {
      title: 'Get Productboard Entity',
      description: `Get a single Productboard entity by its UUID.

Args:
  - id (string): The entity UUID
  - fields (string[], optional): Field projection — return only these fields.
    Pass ["all"] to include fields with null values, ["name","status"] for specific fields,
    or omit to return all non-null fields (default).
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  The entity's fields, metadata, and links.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        fields: z.array(z.string()).optional().describe('Field projection: ["all"], ["name","status"], or omit for non-null fields'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, fields, response_format }) => {
      try {
        const qs = fields?.length ? `?${fields.map((f) => `fields[]=${encodeURIComponent(f)}`).join('&')}` : '';
        const r = await withRetry(
          () => pbFetch<{ data: PBEntity }>('GET', `/v2/entities/${id}${qs}`),
          `get entity ${id}`
        );
        const entity = r.data;

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = [`# Entity: ${(entity.fields['name'] as string) ?? id}`, '', entityToMarkdown(entity)].join('\n');
        } else {
          text = JSON.stringify(entity, null, 2);
        }

        return { content: [{ type: 'text', text }], structuredContent: entity as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
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
          return { content: [{ type: 'text', text: `Error: parent_id is required when creating a ${type}` }] };
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
        return { content: [{ type: 'text', text: handleError(err) }] };
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
          return { content: [{ type: 'text', text: 'Error: Provide either fields or patch (at least one op)' }] };
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
        return { content: [{ type: 'text', text: handleError(err) }] };
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
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_get_entity_configurations ──────────────────────────────────────────
  server.registerTool(
    'pb_get_entity_configurations',
    {
      title: 'Get Productboard Entity Field Configurations',
      description: `Get field definitions (schema, constraints, names) for one or more entity types.

Use this to discover what fields exist, their types, and their IDs before creating or
updating entities. Custom fields use UUID identifiers.

Args:
  - types (string[]): Entity types to get configurations for (default: all hierarchy types)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  For each type: list of fields with id, name, type, schema, and constraints.

Examples:
  - Discover company fields: types=["company"]
  - See all field configs: types=["feature", "component", "product"]`,
      inputSchema: z.object({
        types: z.array(z.enum(ENTITY_TYPES)).min(1).default(['feature', 'component', 'product', 'objective', 'company']).describe('Entity types'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ types, response_format }) => {
      try {
        const typeParams = types.map((t) => `type[]=${t}`).join('&');
        const r = await withRetry(
          () => pbFetch<{ data: PBEntityConfiguration[] }>('GET', `/v2/entities/configurations?${typeParams}`),
          'get entity configurations'
        );

        const configs = r.data ?? [];

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = ['# Entity Field Configurations', ''];
          for (const cfg of configs) {
            lines.push(`## ${cfg.type}`, '');
            for (const [fieldId, def] of Object.entries(cfg.fields ?? {})) {
              const schema = def.schema ? JSON.stringify(def.schema) : 'N/A';
              lines.push(`- **${def.name}** (\`${fieldId}\`) — schema: \`${schema}\``);
            }
            lines.push('');
          }
          text = lines.join('\n');
        } else {
          text = JSON.stringify(configs, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + '\n\n... [truncated]';
        }

        return { content: [{ type: 'text', text }], structuredContent: { data: configs } };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_list_entity_relationships ──────────────────────────────────────────
  server.registerTool(
    'pb_list_entity_relationships',
    {
      title: 'List Productboard Entity Relationships',
      description: `List all relationships for a Productboard entity (parent, children, links, blocking, blocked-by).

Args:
  - id (string): Entity UUID
  - type (string, optional): Filter by relationship type — parent | child | link | isBlockedBy | isBlocking
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  All relationships with type and target entity UUID/type.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Entity UUID'),
        type: z.enum(['parent', 'child', 'link', 'isBlockedBy', 'isBlocking']).optional().describe('Filter by relationship type'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, response_format }) => {
      try {
        const params = type ? `?type=${type}` : '';
        const r = await withRetry(
          () => pbFetch<{ data: PBNoteRelationship[] }>('GET', `/v2/entities/${id}/relationships${params}`),
          `list entity relationships ${id}`
        );
        const data = r.data ?? [];
        const output = { data, count: data.length };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Relationships for \`${id}\` (${data.length})`, ''];
          for (const rel of data) {
            lines.push(`- **${rel.type}** → \`${rel.target.id}\` (${rel.target.type})`);
          }
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
        }
        return { content: [{ type: 'text', text }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
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
  - isBlockedBy: mark this entity as blocked by the target
  - isBlocking: mark this entity as blocking the target
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
        await withRetry(
          () => pbFetch<unknown>('POST', `/v2/entities/${id}/relationships`, {
            data: { type, target: { id: target_id } },
          }),
          `create entity relationship ${id}`
        );
        return { content: [{ type: 'text', text: `Created ${type} relationship from \`${id}\` to \`${target_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
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
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_delete_entity_relationship ─────────────────────────────────────────
  server.registerTool(
    'pb_delete_entity_relationship',
    {
      title: 'Delete Productboard Entity Relationship',
      description: `Delete a specific relationship between two Productboard entities.

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
        await withRetry(
          () => pbFetch<unknown>('DELETE', `/v2/entities/${id}/relationships/${type}/${target_id}`),
          `delete entity relationship ${id}`
        );
        return { content: [{ type: 'text', text: `Deleted ${type} relationship from \`${id}\` to \`${target_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );
}
