import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pbFetch, withRetry, fetchAllPages, fetchPage } from '../services/pbClient.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { paginationSchema, responseFormatSchema, ResponseFormat } from '../schemas/common.js';
import type { PBMember, PBTeam, PBMemberActivityRecord } from '../types.js';

function handleError(err: unknown): string {
  if (err instanceof Error) {
    const pbErr = err as Error & { status?: number };
    if (pbErr.status === 404) return 'Error: Resource not found.';
    if (pbErr.status === 403) return 'Error: Permission denied. Your token may lack the required scope.';
    if (pbErr.status === 429) return 'Error: Rate limit exceeded. Please wait before retrying.';
    return `Error: ${pbErr.message}`;
  }
  return `Error: ${String(err)}`;
}

export function registerMemberTools(server: McpServer): void {

  // ── pb_list_members ───────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_members',
    {
      title: 'List Productboard Workspace Members',
      description: `List all members (users) in the Productboard workspace.

Returns workspace members with their email, name, role, and status. Useful for:
- Resolving "who is the owner of X?" questions
- Verifying an email is a valid PB workspace member before assigning ownership
- Finding member IDs for feature/note assignments

Args:
  - query (string, optional): Full-text search on name or email (1–255 chars, requires members:pii:read scope)
  - roles (string[], optional): Filter by role(s) — admin, maker, viewer, contributor
  - include_disabled (boolean): Include disabled accounts (default false)
  - include_invited (boolean): Include invited (pending) accounts (default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  All workspace members. JSON: { data: PBMember[], count }

Note: Requires members.read scope. Emails appear as "[redacted]" if the token
lacks members:pii:read scope.`,
      inputSchema: z.object({
        query: z.string().min(1).max(255).optional().describe('Full-text search on name or email (requires members:pii:read scope)'),
        roles: z.array(z.enum(['admin', 'maker', 'viewer', 'contributor'])).optional().describe('Filter by role(s)'),
        include_disabled: z.boolean().default(false).describe('Include disabled accounts'),
        include_invited: z.boolean().default(false).describe('Include pending invited accounts'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, roles, include_disabled, include_invited, response_format }) => {
      try {
        const params: string[] = [`includeDisabled=${include_disabled}`, `includeInvited=${include_invited}`];
        if (query) params.push(`query=${encodeURIComponent(query)}`);
        if (roles?.length) roles.forEach((r) => params.push(`roles[]=${r}`));
        const path = `/v2/members?${params.join('&')}`;
        const data = await fetchAllPages<PBMember>(path, 'list members');

        const output = { data, count: data.length };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Workspace Members (${data.length})`, ''];
          for (const m of data) {
            const f = m.fields ?? {};
            const status = f.disabled ? ' (disabled)' : f.invitationPending ? ' (invited)' : '';
            lines.push(`- **${f.name ?? m.id}** \`${m.id}\` — ${f.email ?? '[redacted]'} — ${f.role ?? 'N/A'}${status}`);
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

  // ── pb_list_teams ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_list_teams',
    {
      title: 'List Productboard Teams',
      description: `List all teams in the Productboard workspace, optionally including each team's members.

Args:
  - include_members (boolean): Also fetch members for each team (makes additional API calls, default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  All teams. If include_members=true, each team includes a members array.
  JSON: { data: Array<{ id, fields, members? }>, count }`,
      inputSchema: z.object({
        include_members: z.boolean().default(false).describe('Fetch members for each team'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ include_members, response_format }) => {
      try {
        const teams = await fetchAllPages<PBTeam>('/v2/teams', 'list teams');

        type TeamWithMembers = PBTeam & { members?: PBMember[] };
        const data: TeamWithMembers[] = [...teams];

        if (include_members) {
          await Promise.all(
            data.map(async (team) => {
              try {
                const members = await fetchAllPages<PBMember>(
                  `/v2/teams/${team.id}/members`,
                  `list team members ${team.id}`
                );
                team.members = members;
              } catch {
                team.members = [];
              }
            })
          );
        }

        const output = { data, count: data.length };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Teams (${data.length})`, ''];
          for (const t of data) {
            lines.push(`## ${t.fields?.name ?? t.id} \`${t.id}\``);
            if (t.fields?.description) lines.push(`> ${t.fields.description}`);
            if (t.members) {
              lines.push('', `**Members (${t.members.length}):**`);
              for (const m of t.members) {
                lines.push(`- ${m.fields?.name ?? m.id} — ${m.fields?.email ?? '[redacted]'}`);
              }
            }
            lines.push('');
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

  // ── pb_search_members ─────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_members',
    {
      title: 'Search Productboard Members',
      description: `Search workspace members using POST /v2/members/search with rich filter support.

Filter logic: values within a filter use OR logic; different filters use AND logic.

Args:
  - ids (string[], optional): Filter by member UUIDs (OR logic, max 100)
  - emails (string[], optional): Filter by email addresses (OR logic, max 100, requires members:pii:read scope)
  - roles (string[], optional): Filter by role(s) — admin, maker, viewer, contributor (OR logic)
  - disabled_only (boolean, optional): Return only disabled members
  - pending_only (boolean, optional): Return only invitation-pending members
  - search_query (string, optional): Full-text search on name or email (1–255 chars)
  - include_disabled (boolean): Also include disabled members alongside active ones (default true)
  - include_pending (boolean): Also include invitation-pending members (default false)
  - limit (number): Max results per page, 1–200 (default 200)
  - page_cursor (string, optional): Cursor from a previous response's next_cursor field
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Members with name, email, role, and status flags.
  JSON: { data: PBMember[], count, has_more, next_cursor }`,
      inputSchema: z.object({
        ids: z.array(z.string().uuid()).max(100).optional().describe('Filter by member UUIDs (OR logic, max 100)'),
        emails: z.array(z.string().email()).max(100).optional().describe('Filter by emails (OR logic, max 100, requires members:pii:read)'),
        roles: z.array(z.enum(['admin', 'maker', 'viewer', 'contributor'])).optional().describe('Filter by roles (OR logic)'),
        disabled_only: z.boolean().optional().describe('Return only disabled members'),
        pending_only: z.boolean().optional().describe('Return only invitation-pending members'),
        search_query: z.string().min(1).max(255).optional().describe('Full-text search on name or email'),
        include_disabled: z.boolean().default(true).describe('Include disabled members alongside active ones'),
        include_pending: z.boolean().default(false).describe('Include invitation-pending members alongside accepted ones'),
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
    async ({ ids, emails, roles, disabled_only, pending_only, search_query, include_disabled, include_pending, limit, page_cursor, response_format }) => {
      try {
        const filter: Record<string, unknown> = {};
        if (ids?.length) filter['id'] = ids;
        if (emails?.length || roles?.length || disabled_only !== undefined || pending_only !== undefined) {
          const fields: Record<string, unknown> = {};
          if (emails?.length) fields['email'] = emails;
          if (roles?.length) fields['role'] = roles;
          if (disabled_only !== undefined) fields['disabled'] = disabled_only;
          if (pending_only !== undefined) fields['invitationPending'] = pending_only;
          filter['fields'] = fields;
        }

        const body: Record<string, unknown> = {
          data: {
            filter,
            ...(search_query ? { search: { query: search_query } } : {}),
            return: { includeDisabled: include_disabled !== false, includeInvitationPending: include_pending === true },
          },
        };

        const url = page_cursor
          ? `/v2/members/search?pageCursor=${encodeURIComponent(page_cursor)}`
          : '/v2/members/search';

        const raw = await withRetry(
          () => pbFetch<{ data: PBMember[]; links?: { next?: string } }>(
            page_cursor ? 'GET' : 'POST', url, page_cursor ? undefined : body
          ),
          'search members'
        );

        const data = (raw.data ?? []).slice(0, limit);
        const nextMatch = raw.links?.next?.match(/pageCursor=([^&]+)/);
        const nextCursor = nextMatch ? decodeURIComponent(nextMatch[1]) : null;
        const output = { data, count: data.length, has_more: !!nextCursor, next_cursor: nextCursor ?? undefined };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Members (${data.length}${nextCursor ? ', more available' : ''})`, ''];
          for (const m of data) {
            const f = m.fields ?? {};
            const status = f.disabled ? ' *(disabled)*' : f.invitationPending ? ' *(invited)*' : '';
            lines.push(`- **${f.name ?? m.id}** \`${m.id}\` — ${f.email ?? '[redacted]'} — ${f.role ?? 'N/A'}${status}`);
          }
          if (nextCursor) lines.push(`\n---\n_Next page cursor: \`${nextCursor}\`_`);
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

  // ── pb_get_member_activity ────────────────────────────────────────────────
  server.registerTool(
    'pb_get_member_activity',
    {
      title: 'Get Productboard Member Activity',
      description: `Fetch member activity analytics from GET /v2/analytics/member-activities.

Returns per-member activity counts (features created, notes created, boards opened/created, etc.)
for a given date range. Optionally enriches results with member name/email/role by joining
against the members list.

Modes:
  - summary (default): one row per member, aggregated across the date range. Includes
    active_days_count, total_view_events, total_edit_events, and individual event counts.
  - raw: one row per member per day — useful for time-series analysis. May return large
    datasets for wide date ranges; use page_cursor to paginate.

Args:
  - date_from (string): Start date, ISO 8601, e.g. "2026-01-01"
  - date_to (string): End date, ISO 8601, e.g. "2026-01-31"
  - mode ('summary' | 'raw'): Aggregation mode (default 'summary')
  - workspace_members_only (boolean): Only include current workspace members — filters out
    portal voters, external users, and deleted accounts whose IDs appear in analytics but not
    in the members API (default true). Set false to see all activity including portal users.
  - include_disabled (boolean): Include disabled workspace members (default false).
    Only applies when workspace_members_only=true or enrich_profiles=true.
  - enrich_profiles (boolean): Join member name/email/role from /v2/members/search (default true)
  - role_filter (string[], optional): Only include members with these roles
    (e.g. ["admin","maker"]). Note: analytics uses role names "admin", "editor", "contributor"
    — "editor" corresponds to "maker" in the Members UI.
  - active_filter ('all' | 'active' | 'inactive'): Filter by activity state (default 'all')
    - active: members with at least 1 active day (summary) or activeFlag=true rows (raw)
    - inactive: members with 0 active days / activeFlag=false
  - include_zero_activity (boolean): In summary mode, include members with 0 events
    (requires workspace_members_only=true or enrich_profiles=true, default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Activity data per member. JSON includes structured rows plus a summary count.

View events counted: grid/timeline/insights/document/column boards opened
Edit events counted: features, subfeatures, components, products, notes created/changed,
  insights created, boards created

Note: Requires analytics scope. The analytics endpoint may not be available on all plans.`,
      inputSchema: z.object({
        date_from: z.string().describe('Start date ISO 8601, e.g. "2026-01-01"'),
        date_to: z.string().describe('End date ISO 8601, e.g. "2026-01-31"'),
        mode: z.enum(['summary', 'raw']).default('summary').describe('summary=aggregated per member, raw=per day per member'),
        workspace_members_only: z.boolean().default(true).describe('Filter to current workspace members only — excludes portal voters and deleted users (default true)'),
        include_disabled: z.boolean().default(false).describe('Include disabled workspace members (default false)'),
        enrich_profiles: z.boolean().default(true).describe('Join member name/email/role from members API'),
        role_filter: z.array(z.string()).optional().describe('Only include these roles (analytics names: "admin", "editor", "contributor")'),
        active_filter: z.enum(['all', 'active', 'inactive']).default('all').describe('Filter by activity state'),
        include_zero_activity: z.boolean().default(false).describe('Include members with zero activity (summary mode, requires workspace_members_only or enrich_profiles)'),
        response_format: responseFormatSchema,
      }).strict().refine(
        (d) => d.date_from <= d.date_to,
        { message: 'date_from must not be after date_to' }
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ date_from, date_to, mode, workspace_members_only, include_disabled, enrich_profiles, role_filter, active_filter, include_zero_activity, response_format }) => {
      try {
        const VIEW_KEYS = [
          'gridBoardOpenedCount', 'timelineBoardOpenedCount', 'insightsBoardOpenedCount',
          'documentBoardOpenedCount', 'columnBoardOpenedCount',
        ] as const;
        const EDIT_KEYS = [
          'featureCreatedCount', 'subfeatureCreatedCount', 'componentCreatedCount',
          'productCreatedCount', 'noteCreatedCount', 'noteStateChangedCount',
          'insightCreatedCount', 'gridBoardCreatedCount', 'timelineBoardCreatedCount',
          'insightsBoardCreatedCount', 'documentBoardCreatedCount', 'columnBoardCreatedCount',
        ] as const;
        const COUNT_KEYS = [
          'boardCreatedCount', 'boardOpenedCount',
          ...EDIT_KEYS, ...VIEW_KEYS,
        ] as const;

        // ── Fetch all analytics records (capped at 3000 raw rows ≈ 30 pages) ─
        // The API returns 100 records per page regardless of the limit param.
        // For wide date ranges this can exceed 50+ pages; cap prevents timeouts.
        const MAX_ANALYTICS_RECORDS = 3000;
        const analyticsRecords: PBMemberActivityRecord[] = [];
        let nextPath: string | null =
          `/v2/analytics/member-activities?dateFrom=${date_from}&dateTo=${date_to}`;
        let truncated = false;

        while (nextPath) {
          const r = await withRetry(
            () => pbFetch<{ data: PBMemberActivityRecord[]; links?: { next?: string } }>('GET', nextPath!),
            'fetch member activities'
          );
          if (r.data?.length) analyticsRecords.push(...r.data);
          if (analyticsRecords.length >= MAX_ANALYTICS_RECORDS) {
            truncated = true;
            break;
          }
          const cursorMatch = r.links?.next?.match(/pageCursor=([^&]+)/);
          nextPath = cursorMatch
            ? `/v2/analytics/member-activities?pageCursor=${decodeURIComponent(cursorMatch[1])}`
            : null;
        }

        // ── Fetch member profiles (for enrichment and/or workspace filter) ──
        type MemberProfile = { name: string; email: string; role: string };
        const memberProfiles = new Map<string, MemberProfile>();

        const shouldEnrich = enrich_profiles !== false;
        const needsMembers = shouldEnrich || include_zero_activity || workspace_members_only !== false;
        if (needsMembers) {
          let allMembers: PBMember[] = [];
          try {
            const body = { data: { filter: {}, return: { includeDisabled: !!include_disabled } } };
            let r = await withRetry(
              () => pbFetch<{ data: PBMember[]; links?: { next?: string } }>('POST', '/v2/members/search', body),
              'fetch members for activity enrichment'
            );
            if (r.data?.length) allMembers.push(...r.data);
            let cursorMatch = r.links?.next?.match(/pageCursor=([^&]+)/);
            while (cursorMatch) {
              r = await withRetry(
                () => pbFetch<{ data: PBMember[]; links?: { next?: string } }>(
                  'GET', `/v2/members/search?pageCursor=${decodeURIComponent(cursorMatch![1])}`
                ),
                'fetch members page'
              );
              if (r.data?.length) allMembers.push(...r.data);
              cursorMatch = r.links?.next?.match(/pageCursor=([^&]+)/);
            }
          } catch {
            // Non-fatal — proceed without enrichment/filtering
          }
          for (const m of allMembers) {
            memberProfiles.set(m.id, {
              name:  m.fields?.name  ?? '[unknown]',
              email: m.fields?.email ?? '[unknown]',
              role:  m.fields?.role  ?? 'viewer',
            });
          }
        }

        // ── Filter to workspace members if requested (default true) ───────
        // analyticsRecords contains portal voters, deleted users, and external
        // accounts whose IDs never appear in the members API. Remove them here.
        if (workspace_members_only !== false && memberProfiles.size > 0) {
          analyticsRecords.splice(
            0,
            analyticsRecords.length,
            ...analyticsRecords.filter((rec) => memberProfiles.has(rec.memberId))
          );
        }

        // ── Build rows ────────────────────────────────────────────────────
        type SummaryRow = MemberProfile & {
          memberId: string; dateFrom: string; dateTo: string;
          activeDaysCount: number; totalViewEvents: number; totalEditEvents: number;
          [key: string]: unknown;
        };
        type RawRow = MemberProfile & {
          memberId: string; date: string; activeFlag: boolean;
          totalViewEvents: number; totalEditEvents: number;
          [key: string]: unknown;
        };

        let rows: (SummaryRow | RawRow)[];

        if (mode === 'summary') {
          const totals = new Map<string, { memberId: string; activeDaysCount: number; [k: string]: unknown }>();

          for (const rec of analyticsRecords) {
            if (!totals.has(rec.memberId)) {
              const zero: Record<string, unknown> = { memberId: rec.memberId, activeDaysCount: 0 };
              for (const k of COUNT_KEYS) zero[k] = 0;
              totals.set(rec.memberId, zero as ReturnType<typeof totals.get> & object);
            }
            const t = totals.get(rec.memberId)!;
            if (rec.activeFlag) (t.activeDaysCount as number)++;
            for (const k of COUNT_KEYS) (t[k] as number) += (rec[k] ?? 0);
          }

          if (include_zero_activity) {
            for (const [memberId] of memberProfiles) {
              if (!totals.has(memberId)) {
                const zero: Record<string, unknown> = { memberId, activeDaysCount: 0 };
                for (const k of COUNT_KEYS) zero[k] = 0;
                totals.set(memberId, zero as ReturnType<typeof totals.get> & object);
              }
            }
          }

          rows = [...totals.values()].map((t) => {
            const p = memberProfiles.get(t.memberId) ?? { name: '[removed]', email: '[removed]', role: '[removed]' };
            const totalViewEvents = VIEW_KEYS.reduce((s, k) => s + ((t[k] as number) ?? 0), 0);
            const totalEditEvents = EDIT_KEYS.reduce((s, k) => s + ((t[k] as number) ?? 0), 0);
            return { ...t, ...p, dateFrom: date_from, dateTo: date_to, totalViewEvents, totalEditEvents } as SummaryRow;
          });
        } else {
          rows = analyticsRecords.map((rec) => {
            const p = memberProfiles.get(rec.memberId) ?? { name: '[removed]', email: '[removed]', role: '[removed]' };
            const totalViewEvents = VIEW_KEYS.reduce((s, k) => s + (rec[k] ?? 0), 0);
            const totalEditEvents = EDIT_KEYS.reduce((s, k) => s + (rec[k] ?? 0), 0);
            return { ...rec, ...p, totalViewEvents, totalEditEvents } as RawRow;
          });
        }

        // ── Apply filters ─────────────────────────────────────────────────
        if (role_filter?.length) {
          rows = rows.filter((r) => role_filter.includes(r.role));
        }
        if (active_filter !== 'all') {
          if (mode === 'summary') {
            rows = rows.filter((r) =>
              active_filter === 'active'
                ? (r as SummaryRow).activeDaysCount >= 1
                : (r as SummaryRow).activeDaysCount === 0
            );
          } else {
            rows = rows.filter((r) =>
              active_filter === 'active'
                ? (r as RawRow).activeFlag === true
                : (r as RawRow).activeFlag === false
            );
          }
        }

        // ── Detect workspace-aggregate duplication quirk ─────────────────
        // Some PB workspaces return workspace-level totals duplicated per member
        // row rather than true per-member breakdowns. Detect this by checking if
        // ≥2 active members share identical non-zero totalViewEvents + totalEditEvents.
        let aggregateDuplicationWarning: string | undefined;
        if (rows.length >= 2) {
          const activeRows = rows.filter((r) => (r as SummaryRow).totalViewEvents > 0 || (r as SummaryRow).totalEditEvents > 0);
          if (activeRows.length >= 2) {
            const sig = (r: typeof rows[0]) => `${(r as SummaryRow).totalViewEvents}:${(r as SummaryRow).totalEditEvents}`;
            const allSame = activeRows.every((r) => sig(r) === sig(activeRows[0]));
            if (allSame) {
              aggregateDuplicationWarning =
                '⚠️ All members show identical event counts — this workspace appears to return ' +
                'workspace-level aggregates duplicated per member row rather than true per-member ' +
                'breakdowns. Treat these totals as workspace-wide figures, not individual activity.';
            }
          }
        }

        const truncatedWarning = truncated
          ? `⚠️ Results capped at ${MAX_ANALYTICS_RECORDS} raw records (${rows.length} members shown). Use a shorter date range for complete data.`
          : undefined;
        const output = { mode, date_from, date_to, data: rows, count: rows.length, truncated, ...(aggregateDuplicationWarning ? { warning: aggregateDuplicationWarning } : {}), ...(truncatedWarning ? { truncation_warning: truncatedWarning } : {}) };

        // ── Format output ─────────────────────────────────────────────────
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# Member Activity — ${date_from} to ${date_to} (${mode}, ${rows.length} rows)`, '',
          ];
          if (truncatedWarning) lines.push(`> ${truncatedWarning}`, '');
          if (aggregateDuplicationWarning) lines.push(`> ${aggregateDuplicationWarning}`, '');
          if (mode === 'summary') {
            for (const r of rows as SummaryRow[]) {
              lines.push(
                `### ${r.name} \`${r.memberId}\``,
                `- **Email**: ${r.email} | **Role**: ${r.role}`,
                `- **Active days**: ${r.activeDaysCount} | **View events**: ${r.totalViewEvents} | **Edit events**: ${r.totalEditEvents}`,
                `- Features created: ${r.featureCreatedCount ?? 0} | Notes created: ${r.noteCreatedCount ?? 0} | Insights: ${r.insightCreatedCount ?? 0}`,
                ''
              );
            }
          } else {
            lines.push('| Date | Member | Active | View events | Edit events |', '|------|--------|--------|-------------|-------------|');
            for (const r of rows as RawRow[]) {
              lines.push(`| ${r.date} | ${r.name} | ${r.activeFlag ? 'yes' : 'no'} | ${r.totalViewEvents} | ${r.totalEditEvents} |`);
            }
          }
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

  // ── pb_get_member ─────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_member',
    {
      title: 'Get Productboard Member',
      description: `Get the full details of a single workspace member by UUID.

Args:
  - id (string): Member UUID
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Member with name, email, role, and status flags.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Member UUID'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, response_format }) => {
      try {
        const r = await withRetry(
          () => pbFetch<{ data: PBMember }>('GET', `/v2/members/${id}`),
          `get member ${id}`
        );
        const m = r.data;
        const f = m.fields ?? {};
        const output = m;
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const status = f.disabled ? ' *(disabled)*' : f.invitationPending ? ' *(invited)*' : '';
          text = `# Member: ${f.name ?? id}\n- **ID**: \`${m.id}\`\n- **Email**: ${f.email ?? '[redacted]'}\n- **Role**: ${f.role ?? 'N/A'}${status}`;
        } else {
          text = JSON.stringify(output, null, 2);
        }
        return { content: [{ type: 'text', text }], structuredContent: output as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_get_team ───────────────────────────────────────────────────────────
  server.registerTool(
    'pb_get_team',
    {
      title: 'Get Productboard Team',
      description: `Get the full details of a single team by UUID.

Args:
  - id (string): Team UUID
  - include_members (boolean): Also fetch the team's member list (default false)
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Team with name, handle, description, and optionally members.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Team UUID'),
        include_members: z.boolean().default(false).describe('Also fetch team members'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, include_members, response_format }) => {
      try {
        const [teamRes, members] = await Promise.all([
          withRetry(() => pbFetch<{ data: PBTeam }>('GET', `/v2/teams/${id}`), `get team ${id}`),
          include_members
            ? fetchAllPages<PBMember>(`/v2/teams/${id}/members`, `list team members ${id}`)
            : Promise.resolve([] as PBMember[]),
        ]);
        const team = teamRes.data;
        const output = { ...team, ...(include_members ? { members } : {}) };
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# Team: ${team.fields?.name ?? id} \`${team.id}\``,
            team.fields?.description ? `> ${team.fields.description}` : '',
          ].filter(Boolean);
          if (include_members) {
            lines.push('', `**Members (${members.length}):**`);
            for (const m of members) lines.push(`- ${m.fields?.name ?? m.id} — ${m.fields?.email ?? '[redacted]'}`);
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

  // ── pb_search_teams ───────────────────────────────────────────────────────
  server.registerTool(
    'pb_search_teams',
    {
      title: 'Search Productboard Teams',
      description: `Search teams using POST /v2/teams/search with filter and full-text search.

Args:
  - ids (string[], optional): Filter by specific team UUIDs (OR logic)
  - name (string, optional): Filter by team name (exact or partial match)
  - handle (string, optional): Filter by team handle
  - search_query (string, optional): Full-text search on name and handle
  - response_format ('markdown' | 'json'): Output format (default 'markdown')

Returns:
  Matching teams. JSON: { data: PBTeam[], count }`,
      inputSchema: z.object({
        ids: z.array(z.string().uuid()).optional().describe('Filter by team UUIDs (OR logic)'),
        name: z.string().optional().describe('Filter by team name'),
        handle: z.string().optional().describe('Filter by team handle'),
        search_query: z.string().min(1).optional().describe('Full-text search on name and handle'),
        response_format: responseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ ids, name, handle, search_query, response_format }) => {
      try {
        const body: Record<string, unknown> = { data: {} };
        const filter: Record<string, unknown> = {};
        if (ids?.length) filter['id'] = ids;
        // filter.fields.name/handle returns 0 results in the live API — use search.query instead
        const effectiveQuery = search_query ?? name ?? handle;
        if (Object.keys(filter).length) (body['data'] as Record<string, unknown>)['filter'] = filter;
        if (effectiveQuery) (body['data'] as Record<string, unknown>)['search'] = { query: effectiveQuery };

        const r = await withRetry(
          () => pbFetch<{ data: PBTeam[] }>('POST', '/v2/teams/search', body),
          'search teams'
        );
        const data = r.data ?? [];
        const output = { data, count: data.length };
        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Teams Search (${data.length} results)`, ''];
          for (const t of data) {
            lines.push(`- **${t.fields?.name ?? t.id}** \`${t.id}\`${t.fields?.description ? ` — ${t.fields.description}` : ''}`);
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

  // ── pb_create_team ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_create_team',
    {
      title: 'Create Productboard Team',
      description: `Create a new team in the Productboard workspace.

Args:
  - name (string): Team display name
  - handle (string, optional): Short unique identifier, e.g. "eng" (lowercase, no spaces)
  - description (string, optional): Team description

Returns:
  The created team UUID and confirmation.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Team display name'),
        // API enforces ^[a-z0-9]+$ — no hyphens, spaces, or uppercase
        handle: z.string().regex(/^[a-z0-9]+$/, 'Handle must be lowercase letters and digits only (no hyphens or spaces)').optional().describe('Short unique handle, e.g. "eng" — lowercase letters and digits only, no hyphens'),
        description: z.string().optional().describe('Team description'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, handle, description }) => {
      try {
        const fields: Record<string, unknown> = { name };
        if (handle) fields['handle'] = handle;
        if (description) fields['description'] = description;
        const r = await withRetry(
          () => pbFetch<{ data: PBTeam }>('POST', '/v2/teams', { data: { type: 'team', fields } }),
          'create team'
        );
        const team = r.data;
        return { content: [{ type: 'text', text: `Created team \`${team.id}\`: **${team.fields?.name ?? name}**` }], structuredContent: team as unknown as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_update_team ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_update_team',
    {
      title: 'Update Productboard Team',
      description: `Update a team's name, handle, or description using PATCH.

Args:
  - id (string): Team UUID
  - name (string, optional): New team name
  - handle (string, optional): New handle
  - description (string, optional): New description

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Team UUID'),
        name: z.string().optional().describe('New team name'),
        // API enforces ^[a-z0-9]+$ — no hyphens, spaces, or uppercase
        handle: z.string().regex(/^[a-z0-9]+$/, 'Handle must be lowercase letters and digits only').optional().describe('New handle — lowercase letters and digits only, no hyphens'),
        description: z.string().optional().describe('New description'),
      }).strict().refine(
        (d) => [d.name, d.handle, d.description].some((v) => v !== undefined),
        { message: 'Provide at least one field to update' }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, name, handle, description }) => {
      try {
        const fields: Record<string, unknown> = {};
        if (name !== undefined) fields['name'] = name;
        if (handle !== undefined) fields['handle'] = handle;
        if (description !== undefined) fields['description'] = description;
        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/teams/${id}`, { data: { fields } }),
          `update team ${id}`
        );
        return { content: [{ type: 'text', text: `Updated team \`${id}\` successfully.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_delete_team ────────────────────────────────────────────────────────
  server.registerTool(
    'pb_delete_team',
    {
      title: 'Delete Productboard Team',
      description: `Permanently delete a team from the Productboard workspace.

WARNING: This is irreversible. Members are not deleted — they remain in the workspace
but lose their team association.

Args:
  - id (string): Team UUID to delete

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: z.string().uuid().describe('Team UUID to delete'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        await withRetry(() => pbFetch<unknown>('DELETE', `/v2/teams/${id}`), `delete team ${id}`);
        return { content: [{ type: 'text', text: `Deleted team \`${id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_add_team_member ────────────────────────────────────────────────────
  server.registerTool(
    'pb_add_team_member',
    {
      title: 'Add Member to Productboard Team',
      description: `Add a workspace member to a team using PATCH /v2/teams/{id} with addItems.

Args:
  - team_id (string): Team UUID
  - member_id (string): Member UUID to add (use pb_list_members or pb_search_members to find IDs)

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        team_id: z.string().uuid().describe('Team UUID'),
        member_id: z.string().uuid().describe('Member UUID to add'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ team_id, member_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/teams/${team_id}`, {
            data: { patch: [{ op: 'addItems', path: 'members', value: [{ id: member_id }] }] },
          }),
          `add member ${member_id} to team ${team_id}`
        );
        return { content: [{ type: 'text', text: `Added member \`${member_id}\` to team \`${team_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );

  // ── pb_remove_team_member ─────────────────────────────────────────────────
  server.registerTool(
    'pb_remove_team_member',
    {
      title: 'Remove Member from Productboard Team',
      description: `Remove a workspace member from a team using PATCH /v2/teams/{id} with removeItems.

The member remains in the workspace — only the team association is removed.

Args:
  - team_id (string): Team UUID
  - member_id (string): Member UUID to remove

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        team_id: z.string().uuid().describe('Team UUID'),
        member_id: z.string().uuid().describe('Member UUID to remove'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ team_id, member_id }) => {
      try {
        await withRetry(
          () => pbFetch<unknown>('PATCH', `/v2/teams/${team_id}`, {
            data: { patch: [{ op: 'removeItems', path: 'members', value: [{ id: member_id }] }] },
          }),
          `remove member ${member_id} from team ${team_id}`
        );
        return { content: [{ type: 'text', text: `Removed member \`${member_id}\` from team \`${team_id}\`.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: handleError(err) }] };
      }
    }
  );
}
