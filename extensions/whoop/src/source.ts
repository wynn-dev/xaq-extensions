// The dashboard's McpDataSource, backed by the WHOOP API instead of its Postgres tables.
//
// load() returns exactly what the dashboard's `dashboardData()` returned (records in start order, the member's name,
// and the status fields), so the dashboard's own mcp.ts produces the same answers:
// - Records come live from the four v2 collections, from the configured history start (`historyFrom`) to now. Days
//   WHOOP has finished scoring are kept in the cache (cache.ts) and not downloaded again; the recent `settle` window
//   (7 days), anything unscored and today are always fetched live.
// - Concurrent calls share one fetch, and a result is reused for `memoMs` (60 s), so a burst of tool calls costs one
//   round of requests.
// - The status fields keep the dashboard's names with live meanings: `syncedAt` is the last time WHOOP answered,
//   `syncing` is true while a sync_now refresh runs, `syncError` is the last API error code (null after a success)
//   and `needsReconnect` is true while xaq's token doesn't work.
// - When WHOOP fails, the last good data (or the cached scored days) is served with `syncError` set, as the
//   dashboard served its stored data after a failed sync. With nothing at all to serve, the call fails with a sentence.
// sync() (sync_now) re-reads config.json, drops the cache and downloads the whole history again: the way to pick up
// an edit WHOOP made to an old day, or a new history start. At most once per 5-minute cooldown after a success. A week-old cache is rebuilt the same way, in the
// background, after the load it served.

import { PATHS, WhoopApi, WhoopError } from "./api.ts";
import { CACHE_VERSION, type CacheStore, type Logger, type Row } from "./cache.ts";
import type { McpDataSource } from "./dashboard/mcp";
import type { DashboardData, RecordKind, WhoopRecord } from "./dashboard/whoop";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KINDS: RecordKind[] = ["cycle", "sleep", "recovery", "workout"];
const KIND_ORDER: Record<RecordKind, number> = { cycle: 0, sleep: 1, recovery: 2, workout: 3 };

export interface SourceOptions {
  api: WhoopApi;
  cache: CacheStore;
  /** Epoch ms of the first moment of history to load. */
  historyFrom: number;
  /** Re-reads the history start (config.json) on sync_now, so changing it needs no restart. */
  reloadHistoryFrom?: () => number;
  log: Logger;
  now?: () => number;
  settleMs?: number;
  overlapMs?: number;
  memoMs?: number;
  failMemoMs?: number;
  revalidateMs?: number;
  profileMs?: number;
  syncWaitMs?: number;
  /** After a successful sync_now, further ones within this window answer its result without refetching. */
  syncCooldownMs?: number;
}

interface Profile {
  at: number;
  firstName: string;
  lastName: string;
  email: string;
}

export interface LiveSource extends McpDataSource {
  /** For tests and logs: what the last load fetched. */
  readonly stats: { loads: number; fetches: number; cacheHits: number; lastFetchFrom: string | null };
  /** Tests: resolves once no load or refresh is running. */
  whenIdle(): Promise<void>;
}

/** A record still pending (or a cycle still open) this long after it started is taken as final: it never will be. */
export const STALE_PENDING_MS = 30 * DAY;

/**
 * Final: WHOOP won't score it again. A cycle is final only once it has ended. Anything older than STALE_PENDING_MS
 * counts as final whatever its state, so one record WHOOP never scored can't pin the cache's `through` for ever.
 */
export function isFinal(row: Row, now = Date.now()): boolean {
  if (now - row.startAt > STALE_PENDING_MS) return true;
  const state = row.data.score_state;
  if (state !== "SCORED" && state !== "UNSCORABLE") return false;
  if (row.kind === "cycle" && !row.data.end) return false;
  return true;
}

export function compareRows(a: Row, b: Row): number {
  return a.startAt - b.startAt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export const errorCode = (err: unknown): string => (err instanceof WhoopError ? err.code : "sync_failed");

function friendly(code: string): string {
  switch (code) {
    case "reconnect_required":
      return "WHOOP rejected this connection's token. Reconnect WHOOP in xaq (Connections → Reconnect), then try again.";
    case "rate_limited":
      return "WHOOP rate limit reached. Try again in a few minutes.";
    case "whoop_unavailable":
      return "WHOOP can't be reached right now. Try again in a few minutes.";
    default:
      return `WHOOP sent something unexpected (${code}). Try again in a few minutes.`;
  }
}

export function createLiveSource(opts: SourceOptions): LiveSource {
  const { api, cache, log } = opts;
  const now = opts.now ?? Date.now;
  const settleMs = opts.settleMs ?? 7 * DAY;
  const overlapMs = opts.overlapMs ?? DAY;
  const memoMs = opts.memoMs ?? 60_000;
  const failMemoMs = opts.failMemoMs ?? 30_000;
  const revalidateMs = opts.revalidateMs ?? 7 * DAY;
  const profileMs = opts.profileMs ?? DAY;
  let historyFrom = opts.historyFrom;
  let historyFromIso = new Date(historyFrom).toISOString();

  let profile: Profile | null = null;
  let memo: { at: number; rows: Row[] } | null = null;
  let lastGood: Row[] | null = null;
  let failedAt: number | null = null;
  let loading: Promise<Row[]> | null = null;
  let refreshing: Promise<Row[]> | null = null;
  let lastError: string | null = null;
  let needsReconnect = false;
  let revalidate = false;
  const syncWaitMs = opts.syncWaitMs ?? 40_000;
  const syncCooldownMs = opts.syncCooldownMs ?? 5 * 60_000;
  /** When the last successful sync_now refresh started. */
  let lastSyncAt: number | null = null;
  const stats = { loads: 0, fetches: 0, cacheHits: 0, lastFetchFrom: null as string | null };

  function dashboard(rows: Row[]): DashboardData {
    return {
      user: { firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", email: profile?.email ?? "" },
      syncedAt: api.lastOkAt === null ? null : new Date(api.lastOkAt).toISOString(),
      syncing: refreshing !== null,
      syncError: lastError,
      needsReconnect,
      records: rows.map((r) => ({ kind: r.kind, data: r.data })),
    };
  }

  async function fetchProfile(force: boolean): Promise<void> {
    const t = now();
    if (!force && profile && t - profile.at < profileMs) return;
    const p = await api.get<Record<string, unknown>>(PATHS.profile);
    if (!p || typeof p.first_name !== "string") throw new WhoopError("reconnect_required", "WHOOP didn't return the member's profile (read:profile)");
    profile = { at: t, firstName: p.first_name, lastName: typeof p.last_name === "string" ? p.last_name : "", email: typeof p.email === "string" ? p.email : "" };
  }

  function toRows(kind: RecordKind, records: WhoopRecord[], cycleStarts: Map<string, string>): Row[] {
    const out: Row[] = [];
    let skipped = 0;
    for (const data of records) {
      const id = String(kind === "recovery" ? data.cycle_id : data.id);
      const startedAt = kind === "recovery" ? (cycleStarts.get(String(data.cycle_id)) ?? data.created_at) : data.start;
      const startAt = startedAt ? Date.parse(startedAt) : Number.NaN;
      if (id === "undefined" || Number.isNaN(startAt)) {
        skipped++;
        continue;
      }
      out.push({ kind, id, startAt, data });
    }
    if (skipped) log.warn("skipped WHOOP records without an id or start", { kind, skipped });
    return out;
  }

  async function fetchAll(full: boolean): Promise<Row[]> {
    stats.fetches++;
    const t = now();
    if (full && opts.reloadHistoryFrom) {
      const next = opts.reloadHistoryFrom();
      if (next !== historyFrom) {
        log.info("history start changed", { historyFrom: new Date(next).toISOString() });
        historyFrom = next;
        historyFromIso = new Date(next).toISOString();
        lastGood = null;
      }
    }
    let cached = full ? null : cache.read(historyFromIso);
    if (cached && (cached.through > t || cached.through < historyFrom)) cached = null;
    // A week-old cache still serves this load; a full refresh then runs in the background (load() starts it).
    if (cached && t - cached.builtAt > revalidateMs) revalidate = true;
    // Records starting at or after `from` are replaced by what WHOOP answers now; fetching a day earlier than that
    // covers collections (recovery) whose time filter isn't the record's own start.
    const from = cached ? Math.max(historyFrom, cached.through - overlapMs) : historyFrom;
    const fetchFrom = cached ? Math.max(historyFrom, from - overlapMs) : historyFrom;
    stats.lastFetchFrom = new Date(fetchFrom).toISOString();
    if (cached) stats.cacheHits++;
    await fetchProfile(full);
    const live = {} as Record<RecordKind, WhoopRecord[]>;
    for (const kind of KINDS) live[kind] = await api.collect<WhoopRecord>(PATHS[kind], new Date(fetchFrom).toISOString());

    const rows = new Map<string, Row>();
    const cycleStarts = new Map<string, string>();
    if (cached) {
      for (const r of cached.records) {
        if (r.kind === "cycle" && r.data.start) cycleStarts.set(r.id, r.data.start);
        if (r.startAt < from) rows.set(`${r.kind}:${r.id}`, r);
      }
    }
    for (const c of live.cycle) if (c.start && c.id !== undefined) cycleStarts.set(String(c.id), c.start);
    for (const kind of KINDS) for (const r of toRows(kind, live[kind], cycleStarts)) rows.set(`${r.kind}:${r.id}`, r);
    const sorted = [...rows.values()].sort(compareRows);

    // The cache holds everything before the first record that isn't final, and never the settle window.
    let through = t - settleMs;
    for (const r of sorted) {
      if (r.startAt >= through) break;
      if (!isFinal(r, t)) {
        through = r.startAt;
        break;
      }
    }
    through = Math.max(through, historyFrom);
    cache.write({ v: CACHE_VERSION, historyFrom: historyFromIso, builtAt: cached ? cached.builtAt : t, through, records: sorted.filter((r) => r.startAt < through) });
    return sorted;
  }

  function succeed(rows: Row[]): Row[] {
    memo = { at: now(), rows };
    lastGood = rows;
    failedAt = null;
    lastError = null;
    needsReconnect = false;
    return rows;
  }

  function fail(err: unknown): string {
    const code = errorCode(err);
    lastError = code;
    if (code === "reconnect_required") {
      needsReconnect = true;
      api.dropToken();
    }
    failedAt = now();
    log.warn("WHOOP request failed", { code, detail: err instanceof WhoopError ? err.detail : String((err as Error)?.message ?? err).slice(0, 200) });
    return code;
  }

  /** Starts (or joins) a full refresh; its result replaces the memo. Never two at once. */
  function refresh(): Promise<Row[]> {
    if (refreshing) return refreshing;
    revalidate = false;
    const p = fetchAll(true);
    refreshing = p;
    p.then(
      (rows) => {
        if (refreshing === p) refreshing = null;
        succeed(rows);
      },
      (err) => {
        if (refreshing === p) refreshing = null;
        fail(err);
      },
    );
    return p;
  }

  /** The last good data, else the scored days in the cache: what a failed load still serves. */
  function fallback(): Row[] | null {
    if (lastGood) return lastGood;
    const c = cache.read(historyFromIso);
    return c && c.records.length ? [...c.records].sort(compareRows) : null;
  }

  return {
    stats,

    async load() {
      stats.loads++;
      const t = now();
      if (memo && t - memo.at < memoMs) return dashboard(memo.rows);
      if (failedAt !== null && t - failedAt < failMemoMs) {
        const rows = fallback();
        if (rows && profile) return dashboard(rows);
        throw new Error(friendly(lastError ?? "sync_failed"));
      }
      try {
        loading ??= fetchAll(false).finally(() => {
          loading = null;
        });
        const rows = succeed(await loading);
        if (revalidate) void refresh().catch(() => undefined);
        return dashboard(rows);
      } catch (err) {
        const code = fail(err);
        const rows = fallback();
        if (rows && profile) return dashboard(rows);
        throw new Error(friendly(code));
      }
    },

    // Waits up to syncWaitMs (inside xaq's 60 s per call); a longer refresh carries on in the background and the
    // answer is the dashboard's "Sync started; poll get_status." (`syncing: true`).
    async sync() {
      // A full refresh costs the whole history in requests from the app's shared daily quota: at most one per
      // cooldown. Within it the answer is the last one (finished), with the same shape.
      // A changed history start (config.json) always gets its refresh.
      const historyChanged = opts.reloadHistoryFrom ? opts.reloadHistoryFrom() !== historyFrom : false;
      if (!refreshing && !historyChanged && lastSyncAt !== null && now() - lastSyncAt < syncCooldownMs) return { syncing: false };
      const startedAt = now();
      const current = refresh();
      current.then(
        () => {
          lastSyncAt = startedAt;
        },
        () => undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        current.then(
          () => ({ done: true as const }),
          (err: unknown) => ({ done: true as const, err }),
        ),
        new Promise<{ done: false }>((resolve) => {
          timer = setTimeout(() => resolve({ done: false }), syncWaitMs);
        }),
      ]);
      clearTimeout(timer);
      if (!outcome.done) return { syncing: true };
      if ("err" in outcome) throw new Error(errorCode(outcome.err));
      return { syncing: false };
    },

    whenIdle: async () => {
      while (refreshing || loading) await (refreshing ?? loading)!.catch(() => undefined);
    },
  };
}
