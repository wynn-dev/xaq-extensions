// The WHOOP v2 API client (https://developer.whoop.com/api/). Every request goes through the RateGate, asks xaq for
// the access token (never stored on disk, never logged), and maps failures onto the dashboard's error codes, so
// `sync_now` and `get_status` speak the same words as before: reconnect_required, rate_limited, whoop_unavailable.

import { RateGate, RateLimitedError } from "./ratelimit.ts";

export const WHOOP_ORIGIN = "https://api.prod.whoop.com";
export const PAGE_MAX = 25;
const MAX_PAGES = 2_000;

export const PATHS = {
  profile: "/v2/user/profile/basic",
  cycle: "/v2/cycle",
  recovery: "/v2/recovery",
  sleep: "/v2/activity/sleep",
  workout: "/v2/activity/workout",
} as const;

export type WhoopErrorCode = "reconnect_required" | "rate_limited" | "whoop_unavailable" | "invalid_response" | "incomplete_import" | "request_failed";

export class WhoopError extends Error {
  constructor(
    readonly code: WhoopErrorCode,
    readonly detail = "",
  ) {
    super(code);
    this.name = "WhoopError";
  }
}

export interface AccessToken {
  accessToken: string;
  /** Epoch ms, or null when xaq doesn't know. */
  expiresAt: number | null;
}

export interface ApiOptions {
  /** API base including `/developer`. */
  base: string;
  /** Asks xaq (xaq/credentials/get). Throws when the connection needs re-authorising. */
  credentials: () => Promise<AccessToken>;
  gate: RateGate;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
}

/**
 * The API base. Production is always WHOOP. `XAQ_EXT_WHOOP_API` exists for the test harness only and is honoured
 * only for a loopback http origin, so a stray value can never send the bearer token to another host. xaq's host
 * passes a fixed, minimal environment and never sets it.
 */
export function apiBase(env: Record<string, string | undefined>): string {
  const override = env.XAQ_EXT_WHOOP_API;
  if (override) {
    let u: URL | null = null;
    try {
      u = new URL(override);
    } catch {
      u = null;
    }
    if (u && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.pathname === "/" && !u.username && !u.password) {
      return `${u.origin}/developer`;
    }
  }
  return `${WHOOP_ORIGIN}/developer`;
}

/** Backoff from a 429: Retry-After (seconds or an HTTP date), else X-RateLimit-Reset (seconds), else 60 s; at most 1 h. */
export function retryAfterMs(headers: Headers, now = Date.now()): number {
  const ra = headers.get("retry-after")?.trim();
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra)) return clampRetry(Number(ra) * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return clampRetry(at - now);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+(\.\d+)?$/.test(reset)) return clampRetry(Number(reset) * 1000);
  return 60_000;
}
const clampRetry = (ms: number) => Math.min(3_600_000, Math.max(1_000, Math.ceil(ms)));

export class WhoopApi {
  private readonly opts: Required<Omit<ApiOptions, "fetch">> & { fetch: typeof fetch };
  private token: AccessToken | null = null;
  private tokenRequest: Promise<AccessToken> | null = null;
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** When the last request WHOOP answered successfully (epoch ms). */
  lastOkAt: number | null = null;

  constructor(opts: ApiOptions) {
    this.opts = {
      fetch: opts.fetch ?? fetch,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      timeoutMs: opts.timeoutMs ?? 20_000,
      base: opts.base,
      credentials: opts.credentials,
      gate: opts.gate,
    };
  }

  /** GET a v2 path; concurrent identical requests share one fetch. Null on 404. */
  get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T | null> {
    const url = new URL(this.opts.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const key = url.href;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T | null>;
    const p = this.request<T>(url).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Every record of a collection overlapping [start, end), across pages. */
  async collect<T>(path: string, start: string, end?: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get<{ records?: unknown; next_token?: unknown }>(path, { start, end, limit: String(PAGE_MAX), nextToken: next });
      if (!body) return out;
      if (!Array.isArray(body.records)) throw new WhoopError("invalid_response", "a collection page without records");
      for (const r of body.records) if (r && typeof r === "object") out.push(r as T);
      const token = typeof body.next_token === "string" && body.next_token ? body.next_token : undefined;
      if (!token) return out;
      if (seen.has(token)) throw new WhoopError("incomplete_import", "WHOOP repeated a page token");
      seen.add(token);
      next = token;
    }
    throw new WhoopError("incomplete_import", "too many pages");
  }

  /** Forget the cached access token (the next request asks xaq again). */
  dropToken(): void {
    this.token = null;
  }

  private async accessToken(force: boolean): Promise<string> {
    const t = this.token;
    if (!force && t && (t.expiresAt === null || t.expiresAt - 60_000 > this.opts.now())) return t.accessToken;
    this.tokenRequest ??= (async () => {
      try {
        const c = await this.opts.credentials();
        if (!c || typeof c.accessToken !== "string" || !c.accessToken) throw new Error("no access token");
        return c;
      } catch (err) {
        if (err instanceof WhoopError) throw err;
        throw new WhoopError("reconnect_required", "xaq has no working WHOOP token for this connection");
      } finally {
        this.tokenRequest = null;
      }
    })();
    const next = await this.tokenRequest;
    this.token = next;
    return next.accessToken;
  }

  private async request<T>(url: URL): Promise<T | null> {
    const { gate, sleep, random, timeoutMs } = this.opts;
    let token = await this.accessToken(false);
    let refreshed = false;
    let limited = 0;
    let failed = 0;
    const backoff = async () => sleep(1_000 * 2 ** failed + Math.floor(random() * 500));
    for (;;) {
      let res: Response;
      try {
        res = await gate.run(() =>
          this.opts.fetch(url, {
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
      } catch (err) {
        if (err instanceof RateLimitedError) throw new WhoopError("rate_limited", "the extension's own rate budget is spent");
        if (failed++ < 1) {
          await backoff();
          continue;
        }
        throw new WhoopError("whoop_unavailable", "WHOOP is unreachable");
      }
      if (res.status === 401) {
        await res.body?.cancel();
        if (!refreshed) {
          refreshed = true;
          const next = await this.accessToken(true);
          if (next !== token) {
            token = next;
            continue;
          }
        }
        this.token = null;
        throw new WhoopError("reconnect_required", "WHOOP rejected the access token");
      }
      if (res.status === 403) {
        await res.body?.cancel();
        throw new WhoopError("reconnect_required", "WHOOP refused the request (403): the connection may be missing a scope");
      }
      if (res.status === 429) {
        await res.body?.cancel();
        gate.block(retryAfterMs(res.headers, this.opts.now()));
        // The gate holds every request until the block passes; give up after two 429s in a row.
        if (limited++ < 2) continue;
        throw new WhoopError("rate_limited", "WHOOP's rate limit was reached");
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        if (failed++ < 1) {
          await backoff();
          continue;
        }
        throw new WhoopError("whoop_unavailable", `WHOOP answered ${res.status}`);
      }
      if (res.status === 404) {
        await res.body?.cancel();
        this.lastOkAt = this.opts.now();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new WhoopError("request_failed", `WHOOP refused the request (${res.status})`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new WhoopError("invalid_response", "WHOOP sent a response that isn't JSON");
      }
      this.lastOkAt = this.opts.now();
      return body as T;
    }
  }
}
