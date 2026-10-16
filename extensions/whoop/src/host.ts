// The extension-to-host protocol (xaq docs/EXTENSIONS.md, "Protocol"): custom JSON-RPC on the same stdio MCP
// session, with xaq as the client.
// - request `xaq/credentials/get` {} → { accessToken, expiresAt } for this connection only; an error means the
//   connection needs re-authorising. The token lives in memory only.
// - notification `xaq/log` { level, msg, meta }. Never a token, a header or a response body.
// No `xaq/events/emit`: without polling there's nothing to announce (the manifest's events list is empty).

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { AccessToken } from "./api.ts";
import type { Logger } from "./cache.ts";

const CredentialsResult = z.looseObject({
  accessToken: z.string().min(1),
  expiresAt: z.union([z.number(), z.string(), z.null()]).optional(),
});

/** expiresAt as epoch ms: a number (ms, or seconds if it's clearly seconds), an ISO string, or null. */
export function parseExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

type Level = "debug" | "info" | "warn" | "error";

export class Host implements Logger {
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  async credentials(): Promise<AccessToken> {
    if (!this.server) throw new Error("not connected to xaq");
    const res = await this.server.request({ method: "xaq/credentials/get", params: {} }, CredentialsResult, { timeout: 30_000 });
    return { accessToken: res.accessToken, expiresAt: parseExpiry(res.expiresAt) };
  }

  log(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
    const server = this.server;
    if (!server) return;
    server.notification({ method: "xaq/log", params: { level, msg, meta } }).catch(() => {
      // Not connected yet, or xaq went away: logs are best effort.
    });
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.log("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log("warn", msg, meta);
  }
}
