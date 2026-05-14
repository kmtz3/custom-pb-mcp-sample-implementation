/**
 * Productboard API client with rate limiting, retry, and cursor pagination.
 * Ported from PBToolkit/src/lib/pbClient.js with TypeScript types.
 *
 * Multi-tenant: each request carries a userId in AsyncLocalStorage.
 * getToken() reads that userId and maintains a per-user in-memory cache.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { BASE_US, BASE_EU } from '../constants.js';
import { loadTokens, type StoredTokens } from '../lib/tokenStore.js';
import { refreshAccessToken } from '../lib/oauth.js';
import type { PBPage } from '../types.js';

// ── Request context ───────────────────────────────────────────────────────────
// Set by the /mcp middleware; read by getToken() so tools don't need to pass
// userId explicitly.

export const requestContext = new AsyncLocalStorage<{ userId?: string }>();

function currentUserId(): string | undefined {
  return requestContext.getStore()?.userId;
}

// ── Base URL ──────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (process.env.PB_API_BASE_URL) return process.env.PB_API_BASE_URL;
  return process.env.PB_EU === 'true' ? BASE_EU : BASE_US;
}

// ── Per-user token cache + refresh deduplication ──────────────────────────────
// refreshInFlight prevents concurrent requests for the same expiring user token
// from each triggering a separate refresh (the second would fail because the
// first already consumed the refresh_token).

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const tokenCache = new Map<string, StoredTokens>();
const refreshInFlight = new Map<string, Promise<StoredTokens>>();

function scheduleRefresh(
  cacheKey: string,
  current: StoredTokens,
  userId: string | undefined
): Promise<StoredTokens> {
  let inFlight = refreshInFlight.get(cacheKey);
  if (!inFlight) {
    inFlight = refreshAccessToken(current, userId)
      .then(refreshed => {
        tokenCache.set(cacheKey, refreshed);
        return refreshed;
      })
      .catch(err => {
        tokenCache.delete(cacheKey);
        throw err;
      })
      .finally(() => refreshInFlight.delete(cacheKey));
    refreshInFlight.set(cacheKey, inFlight);
  }
  return inFlight;
}

async function getToken(): Promise<string> {
  const userId = currentUserId();
  const cacheKey = userId ?? '';

  let cached = tokenCache.get(cacheKey) ?? null;

  if (!cached) {
    cached = await loadTokens(userId);
    if (!cached) {
      const hint = userId
        ? `Visit /setup to connect your Productboard account.`
        : `Visit /setup to authorize via OAuth.`;
      throw new Error(`Productboard is not connected. ${hint}`);
    }
    tokenCache.set(cacheKey, cached);
  }

  if (cached.expires_at && Date.now() > cached.expires_at - EXPIRY_BUFFER_MS) {
    if (cached.refresh_token) {
      try {
        cached = await scheduleRefresh(cacheKey, cached, userId);
      } catch {
        throw new Error('Token expired and refresh failed. Visit /setup to re-authorize.');
      }
    }
  }

  return cached.access_token;
}

/** Invalidate cached token(s). Pass userId to target one user; omit to clear all. */
export function invalidateTokenCache(userId?: string): void {
  if (userId !== undefined) {
    tokenCache.delete(userId);
  } else {
    tokenCache.clear();
  }
}

// ── Per-user rate limiter ─────────────────────────────────────────────────────
// PB rate limits are per-token (per user). A shared singleton would cause
// User A's limit headers to throttle User B's requests and vice versa.

interface RateLimiter {
  lastRequestTime: number;
  remaining: number | null;
  limit: number;
  minDelay: number;
}

const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(userId: string | undefined): RateLimiter {
  const key = userId ?? '';
  let rl = rateLimiters.get(key);
  if (!rl) {
    rl = { lastRequestTime: 0, remaining: null, limit: 50, minDelay: 20 };
    rateLimiters.set(key, rl);
  }
  return rl;
}

function updateRateLimit(headers: Headers, userId: string | undefined): void {
  const rl = getRateLimiter(userId);
  const limit =
    headers.get('x-ratelimit-limit-second') ??
    headers.get('ratelimit-limit') ??
    headers.get('x-ratelimit-limit');
  const remaining =
    headers.get('x-ratelimit-remaining-second') ??
    headers.get('ratelimit-remaining') ??
    headers.get('x-ratelimit-remaining');

  if (limit) rl.limit = parseInt(limit, 10);
  if (remaining !== null) rl.remaining = parseInt(remaining, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(userId: string | undefined): Promise<void> {
  const rl = getRateLimiter(userId);
  const now = Date.now();
  let delay = rl.minDelay;

  if (rl.remaining !== null && rl.remaining < 10) {
    delay = Math.max(100, rl.minDelay * 5);
  } else if (rl.remaining !== null && rl.remaining < 20) {
    delay = rl.minDelay * 2;
  }

  const elapsed = now - rl.lastRequestTime;
  if (elapsed < delay) await sleep(delay - elapsed);
  rl.lastRequestTime = Date.now();
}

// ── HTTP client ───────────────────────────────────────────────────────────────

interface PBError extends Error {
  status?: number;
  retryAfter?: number;
}

export async function pbFetch<T>(
  method: string,
  pathOrUrl: string,
  body?: unknown,
  _isRetry = false
): Promise<T> {
  const userId = currentUserId();
  await throttle(userId);

  const cacheKey = userId ?? '';
  const token = await getToken();
  const baseUrl = getBaseUrl();
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

  const isV2 = pathOrUrl.includes('/v2/');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (!isV2) headers['X-Version'] = '1';

  const opts: RequestInit = { method: method.toUpperCase(), headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  updateRateLimit(res.headers, userId);

  const text = await res.text();
  if (res.ok) return text ? (JSON.parse(text) as T) : ({} as T);

  if (res.status === 401 && !_isRetry) {
    const current = tokenCache.get(cacheKey);
    if (current?.refresh_token) {
      try {
        await scheduleRefresh(cacheKey, current, userId);
        return pbFetch(method, pathOrUrl, body, true);
      } catch {
        throw new Error('Token expired and refresh failed. Visit /setup to re-authorize.');
      }
    }
  }

  if (res.status === 401) tokenCache.delete(cacheKey);

  const err: PBError = new Error(`PB ${method.toUpperCase()} ${url} → ${res.status}: ${text}`);
  err.status = res.status;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) err.retryAfter = parseInt(retryAfter, 10);
  throw err;
}

export async function withRetry<T>(fn: () => Promise<T>, label = 'request'): Promise<T> {
  const maxAttempts = 6;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const pbErr = err as PBError;
      const status = pbErr.status ?? 0;
      const retryable = status === 429 || (status >= 500 && status < 600);

      if (!retryable || i === maxAttempts - 1) throw err;

      let delay: number;
      if (status === 429 && pbErr.retryAfter) {
        delay = pbErr.retryAfter * 1000;
        process.stderr.write(`${label}: 429 rate limited, Retry-After: ${pbErr.retryAfter}s\n`);
      } else {
        delay = Math.floor(Math.pow(2, i) * 250 + Math.random() * 200);
        process.stderr.write(`${label}: ${status} error (attempt ${i + 1}), backoff ${delay}ms\n`);
      }
      await sleep(delay);
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

export async function fetchAllPages<T>(path: string, label?: string): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = path;
  while (nextUrl) {
    const r = await withRetry(() => pbFetch<PBPage<T>>('GET', nextUrl!), label ?? path);
    if (r.data?.length) items.push(...r.data);
    nextUrl = r.links?.next ?? null;
  }
  return items;
}

export async function fetchPage<T>(
  pathOrUrl: string,
  label?: string
): Promise<{ data: T[]; nextUrl: string | null }> {
  const r = await withRetry(() => pbFetch<PBPage<T>>('GET', pathOrUrl), label ?? pathOrUrl);
  return { data: r.data ?? [], nextUrl: r.links?.next ?? null };
}
