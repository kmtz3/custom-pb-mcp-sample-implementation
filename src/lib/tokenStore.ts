/**
 * Token storage — persists the Productboard OAuth token set after setup.
 *
 * Stored shape:
 *   { access_token, refresh_token?, expires_at?, use_eu }
 *
 * Storage backends (first available wins):
 *   1. GCP Secret Manager  — when GCP_PROJECT_ID is set (Cloud Run production)
 *   2. Local file          — .pb-token in the working directory (dev / non-GCP)
 *
 * Multi-tenant mode (GOOGLE_CLIENT_ID set):
 *   Tokens are stored per-user under secret name `pb-mcp-token-{googleUserId}`.
 *
 * Single-user / local dev mode (no GOOGLE_CLIENT_ID):
 *   Tokens are stored under `productboard-mcp-token` (backwards compatible).
 *
 * The local file path can be overridden with PB_TOKEN_FILE.
 */

import fs from 'fs';
import path from 'path';

const SECRET_NAME_SINGLE = 'productboard-mcp-token';
const LOCAL_TOKEN_FILE = process.env.PB_TOKEN_FILE ?? path.join(process.cwd(), '.pb-token');

// Sliding TTL — idle users' tokens auto-delete after this window.
// Refreshed on every save and successful load, so active users never expire.
const TOKEN_TTL_DAYS = 60;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

type SmClient = import('@google-cloud/secret-manager').SecretManagerServiceClient;

async function bumpExpiry(client: SmClient, name: string): Promise<void> {
  try {
    await client.updateSecret({
      secret: {
        name,
        expireTime: { seconds: Math.floor((Date.now() + TOKEN_TTL_MS) / 1000) },
      },
      updateMask: { paths: ['expire_time'] },
    });
  } catch (err) {
    // Non-fatal: if updateSecret fails (perms, transient error), the token still works.
    process.stderr.write(`[tokenStore] Failed to bump expireTime on ${name}: ${(err as Error).message}\n`);
  }
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Unix ms timestamp after which access_token should be considered expired */
  expires_at?: number;
  use_eu?: boolean;
}

function useSecretManager(): boolean {
  return !!process.env.GCP_PROJECT_ID;
}

function isMultiTenant(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID;
}

// PROTOTYPE: tokens are keyed by googleUserId only — one workspace per Google account.
// To support multiple Productboard workspaces under one Google identity, extend the
// key with a workspaceId (e.g. `pb-mcp-token-${userId}-${workspaceId}`) and thread
// workspaceId through requestContext / pbClient. See README "Known limitations".
function secretName(userId?: string): string {
  return isMultiTenant() && userId ? `pb-mcp-token-${userId}` : SECRET_NAME_SINGLE;
}

export async function saveTokens(tokens: StoredTokens, userId?: string): Promise<void> {
  const data = JSON.stringify(tokens);

  if (useSecretManager()) {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const project = process.env.GCP_PROJECT_ID!;
    const id = secretName(userId);
    const name = `projects/${project}/secrets/${id}`;

    try {
      await client.addSecretVersion({
        parent: name,
        payload: { data: Buffer.from(data, 'utf8') },
      });
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 5) {
        await client.createSecret({
          parent: `projects/${project}`,
          secretId: id,
          secret: {
            replication: { automatic: {} },
            expireTime: { seconds: Math.floor((Date.now() + TOKEN_TTL_MS) / 1000) },
          },
        });
        await client.addSecretVersion({
          parent: name,
          payload: { data: Buffer.from(data, 'utf8') },
        });
      } else {
        throw err;
      }
    }

    await bumpExpiry(client, name);

    // Destroy all but the latest version to avoid accumulating charges
    try {
      const [versions] = await client.listSecretVersions({ parent: name, filter: 'state=ENABLED' });
      versions.sort((a, b) => {
        const n = (v: typeof a) => parseInt(v.name!.split('/').pop()!, 10);
        return n(b) - n(a);
      });
      for (const v of versions.slice(1)) {
        await client.destroySecretVersion({ name: v.name! });
      }
    } catch {
      // Non-fatal — old versions can be cleaned up manually if this fails
    }

    process.stderr.write(`[tokenStore] Tokens saved to Secret Manager: ${name}\n`);
  } else {
    fs.writeFileSync(LOCAL_TOKEN_FILE, data, { mode: 0o600 });
    process.stderr.write(`[tokenStore] Tokens saved to ${LOCAL_TOKEN_FILE}\n`);
  }
}

export async function loadTokens(userId?: string): Promise<StoredTokens | null> {
  // Env var overrides — single-user local dev shortcuts, no expiry tracking
  if (process.env.PB_API_KEY) {
    return { access_token: process.env.PB_API_KEY, use_eu: process.env.PB_EU === 'true' };
  }
  if (process.env.PB_TOKEN) {
    return { access_token: process.env.PB_TOKEN, use_eu: process.env.PB_EU === 'true' };
  }

  // In multi-tenant mode a userId is required — can't load an anonymous token
  if (isMultiTenant() && !userId) return null;

  let raw: string | null = null;

  if (useSecretManager()) {
    try {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const secretPath = `projects/${process.env.GCP_PROJECT_ID}/secrets/${secretName(userId)}`;
      const name = `${secretPath}/versions/latest`;
      const [version] = await client.accessSecretVersion({ name });
      const payload = version.payload?.data;
      if (payload) {
        raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
        // Sliding TTL — push expireTime forward on every successful load so
        // active users never expire. Existing pre-TTL secrets get their first
        // expireTime set here on next access.
        await bumpExpiry(client, secretPath);
      }
    } catch {
      return null;
    }
  } else if (fs.existsSync(LOCAL_TOKEN_FILE)) {
    raw = fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8').trim();
  }

  if (!raw) return null;

  try {
    // Support old format (bare token string) for backwards compatibility
    if (!raw.startsWith('{')) {
      return { access_token: raw, use_eu: process.env.PB_EU === 'true' };
    }
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}
