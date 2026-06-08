import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry, fetchPage } from '../services/pbClient.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { paginationSchema, responseFormatSchema, ResponseFormat } from '../schemas/common.js';
import type { PBNote, PBNoteRelationship } from '../types.js';

function extractCursor(nextUrl: string | null): string | null {
  if (!nextUrl) return null;
  const m = nextUrl.match(/pageCursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function handleError(err: unknown, context?: 'note' | 'relationship'): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) {
      if (context === 'relationship') return 'Error: Note or target entity not found. Check both IDs are correct. If the entity was just created, wait a few seconds and retry.';
      return 'Error: Note not found. Check the ID is correct.';
    }
    if (pbErr.status === 403) return 'Error: Permission denied. Your token may lack the required scope (notes:write).';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    if (pbErr.status === 422) return `Error: Validation failed — ${pbErr.message}`;
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

function noteToMarkdown(n: PBNote): string {
  const lines = [
    `### ${n.fields.name ?? '(no title)'} \`${n.id}\``,
    `- **Owner**: ${n.fields.owner?.email ?? 'unassigned'}`,
  ];
  if (n.fields.tags?.length) {
    lines.push(`- **Tags**: ${n.fields.tags.map((t) => t.name).join(', ')}`);
  }
  if (n.fields.content) {
    const preview = n.fields.content.slice(0, 300);
    lines.push(`- **Content**: ${preview}${n.fields.content.length > 300 ? '…' : ''}`);
  }
  if (n.metadata?.source?.system) {
    lines.push(`- **Source**: ${n.metadata.source.system} / ${n.metadata.source.recordId}`);
  }
  return lines.join('\n');
}

export function registerNoteTools(server: McpServer): void {

  // ── pb_list_notes ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_notes',
    {
      title: 'List Productboard Notes',
      description: `List Productboard notes (customer feedback) with optional filters and cursor pagination.

Args:
  - archived (boolean, optional): Include archived notes (default false)
  - processed (boolean, optional): Filter by processed state
  - source_system (string, optional): Filter by metadata.source.system, e.g. "hubspot"
  - source_record_id (string, optional): Filter by metadata.source.recordId
  - owner_id (string, optional): Filter by owner member UUID
  - owner_email (string, optional): Filter by owner email (requires members:pii:read scope)
  - creator_id (string, optional): Filter by creator member UUID
  - creator_email (string, optional): Filter by creator email (requires members:pii:read scope)
  - created_from (string, optional): ISO 8601 datetime — notes created on or after, e.g. "2024-01-01T00:00:00Z"
  - created_to (string, optional): ISO 8601 datetime — notes created on or before, e.g. "2024-03-31T23:59:59Z"
  - updated_from (string, optional): ISO 8601 datetime — notes updated on or after
  - updated_to (string, optional): ISO 8601 datetime — notes updated on or before
  - limit (number): Max results per page, 1–200 (default 50)
  - page_cursor (string, optional): Cursor from a previous response's next_cursor field
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  List of notes with title, owner, tags, content preview, and metadata.
  JSON: { data: PBNote[], count, has_more, next_cursor }

Examples:
  - "Show HubSpot deal notes" → source_system="hubspot"
  - "Unprocessed notes" → processed=false
  - "Show feedback from Q1 2024" → created_from="2024-01-01T00:00:00Z", created_to="2024-03-31T23:59:59Z"`,
      inputSchema: z.object({
        archived: z.boolean().optional().describe('Include archived notes'),
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
    async ({ archived, processed, source_system, source_record_id, owner_id, owner_email, creator_id, creator_email, created_from, created_to, updated_from, updated_to, limit, page_cursor, response_format }) => {
      try {
        const params: string[] = [];
        if (archived !== undefined) params.push(`archived=${archived}`);
        if (processed !== undefined) params.push(`processed=${processed}`);
        if (source_system) params.push(`metadata[source][system]=${encodeURIComponent(source_system)}`);
        if (source_record_id) params.push(`metadata[source][recordId]=${encodeURIComponent(source_record_id)}`);
        if (owner_id) params.push(`owner[id]=${encodeURIComponent(owner_id)}`);
        if (owner_email) params.push(`owner[email]=${encodeURIComponent(owner_email)}`);
        if (creator_id) params.push(`creator[id]=${encodeURIComponent(creator_id)}`);
        if (creator_email) params.push(`creator[email]=${encodeURIComponent(creator_email)}`);
        if (created_from) params.push(`createdFrom=${encodeURIComponent(created_from)}`);
        if (created_to) params.push(`createdTo=${encodeURIComponent(created_to)}`);
        if (updated_from) params.push(`updatedFrom=${encodeURIComponent(updated_from)}`);
        if (updated_to) params.push(`updatedTo=${encodeURIComponent(updated_to)}`);

        if (page_cursor) params.unshift(`pageCursor=${encodeURIComponent(page_cursor)}`);
        const path = `/v2/notes${params.length ? `?${params.join('&')}` : ''}`;

        const { data: rawData, nextUrl } = await fetchPage<PBNote>(path, 'list notes');
        const data = rawData.slice(0, limit);
        const nextCursor = extractCursor(nextUrl);
        const output = { data, count: data.length, has_more: !!nextCursor, next_cursor: nextCursor ?? undefined };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Notes (${data.length} results${nextCursor ? ', more available' : ''})`, ''];
          for (const n of data) lines.push(noteToMarkdown(n), '');
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

  // ── pb_get_note ───────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_note',
    {
      title: 'Get Productboard Note',
      description: `Get a single Productboard note by UUID, including its relationships (linked features/products/customers).

Args:
  - id (string): Note UUID
  - include_relationships (boolean): Also fetch the note's relationships (default true)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  The note fields, metadata, and (if include_relationships=true) any linked entities/customers.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Note UUID'),
        include_relationships: z.boolean().default(true).describe('Fetch note relationships'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, include_relationships, response_format }) => {
      try {
        const [noteRes, relsData] = await Promise.all([
          withRetry(() => pbFetch<{ data: PBNote }>('GET', `/v2/notes/${id}`), `get note ${id}`),
          include_relationships
            ? withRetry(
                () => pbFetch<{ data: PBNoteRelationship[] }>('GET', `/v2/notes/${id}/relationships`),
                `get note relationships ${id}`
              ).then((r) => r.data ?? [])
            : Promise.resolve([]),
        ]);

        const note = noteRes.data;
        const output = { ...note, relationships: relsData };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# Note: ${note.fields.name ?? id}`,
            '',
            noteToMarkdown(note),
          ];
          if (relsData.length > 0) {
            lines.push('', '**Relationships:**');
            for (const r of relsData) {
              lines.push(`- ${r.type}: \`${r.target.id}\` (${r.target.type})`);
            }
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
      }).strict().refine(
        (d) => !(d.customer_type && !d.customer_id) && !(d.customer_id && !d.customer_type),
        { message: 'customer_type and customer_id must both be provided together' }
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, content, owner_email, creator_email, archived, processed, tags, customer_type, customer_id, source_system, source_record_id, source_url }) => {
      try {
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
        return { content: [{ type: 'text', text: handleError(err) }] };
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
      }).strict().refine(
        (d) => [d.title, d.content, d.owner_email, d.tags, d.archived, d.processed].some((v) => v !== undefined),
        { message: 'Provide at least one field to update' }
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, title, content, owner_email, tags, archived, processed }) => {
      try {
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
        return { content: [{ type: 'text', text: handleError(err) }] };
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
        return { content: [{ type: 'text', text: handleError(err) }] };
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
        return { content: [{ type: 'text', text: handleError(err, 'relationship') }] };
      }
    }
  );

  // ── pb_search_notes ───────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_notes',
    {
      title: 'Search Productboard Notes',
      description: `Search Productboard notes with hybrid GET + POST routing for correct filtering.

Routing (live-verified — POST search silently ignores most filter fields):
  - No relationship filters → GET /v2/notes (archived, processed, owner, source all server-side)
  - With relationship filters (customer_ids / link_ids) → POST /v2/notes/search
    (server-side: relationships + source; client-side pass: archived, owner, processed)
  - tags and name are always applied client-side regardless of path

Filter logic:
  - customer_ids / link_ids: OR within each, AND between types
  - tags: ALL must be present (AND logic)

Args:
  - name (string, optional): Client-side partial title match
  - archived (boolean, optional): Filter by archived status
  - processed (boolean, optional): Filter by processed state
  - owner_email (string, optional): Filter by owner email (requires members:pii:read scope)
  - tags (string[], optional): Notes must have ALL of these tag names (client-side)
  - customer_ids (string[], optional): Linked customer/company UUIDs (OR logic)
  - link_ids (string[], optional): Linked hierarchy entity UUIDs e.g. feature IDs (OR logic)
  - source_system (string, optional): Filter by metadata.source.system
  - source_record_id (string, optional): Filter by metadata.source.recordId
  - limit (number): Max results per page, 1–200 (default 50)
  - page_cursor (string, optional): Cursor from a previous response's next_cursor field
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  JSON: { data: PBNote[], count, has_more, next_cursor, _route }

Examples:
  - "Find notes mentioning pricing" → name="pricing"
  - "Salesforce notes" → source_system="salesforce"
  - "Notes linked to company X" → customer_ids=["<uuid>"]
  - "Unprocessed notes for feature Y" → link_ids=["<uuid>"], processed=false
  - "Notes tagged 'churn'" → tags=["churn"]`,
      inputSchema: z.object({
        name: z.string().optional().describe('Client-side partial title match'),
        archived: z.boolean().optional().describe('Filter by archived status'),
        processed: z.boolean().optional().describe('Filter by processed state'),
        owner_email: z.string().email().optional().describe('Filter by owner email (requires members:pii:read scope)'),
        tags: z.array(z.string()).optional().describe('Notes must have ALL of these tag names (client-side)'),
        customer_ids: z.array(z.string().uuid()).optional().describe('Linked customer/company UUIDs (OR logic)'),
        link_ids: z.array(z.string().uuid()).optional().describe('Linked hierarchy entity UUIDs e.g. feature IDs (OR logic)'),
        source_system: z.string().optional().describe('metadata.source.system filter'),
        source_record_id: z.string().optional().describe('metadata.source.recordId filter'),
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
    async ({ name, archived, processed, owner_email, tags, customer_ids, link_ids, source_system, source_record_id, limit, page_cursor, response_format }) => {
      try {
        const hasRelFilter = !!(customer_ids?.length || link_ids?.length);
        let allData: PBNote[] = [];
        let nextCursor: string | null = null;
        let route: 'GET' | 'POST';

        if (hasRelFilter) {
          // POST path: server-side for relationships + source metadata.
          // archived / owner_email / processed are silently ignored by POST — apply client-side after.
          route = 'POST';
          const filter: Record<string, unknown> = {};
          if (source_system || source_record_id) {
            filter['metadata'] = { source: {
              ...(source_system ? { system: source_system } : {}),
              ...(source_record_id ? { recordId: source_record_id } : {}),
            }};
          }
          // PB notes/search expects relationships as arrays of {id} objects, not {ids:[]}
          // Confirmed from PBToolkit/src/routes/companiesDuplicateCleanup.js (source of truth).
          const relationships: Record<string, unknown> = {};
          if (customer_ids?.length) relationships['customer'] = customer_ids.map((id) => ({ id }));
          if (link_ids?.length) relationships['link'] = link_ids.map((id) => ({ id }));
          filter['relationships'] = relationships;

          const url = page_cursor
            ? `/v2/notes/search?pageCursor=${encodeURIComponent(page_cursor)}`
            : '/v2/notes/search';

          const raw = await withRetry(
            () => pbFetch<{ data: PBNote[]; links?: { next?: string } }>('POST', url, { data: { filter } }),
            'search notes (POST)'
          );
          allData = raw.data ?? [];
          nextCursor = extractCursor(raw.links?.next ?? null);

          // Client-side pass for what POST search silently ignores (live-verified May 2026)
          if (archived !== undefined) allData = allData.filter((n) => !!n.fields.archived === archived);
          if (owner_email) allData = allData.filter((n) => n.fields.owner?.email === owner_email);
          if (processed !== undefined) {
            allData = allData.filter((n) => !!(n.fields as Record<string, unknown>)['processed'] === processed);
          }
        } else {
          // GET path: archived, processed, owner, source all handled server-side
          route = 'GET';
          const params: string[] = [];
          if (archived !== undefined) params.push(`archived=${archived}`);
          if (processed !== undefined) params.push(`processed=${processed}`);
          if (owner_email) params.push(`owner[email]=${encodeURIComponent(owner_email)}`);
          if (source_system) params.push(`metadata[source][system]=${encodeURIComponent(source_system)}`);
          if (source_record_id) params.push(`metadata[source][recordId]=${encodeURIComponent(source_record_id)}`);
          if (page_cursor) params.unshift(`pageCursor=${encodeURIComponent(page_cursor)}`);
          const path = `/v2/notes${params.length ? `?${params.join('&')}` : ''}`;

          const { data: rawData, nextUrl } = await fetchPage<PBNote>(path, 'search notes (GET)');
          allData = rawData;
          nextCursor = extractCursor(nextUrl);
        }

        // Client-side filters that neither endpoint handles natively
        if (tags?.length) {
          allData = allData.filter((n) =>
            tags.every((t) => (n.fields.tags ?? []).some((nt) => nt.name === t))
          );
        }
        if (name) {
          const lc = name.toLowerCase();
          allData = allData.filter((n) => (n.fields.name ?? '').toLowerCase().includes(lc));
        }

        const data = allData.slice(0, limit);
        const output = { data, count: data.length, has_more: !!nextCursor, next_cursor: nextCursor ?? undefined, _route: route };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Notes Search (${data.length} results${nextCursor ? ', more available' : ''})`, ''];
          for (const n of data) lines.push(noteToMarkdown(n), '');
          if (nextCursor) lines.push(`---\n_Next page cursor: \`${nextCursor}\`_`);
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + '\n\n... [truncated]';

        return { content: [{ type: 'text', text }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
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
        return { content: [{ type: 'text', text: handleError(err, 'relationship') }] };
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
        return { content: [{ type: 'text', text: handleError(err, 'relationship') }] };
      }
    }
  );
}
