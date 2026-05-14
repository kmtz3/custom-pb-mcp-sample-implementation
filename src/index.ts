#!/usr/bin/env node
/**
 * Productboard MCP Server — HTTP (Streamable HTTP transport)
 *
 * ── Single-user / local dev mode (no GOOGLE_CLIENT_ID) ───────────────────────
 *   GET  /setup           → redirect to Productboard OAuth consent
 *   GET  /setup/callback  → exchange code for token, store it
 *   POST /mcp             → MCP endpoint; auth via MCP_AUTH_SECRET if set
 *   GET  /health          → liveness check
 *
 * ── Multi-tenant mode (GOOGLE_CLIENT_ID set) ─────────────────────────────────
 *   GET  /auth/google          → redirect to Google OAuth (hd=productboard.com)
 *   GET  /auth/google/callback → verify domain, store identity in session
 *   GET  /setup                → Productboard OAuth (requires Google auth first)
 *   GET  /setup/callback       → store per-user PB token; issue bearer token
 *   POST /mcp                  → bearer token → Firestore lookup → userId → PB token
 *   GET  /health               → liveness check
 *
 * Required env vars:
 *   PB_OAUTH_CLIENT_ID     Productboard OAuth app client ID
 *   PB_OAUTH_CLIENT_SECRET Productboard OAuth app client secret
 *   APP_URL                Public base URL, e.g. https://xyz.run.app
 *   SESSION_SECRET         Random string for signing session cookies
 *
 * Additional env vars for multi-tenant mode:
 *   GOOGLE_CLIENT_ID       Google OAuth app client ID
 *   GOOGLE_CLIENT_SECRET   Google OAuth app client secret
 *   GCP_PROJECT_ID         Enables Secret Manager + Firestore
 *
 * Optional:
 *   PORT                   HTTP port (default 3000)
 *   MCP_AUTH_SECRET        Single shared bearer token (single-user mode only)
 *   GOOGLE_ALLOWED_DOMAIN  G Suite domain to allow (default: productboard.com)
 *   PB_EU                  "true" to use EU datacenter
 *   PB_API_KEY             Skip OAuth entirely (local dev shortcut)
 */

import express from 'express';
import session from 'express-session';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { registerEntityTools } from './tools/entities.js';
import { registerNoteTools } from './tools/notes.js';
import { registerMemberTools } from './tools/members.js';
import { registerFieldTools } from './tools/fields.js';
import { handleSetupStart, handleSetupCallback } from './lib/oauth.js';
import { handleGoogleAuthStart, handleGoogleAuthCallback } from './lib/googleAuth.js';
import { lookupUser } from './lib/userRegistry.js';
import { invalidateTokenCache, requestContext } from './services/pbClient.js';
import { FirestoreSessionStore } from './lib/firestoreSessionStore.js';
import { registerClient, consumeAuthCode, isRegisteredRedirectUri, getClient, verifyClientSecret } from './lib/pkceStore.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'change-me-in-production';
const MCP_AUTH_SECRET = process.env.MCP_AUTH_SECRET;

function isMultiTenant(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID;
}

// ── MCP server factory (one instance per request — stateless HTTP transport
// cannot share a single McpServer across concurrent connections) ─────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'productboard-mcp-server',
    version: '1.0.0',
  });
  registerEntityTools(server);
  registerNoteTools(server);
  registerMemberTools(server);
  registerFieldTools(server);
  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Firestore-backed store in GCP deployments — prevents OAuth session loss
  // when Cloud Run scales horizontally and callbacks land on a different instance.
  store: process.env.GCP_PROJECT_ID ? new FirestoreSessionStore() : undefined,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 60 * 1000, // 30 min — covers Google + PB OAuth round trip
  },
}));

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'productboard-mcp-server', multiTenant: isMultiTenant() });
});

// ── OAuth 2.0 Discovery (RFC 8414) ────────────────────────────────────────────
// Advertises the authorization + token + registration endpoints so that MCP
// clients (e.g. Claude Code) can discover them automatically.

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = process.env.APP_URL ?? `https://${req.hostname}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  });
});

// ── OAuth Dynamic Client Registration (RFC 7591) ──────────────────────────────

app.post('/register', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawUris = body['redirect_uris'];
  if (!Array.isArray(rawUris) || rawUris.length === 0 || !rawUris.every((u) => typeof u === 'string')) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required and must be a non-empty array of strings' });
    return;
  }
  const { client_id, client_secret, redirect_uris } = await registerClient(body);
  if (redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'No allowed redirect_uris (must be https, or http on loopback)' });
    return;
  }
  res.status(201).json({
    client_id,
    client_secret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris,
  });
});

// ── OAuth Authorization Endpoint ──────────────────────────────────────────────
// MCP clients land here first. We save their PKCE state in the session, then
// hand off to the existing Google → PB OAuth chain. The setup/callback handler
// detects the session PKCE state and redirects back to the client at the end.

app.get('/oauth/authorize', async (req, res) => {
  const { state, code_challenge, redirect_uri, client_id, code_challenge_method } = req.query as Record<string, string>;

  if (!client_id || !redirect_uri || !state || !code_challenge) {
    res.status(400).send('Missing required parameter (client_id, redirect_uri, state, code_challenge).');
    return;
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    res.status(400).send('Unsupported code_challenge_method — only S256 is supported.');
    return;
  }
  if (!(await getClient(client_id))) {
    res.status(400).send('Unknown client_id. Register first.');
    return;
  }
  if (!(await isRegisteredRedirectUri(client_id, redirect_uri))) {
    // Per OAuth 2.1: do NOT redirect to an unregistered URI; render an error instead.
    res.status(400).send('redirect_uri does not match a registered URI for this client.');
    return;
  }

  const session = req.session as unknown as Record<string, unknown>;
  session['pkce_state'] = state;
  session['pkce_code_challenge'] = code_challenge;
  session['pkce_redirect_uri'] = redirect_uri;
  session['pkce_client_id'] = client_id;

  try {
    if (isMultiTenant()) {
      await handleGoogleAuthStart(req, res);
    } else {
      await handleSetupStart(req, res);
    }
  } catch (err) {
    if (!res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).send(`Authorization failed: ${msg}. <a href="/">Try again</a>.`);
    }
  }
});

// ── OAuth Token Endpoint ──────────────────────────────────────────────────────

app.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
  const { code, code_verifier, grant_type, redirect_uri } = req.body as Record<string, string>;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code || !code_verifier || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request', error_description: 'code, code_verifier, and redirect_uri are required' });
    return;
  }

  // Resolve client_id from body, Basic auth, or rely on the binding stored with the code.
  let clientId = (req.body as Record<string, string>)['client_id'];
  let clientSecret = (req.body as Record<string, string>)['client_secret'];
  const basic = req.headers['authorization'];
  if (basic?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        clientId = clientId ?? decoded.slice(0, idx);
        clientSecret = clientSecret ?? decoded.slice(idx + 1);
      }
    } catch { /* ignore malformed header */ }
  }
  if (!clientId) {
    res.status(400).json({ error: 'invalid_client', error_description: 'client_id is required' });
    return;
  }
  const client = await getClient(clientId);
  if (!client) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }
  // Confidential clients (those that received a secret) must authenticate.
  if (client.clientSecret && !(clientSecret && (await verifyClientSecret(clientId, clientSecret)))) {
    res.status(401).json({ error: 'invalid_client', error_description: 'client authentication failed' });
    return;
  }

  const bearerToken = await consumeAuthCode(code, code_verifier, clientId, redirect_uri);
  if (!bearerToken) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired, not found, or PKCE / client / redirect_uri mismatch' });
    return;
  }

  res.json({
    access_token: bearerToken,
    token_type: 'bearer',
    expires_in: 31536000,
  });
});

// ── Google OAuth routes (multi-tenant only) ───────────────────────────────────

app.get('/auth/google', async (req, res) => {
  if (!isMultiTenant()) {
    res.status(404).send('Not found.');
    return;
  }
  try {
    await handleGoogleAuthStart(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`Google auth error: ${msg}`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  if (!isMultiTenant()) {
    res.status(404).send('Not found.');
    return;
  }
  try {
    const user = await handleGoogleAuthCallback(req, res);
    if (!user) return; // response already sent by handler
    const session = req.session as unknown as Record<string, unknown>;
    session['googleUserId'] = user.googleUserId;
    session['googleEmail'] = user.email;
    // Explicitly save so googleUserId + PKCE fields are in Firestore before
    // the browser follows the redirect to /setup → PB OAuth.
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    res.redirect('/setup');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[google/callback] Error: ${msg}\n`);
    res.status(500).send(`Google auth failed: ${msg}. <a href="/auth/google">Try again</a>.`);
  }
});

// ── Productboard OAuth setup ──────────────────────────────────────────────────

app.get('/setup', async (req, res) => {
  try {
    await handleSetupStart(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`Setup error: ${msg}. Check your PB_OAUTH_CLIENT_ID and APP_URL env vars.`);
  }
});

app.get('/setup/callback', async (req, res) => {
  try {
    const userId = await handleSetupCallback(req, res);
    // Invalidate cache for this user so the next /mcp call loads the fresh token
    if (userId) invalidateTokenCache(userId);
    else invalidateTokenCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[setup] Callback error: ${msg}\n`);
    res.status(500).send(`Setup failed: ${msg}. <a href="/setup">Try again</a>.`);
  }
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────
// Auth strategy:
//   Multi-tenant — bearer token looked up in Firestore → userId injected into context
//   Single-user  — optional MCP_AUTH_SECRET check (if set)

app.post('/mcp', async (req, res) => {
  let userId: string | undefined;

  if (isMultiTenant()) {
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing Authorization header.' });
      return;
    }
    const user = await lookupUser(token).catch(() => null);
    if (!user) {
      res.status(401).json({ error: 'Unrecognised token. Visit /setup to connect your account.' });
      return;
    }
    userId = user.googleUserId;
  } else if (MCP_AUTH_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${MCP_AUTH_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => transport.close());

  try {
    await requestContext.run({ userId }, async () => {
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.redirect(isMultiTenant() ? '/auth/google' : '/setup');
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const mode = isMultiTenant() ? 'multi-tenant' : 'single-user';
  process.stderr.write(`Productboard MCP server listening on http://localhost:${PORT} [${mode}]\n`);
  if (isMultiTenant()) {
    process.stderr.write(`  Setup:  http://localhost:${PORT}/auth/google\n`);
  } else {
    process.stderr.write(`  Setup:  http://localhost:${PORT}/setup\n`);
  }
  process.stderr.write(`  MCP:    http://localhost:${PORT}/mcp\n`);
});
