/**
 * OAuth 2.0 PKCE flow storage (Claude Code MCP auth).
 *
 * When GCP_PROJECT_ID is set, both clients and auth codes use Firestore so
 * /register, /oauth/authorize, and /oauth/token can land on different Cloud
 * Run instances. Otherwise everything is in-memory (single-instance / local).
 */

import crypto from 'crypto';

interface AuthCodeEntry {
  bearerToken: string;
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

interface ClientEntry {
  clientSecret: string;
  redirectUris: string[];
}

const clientsMemory = new Map<string, ClientEntry>();
const authCodesMemory = new Map<string, AuthCodeEntry>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;

async function getDb() {
  if (_db) return _db;
  if (!process.env.GCP_PROJECT_ID) return null;
  const { Firestore } = await import('@google-cloud/firestore');
  _db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
  return _db;
}

/** Whitelist of redirect URI schemes/hosts. https, or http on loopback only. */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function registerClient(body: Record<string, unknown>): Promise<{
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}> {
  const client_id = crypto.randomUUID();
  const client_secret = crypto.randomBytes(32).toString('base64url');

  const raw = body['redirect_uris'];
  const redirectUris = Array.isArray(raw)
    ? raw.filter((u): u is string => typeof u === 'string' && isAllowedRedirectUri(u))
    : [];

  const entry: ClientEntry = { clientSecret: client_secret, redirectUris };

  const db = await getDb();
  if (db) {
    await db.collection('mcp-clients').doc(client_id).set(entry);
  } else {
    clientsMemory.set(client_id, entry);
  }

  return { client_id, client_secret, redirect_uris: redirectUris };
}

/** Look up a registered client. Returns null if unknown. */
export async function getClient(clientId: string): Promise<ClientEntry | null> {
  if (!clientId) return null;
  const db = await getDb();
  if (db) {
    const doc = await db.collection('mcp-clients').doc(clientId).get();
    if (!doc.exists) return null;
    const data = doc.data() as ClientEntry;
    return {
      clientSecret: String(data.clientSecret ?? ''),
      redirectUris: Array.isArray(data.redirectUris) ? data.redirectUris.map(String) : [],
    };
  }
  return clientsMemory.get(clientId) ?? null;
}

/** Verify a redirect_uri is exactly registered for this client. */
export async function isRegisteredRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
  const c = await getClient(clientId);
  if (!c) return false;
  return c.redirectUris.includes(redirectUri);
}

/** Issue a short-lived auth code bound to client_id + redirect_uri. */
export async function issueAuthCode(
  bearerToken: string,
  codeChallenge: string,
  clientId: string,
  redirectUri: string,
): Promise<string> {
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 5 * 60 * 1000;

  const db = await getDb();
  if (db) {
    await db.collection('mcp-auth-codes').doc(code).set({
      bearerToken,
      codeChallenge,
      clientId,
      redirectUri,
      expiresAt: new Date(expiresAt),
    });
  } else {
    authCodesMemory.set(code, { bearerToken, codeChallenge, clientId, redirectUri, expiresAt });
  }
  return code;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Validate auth code + PKCE verifier + client binding and return the bearer token.
 * Returns null if the code is invalid, expired, the verifier doesn't match, or the
 * presented client_id / redirect_uri don't match what was bound at issue time.
 * Consumes the code on success (single-use).
 */
export async function consumeAuthCode(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
): Promise<string | null> {
  const db = await getDb();

  if (db) {
    const doc = await db.collection('mcp-auth-codes').doc(code).get();
    if (!doc.exists) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = doc.data() as any;
    const expiresAt: number = data.expiresAt?.toDate?.()?.getTime() ?? 0;
    if (expiresAt < Date.now()) {
      await doc.ref.delete().catch(() => {});
      return null;
    }
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    if (!safeEqual(challenge, String(data.codeChallenge ?? ''))) return null;
    if (!safeEqual(clientId, String(data.clientId ?? ''))) return null;
    if (!safeEqual(redirectUri, String(data.redirectUri ?? ''))) return null;
    await doc.ref.delete().catch(() => {});
    return data.bearerToken as string;
  }

  const stored = authCodesMemory.get(code);
  if (!stored || stored.expiresAt < Date.now()) {
    authCodesMemory.delete(code);
    return null;
  }
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  if (!safeEqual(challenge, stored.codeChallenge)) return null;
  if (!safeEqual(clientId, stored.clientId)) return null;
  if (!safeEqual(redirectUri, stored.redirectUri)) return null;
  authCodesMemory.delete(code);
  return stored.bearerToken;
}

/** Verify a client_secret against the stored value (constant-time). */
export async function verifyClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
  const c = await getClient(clientId);
  if (!c) return false;
  return safeEqual(clientSecret, c.clientSecret);
}
