/**
 * Firestore-backed express-session store.
 *
 * Used in multi-tenant / Cloud Run deployments (GCP_PROJECT_ID set) where
 * horizontal scaling means the Google + PB OAuth callbacks can land on a
 * different instance than the one that started the flow, breaking the default
 * in-memory MemoryStore.
 *
 * Collection: mcp-sessions
 * Document schema: { sess: SessionData, expiresAt: Timestamp }
 */

import session from 'express-session';
import { Firestore } from '@google-cloud/firestore';

const COLLECTION = 'mcp-sessions';
const TTL_MS = 60 * 60 * 1000; // 1 hour — generous window for the OAuth round-trip

export class FirestoreSessionStore extends session.Store {
  private db: Firestore;

  constructor() {
    super();
    this.db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
  }

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    this.db.collection(COLLECTION).doc(sid).get()
      .then(doc => {
        if (!doc.exists) return callback(null, null);
        const data = doc.data()!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const expiresAt: Date | null = (data.expiresAt as any)?.toDate?.() ?? null;
        if (expiresAt && expiresAt.getTime() < Date.now()) {
          this.destroy(sid, () => {});
          return callback(null, null);
        }
        callback(null, data.sess as session.SessionData);
      })
      .catch(err => callback(err));
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = new Date(Date.now() + TTL_MS);
    // Firestore rejects objects with custom prototypes (express-session's Session
    // class). Strip to a plain object so the SDK can serialize it.
    const plainSess = JSON.parse(JSON.stringify(sess));
    try {
      this.db.collection(COLLECTION).doc(sid).set({ sess: plainSess, expiresAt })
        .then(() => callback?.())
        .catch(err => callback?.(err));
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.db.collection(COLLECTION).doc(sid).delete()
      .then(() => callback?.())
      .catch(err => callback?.(err));
  }

  touch(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void): void {
    // Extend TTL by re-writing the full document so the session stays alive
    // as long as the OAuth flow is in progress.
    this.set(sid, sess, callback);
  }
}
