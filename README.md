# productboard-mcp-server

MCP server for the [Productboard Public API v2](https://developer.productboard.com).

**Single-user mode**: Deploy your own instance, connect it to your Productboard workspace via OAuth. No shared infrastructure — you own your data.

**Multi-tenant mode**: Deploy once for an entire team. Each `@yourcompany.com` user self-onboards via Google OAuth + Productboard OAuth, gets their own per-user bearer token, and the server routes every request to their workspace. See [deployment-guide.md](deployment-guide.md) for the full setup.

## How it works

**Single-user:**
1. Deploy to Cloud Run (or any Node host)
2. Register a Productboard OAuth app and set the env vars
3. Visit `https://your-server/setup` → authorize with Productboard
4. Add the MCP URL to your Claude config — done

**Multi-tenant:**
1. Deploy once with `GOOGLE_CLIENT_ID` set
2. Each user visits `/auth/google` → signs in with their `@yourcompany.com` account → authorizes Productboard
3. User copies the bearer token snippet shown after setup into their Claude config
4. See [deployment-guide.md](deployment-guide.md) for the complete walkthrough

## Tools

### Entities

| Tool | Description |
|---|---|
| `pb_list_entities` | List entities of one type as compact rows (id, name, status, owner, teams, archived, url); filters: parent, name, status, owner, archived; optional extra fields by display name |
| `pb_search_entities` | Search with exact filters plus operator conditions (`contains`, `in`, `is_empty`, `gt`, `before`, `in_last "7 days"`, …) on any field by display name; resumable scans (`complete`, `resume_cursor`) |
| `pb_get_entity` | Get a single entity with custom fields under their display names, rich text as markdown, and all relationships (`raw=true` for the API response) |
| `pb_read_entity_document` | Read an entity's rich-text documents (Description, Specification, rich-text custom fields) as markdown. Standalone Productboard documents are not available via the public API |
| `pb_create_entity` | Create a new entity |
| `pb_update_entity` | Update entity fields (replace or granular patch) |
| `pb_delete_entity` | Permanently delete an entity by UUID |
| `pb_get_entity_configurations` | Get field ids, display names and data types per entity type (`include_schema` for full schemas) |
| `pb_list_entity_relationships` | List all relationships (parent, children, links, blocking, blocked-by) |
| `pb_create_entity_relationship` | Create a relationship between two entities |
| `pb_set_entity_parent` | Set or replace an entity's parent |
| `pb_delete_entity_relationship` | Delete a specific relationship between two entities |

### Notes

| Tool | Description |
|---|---|
| `pb_list_notes` | List notes as compact rows with filters (source, owner, creator, processed, archived, created/updated dates) |
| `pb_list_entity_feedback` | List the feedback notes linked to a feature or other entity |
| `pb_get_note` | Get a note (content as markdown) + all its relationships |
| `pb_create_note` | Create a customer feedback note |
| `pb_update_note` | Update note title, content, owner, tags, archived |
| `pb_delete_note` | Permanently delete a note |
| `pb_set_note_customer` | Set/replace a note's customer relationship |
| `pb_search_notes` | Search notes: text in title/content, `created_in_last` / `updated_in_last`, linked entities, customers, tags, owner, processed, plus operator conditions; resumable scans |
| `pb_link_note_entity` | Link a note to a hierarchy entity |
| `pb_delete_note_relationship` | Delete a note–entity relationship |

### Members & Teams

| Tool | Description |
|---|---|
| `pb_list_members` | List workspace members with email and role |
| `pb_get_member` | Get a single member by ID |
| `pb_search_members` | Search members by name or email |
| `pb_get_member_activity` | Member activity analytics for a date range (summary or per-day rows) |
| `pb_list_teams` | List teams, optionally with members |
| `pb_get_team` | Get a single team by ID |
| `pb_search_teams` | Search teams by name |
| `pb_create_team` | Create a new team |
| `pb_update_team` | Rename a team or update its description |
| `pb_delete_team` | Delete a team |
| `pb_add_team_member` | Add a member to a team |
| `pb_remove_team_member` | Remove a member from a team |

### Fields

| Tool | Description |
|---|---|
| `pb_list_field_values` | List allowed values for select fields or tags |
| `pb_create_field_value` | Create a value for a custom select field |
| `pb_update_field_value` | Update an existing field value |
| `pb_delete_field_value` | Delete a field value |

## Known API issue: dependency direction

The public API reports `isBlocking` / `isBlockedBy` **inverted** relative to the Productboard UI
(verified 2026-10-12 in the UI and with the official Productboard MCP on two independent pairs —
e.g. the API says *Playback* `isBlocking` *🎨 Accessibility-friendly video player components*, while the UI
shows Playback as **blocked by** it).

- **Reads are corrected**: `pb_get_entity`, `pb_list_entity_relationships` and `pb_get_note` report
  dependencies in the UI direction, and the `type` filter of `pb_list_entity_relationships` is
  translated before it is sent (`raw=true` on `pb_get_entity` still returns the API's own values).
- **Writes need no correction**: `pb_create_entity_relationship` and `pb_delete_entity_relationship`
  take `isBlocking` / `isBlockedBy` in the UI direction and send them unchanged. Verified 2026-10-12 with a
  reversible write test: creating *A* `isBlocking` *B* showed in the UI (via the official MCP) as "A is
  blocking B", the API then read it back as `isBlockedBy`, and `DELETE …/relationships/isBlocking/B` removed it.
  So only the API's read direction is inverted.

## Live test

`test/live-read-tools.ts` runs every read tool through an in-memory MCP client against a real
workspace and compares each result with direct Productboard API calls (including full scans for
the search tools and cursor walks that check nothing is skipped or repeated). It never calls write
tools; the only non-GET requests are read-only `POST …/search` calls.

```bash
PB_TOKEN=your_token npm run test:live      # add PB_EU=true for EU workspaces
```

## Deploy to Cloud Run

### Single-user (quick start)

#### 1. Fork and clone

```bash
git clone https://github.com/your-fork/productboard-mcp-server
cd productboard-mcp-server
npm install && npm run build
```

#### 2. Register a Productboard OAuth app

In Productboard: **Settings → Integrations → OAuth Apps → New app**

- Redirect URI: `https://YOUR-SERVICE-URL/setup/callback`
- Scopes: `read write members.read` (or whatever you need)
- Note your `client_id` and `client_secret`

#### 3. Deploy

```bash
gcloud run deploy productboard-mcp-server \
  --source=. \
  --region=us-central1 \
  --project=YOUR_PROJECT \
  --allow-unauthenticated \
  --set-env-vars="PB_OAUTH_CLIENT_ID=YOUR_CLIENT_ID,PB_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET,APP_URL=https://YOUR-SERVICE.run.app,SESSION_SECRET=$(openssl rand -base64 32),GCP_PROJECT_ID=YOUR_PROJECT" \
  --port=8080
```

#### 4. Authorize

Visit `https://YOUR-SERVICE.run.app/setup` and click through the Productboard OAuth flow. The access token is stored in Secret Manager automatically.

#### 5. Add to Claude

The setup page shows the exact config snippet after authorization. For single-user mode with no `MCP_AUTH_SECRET` set:

```json
{
  "mcpServers": {
    "productboard": {
      "type": "http",
      "url": "https://YOUR-SERVICE.run.app/mcp"
    }
  }
}
```

Add this to `~/.claude.json` (under `mcpServers`) and restart Claude Code.

### Multi-tenant / team deployment

See [deployment-guide.md](deployment-guide.md) for the complete setup: Google OAuth, per-user Firestore token registry, Secret Manager, and GitHub auto-deploy on push to `main`.

After the multi-tenant setup each user's Claude config includes their personal bearer token:

```json
{
  "mcpServers": {
    "productboard": {
      "type": "http",
      "url": "https://YOUR-SERVICE.run.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_PERSONAL_TOKEN" }
    }
  }
}
```

## Local development

```bash
cp .env.example .env
# fill in PB_OAUTH_CLIENT_ID, PB_OAUTH_CLIENT_SECRET, APP_URL (use ngrok), SESSION_SECRET

npm run dev
# Visit http://localhost:3000/setup
```

For `APP_URL` locally, use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# use the https://xxxx.ngrok.io URL as APP_URL and as the PB OAuth redirect base
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PB_OAUTH_CLIENT_ID` | Yes | Productboard OAuth app client ID |
| `PB_OAUTH_CLIENT_SECRET` | Yes | Productboard OAuth app client secret |
| `APP_URL` | Yes | Public base URL (no trailing slash) |
| `SESSION_SECRET` | Yes | Random string for signing session cookies |
| `PORT` | No | HTTP port (default 3000, Cloud Run uses 8080) |
| `GCP_PROJECT_ID` | No | Enables Secret Manager token storage + Firestore session store (recommended for Cloud Run) |
| `MCP_AUTH_SECRET` | No | Single-user mode only: bearer token required on `/mcp` requests |
| `PB_EU` | No | `true` for EU datacenter |
| `PB_API_KEY` | No | Skip OAuth entirely — use a static token directly (local dev shortcut) |

**Multi-tenant only** (requires `GOOGLE_CLIENT_ID`):

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth app client ID — enables multi-tenant mode |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth app client secret |
| `GOOGLE_ALLOWED_DOMAIN` | No | G Suite domain to restrict login to (default: `productboard.com`) |

## Token storage

| Env | Storage | Notes |
|---|---|---|
| Cloud Run, single-user (`GCP_PROJECT_ID` set) | Secret Manager (`productboard-mcp-token`) | Survives restarts |
| Cloud Run, multi-tenant (`GOOGLE_CLIENT_ID` set) | Secret Manager per user (`pb-mcp-token-{userId}`) | Each user's token is isolated |
| Local / other | `.pb-token` file in working directory | Ephemeral on Cloud Run without `GCP_PROJECT_ID` |

## Security

**Single-user mode**: The `/mcp` endpoint is unauthenticated by default — designed for private single-user deployments. Set `MCP_AUTH_SECRET` to require a bearer token:

```json
"productboard": {
  "type": "http",
  "url": "https://YOUR-SERVICE.run.app/mcp",
  "headers": { "Authorization": "Bearer YOUR_SECRET" }
}
```

**Multi-tenant mode**: Each user receives a unique per-user bearer token after completing the Google + Productboard OAuth flow. The server validates the token against Firestore on every request and routes to that user's Productboard workspace. `MCP_AUTH_SECRET` is not used in multi-tenant mode.

## Known limitations

- **One Productboard workspace per Google account (prototype scope).** Tokens are stored per `googleUserId` (`pb-mcp-token-{userId}` in Secret Manager) with no workspace dimension, and `userRegistry.registerUser()` revokes any prior bearer token for the same Google user before issuing a new one. Re-authorizing the same Google account into a second workspace will invalidate the first. This is a deliberate choice for a sample implementation — customers extending this should decide their own multi-workspace model. To lift the limitation, key the token store and registry by `(googleUserId, workspaceId)` and thread `workspaceId` through `requestContext` / `pbClient`. See `src/lib/tokenStore.ts:64` and `src/lib/userRegistry.ts:46`.
- PB OAuth access tokens may not include a refresh token depending on your OAuth app configuration; if your token expires, revisit `/setup` to re-authorize.
- `POST /v2/entities/fields/tags/values` returns HTTP 500 (PB bug) — tags can only be listed, not created via API.
- `opportunityNote` cannot be created via the public API; `pb_create_note` always uses `textNote`.
- The `objectives` type returns empty from `POST /v2/entities/search`; `pb_search_entities` always fetches objectives with `GET /v2/entities`.
- The public API only filters by exact values joined with AND (and `GET /v2/entities` ignores `archived=false` and rejects date filters). Operators, date ranges, `archived=false` and text search are evaluated by the server over fetched pages, so large scans may need several calls — follow `resume_cursor` until `complete` is true.
- `POST /v2/notes/search` rejects most of its published filter shape and silently ignores unknown filter keys, so note search uses `GET /v2/notes` filters instead.
- A `pageCursor` sent on its own drops all filters; every paginated request re-sends the original filters/body with the cursor.
- Responses are capped at 25,000 characters. List items are dropped (never cut mid-JSON) and the returned cursor resumes at the first dropped item.
- Relationship rows include the related entity's name (`target_name`), looked up with one `GET /v2/entities/{id}` per related entity (there is no bulk lookup), cached per call and capped at 100 per call (`names_truncated` says when the cap is hit).
- Health is returned as current + previous status only; the public API has no health history.
- Standalone Productboard documents are not exposed by the public API (`/v2/documents` → 404); `pb_read_entity_document` reads rich-text fields on entities instead.
