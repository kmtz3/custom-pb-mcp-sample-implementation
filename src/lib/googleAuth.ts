/**
 * Google OAuth 2.0 helpers — used to gate /setup to a specific G Suite domain.
 *
 * Multi-tenant mode is active when GOOGLE_CLIENT_ID is set.
 * In local dev (no GOOGLE_CLIENT_ID) these helpers are never called.
 *
 * Env vars:
 *   GOOGLE_CLIENT_ID      Google OAuth app client ID
 *   GOOGLE_CLIENT_SECRET  Google OAuth app client secret
 *   GOOGLE_ALLOWED_DOMAIN Allowed G Suite domain (default: productboard.com)
 *   APP_URL               Public base URL of this service
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function getRequiredEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

export function allowedDomain(): string {
  return process.env.GOOGLE_ALLOWED_DOMAIN ?? 'productboard.com';
}

export async function handleGoogleAuthStart(req: Request, res: Response): Promise<void> {
  const clientId = getRequiredEnv('GOOGLE_CLIENT_ID');
  const appUrl = getRequiredEnv('APP_URL');

  const state = crypto.randomBytes(16).toString('base64url');
  (req.session as unknown as Record<string, unknown>)['googleState'] = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: `${appUrl}/auth/google/callback`,
    scope: 'openid email profile',
    hd: allowedDomain(),
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  // Explicitly save before redirecting so Firestore has the session data
  // (including any PKCE fields set by the /oauth/authorize handler) before
  // the browser follows the cross-origin Google redirect.
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
}

export interface GoogleUser {
  googleUserId: string;
  email: string;
}

/**
 * Exchange the auth code for tokens, fetch user info, and verify the hd claim.
 * Returns the verified user or sends an error response and returns null.
 */
export async function handleGoogleAuthCallback(
  req: Request,
  res: Response
): Promise<GoogleUser | null> {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`Google auth error: ${error}. <a href="/auth/google">Try again</a>.`);
    return null;
  }

  const session = req.session as unknown as Record<string, unknown>;
  if (!state || state !== session['googleState']) {
    res.status(400).send('Invalid state — possible CSRF. <a href="/auth/google">Try again</a>.');
    return null;
  }
  delete session['googleState'];

  const clientId = getRequiredEnv('GOOGLE_CLIENT_ID');
  const clientSecret = getRequiredEnv('GOOGLE_CLIENT_SECRET');
  const appUrl = getRequiredEnv('APP_URL');

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${appUrl}/auth/google/callback`,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    process.stderr.write(`[googleAuth] Token exchange failed: ${tokenRes.status} ${body}\n`);
    res.status(500).send('Google token exchange failed. <a href="/auth/google">Try again</a>.');
    return null;
  }

  const tokenData = await tokenRes.json() as { access_token: string };

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    res.status(500).send('Failed to fetch Google user info. <a href="/auth/google">Try again</a>.');
    return null;
  }

  const user = await userRes.json() as { sub: string; email: string; hd?: string };

  if (user.hd !== allowedDomain()) {
    process.stderr.write(`[googleAuth] Rejected login from domain: ${user.hd ?? 'unknown'}\n`);
    res.status(403).send(
      `Access is restricted to @${allowedDomain()} accounts. You signed in as ${user.email}.`
    );
    return null;
  }

  return { googleUserId: user.sub, email: user.email };
}
