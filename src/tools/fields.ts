import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry, fetchAllPages } from '../services/pbClient.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { responseFormatSchema, ResponseFormat } from '../schemas/common.js';
import type { PBFieldValueDefinition } from '../types.js';

function handleError(err: unknown): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) return 'Error: Field not found. Check the field ID is correct.';
    if (pbErr.status === 403) return 'Error: Permission denied.';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    if (pbErr.status === 500) return 'Error: Productboard returned a 500 — this endpoint may not be available for this field type (known issue for the "tags" field).';
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

export function registerFieldTools(server: McpServer): void {

  // ── pb_list_field_values ──────────────────────────────────────────────────
  server.registerTool(
    'pb_list_field_values',
    {
      title: 'List Productboard Field Values',
      description: `List the allowed values for a select/multiselect field in Productboard.

Use this to discover what status values, tag names, or custom select options exist
before creating or updating entities.

The special field ID "tags" returns all workspace tags.

Args:
  - field_id (string): The field UUID (from pb_get_entity_configurations) or "tags" for workspace tags
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  All values for the field with id, name, and color.
  JSON: { data: [{ id, name, color }], count }

Common uses:
  - List status options: field_id="<status-field-uuid>"
  - List all tags: field_id="tags"

Known limitation: POST /v2/entities/fields/tags/values returns HTTP 500 (PB bug,
live-tested 2026-05-03) — tags can only be listed, not created via API.`,
      inputSchema: z.object({
        field_id: z.string().min(1).describe('Field UUID or "tags" for workspace tags'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ field_id, response_format }) => {
      try {
        const data = await fetchAllPages<PBFieldValueDefinition>(
          `/v2/entities/fields/${field_id}/values`,
          `list field values ${field_id}`
        );

        const output = {
          data: data.map((v) => ({ id: v.id, name: v.fields.name, color: v.fields.color ?? null })),
          count: data.length,
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Field Values: \`${field_id}\` (${data.length})`, ''];
          for (const v of data) {
            lines.push(`- **${v.fields.name}** \`${v.id}\`${v.fields.color ? ` — ${v.fields.color}` : ''}`);
          }
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

  // ── pb_create_field_value ─────────────────────────────────────────────────
  server.registerTool(
    'pb_create_field_value',
    {
      title: 'Create Productboard Field Value',
      description: `Create a new allowed value for a custom select or multiselect field.

Note: This does NOT work for the built-in "tags" field (PB returns HTTP 500 — known
API limitation as of 2026-05-03). Only use for custom select/multiselect fields.

To prevent duplicates, first check existing values with pb_list_field_values.

Args:
  - field_id (string): Custom field UUID from pb_get_entity_configurations
  - name (string): Display name for the new value
  - color (string, optional): Color for the value — one of: red, blue, green, yellow, purple, gray, lime, pink

Returns:
  The created value with its assigned UUID.`,
      inputSchema: z.object({
        field_id: z.string().min(1).describe('Custom field UUID'),
        name: z.string().min(1).describe('Value display name'),
        color: z.enum(['red', 'blue', 'green', 'yellow', 'purple', 'gray', 'lime', 'pink']).optional().describe('Value color'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ field_id, name, color }) => {
      try {
        const r = await withRetry(
          () => pbFetch<{ data: { id: string; fields: { name: string } } }>(
            'POST',
            `/v2/entities/fields/${field_id}/values`,
            { data: { fields: { name, ...(color ? { color } : {}) } } }
          ),
          `create field value ${field_id}`
        );

        const val = r.data;
        // Create response only returns {id, links} — fields is absent
        const text = `Created field value **${val.fields?.name ?? name}** \`${val.id}\` on field \`${field_id}\`.`;
        return { content: [{ type: 'text', text }], structuredContent: val as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_update_field_value ─────────────────────────────────────────────────
  server.registerTool(
    'pb_update_field_value',
    {
      title: 'Update Productboard Field Value',
      description: `Update the name or color of an existing value on a custom select/multiselect/tag field.

Only provided fields are updated; omitted fields remain unchanged.
STATUS field values cannot be updated here — they are managed through the status lifecycle.

Args:
  - field_id (string): Field UUID from pb_get_entity_configurations
  - value_id (string): The field value UUID to update (from pb_list_field_values)
  - name (string, optional): New display name for the value
  - color (string, optional): New color for the value

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        field_id: z.string().min(1).describe('Field UUID'),
        value_id: z.string().uuid().describe('Field value UUID to update'),
        name: z.string().optional().describe('New display name'),
        color: z.enum(['red', 'blue', 'green', 'yellow', 'purple', 'gray', 'lime', 'pink']).optional().describe('New color'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ field_id, value_id, name, color }) => {
      try {
        if (name === undefined && color === undefined) {
          return { content: [{ type: 'text', text: 'Error: Provide at least one of name or color to update' }] };
        }

        const fields: Record<string, unknown> = {};
        if (name !== undefined) fields['name'] = name;
        if (color !== undefined) fields['color'] = color;
        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/entities/fields/${field_id}/values/${value_id}`, { data: { fields } }),
          `update field value ${value_id}`
        );
        return { content: [{ type: 'text', text: `Updated field value \`${value_id}\` on field \`${field_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_delete_field_value ─────────────────────────────────────────────────
  server.registerTool(
    'pb_delete_field_value',
    {
      title: 'Delete Productboard Field Value',
      description: `Delete an allowed value from a custom select/multiselect/tag field.

STATUS field values cannot be deleted here.

By default the API rejects deletion if the value is currently assigned to any entities.
Use one of the two resolution options:
  - force=true: delete and unset the value from all assigned entities
  - replace_with_id: reassign all assignments to another value before deleting

Providing both force and replace_with_id is an error.

Args:
  - field_id (string): Field UUID
  - value_id (string): Field value UUID to delete
  - force (boolean, optional): Force-delete even if assigned to entities (unsets those assignments)
  - replace_with_id (string, optional): UUID of another value to reassign existing assignments to

Returns:
  Confirmation message on success (204 No Content).`,
      inputSchema: z.object({
        field_id: z.string().min(1).describe('Field UUID'),
        value_id: z.string().uuid().describe('Field value UUID to delete'),
        force: z.boolean().optional().describe('Force-delete even if assigned to entities'),
        replace_with_id: z.string().uuid().optional().describe('Reassign current assignments to this value UUID before deleting'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ field_id, value_id, force, replace_with_id }) => {
      try {
        if (force && replace_with_id) {
          return { content: [{ type: 'text', text: 'Error: Cannot provide both force and replace_with_id' }] };
        }

        // Live API: DELETE body is rejected (400). force and replaceWith are query params.
        const params: string[] = [];
        if (force) params.push('force=true');
        if (replace_with_id) params.push(`replaceWith=${encodeURIComponent(replace_with_id)}`);
        const path = `/v2/entities/fields/${field_id}/values/${value_id}${params.length ? `?${params.join('&')}` : ''}`;
        await withRetry(
          () => pbFetch<unknown>('DELETE', path),
          `delete field value ${value_id}`
        );
        return { content: [{ type: 'text', text: `Deleted field value \`${value_id}\` from field \`${field_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );
}
