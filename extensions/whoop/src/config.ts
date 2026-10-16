// Optional settings in `$XAQ_EXT_STATE_DIR/config.json`, written by hand (the extension never writes it):
//   { "historyFrom": "2026-08-25" }
// historyFrom: where the loaded history starts, a date (UTC midnight) or an ISO timestamp. The dashboard's answers
// depend on how far back its data goes (baselines, correlations, dataSpan), so for parity it should be the start of
// the dashboard's own first record. Default 2026-08-25.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./cache.ts";

export const DEFAULT_HISTORY_FROM = "2026-08-25";
export const CONFIG_FILE = "config.json";
const EARLIEST = Date.parse("2015-01-01T00:00:00Z");

export interface Config {
  historyFrom: number;
}

export function parseHistoryFrom(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  let t: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) t = Date.parse(`${s}T00:00:00Z`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) t = Date.parse(s);
  else return null;
  return Number.isFinite(t) && t >= EARLIEST && t < now ? t : null;
}

export function readConfig(stateDir: string | null, log: Logger, now = Date.now()): Config {
  const fallback = { historyFrom: parseHistoryFrom(DEFAULT_HISTORY_FROM, now) ?? now - 90 * 86_400_000 };
  if (!stateDir) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, CONFIG_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("config.json ignored: it isn't valid JSON");
    return fallback;
  }
  const historyFrom = parseHistoryFrom((raw as Record<string, unknown> | null)?.historyFrom, now);
  if (historyFrom === null) {
    if ((raw as Record<string, unknown> | null)?.historyFrom !== undefined) log.warn("config.json historyFrom ignored: use YYYY-MM-DD or an ISO timestamp in the past");
    return fallback;
  }
  return { historyFrom };
}
