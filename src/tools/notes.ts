import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry } from '../services/pbClient.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { paginationSchema, responseFormatSchema, ResponseFormat, jsonArrayArg } from '../schemas/common.js';
import type { PBNote } from '../types.js';
import {
  type Json, type Condition, type Query,
  errorResult, respondList, respondObject, encodeCursor, scan, getPager, fetchAll,
  noteRow, noteRowMd, relRow, entityNameResolver, simple, stripHtml, htmlToMarkdown, periodMs,
  OPERATORS, conditionsArg, checkConditions, matches, fieldValue, matchedValues, noteFieldAlias,
} from '../lib/shape.js';

function handleError(err: unknown, context?: 'note' | 'relationship'): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) {
      if (context === 'relationship') return 'Error: Note or target entity not found. Check both IDs are correct. If the entity was just created, wait a few seconds and retry.';
      return 'Error: Note not found. Check the ID is correct.';
    }
    if (pbErr.status === 403) return 'Error: Permission denied. Your token may lack the required scope (notes:write).';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    if (pbErr.status === 400 || pbErr.status === 422) return `Error: Validation failed — ${pbErr.message}`;
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

const SCAN_BUDGET = Math.floor(CHARACTER_LIMIT * 0.7);

/** Note field ids → display names (same for textNote / conversationNote / opportunityNote). */
const NOTE_FIELDS: Record<string, string> = {
  name: 'Title', content: 'Content', owner: 'Owner', creator: 'Creator', processed: 'Processed', archived: 'Archived', tags: 'Tags',
};

const noteListMarkdown = (title: string) => (o: Json) => [
  `# ${title} (${o.count} results${o.has_more ? ', more available' : ''})`, '',
  ...o.data.map(noteRowMd),
  ...(o.truncated ? ['', `_${o.truncated}_`] : []),
  ...(o.next_cursor ? ['', `_Next page cursor: \`${o.next_cursor}\`_`] : []),
].join('\n');

/** One page (up to `limit` rows) of GET /v2/notes with the given query; cursor-safe and size-safe. */
async function listNotesPage(query: Query, limit: number, pageCursor: string | undefined, format: ResponseFormat, title: string) {
  const res = await scan({ sources: [getPager('/v2/notes', query, 'list notes')], start: pageCursor, limit, maxPages: Math.ceil(limit / 100) + 1, map: noteRow });
  return respondList({
    format, rows: res.rows.map((r) => r.row),
    cursorAt: (k) => encodeCursor(k < res.rows.length ? res.rows[k].pos : res.resume),
    build: (shown, next, note) => ({ data: shown, count: shown.length, has_more: !!next, next_cursor: next ?? undefined, ...(note ? { truncated: note } : {}) }),
    markdown: noteListMarkdown(title),
  });
}

export function registerNoteTools(server: McpServer): void {

  // ── pb_list_notes ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_notes',
    {
      title: 'List Productboard Notes',
      description: `List Productboard notes (customer feedback), newest first, with optional filters and cursor pagination.
Returns compact rows with a 200-character preview; use pb_get_note for the full content.
All filters are applied by Productboard (GET /v2/notes).

Args:
  - archived (boolean, optional): Filter by archived state
  - processed (boolean, optional): Filter by processed state
  - source_system (string, optional): Filter by metadata.source.system, e.g. "hubspot"
  - source_record_id (string, optional): Filter by metadata.source.recordId
  - owner_id / owner_email (string, optional): Filter by owner (email requires members:pii:read scope)
  - creator_id / creator_email (string, optional): Filter by creator
  - created_from / created_to / updated_from / updated_to (string, optional): ISO 8601 datetimes
  - limit (number): Max rows, 1–200 (default 50)
  - page_cursor (string, optional): next_cursor from a previous response
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: [{ id, type, title, preview, owner, creator, tags, processed, archived, createdAt, updatedAt, url }], count, has_more, next_cursor }

Examples:
  - "Show HubSpot deal notes" → source_system="hubspot"
  - "Unprocessed notes" → processed=false
  - "Feedback from Q1 2024" → created_from="2024-01-01T00:00:00Z", created_to="2024-03-31T23:59:59Z"

For text search, relative dates, or notes linked to a feature/customer use pb_search_notes or pb_list_entity_feedback.`,
      inputSchema: z.object({
        archived: z.boolean().optional().describe('Filter by archived state'),
        processed: z.boolean().optional().describe('Filter by processed state'),
        source_system: z.string().optional().describe('Filter by metadata.source.system'),
        source_record_id: z.string().optional().describe('Filter by metadata.source.recordId'),
        owner_id: z.string().uuid().optional().describe('Filter by owner member UUID'),
        owner_email: z.string().email().optional().describe('Filter by owner email (requires members:pii:read scope)'),
        creator_id: z.string().uuid().optional().describe('Filter by creator member UUID'),
        creator_email: z.string().email().optional().describe('Filter by creator email (requires members:pii:read scope)'),
        created_from: z.string().optional().describe('ISO 8601 datetime — notes created on or after, e.g. "2024-01-01T00:00:00Z"'),
        created_to: z.string().optional().describe('ISO 8601 datetime — notes created on or before, e.g. "2024-03-31T23:59:59Z"'),
        updated_from: z.string().optional().describe('ISO 8601 datetime — notes updated on or after'),
        updated_to: z.string().optional().describe('ISO 8601 datetime — notes updated on or before'),
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
    async (a) => {
      try {
        return await listNotesPage({
          archived: a.archived, processed: a.processed,
          'metadata[source][system]': a.source_system, 'metadata[source][recordId]': a.source_record_id,
          'owner[id]': a.owner_id, 'owner[email]': a.owner_email, 'creator[id]': a.creator_id, 'creator[email]': a.creator_email,
          createdFrom: a.created_from, createdTo: a.created_to, updatedFrom: a.updated_from, updatedTo: a.updated_to,
        }, a.limit, a.page_cursor, a.response_format, 'Notes');
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_list_entity_feedback ───────────────────────────────────────────────
  server.registerTool(
    'pb_list_entity_feedback',
    {
      title: 'List Feedback Linked to an Entity',
      description: `List the feedback notes linked to a feature (or other entity such as a subfeature, component,
product or initiative) — the customer evidence behind it. Uses GET /v2/notes?relationships[link][ids][]=<id>.

Args:
  - id (string): Feature / entity UUID
  - processed (boolean, optional), archived (boolean, optional): Extra filters
  - limit (number): Max rows, 1–200 (default 50)
  - page_cursor (string, optional): next_cursor from a previous response
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Compact note rows (use pb_get_note for full text): { data, count, has_more, next_cursor }`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Feature or entity UUID'),
        processed: z.boolean().optional().describe('Filter by processed state'),
        archived: z.boolean().optional().describe('Filter by archived state'),
        ...paginationSchema,
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, processed, archived, limit, page_cursor, response_format }) => {
      try {
        return await listNotesPage({ 'relationships[link][ids][]': [id], processed, archived }, limit, page_cursor, response_format, `Feedback linked to ${id}`);
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_get_note ───────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_note',
    {
      title: 'Get Productboard Note',
      description: `Get a single Productboard note by UUID: full content (HTML converted to markdown), fields, source,
and its relationships (customer user/company and linked features/entities, each with its name).

Args:
  - id (string): Note UUID
  - include_relationships (boolean): Also fetch the note's relationships (default true)
  - raw (boolean): Return the unmodified API response instead (default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { id, type, title, content, owner, creator, tags, processed, archived, createdAt, updatedAt, url, source, relationships }`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Note UUID'),
        include_relationships: z.boolean().default(true).describe('Fetch note relationships'),
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
    async ({ id, include_relationships, raw, response_format }) => {
      try {
        const [noteRes, rels] = await Promise.all([
          withRetry(() => pbFetch<{ data: PBNote & Json }>('GET', `/v2/notes/${id}`), `get note ${id}`),
          include_relationships
            ? fetchAll(getPager(`/v2/notes/${id}/relationships`, {}, `get note relationships ${id}`))
            : Promise.resolve([] as Json[]),
        ]);
        if (raw) return respondObject(response_format, { ...noteRes, relationships: rels }, (o) => '```json\n' + JSON.stringify(o, null, 1) + '\n```');
        const n = noteRes.data;
        const named = include_relationships ? await entityNameResolver()(rels.map(relRow)) : null;
        const { name, content, owner, creator, tags, processed, archived, ...rest } = (n.fields ?? {}) as Json;
        const out = {
          id: n.id, type: n.type, title: name,
          content: typeof content === 'string' ? htmlToMarkdown(content) : simple(content),
          owner: simple(owner) ?? undefined, creator: simple(creator) ?? undefined,
          tags: Array.isArray(tags) && tags.length ? simple(tags) : undefined,
          processed, archived, createdAt: n.createdAt, updatedAt: n.updatedAt, url: n.links?.html,
          source: n.metadata?.source,
          ...(Object.keys(rest).length ? { other_fields: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, simple(v)])) } : {}),
          ...(named ? { relationships: named.items, ...(named.names_truncated ? { names_truncated: named.names_truncated } : {}) } : {}),
        };
        return respondObject(response_format, out, (o) => {
          const lines = [
            `# Note: ${o.title ?? '(no title)'} \`${o.id}\``,
            `- **Type**: ${o.type}`,
            `- **Owner**: ${o.owner ?? 'unassigned'}${o.creator ? ` | **Creator**: ${o.creator}` : ''}`,
            `- **Processed**: ${o.processed ? 'yes' : 'no'}${o.archived ? ' | **Archived**' : ''}`,
            `- **Created**: ${o.createdAt ?? 'n/a'} | **Updated**: ${o.updatedAt ?? 'n/a'}`,
          ];
          if (o.tags?.length) lines.push(`- **Tags**: ${o.tags.join(', ')}`);
          if (o.source?.system) lines.push(`- **Source**: ${o.source.system} / ${o.source.recordId}${o.source.url ? ` (${o.source.url})` : ''}`);
          if (o.url) lines.push(`- **URL**: ${o.url}`);
          if (o.relationships?.length) {
            lines.push('', '**Relationships:**');
            for (const r of o.relationships) lines.push(`- ${r.type}: **${r.target_name ?? '?'}** \`${r.target_id}\` (${r.target_type})`);
          }
          lines.push('', '## Content', '', typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? ''));
          return lines.join('\n');
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_create_note ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_create_note',
    {
      title: 'Create Productboard Note',
      description: `Create a new Productboard customer feedback note.

Notes capture customer feedback and can be linked to companies (customers) and features.
Always use textNote type — opportunityNote cannot be created via the public API.

Args:
  - title (string): Note title (required)
  - content (string, optional): Note content/body as HTML (plain text is rejected; wrap in <p> tags,
    e.g. "<p>Customer requested dark mode.</p>")
  - owner_email (string, optional): Email of the PB workspace member who owns the note
  - creator_email (string, optional): Email of the PB workspace member to set as the note creator.
    Can only be set at creation time — cannot be changed after.
  - archived (boolean, optional): Create the note in an archived state (default false)
  - processed (boolean, optional): Create the note already marked as processed (default false)
  - tags (string[], optional): Tag names to apply (must already exist in workspace)
  - customer_type ('company' | 'user', optional): Link note to a customer
  - customer_id (string, optional): UUID of the company or user to link
  - source_system (string, optional): metadata.source.system for dedup/tracking
  - source_record_id (string, optional): metadata.source.recordId
  - source_url (string, optional): metadata.source.url

Returns:
  The created note UUID and confirmation.

Notes:
  - Tags must already exist in the workspace; unknown tags are rejected.
  - Use pb_list_field_values (field_id="tags") to discover available tag names.
  - Propagation delay: if customer_type/customer_id are provided and the customer entity
    was just created (within the last ~30 seconds), the API may return 404. If this happens,
    create the note without the customer fields, wait a few seconds, then use
    pb_set_note_customer to link it.`,
      inputSchema: z.object({
        title: z.string().min(1).describe('Note title'),
        content: z.string().optional().describe('Note content/body'),
        owner_email: z.string().email().optional().describe('Owner email (must be a workspace member)'),
        creator_email: z.string().email().optional().describe('Creator email (must be a workspace member; can only be set at creation time)'),
        archived: z.boolean().optional().describe('Create the note in an archived state'),
        processed: z.boolean().optional().describe('Create the note already marked as processed'),
        tags: z.array(z.string()).optional().describe('Tag names to apply'),
        customer_type: z.enum(['company', 'user']).optional().describe('Customer relationship type'),
        customer_id: z.string().uuid().optional().describe('Customer company or user UUID'),
        source_system: z.string().optional().describe('Metadata source system'),
        source_record_id: z.string().optional().describe('Metadata source record ID'),
        source_url: z.string().url().optional().describe('Metadata source URL'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, content, owner_email, creator_email, archived, processed, tags, customer_type, customer_id, source_system, source_record_id, source_url }) => {
      try {
        if ((customer_type && !customer_id) || (customer_id && !customer_type)) {
          return errorResult('Error: customer_type and customer_id must both be provided together');
        }

        const fields: Record<string, unknown> = { name: title };
        if (content) fields['content'] = content;
        if (owner_email) fields['owner'] = { email: owner_email };
        if (creator_email) fields['creator'] = { email: creator_email };
        if (archived !== undefined) fields['archived'] = archived;
        if (processed !== undefined) fields['processed'] = processed;
        if (tags?.length) fields['tags'] = tags.map((name) => ({ name }));

        const payload: Record<string, unknown> = {
          data: {
            type: 'textNote',
            fields,
            ...(source_system && source_record_id
              ? { metadata: { source: { system: source_system, recordId: source_record_id, ...(source_url ? { url: source_url } : {}) } } }
              : {}),
            ...(customer_type && customer_id
              ? { relationships: [{ type: 'customer', target: { type: customer_type, id: customer_id } }] }
              : {}),
          },
        };

        const r = await withRetry(
          () => pbFetch<{ data: PBNote }>('POST', '/v2/notes', payload),
          'create note'
        );

        const note = r.data;
        // Create response only returns {id, type, links} — fields is absent
        const text = `Created note \`${note.id}\`: **${note.fields?.name ?? title}**`;
        return { content: [{ type: 'text', text }], structuredContent: note as unknown as Record<string, unknown> };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_update_note ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_update_note',
    {
      title: 'Update Productboard Note',
      description: `Update fields on an existing Productboard note using PATCH.

Note: PATCH does NOT accept relationship changes — use pb_set_note_customer or
pb_link_note_entity for relationship management.

Args:
  - id (string): Note UUID
  - title (string, optional): New note title
  - content (string, optional): New note content
  - owner_email (string, optional): New owner email
  - tags (string[], optional): Replace tags (full replacement — include all desired tags)
  - archived (boolean, optional): Archive or unarchive the note
  - processed (boolean, optional): Mark the note as processed (reviewed/actioned)

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Note UUID'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New content'),
        owner_email: z.string().email().optional().describe('New owner email'),
        tags: z.array(z.string()).optional().describe('Replace tags (full list)'),
        archived: z.boolean().optional().describe('Archive or unarchive'),
        processed: z.boolean().optional().describe('Mark note as processed/reviewed'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, title, content, owner_email, tags, archived, processed }) => {
      try {
        if ([title, content, owner_email, tags, archived, processed].every((v) => v === undefined)) {
          return errorResult('Error: Provide at least one field to update');
        }

        const fields: Record<string, unknown> = {};
        if (title !== undefined) fields['name'] = title;
        if (content !== undefined) fields['content'] = content;
        if (owner_email !== undefined) fields['owner'] = { email: owner_email };
        if (tags !== undefined) fields['tags'] = tags.map((name) => ({ name }));
        if (archived !== undefined) fields['archived'] = archived;
        if (processed !== undefined) fields['processed'] = processed;

        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/notes/${id}`, { data: { fields } }),
          `update note ${id}`
        );

        return { content: [{ type: 'text', text: `Updated note \`${id}\` successfully.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_delete_note ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_delete_note',
    {
      title: 'Delete Productboard Note',
      description: `Permanently delete a Productboard note by UUID.

WARNING: This is irreversible. The note and all its relationships are deleted.
Consider archiving instead (use pb_update_note with archived=true).

Args:
  - id (string): Note UUID to delete

Returns:
  Confirmation message on success.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Note UUID to delete'),
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
          () => pbFetch<unknown>('DELETE', `/v2/notes/${id}`),
          `delete note ${id}`
        );
        return { content: [{ type: 'text', text: `Deleted note \`${id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_set_note_customer ──────────────────────────────────────────────────
  server.registerTool(
    'pb_set_note_customer',
    {
      title: 'Set Productboard Note Customer Relationship',
      description: `Set or replace the customer relationship on a Productboard note.

A note can be linked to one customer — either a Company (entity) or a User. This replaces
any existing customer relationship.

Uses POST /v2/notes/{id}/relationships (PBToolkit-verified pattern). If a customer
relationship already exists it is automatically replaced by the API.

Propagation delay: if the target company or user entity was just created (within the
last ~30 seconds), this call may return a 404. Wait a few seconds and retry — the
entity index catches up quickly.

Args:
  - note_id (string): Note UUID
  - customer_type ('company' | 'user'): Type of customer to link
  - customer_id (string): UUID of the company or user

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        note_id: z.string().uuid().describe('Note UUID'),
        customer_type: z.enum(['company', 'user']).describe('Customer entity type'),
        customer_id: z.string().uuid().describe('Customer UUID'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ note_id, customer_type, customer_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('POST', `/v2/notes/${note_id}/relationships`, {
            data: { type: 'customer', target: { type: customer_type, id: customer_id } },
          }),
          `set note customer ${note_id}`
        );
        return { content: [{ type: 'text', text: `Linked note \`${note_id}\` to ${customer_type} \`${customer_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err, 'relationship'));
      }
    }
  );


  // ── pb_search_notes ───────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_notes',
    {
      title: 'Search Productboard Notes',
      description: `Search Productboard notes (customer feedback).

Server-side (GET /v2/notes — POST /v2/notes/search is not used because it rejects its published
filter shape and silently ignores unknown filter keys): archived, processed, owner, source,
created/updated date bounds, linked entities and customers.
Client-side, on each fetched page: text, name, tags and operator conditions.

Args:
  - text (string, optional): Case-insensitive match in the title or content (HTML stripped)
  - name (string, optional): Case-insensitive match in the title only
  - created_in_last / updated_in_last (string, optional): Period such as "7 days", "2 weeks", "3 months"
  - created_from / created_to / updated_from / updated_to (string, optional): ISO 8601 bounds
  - linked_entity_ids (string[], optional): Notes linked to any of these features/entities (OR). Alias: link_ids
  - customer_ids (string[], optional): Notes whose customer is any of these users/companies (OR)
  - archived / processed (boolean, optional)
  - owner_email / owner_id (string, optional): Note owner
  - tags (string[], optional): Notes must have ALL of these tag names
  - source_system / source_record_id (string, optional): metadata.source filters
  - conditions (array, optional): [{ field, operator, value }] on note fields (title, content, owner,
    creator, processed, archived, tags, createdAt, updatedAt). Operators: ${OPERATORS.join(', ')}
  - limit (number): Stop after this many matches (default 50, max 200)
  - max_pages (number): Max API pages (100 notes each) to scan per call (default 10, max 40)
  - page_cursor (string, optional): resume_cursor from a previous call
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  { data: compact note rows, count, scanned, pages_scanned, complete, resume_cursor, filters_sent }
  If complete=false, pass resume_cursor as page_cursor to keep scanning (nothing is skipped or repeated).

Examples:
  - "Feedback mentioning pricing in the last month" → text="pricing", created_in_last="30 days"
  - "Notes for feature X" → linked_entity_ids=["<feature-uuid>"]  (or use pb_list_entity_feedback)
  - "Notes from company Y" → customer_ids=["<company-uuid>"]
  - "Unprocessed notes tagged churn" → processed=false, tags=["churn"]`,
      inputSchema: z.object({
        text: z.string().min(1).optional().describe('Match in title or content (case-insensitive)'),
        name: z.string().min(1).optional().describe('Match in title only (case-insensitive)'),
        created_in_last: z.string().optional().describe('Period, e.g. "7 days", "2 weeks", "3 months"'),
        updated_in_last: z.string().optional().describe('Period, e.g. "7 days"'),
        created_from: z.string().optional().describe('ISO 8601 — created on or after'),
        created_to: z.string().optional().describe('ISO 8601 — created on or before'),
        updated_from: z.string().optional().describe('ISO 8601 — updated on or after'),
        updated_to: z.string().optional().describe('ISO 8601 — updated on or before'),
        linked_entity_ids: jsonArrayArg(z.string().uuid()).optional().describe('Notes linked to any of these entity UUIDs (OR)'),
        link_ids: jsonArrayArg(z.string().uuid()).optional().describe('Alias of linked_entity_ids'),
        customer_ids: jsonArrayArg(z.string().uuid()).optional().describe('Notes whose customer is any of these user/company UUIDs (OR)'),
        archived: z.boolean().optional().describe('Filter by archived state'),
        processed: z.boolean().optional().describe('Filter by processed state'),
        owner_email: z.string().email().optional().describe('Filter by owner email (requires members:pii:read scope)'),
        owner_id: z.string().uuid().optional().describe('Filter by owner member UUID'),
        tags: jsonArrayArg(z.string()).optional().describe('Notes must have ALL of these tag names'),
        source_system: z.string().optional().describe('metadata.source.system filter'),
        source_record_id: z.string().optional().describe('metadata.source.recordId filter'),
        conditions: conditionsArg.optional(),
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
        const conds: Condition[] = (a.conditions ?? []).map(noteFieldAlias);
        checkConditions(conds);
        const known = new Set(['createdat', 'updatedat', ...Object.keys(NOTE_FIELDS), ...Object.values(NOTE_FIELDS).map((n) => n.toLowerCase())]);
        const unknown = conds.map((c) => c.field).filter((f) => !known.has(f.split('.')[0].toLowerCase()));
        if (unknown.length) {
          return errorResult(`Error: Unknown note field(s): ${unknown.join(', ')}. Note fields: title, content, owner, creator, processed, archived, tags, createdAt, updatedAt.`);
        }

        // "in the last N days" is fixed once per call, so a resumed scan uses a fresh window.
        const since = (p?: string) => (p ? new Date(Date.now() - periodMs(p)).toISOString() : undefined);
        const linked = [...new Set([...(a.linked_entity_ids ?? []), ...(a.link_ids ?? [])])];
        const query: Query = {
          archived: a.archived, processed: a.processed,
          'owner[email]': a.owner_email, 'owner[id]': a.owner_id,
          'metadata[source][system]': a.source_system, 'metadata[source][recordId]': a.source_record_id,
          createdFrom: since(a.created_in_last) ?? a.created_from, createdTo: a.created_to,
          updatedFrom: since(a.updated_in_last) ?? a.updated_from, updatedTo: a.updated_to,
          'relationships[link][ids][]': linked.length ? linked : undefined,
          'relationships[customer][ids][]': a.customer_ids?.length ? a.customer_ids : undefined,
        };

        const text = a.text?.toLowerCase();
        const name = a.name?.toLowerCase();
        const now = Date.now();
        const test = (n: Json): boolean => {
          const title = String(n.fields?.name ?? '');
          if (name && !title.toLowerCase().includes(name)) return false;
          if (text) {
            const c = n.fields?.content;
            const body = typeof c === 'string' ? stripHtml(c) : JSON.stringify(c ?? '');
            if (!`${title}\n${body}`.toLowerCase().includes(text)) return false;
          }
          if (a.tags?.length) {
            const have = new Set(((n.fields?.tags ?? []) as Json[]).map((t) => String(t?.name ?? '').toLowerCase()));
            if (!a.tags.every((t) => have.has(t.toLowerCase()))) return false;
          }
          return conds.every((c) => matches(fieldValue(n, c.field, NOTE_FIELDS), c.operator, c.value, now));
        };

        const res = await scan({
          sources: [getPager('/v2/notes', query, 'search notes')], start: a.page_cursor,
          limit: a.limit, maxPages: a.max_pages, budget: SCAN_BUDGET, test,
          map: (n: Json) => ({ ...noteRow(n), matched: matchedValues(n, conds, NOTE_FIELDS) }),
        });
        const filtersSent = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));

        return respondList({
          format: a.response_format, rows: res.rows.map((r) => r.row),
          cursorAt: (k) => encodeCursor(k < res.rows.length ? res.rows[k].pos : res.resume),
          build: (shown, next, note) => ({
            data: shown, count: shown.length, scanned: res.scanned, pages_scanned: res.pagesScanned,
            complete: !next, resume_cursor: next, filters_sent: filtersSent, ...(note ? { truncated: note } : {}),
          }),
          markdown: (o) => [
            `# Notes Search (${o.count} matches, ${o.scanned} scanned${o.complete ? ', complete' : ', more to scan'})`, '',
            ...o.data.map(noteRowMd),
            ...(o.truncated ? ['', `_${o.truncated}_`] : []),
            ...(o.resume_cursor ? ['', `_Scan not complete — continue with page_cursor: \`${o.resume_cursor}\`_`] : []),
          ].join('\n'),
        });
      } catch (err) {
        return errorResult(handleError(err));
      }
    }
  );

  // ── pb_link_note_entity ───────────────────────────────────────────────────
  server.registerTool(
    'pb_link_note_entity',
    {
      title: 'Link Productboard Note to Hierarchy Entity',
      description: `Link a Productboard note to a hierarchy entity (feature, component, product, etc.)
using POST /v2/notes/{id}/relationships.

This is distinct from pb_set_note_customer, which links to a company/user.
Use this to associate feedback with a specific product hierarchy item.

A note can be linked to multiple entities. Each call adds one link.

Args:
  - note_id (string): UUID of the note to link
  - entity_id (string): UUID of the hierarchy entity (feature, component, product, etc.)

Returns:
  Confirmation message on success.

Example:
  - "Link note abc-123 to feature def-456" → note_id="abc-123", entity_id="def-456"`,
      inputSchema: z.object({
        note_id: z.string().uuid().describe('Note UUID'),
        entity_id: z.string().uuid().describe('Hierarchy entity UUID to link to'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ note_id, entity_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('POST', `/v2/notes/${note_id}/relationships`, {
            data: { type: 'link', target: { id: entity_id, type: 'link' } },
          }),
          `link note ${note_id} to entity ${entity_id}`
        );
        return { content: [{ type: 'text', text: `Linked note \`${note_id}\` to entity \`${entity_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err, 'relationship'));
      }
    }
  );

  // ── pb_delete_note_relationship ───────────────────────────────────────────
  server.registerTool(
    'pb_delete_note_relationship',
    {
      title: 'Delete Productboard Note Relationship',
      description: `Remove a specific relationship from a Productboard note.

Use this to unlink a note from an entity or remove a customer association.

Args:
  - note_id (string): Note UUID
  - target_type ('customer' | 'link'): 'customer' to unlink a company/user, 'link' to unlink a hierarchy entity.
    NOTE: The API uses 'customer' (not 'company'/'user') for customer relationship deletions.
  - target_id (string): UUID of the target entity/customer to unlink

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        note_id: z.string().uuid().describe('Note UUID'),
        // Live API accepts only "customer" or "link" as the path segment — NOT "company"/"user"
        target_type: z.enum(['customer', 'link']).describe('"customer" to unlink a company/user, "link" to unlink a hierarchy entity'),
        target_id: z.string().uuid().describe('Target UUID to unlink'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ note_id, target_type, target_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('DELETE', `/v2/notes/${note_id}/relationships/${target_type}/${target_id}`),
          `delete note relationship ${note_id}`
        );
        return { content: [{ type: 'text', text: `Removed ${target_type} relationship \`${target_id}\` from note \`${note_id}\`.` }] };
      } catch (err) {
        return errorResult(handleError(err, 'relationship'));
      }
    }
  );
}
