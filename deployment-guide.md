# Deployment Guide

Multi-tenant Cloud Run deployment with Google OAuth domain restriction, per-user Productboard OAuth tokens, and GitHub auto-deploy on push to `main`.

---

## Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Docker (only needed if testing locally)
- A GCP project with billing enabled
- A GitHub repo containing this codebase
- A Google OAuth app (created below)
- A Productboard OAuth app (created at `developer.productboard.com`)

---

## Step 1 — Create the Google OAuth app (browser)

1. Go to **Google Cloud Console → APIs & Services → OAuth consent screen**
   - Set to **Internal** (restricts to your Google Workspace domain automatically)
   - App name: `Productboard MCP Server`
   - Save

2. Go to **Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `productboard-mcp-server`
   - Authorized redirect URIs: add a placeholder for now — you will update it in Step 6
   - Save → note the **Client ID** and **Client Secret**

---

## Step 2 — Register a Productboard OAuth app

In your Productboard OAuth app settings at `developer.productboard.com`:
- Add a placeholder redirect URI for now — you will update it in Step 6
- Note the **Client ID** and **Client Secret**

---

## Step 3 — GCP infrastructure

Set your project once so you don't repeat it in every command:

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
```

### Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  --project=$PROJECT_ID
```

### Create Firestore database (native mode, one-time)

```bash
gcloud firestore databases create \
  --location=$REGION \
  --project=$PROJECT_ID
```

### Create the Cloud Run service account

```bash
gcloud iam service-accounts create pb-mcp-server \
  --display-name="PB MCP Server" \
  --project=$PROJECT_ID
```

### Grant IAM roles

```bash
# Runtime permissions (Secret Manager + Firestore)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.admin" --condition=None

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user" --condition=None

# Build-time permissions (Cloud Build runs as this SA)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter" --condition=None

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" --condition=None

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin" --condition=None

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin" --condition=None

# SA needs to act as itself when deploying Cloud Run
gcloud iam service-accounts add-iam-policy-binding \
  pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com \
  --member="serviceAccount:pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" \
  --project=$PROJECT_ID

# Cloud Build P4SA needs Secret Manager access for the GitHub connection
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com" \
  --role="roles/secretmanager.admin" --condition=None
```

---

## Step 4 — Store secrets in Secret Manager

Never pass OAuth secrets as plain env vars. Store them here and reference via `--set-secrets` in Cloud Run.

```bash
# Generate a random session secret
SESSION_SECRET=$(openssl rand -base64 32 | tr -d '\n')

echo -n 'YOUR_GOOGLE_CLIENT_SECRET' | \
  gcloud secrets create google-oauth-client-secret --data-file=- --project=$PROJECT_ID

echo -n 'YOUR_PB_CLIENT_SECRET' | \
  gcloud secrets create pb-oauth-client-secret --data-file=- --project=$PROJECT_ID

echo -n "$SESSION_SECRET" | \
  gcloud secrets create mcp-session-secret --data-file=- --project=$PROJECT_ID
```

---

## Step 5 — First deploy (gets the permanent service URL)

```bash
cd /path/to/productboard-mcp-server

gcloud run deploy productboard-mcp-server \
  --source=. \
  --region=$REGION \
  --project=$PROJECT_ID \
  --allow-unauthenticated \
  --service-account=pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID,GOOGLE_ALLOWED_DOMAIN=productboard.com,PB_OAUTH_CLIENT_ID=YOUR_PB_CLIENT_ID,NODE_ENV=production" \
  --set-secrets="GOOGLE_CLIENT_SECRET=google-oauth-client-secret:latest,PB_OAUTH_CLIENT_SECRET=pb-oauth-client-secret:latest,SESSION_SECRET=mcp-session-secret:latest" \
  --port=8080
```

After deploy, capture the service URL:

```bash
APP_URL=$(gcloud run services describe productboard-mcp-server \
  --region=$REGION --project=$PROJECT_ID --format='value(status.url)')
echo "Service URL: $APP_URL"

# Set APP_URL on the service
gcloud run services update productboard-mcp-server \
  --region=$REGION --project=$PROJECT_ID \
  --update-env-vars="APP_URL=$APP_URL"
```

---

## Step 6 — Update OAuth redirect URIs (browser)

Now that you have the permanent URL, update both OAuth apps:

**Google OAuth app** (Console → APIs & Services → Credentials → your client):
```
https://<your-service-url>/auth/google/callback
```

**Productboard OAuth app** (`developer.productboard.com`):
```
https://<your-service-url>/setup/callback
```

Verify the service is healthy:

```bash
curl https://<your-service-url>/health
# → {"ok":true,"service":"productboard-mcp-server","multiTenant":true}
```

---

## Step 7 — Set up GitHub auto-deploy

### Create the GitHub connection

```bash
gcloud builds connections create github pb-mcp-github \
  --region=$REGION \
  --project=$PROJECT_ID
```

This outputs a URL — open it in a browser, sign in with your Google account, and authorize Cloud Build to access your GitHub account. When you see "Connection configured successfully", return here.

### Link the repository

```bash
gcloud builds repositories create YOUR_REPO_NAME \
  --remote-uri=https://github.com/OWNER/REPO.git \
  --connection=pb-mcp-github \
  --region=$REGION \
  --project=$PROJECT_ID
```

### Create the build trigger

> **Note:** `gcloud builds triggers create github` sends to `locations/global` even with `--region`, which rejects 2nd gen repository resources. Use the REST API directly.

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

curl -s -X POST \
  "https://cloudbuild.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/triggers" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"deploy-on-main\",
    \"filename\": \"cloudbuild.yaml\",
    \"serviceAccount\": \"projects/$PROJECT_ID/serviceAccounts/pb-mcp-server@$PROJECT_ID.iam.gserviceaccount.com\",
    \"repositoryEventConfig\": {
      \"repository\": \"projects/$PROJECT_ID/locations/$REGION/connections/pb-mcp-github/repositories/YOUR_REPO_NAME\",
      \"push\": { \"branch\": \"^main$\" }
    }
  }"
```

> **Note:** The `serviceAccount` field is required — the API rejects triggers without it. Use a user-managed SA, not the Cloud Build P4SA (`service-XXX@gcp-sa-cloudbuild.iam.gserviceaccount.com`).

From this point, every push to `main` triggers a build and deploy automatically.

---

## User onboarding flow

Once deployed, each `@productboard.com` user self-onboards:

1. Visit `https://<service-url>/auth/google`
2. Sign in with their `@productboard.com` Google account
3. Authorize the Productboard OAuth app
4. Copy the config snippet shown — it includes their personal bearer token
5. Add to `~/.claude/claude.json` (or equivalent MCP config) and restart Claude Code

```json
{
  "mcpServers": {
    "productboard": {
      "type": "http",
      "url": "https://<service-url>/mcp",
      "headers": {
        "Authorization": "Bearer <their-personal-token>"
      }
    }
  }
}
```

---

## Local dev

Local dev does not require any GCP services. Without `GOOGLE_CLIENT_ID` set, the server runs in single-user mode: no Google auth gate, tokens stored in `.pb-token`, optional `MCP_AUTH_SECRET` for bearer auth.

Minimum `.env` for local dev:

```bash
PB_OAUTH_CLIENT_ID=your-pb-client-id
PB_OAUTH_CLIENT_SECRET=your-pb-client-secret
APP_URL=http://localhost:3000
SESSION_SECRET=any-random-string
PORT=3000
```

Then:

```bash
npm run dev
# Visit http://localhost:3000/setup to authorize
```

To test multi-tenant mode locally, add:

```bash
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_ALLOWED_DOMAIN=productboard.com
# APP_URL must be a public URL (use ngrok or similar for OAuth callbacks)
```

---

## Maintenance

### Rotating a secret

```bash
echo -n 'NEW_SECRET_VALUE' | \
  gcloud secrets versions add SECRET_NAME --data-file=- --project=$PROJECT_ID
```

The server picks up the new version on the next token operation (in-memory cache is per-process; a Cloud Run revision restart forces an immediate reload).

The old version is destroyed automatically by the server on the next token save. To destroy manually:

```bash
gcloud secrets versions destroy VERSION_NUMBER \
  --secret=SECRET_NAME --project=$PROJECT_ID
```

### Revoking a user's access

The user registry lives in Firestore (`mcp-users` collection). Each document is keyed by `SHA-256(bearer_token)` and contains `{ googleUserId, email, createdAt, lastUsedAt }`.

To revoke via the API (add a `/admin/revoke` route if needed), or directly in the Firestore console: delete the document(s) for the user. Their bearer token becomes invalid immediately. Their PB OAuth token in Secret Manager (`pb-mcp-token-{googleUserId}`) can be deleted separately.

### Re-running a deploy without a code push

```bash
gcloud builds triggers run deploy-on-main \
  --region=$REGION \
  --branch=main \
  --project=$PROJECT_ID
```

---

## Known gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `gcloud builds triggers create github` → `INVALID_ARGUMENT` | gcloud CLI sends to `locations/global` even with `--region` | Use the REST API directly (see Step 7) |
| Build fails: `PERMISSION_DENIED` on `gcloud run deploy` | `--source=.` in Cloud Build triggers a nested build the SA can't create | Use explicit `docker build` + `docker push` + `gcloud run deploy --image` in `cloudbuild.yaml` |
| GitHub connection creation fails with Secret Manager error | Cloud Build P4SA lacks Secret Manager permissions | Grant `roles/secretmanager.admin` to `service-PROJECT_NUMBER@gcp-sa-cloudbuild.iam.gserviceaccount.com` |
| Trigger creation fails: `invalid value for build.service_account` | Cloud Build P4SA used as `serviceAccount` — only user-managed SAs allowed | Use `pb-mcp-server@PROJECT.iam.gserviceaccount.com` |
