/**
 * Productboard OAuth 2.1 + PKCE helpers.
 * Ported from PBToolkit/src/routes/auth.js.
 *
 * In multi-tenant mode (GOOGLE_CLIENT_ID set), the setup flow expects
 * `googleUserId` and `email` to already be stored in the session by
 * handleGoogleAuthCallback before /setup is called.
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { saveTokens, type StoredTokens } from './tokenStore.js';
import { registerUser } from './userRegistry.js';
import { issueAuthCode } from './pkceStore.js';

function pbBaseUrl(useEu: boolean): string {
  return useEu ? 'https://app.eu.productboard.com' : 'https://app.productboard.com';
}

function randomBase64url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function sha256Base64url(str: string): string {
  return crypto.createHash('sha256').update(str).digest('base64url');
}

function getRequiredEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

function isMultiTenant(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function handleSetupStart(req: Request, res: Response): Promise<void> {
  // In multi-tenant mode the user must have completed Google auth first
  if (isMultiTenant()) {
    const session = req.session as unknown as Record<string, unknown>;
    if (!session['googleUserId']) {
      res.redirect('/auth/google');
      return;
    }
  }

  const clientId = getRequiredEnv('PB_OAUTH_CLIENT_ID');
  const appUrl = getRequiredEnv('APP_URL');
  const redirectUri = `${appUrl}/setup/callback`;
  const useEu = req.query['eu'] === 'true';

  const state = randomBase64url(16);
  const codeVerifier = randomBase64url(32);
  const codeChallenge = sha256Base64url(codeVerifier);

  const session = req.session as unknown as Record<string, unknown>;
  session['oauthState'] = state;
  session['oauthVerifier'] = codeVerifier;
  session['useEu'] = useEu;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  // Explicitly save before redirecting so all session data (including PKCE
  // fields from /oauth/authorize) is in Firestore before the PB redirect fires.
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

  res.redirect(`${pbBaseUrl(useEu)}/oauth2/authorize?${params}`);
}

export async function handleSetupCallback(req: Request, res: Response): Promise<string | undefined> {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`OAuth error: ${error}. <a href="/setup">Try again</a>.`);
    return;
  }

  const session = req.session as unknown as Record<string, unknown>;
  if (!state || state !== session['oauthState']) {
    res.status(400).send('Invalid state — possible CSRF. <a href="/setup">Try again</a>.');
    return;
  }

  const clientId = getRequiredEnv('PB_OAUTH_CLIENT_ID');
  const clientSecret = getRequiredEnv('PB_OAUTH_CLIENT_SECRET');
  const appUrl = getRequiredEnv('APP_URL');
  const redirectUri = `${appUrl}/setup/callback`;
  const codeVerifier = session['oauthVerifier'] as string;
  const useEu = session['useEu'] as boolean ?? false;

  // Read Google identity before clearing session
  const googleUserId = session['googleUserId'] as string | undefined;
  const email = session['googleEmail'] as string | undefined;

  delete session['oauthState'];
  delete session['oauthVerifier'];

  const tokenRes = await fetch(`${pbBaseUrl(useEu)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    process.stderr.write(`[oauth] Token exchange failed: ${tokenRes.status} ${body}\n`);
    res.status(500).send('Token exchange failed. <a href="/setup">Try again</a>.');
    return;
  }

  const data = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    res.status(500).send('No access_token in response. <a href="/setup">Try again</a>.');
    return;
  }

  const stored: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    use_eu: useEu,
  };

  await saveTokens(stored, googleUserId);

  // Issue a bearer token for this user.
  // Multi-tenant: register a per-user token in Firestore.
  // Single-user:  use MCP_AUTH_SECRET if set, or an ephemeral random token
  //               (the /mcp endpoint accepts any bearer when no secret is configured).
  let bearerToken: string | undefined;
  if (isMultiTenant() && googleUserId && email) {
    bearerToken = await registerUser(googleUserId, email);
  } else if (!isMultiTenant()) {
    bearerToken = process.env.MCP_AUTH_SECRET ?? crypto.randomBytes(16).toString('base64url');
  }

  // If this auth was initiated by an MCP client (Claude Code PKCE flow),
  // redirect back to the client's callback URL with an auth code instead of
  // showing the success page.
  const pkceRedirectUri = session['pkce_redirect_uri'] as string | undefined;
  const pkceState = session['pkce_state'] as string | undefined;
  const pkceCodeChallenge = session['pkce_code_challenge'] as string | undefined;
  const pkceClientId = session['pkce_client_id'] as string | undefined;

  if (pkceRedirectUri && pkceState && pkceCodeChallenge && pkceClientId && bearerToken) {
    let callbackUrl: URL | undefined;
    try {
      callbackUrl = new URL(pkceRedirectUri);
    } catch {
      process.stderr.write(`[oauth] Invalid pkce_redirect_uri in session: "${pkceRedirectUri}" — falling back to success page\n`);
    }

    if (callbackUrl) {
      delete session['pkce_state'];
      delete session['pkce_code_challenge'];
      delete session['pkce_redirect_uri'];
      delete session['pkce_client_id'];

      const authCode = await issueAuthCode(bearerToken, pkceCodeChallenge, pkceClientId, pkceRedirectUri);
      callbackUrl.searchParams.set('code', authCode);
      callbackUrl.searchParams.set('state', pkceState);
      res.redirect(callbackUrl.toString());
      return googleUserId;
    }
  }

  const mcpConfig = bearerToken
    ? JSON.stringify({
        mcpServers: {
          'productboard': {
            type: 'http',
            url: `${appUrl}/mcp`,
            headers: { Authorization: `Bearer ${bearerToken}` },
          },
        },
      }, null, 2)
    : JSON.stringify({
        mcpServers: { 'productboard': { type: 'http', url: `${appUrl}/mcp` } },
      }, null, 2);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connected to Productboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      --c-text: #111827;
      --c-muted: #6b7280;
      --c-bg: #f9fafb;
      --c-surface: #ffffff;
      --c-brand: #355E3B;
      --c-brand-light: #edf7ee;
      --c-border: #e5e7eb;
      --font: 'Manrope', system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--font);
      color: var(--c-text);
      background: var(--c-bg);
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-radius: 16px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--c-brand-light);
      color: var(--c-brand);
      margin-bottom: 16px;
      font-size: 24px;
      font-weight: 700;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin: 0 0 8px;
      letter-spacing: -0.01em;
    }
    .signed-in {
      color: var(--c-muted);
      font-size: 14px;
      margin: 0 0 24px;
    }
    .signed-in strong { color: var(--c-text); font-weight: 600; }
    .label {
      font-size: 13px;
      font-weight: 600;
      color: var(--c-text);
      margin: 0 0 8px;
    }
    .hint {
      font-size: 12px;
      color: var(--c-muted);
      margin: 0 0 12px;
    }
    pre {
      background: #0f172a;
      color: #e2e8f0;
      padding: 16px;
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.55;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-x: auto;
      margin: 0 0 20px;
    }
    .footer {
      font-size: 13px;
      color: var(--c-muted);
      margin: 0;
      padding-top: 16px;
      border-top: 1px solid var(--c-border);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">&#10003;</div>
    <h1>Connected to Productboard</h1>
    ${email ? `<p class="signed-in">Signed in as <strong>${escapeHtml(email)}</strong></p>` : ''}
    <p class="label">Add this to your Claude MCP config</p>
    ${bearerToken ? '<p class="hint">Keep the bearer token private.</p>' : ''}
    <pre>${escapeHtml(mcpConfig)}</pre>
    <p class="footer">Restart Claude Code after updating the config.</p>
  </div>
</body>
</html>`);

  return googleUserId;
}

/**
 * Exchange a stored refresh token for a new access token.
 * Saves the updated token set and returns it.
 * Throws if no refresh token is available or the request fails.
 */
export async function refreshAccessToken(
  tokens: StoredTokens,
  userId?: string
): Promise<StoredTokens> {
  if (!tokens.refresh_token) {
    throw new Error('No refresh token available. Visit /setup to re-authorize.');
  }

  const clientId = getRequiredEnv('PB_OAUTH_CLIENT_ID');
  const clientSecret = getRequiredEnv('PB_OAUTH_CLIENT_SECRET');
  const useEu = tokens.use_eu ?? false;

  const tokenRes = await fetch(`${pbBaseUrl(useEu)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    process.stderr.write(`[oauth] Token refresh failed: ${tokenRes.status} ${body}\n`);
    throw new Error(`Token refresh failed with status ${tokenRes.status}`);
  }

  const data = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('No access_token in refresh response.');
  }

  const newTokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    use_eu: useEu,
  };

  await saveTokens(newTokens, userId);
  process.stderr.write('[oauth] Access token refreshed and saved.\n');
  return newTokens;
}
