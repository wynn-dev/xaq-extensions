// The only thing the extension keeps on disk: `cache-v1.json` in $XAQ_EXT_STATE_DIR, the records of days WHOOP has
// finished scoring (score_state SCORED or UNSCORABLE, the cycle closed, and older than the settle window), so a 90-day
// trend doesn't re-download months of history on every call. No tokens, ever.
//
// - Versioned (`v`) and tied to the configured history start: either changing rebuilds it.
// - Bounded: at most MAX_RECORDS records and MAX_BYTES on disk; a cache that would be larger isn't written.
// - Safe to delete at any time, and a file that doesn't parse or validate is ignored and rebuilt.
// - Written atomically (temp file + rename, mode 0600) inside the state dir only.
// Health data, so it's only as private as the state dir (0700, owned by xaq): no tokens or secrets are in it.

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { RecordKind, WhoopRecord } from "./dashboard/whoop";

export const CACHE_VERSION = 1;
export const CACHE_FILE = "cache-v1.json";
export const MAX_RECORDS = 20_000;
export const MAX_BYTES = 16 * 1024 * 1024;
const KINDS = new Set<RecordKind>(["cycle", "recovery", "sleep", "workout"]);

export interface Row {
  kind: RecordKind;
  /** The dashboard's record_id: the cycle id for a recovery, else the record's id. */
  id: string;
  /** The dashboard's start_at (epoch ms): the cycle's start for a recovery, else the record's start. */
  startAt: number;
  data: WhoopRecord;
}

export interface CacheFile {
  v: typeof CACHE_VERSION;
  historyFrom: string;
  /** When this cache was first built (epoch ms); it's rebuilt from scratch after the revalidation period. */
  builtAt: number;
  /** Every record starting before this (epoch ms) is final and in `records`. */
  through: number;
  records: Row[];
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

function valid(file: unknown, historyFrom: string): file is CacheFile {
  if (!file || typeof file !== "object") return false;
  const f = file as Record<string, unknown>;
  if (f.v !== CACHE_VERSION || f.historyFrom !== historyFrom) return false;
  if (typeof f.builtAt !== "number" || !Number.isFinite(f.builtAt) || typeof f.through !== "number" || !Number.isFinite(f.through)) return false;
  if (!Array.isArray(f.records) || f.records.length > MAX_RECORDS) return false;
  for (const r of f.records as unknown[]) {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    if (!KINDS.has(row.kind as RecordKind) || typeof row.id !== "string" || typeof row.startAt !== "number" || !Number.isFinite(row.startAt)) return false;
    if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) return false;
    if (row.startAt >= (f.through as number)) return false;
  }
  return true;
}

export class CacheStore {
  private lastWritten: string | null = null;

  constructor(
    private readonly path: string | null,
    private readonly log: Logger,
  ) {}

  read(historyFrom: string): CacheFile | null {
    if (!this.path) return null;
    let text: string;
    try {
      if (statSync(this.path).size > MAX_BYTES) {
        this.log.warn("cache file too large; rebuilding it");
        return null;
      }
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("cache file unreadable; rebuilding it", { code: (err as NodeJS.ErrnoException).code ?? null });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.warn("cache file is corrupt; rebuilding it");
      return null;
    }
    if (!valid(parsed, historyFrom)) {
      this.log.info("cache file is from another version or history start; rebuilding it");
      return null;
    }
    this.lastWritten = text;
    return parsed;
  }

  write(file: CacheFile): void {
    if (!this.path) return;
    const text = JSON.stringify(file);
    if (text === this.lastWritten) return;
    if (file.records.length > MAX_RECORDS || Buffer.byteLength(text) > MAX_BYTES) {
      this.log.warn("cache would exceed its bounds; not caching", { records: file.records.length });
      this.clear();
      return;
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      // No fsync: Node 24's permission model refuses it on a file descriptor. A file torn by a power cut is
      // ignored and rebuilt on the next read.
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, this.path);
      this.lastWritten = text;
    } catch (err) {
      this.log.warn("couldn't write the cache file", { code: (err as NodeJS.ErrnoException).code ?? null });
      try {
        rmSync(tmp, { force: true });
      } catch {
        // nothing to clean up
      }
    }
  }

  clear(): void {
    if (!this.path) return;
    this.lastWritten = null;
    try {
      rmSync(this.path, { force: true });
    } catch {
      // already gone
    }
  }
}
