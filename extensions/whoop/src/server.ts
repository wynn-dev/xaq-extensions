// The WHOOP code extension for xaq: the WHOOP dashboard's MCP server (src/dashboard/, copied from
// wynn-dev/whoop-dashboard; see NOTICE) over a live WHOOP API data source, on stdio. xaq spawns it as
//   node --permission --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> dist/server.mjs
// with only XAQ_EXT_NAME, XAQ_EXT_CONNECTION_ID, XAQ_EXT_STATE_DIR, XAQ_EXT_PROTOCOL, TZ and LANG set.
// Nothing may be written to stdout except the protocol.

import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WhoopApi, apiBase } from "./api.ts";
import { CACHE_FILE, CacheStore } from "./cache.ts";
import { readConfig } from "./config.ts";
import { createFormServer } from "./dashboard/mcp";
import { Host } from "./host.ts";
import { RateGate } from "./ratelimit.ts";
import { createLiveSource } from "./source.ts";

async function main(): Promise<void> {
  const env = process.env;
  const stateDir = env.XAQ_EXT_STATE_DIR && env.XAQ_EXT_STATE_DIR.startsWith("/") ? env.XAQ_EXT_STATE_DIR : null;
  const host = new Host();
  const config = readConfig(stateDir, host);
  const api = new WhoopApi({ base: apiBase(env), credentials: () => host.credentials(), gate: new RateGate() });
  const cache = new CacheStore(stateDir ? join(stateDir, CACHE_FILE) : null, host);
  const source = createLiveSource({ api, cache, historyFrom: config.historyFrom, reloadHistoryFrom: () => readConfig(stateDir, host).historyFrom, log: host });
  const mcp = createFormServer(source);
  host.attach(mcp.server);
  mcp.server.oninitialized = () => {
    host.info("whoop extension ready", { historyFrom: new Date(config.historyFrom).toISOString(), cache: stateDir !== null, protocol: env.XAQ_EXT_PROTOCOL ?? null });
  };
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`whoop extension failed to start: ${String((err as Error)?.message ?? err).slice(0, 300)}\n`);
  process.exit(1);
});
