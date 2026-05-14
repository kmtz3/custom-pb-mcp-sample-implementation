/**
 * User registry — maps per-user bearer tokens to Google user IDs.
 *
 * Storage: Firestore collection "mcp-users".
 * Document ID: SHA-256 hash of the bearer token (raw token is never stored).
 * Fields: { googleUserId, email, createdAt, lastUsedAt }
 *
 * Only active in multi-tenant mode (GOOGLE_CLIENT_ID set + GCP_PROJECT_ID set).
 * In local dev, this module is never called.
 */

import crypto from 'crypto';

const COLLECTION = 'mcp-users';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;

async function getDb() {
  if (!_db) {
    const { Firestore } = await import('@google-cloud/firestore');
    _db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
  }
  return _db;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface UserRecord {
  googleUserId: string;
  email: string;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * Issue a new bearer token for a user. Replaces any existing token for the same
 * googleUserId so each user has exactly one active token at a time.
 * Returns the raw bearer token (shown once — not stored).
 *
 * PROTOTYPE: this "one active token per googleUserId" model means a single Google
 * account can only be bound to one Productboard workspace at a time — re-authorizing
 * into a second workspace invalidates the first. To support concurrent workspaces
 * under one identity, scope the registry query by (googleUserId, workspaceId) instead
 * of googleUserId alone. See README "Known limitations".
 */
export async function registerUser(googleUserId: string, email: string): Promise<string> {
  const db = await getDb();

  // Delete any previous token for this user
  const existing = await db.collection(COLLECTION)
    .where('googleUserId', '==', googleUserId)
    .get();
  const batch = db.batch();
  for (const doc of existing.docs) batch.delete(doc.ref);

  const bearerToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(bearerToken);

  batch.set(db.collection(COLLECTION).doc(tokenHash), {
    googleUserId,
    email,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  await batch.commit();
  process.stderr.write(`[userRegistry] Registered user ${email} (${googleUserId})\n`);
  return bearerToken;
}

/**
 * Look up which user owns a bearer token.
 * Updates lastUsedAt as a side effect.
 * Returns null if the token is not recognised.
 */
export async function lookupUser(bearerToken: string): Promise<UserRecord | null> {
  const db = await getDb();
  const tokenHash = hashToken(bearerToken);
  const doc = await db.collection(COLLECTION).doc(tokenHash).get();

  if (!doc.exists) return null;

  // Fire-and-forget lastUsedAt update — non-fatal if it fails
  doc.ref.update({ lastUsedAt: new Date() }).catch(() => undefined);

  return doc.data() as UserRecord;
}

/**
 * Revoke all tokens for a given Google user ID.
 */
export async function revokeUser(googleUserId: string): Promise<void> {
  const db = await getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('googleUserId', '==', googleUserId)
    .get();

  const batch = db.batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  process.stderr.write(`[userRegistry] Revoked tokens for user ${googleUserId}\n`);
}
