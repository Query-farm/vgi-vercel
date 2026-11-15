/**
 * Vercel REST API client: the `vercel` secret, team scoping, rate limits and retries.
 *
 * - **Auth.** A `vercel` DuckDB secret carries an access token (sent as
 *   `Authorization: Bearer <token>`), an optional team (`TEAM_ID` → `teamId=`,
 *   or `TEAM_SLUG` → `slug=` on every team-scoped request) and an optional
 *   `BASE_URL` (default https://api.vercel.com; http:// only for a loopback fixture).
 *   Credentials are read from the secret on every call and never enter scan state.
 * - **Rate limits.** Vercel answers with `X-RateLimit-Limit / -Remaining / -Reset`
 *   (reset = epoch seconds). A 429 waits until the reset (bounded); when the bucket is
 *   about to run dry the client pauses before the next call. 5xx and network errors
 *   retry with exponential backoff.
 * - **Read-only.** Only GET is ever issued.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "vercel";
export const DEFAULT_BASE_URL = "https://api.vercel.com";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-vercel-worker/${VERSION}`;

export class VercelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface VercelConfig {
  baseUrl: string;
  token: string;
  teamId?: string;
  teamSlug?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new VercelError(`vercel secret: base_url '${raw}' is not a URL (expected e.g. https://api.vercel.com)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new VercelError(
      "vercel secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `vercel` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): VercelConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new VercelError(
      "no vercel secret: run CREATE SECRET (TYPE vercel, TOKEN '<access token>') and add TEAM_ID 'team_…' for a team",
    );
  }
  const token = str(s.token);
  if (!token) throw new VercelError("vercel secret: TOKEN is required (create one under Account Settings > Tokens)");
  const teamId = str(s.team_id);
  const teamSlug = str(s.team_slug);
  if (teamId && teamSlug) throw new VercelError("vercel secret: set TEAM_ID or TEAM_SLUG, not both");
  return { baseUrl: normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL), token, teamId, teamSlug };
}

/** The team query parameter every team-scoped request carries. */
export function teamQuery(cfg: VercelConfig): Record<string, string> {
  if (cfg.teamId) return { teamId: cfg.teamId };
  if (cfg.teamSlug) return { slug: cfg.teamSlug };
  return {};
}

/** Build the request URL; undefined / empty query values are dropped. */
export function buildUrl(cfg: VercelConfig, path: string, query: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
  const q = qs.toString();
  return `${cfg.baseUrl}${path}${q ? `?${q}` : ""}`;
}

/** Last rate-limit reading per API origin (module-level: one worker process, many scans). */
const buckets = new Map<string, { remaining: number; resetMs: number }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for a rate-limit reset, from X-RateLimit-Reset (epoch seconds) or Retry-After. */
export function resetDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After");
  if (retry && /^\d+$/.test(retry)) return Number(retry) * 1000;
  const reset = headers.get("X-RateLimit-Reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now) + 250;
  return undefined;
}

/** GET one Vercel API resource and return its parsed JSON body. */
export async function vercelGet(
  cfg: VercelConfig,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<unknown> {
  const url = buildUrl(cfg, path, query);
  const bucketKey = new URL(cfg.baseUrl).origin;

  for (let attempt = 1; ; attempt++) {
    const bucket = buckets.get(bucketKey);
    if (bucket && bucket.remaining <= 1 && bucket.resetMs > Date.now()) {
      const wait = Math.min(bucket.resetMs - Date.now() + 250, MAX_RATE_WAIT_MS);
      log.info(`vercel: rate-limit bucket nearly empty; waiting ${wait} ms for reset`);
      await sleep(wait);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${cfg.token}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new VercelError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const remaining = res.headers.get("X-RateLimit-Remaining");
    const reset = res.headers.get("X-RateLimit-Reset");
    if (remaining && reset && /^\d+$/.test(remaining) && /^\d+$/.test(reset)) {
      buckets.set(bucketKey, { remaining: Number(remaining), resetMs: Number(reset) * 1000 });
    }
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new VercelError(
        `GET ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`,
        res.status,
      );
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(resetDelayMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.debug(`vercel: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Vercel errors are `{"error": {"code": "...", "message": "..."}}`; keep the message short. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
    return [j.error?.code, j.error?.message].filter(Boolean).join(" - ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Show the path + query of a URL in errors (the token is never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
