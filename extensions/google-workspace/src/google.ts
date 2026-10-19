// The one way the extension talks to Google. Every tool gets a GoogleClient; this file owns the interface (shared with
// the Sheets and Slides writers) and its HTTP implementation:
// - the access token comes from xaq (`xaq/credentials/get`), already downscoped to the manifest's scopes; it lives in
//   memory only and is never logged, written or echoed;
// - only https://<name>.googleapis.com URLs, built by the tools from constants (never a URL taken from tool input);
// - per-attempt timeouts, an overall deadline under xaq's 60 s per call, and a response size cap;
// - errors in plain words (GoogleError.message is what the agent reads): 401 → reconnect, a disabled API → the link to
//   enable it, a missing scope → re-consent, 404, and a bounded retry with Retry-After and jitter for 429 and 5xx
//   (5xx and network errors only for GET, so a create is never sent twice). A 429 holds every request of this
//   connection until it passes, so concurrent tool calls don't hammer Google.

export type Query = Record<string, string | number | boolean | undefined>;

export interface GoogleClient {
  json<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T>;
  bytes(method: "GET" | "POST", url: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; contentType?: string }): Promise<{ data: Buffer; contentType: string }>;
}

/** API bases. Build every URL from these. */
export const DRIVE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DOCS = "https://docs.googleapis.com/v1";
export const SHEETS = "https://sheets.googleapis.com/v4";
export const SLIDES = "https://slides.googleapis.com/v1";

/** The APIs the manifest asks the user to enable (code.auth.apis), by service name. */
export const APIS: Record<string, string> = {
  "docs.googleapis.com": "Google Docs API",
  "sheets.googleapis.com": "Google Sheets API",
  "slides.googleapis.com": "Google Slides API",
  "drive.googleapis.com": "Google Drive API",
};

/** A Google answer (JSON or bytes) larger than this is refused. Drive's own export limit is 10 MB. */
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 25_000;
/** All attempts of one request, waits included, fit in this (xaq allows 60 s per tool call). */
const DEADLINE_MS = 45_000;
const MAX_ATTEMPTS = 3;
/** A Retry-After longer than this isn't waited for: the call fails at once and says when to try again. */
const MAX_RETRY_AFTER_MS = 20_000;

export type GoogleErrorCode =
  | "reconnect_required"
  | "api_disabled"
  | "insufficient_scope"
  | "no_file_access"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "too_large"
  | "bad_request"
  | "conflict"
  | "invalid_response";

export class GoogleError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

export interface AccessToken {
  accessToken: string;
  /** Epoch ms, or null when xaq doesn't know. */
  expiresAt: number | null;
}

export interface Logger {
  log(level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
}

export interface ClientOptions {
  /** Asks xaq (xaq/credentials/get). Throws when the connection needs re-authorising. */
  credentials: () => Promise<AccessToken>;
  /** Test only: a loopback http origin that stands in for every googleapis.com host (see testOrigin). */
  testOrigin?: string | null;
  log?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  maxBytes?: number;
}

/**
 * The test override: `XAQ_EXT_GOOGLE_API`, honoured only for a loopback http origin with no path or credentials, so a
 * stray value can never send the token to another host. xaq's host passes a fixed, minimal environment and never
 * sets it. Requests then go to `<origin>/<googleapis host>/<path>`.
 */
export function testOrigin(env: Record<string, string | undefined>): string | null {
  const raw = env.XAQ_EXT_GOOGLE_API;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/" || u.username || u.password || u.search) return null;
  return u.origin;
}

const HOST = /^[a-z0-9-]+\.googleapis\.com$/;

/** The URL to fetch, or a thrown error for anything that isn't https://<name>.googleapis.com/…. */
export function checkedUrl(url: string, query: Query | undefined): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url.slice(0, 100)}`);
  }
  if (u.protocol !== "https:" || !HOST.test(u.hostname) || u.port || u.username || u.password) throw new Error(`refusing to fetch ${u.origin}: only https://*.googleapis.com`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  return u;
}

/** Which Google API a URL belongs to (for "enable the … API" messages). */
export function serviceOf(u: URL): string {
  if (u.hostname === "www.googleapis.com") {
    const first = u.pathname.split("/")[1] === "upload" ? u.pathname.split("/")[2] : u.pathname.split("/")[1];
    return `${first}.googleapis.com`;
  }
  return u.hostname;
}

/** Retry-After in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const ra = headers.get("retry-after")?.trim();
  if (!ra) return null;
  if (/^\d+(\.\d+)?$/.test(ra)) return Math.ceil(Number(ra) * 1000);
  const at = Date.parse(ra);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  errors?: { reason?: string; domain?: string; message?: string }[];
  details?: { "@type"?: string; reason?: string; domain?: string; metadata?: Record<string, string>; links?: { url?: string; description?: string }[] }[];
}

/** Google's error body, if it is one: `{ "error": { code, message, status, errors[], details[] } }`. */
export function parseErrorBody(text: string): GoogleErrorBody {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "object" && parsed.error) return parsed.error as GoogleErrorBody;
  } catch {
    // not JSON
  }
  return {};
}

const clean = (s: string | undefined, max = 300) =>
  (s ?? "")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[token]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "backendError"]);
const QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded", "dailyLimitExceededUnreg", "storageQuotaExceeded"]);

/** An enable link from Google's ErrorInfo/Help, else the API library page (with the project when Google named it). */
function enableLink(body: GoogleErrorBody, service: string): string {
  const info = body.details?.find((d) => d.reason === "SERVICE_DISABLED" || d.metadata?.activationUrl);
  const candidates = [info?.metadata?.activationUrl, ...(body.details ?? []).flatMap((d) => (d.links ?? []).map((l) => l.url)), ...(body.errors ?? []).map((e) => /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/.exec(e.message ?? "")?.[0])];
  for (const c of candidates) {
    if (typeof c === "string" && /^https:\/\/console\.(developers|cloud)\.google\.com\/[\w\-./?=&%]+$/.test(c.replace(/[.,)]+$/, ""))) return c.replace(/[.,)]+$/, "");
  }
  const project = /^projects\/(\d+)$/.exec(info?.metadata?.consumer ?? "")?.[1] ?? /project[ =](\d+)/.exec(body.message ?? "")?.[1];
  return `https://console.cloud.google.com/apis/library/${service}${project ? `?project=${project}` : ""}`;
}

const RECONNECT = "Google rejected this connection's sign-in. Reconnect Google Workspace in xaq (Connections → Google Workspace → Reconnect).";

/** A non-2xx answer as a GoogleError in plain words, plus whether it may be retried. */
export function classify(status: number, body: GoogleErrorBody, service: string): { error: GoogleError; retry: boolean } {
  const reasons = new Set<string>([...(body.errors ?? []).map((e) => e.reason ?? ""), ...(body.details ?? []).map((d) => d.reason ?? ""), body.status ?? ""].filter(Boolean));
  const has = (...r: string[]) => r.some((x) => reasons.has(x));
  const msg = clean(body.message || body.errors?.[0]?.message);
  const label = APIS[service] ?? service;
  const said = msg ? ` Google said: "${msg}"` : "";
  if (status === 401) return { error: new GoogleError("reconnect_required", RECONNECT, status), retry: false };
  if (has("SERVICE_DISABLED", "accessNotConfigured") || /has not been used in project|is disabled/i.test(msg)) {
    return {
      error: new GoogleError("api_disabled", `The ${label} is turned off in the Google Cloud project this connection uses. Enable it here, wait a minute, and try again: ${enableLink(body, service)}`, status),
      retry: false,
    };
  }
  if (has("ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions") || /insufficient authentication scopes/i.test(msg)) {
    return {
      error: new GoogleError("insufficient_scope", "This connection's Google sign-in is missing a permission the extension needs. Reconnect Google Workspace in xaq and tick every permission on Google's consent screen.", status),
      retry: false,
    };
  }
  if (has("appNotAuthorizedToFile", "appNotAuthorizedToChild")) {
    return {
      error: new GoogleError(
        "no_file_access",
        "Google lets this extension change a file through Drive only if the extension created it (it asks for Drive's per-file access, drive.file, not full Drive access). Reading works for every file; for this change, use a file the extension created, or make the edit in Google Docs.",
        status,
      ),
      retry: false,
    };
  }
  if (has("exportSizeLimitExceeded")) return { error: new GoogleError("too_large", "This file is too large for Google to export (Google's limit is 10 MB). Open it in Google instead.", status), retry: false };
  if (has("fileNotExportable") || /Export only supports/i.test(msg)) return { error: new GoogleError("bad_request", "Google can only export Google Docs, Sheets, Slides and Drawings, and this file isn't one of them.", status), retry: false };
  if (status === 429 || (status === 403 && has(...RATE_REASONS))) {
    return { error: new GoogleError("rate_limited", "Google is rate-limiting this connection. Wait a minute and try again.", status), retry: true };
  }
  if (status === 403 && has(...QUOTA_REASONS)) return { error: new GoogleError("rate_limited", `Google's quota for this project is used up for now; try again later.${said}`, status), retry: false };
  if (status === 403) return { error: new GoogleError("permission_denied", `Google refused: this account doesn't have permission for that (for example, the file is shared view-only).${said}`, status), retry: false };
  if (status === 404) return { error: new GoogleError("not_found", "Google found nothing with that id: it doesn't exist, was deleted, or this Google account can't see it.", status), retry: false };
  if (status === 409) return { error: new GoogleError("conflict", `Google reported a conflict.${said}`, status), retry: false };
  if (status === 413) return { error: new GoogleError("too_large", "That's more than Google accepts in one request.", status), retry: false };
  if (status >= 500) return { error: new GoogleError("unavailable", `Google's ${label} is having trouble (HTTP ${status}). Try again in a minute.`, status), retry: true };
  if (status === 400 && /not supported for this document|must be a google doc/i.test(msg)) return { error: new GoogleError("bad_request", "That file isn't a Google Doc (it may be an uploaded Word or PDF file). Only Google Docs can be read or edited with the docs_ tools.", status), retry: false };
  if (status === 400 && /revision/i.test(msg) && /required|match|stale/i.test(msg)) return { error: new GoogleError("conflict", "The document changed while this edit was being made. Read it again and retry.", status), retry: false };
  return { error: new GoogleError("bad_request", `Google refused the request (HTTP ${status}).${said}`, status), retry: false };
}

/** The response body, refusing one over the cap (declared or actual) without reading it all. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new GoogleError("too_large", `Google's answer is larger than the extension accepts (${Math.round(max / 1024 / 1024)} MB).`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new GoogleError("unavailable", "Google took too long to answer.");
      }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new GoogleError("too_large", `Google's answer is larger than the extension accepts (${Math.round(max / 1024 / 1024)} MB).`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export class HttpGoogleClient implements GoogleClient {
  private token: AccessToken | null = null;
  private tokenRequest: Promise<AccessToken> | null = null;
  /** After a 429: no request of this connection starts before this time (epoch ms). */
  private blockedUntil = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly attemptTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
    this.maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  }

  async json<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const hasBody = opts.body !== undefined;
    const res = await this.request(method, url, opts.query, hasBody ? Buffer.from(JSON.stringify(opts.body), "utf8") : undefined, hasBody ? "application/json; charset=utf-8" : undefined, "application/json");
    if (res.data.length === 0) return {} as T;
    try {
      return JSON.parse(res.data.toString("utf8")) as T;
    } catch {
      throw new GoogleError("invalid_response", "Google sent an answer that isn't JSON.");
    }
  }

  async bytes(method: "GET" | "POST", url: string, opts: { query?: Query; body?: unknown; contentType?: string } = {}): Promise<{ data: Buffer; contentType: string }> {
    let body: Buffer | undefined;
    let contentType = opts.contentType;
    if (opts.body === undefined || opts.body === null) body = undefined;
    else if (Buffer.isBuffer(opts.body)) body = opts.body;
    else if (opts.body instanceof Uint8Array) body = Buffer.from(opts.body);
    else if (typeof opts.body === "string") body = Buffer.from(opts.body, "utf8");
    else {
      body = Buffer.from(JSON.stringify(opts.body), "utf8");
      contentType ??= "application/json; charset=utf-8";
    }
    if (body && !contentType) contentType = "application/octet-stream";
    return this.request(method, url, opts.query, body, contentType, "*/*");
  }

  /** Forget the cached access token (the next request asks xaq again). */
  dropToken(): void {
    this.token = null;
  }

  private async accessToken(force: boolean): Promise<string> {
    const t = this.token;
    if (!force && t && (t.expiresAt === null || t.expiresAt - 60_000 > this.now())) return t.accessToken;
    this.tokenRequest ??= (async () => {
      try {
        const c = await this.opts.credentials();
        if (!c || typeof c.accessToken !== "string" || !c.accessToken) throw new Error("no access token");
        return c;
      } catch {
        throw new GoogleError("reconnect_required", RECONNECT);
      } finally {
        this.tokenRequest = null;
      }
    })();
    const next = await this.tokenRequest;
    this.token = next;
    return next.accessToken;
  }

  private target(u: URL): string {
    const origin = this.opts.testOrigin;
    return origin ? `${origin}/${u.hostname}${u.pathname}${u.search}` : u.href;
  }

  private async request(method: string, url: string, query: Query | undefined, body: Buffer | undefined, contentType: string | undefined, accept: string): Promise<{ data: Buffer; contentType: string }> {
    const u = checkedUrl(url, query);
    const service = serviceOf(u);
    const started = this.now();
    const deadline = started + this.deadlineMs;
    const idempotent = method === "GET";
    let token = await this.accessToken(false);
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      attempt++;
      const wait = this.blockedUntil - this.now();
      if (wait > 0) {
        if (this.now() + wait > deadline || wait > MAX_RETRY_AFTER_MS) throw new GoogleError("rate_limited", `Google is rate-limiting this connection. Try again in ${Math.ceil(wait / 1000)} seconds.`, 429);
        await this.sleep(wait + Math.floor(this.random() * 250));
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new GoogleError("unavailable", "Google took too long to answer.");
      const signal = AbortSignal.timeout(Math.min(this.attemptTimeoutMs, remaining));
      let res: Response;
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept };
        if (contentType) headers["content-type"] = contentType;
        res = await this.fetchImpl(this.target(u), { method, headers, body, redirect: "error", signal });
      } catch {
        // Network error or timeout. Retried only for GET: a POST may have reached Google.
        if (idempotent && attempt < MAX_ATTEMPTS && (await this.backoff(attempt, null, deadline))) continue;
        this.opts.log?.log("warn", "google request failed", { service, method, path: u.pathname, attempt });
        throw new GoogleError("unavailable", `Couldn't reach Google's ${APIS[service] ?? service} (network error or timeout). Try again in a minute.`);
      }
      if (res.ok) {
        const data = await readCapped(res, this.maxBytes, signal);
        return { data, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
      }
      const text = (await readCapped(res, 256 * 1024, signal).catch(() => Buffer.alloc(0))).toString("utf8");
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        const next = await this.accessToken(true);
        if (next !== token) {
          token = next;
          attempt--;
          continue;
        }
      }
      if (res.status === 401) this.token = null;
      const { error, retry } = classify(res.status, parseErrorBody(text), service);
      const after = retryAfterMs(res.headers, this.now());
      if (res.status === 429 || error.code === "rate_limited") {
        if (after !== null && after > MAX_RETRY_AFTER_MS) {
          this.blockedUntil = Math.max(this.blockedUntil, this.now() + after);
          throw new GoogleError("rate_limited", `Google is rate-limiting this connection. Try again in ${Math.ceil(after / 1000)} seconds.`, res.status);
        }
      }
      // 429 and rate-limit 403s were refused before any work, so any method may retry them; 5xx only for GET.
      const mayRetry = retry && (error.code === "rate_limited" || idempotent);
      if (mayRetry && attempt < MAX_ATTEMPTS) {
        if (error.code === "rate_limited") this.blockedUntil = Math.max(this.blockedUntil, this.now() + (after ?? 0));
        if (await this.backoff(attempt, after, deadline)) continue;
      }
      this.opts.log?.log(error.code === "not_found" ? "info" : "warn", "google request refused", { service, method, path: u.pathname, status: res.status, code: error.code, attempt });
      throw error;
    }
  }

  /** Waits before the next attempt (Retry-After if given, else 1 s, 2 s, … plus up to 1 s of jitter); false if past the deadline. */
  private async backoff(attempt: number, retryAfter: number | null, deadline: number): Promise<boolean> {
    const base = retryAfter ?? 1000 * 2 ** (attempt - 1);
    const ms = base + Math.floor(this.random() * 1000);
    if (this.now() + ms + 1000 > deadline) return false;
    await this.sleep(ms);
    return true;
  }
}
