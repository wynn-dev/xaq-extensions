// The google-workspace code extension for xaq: Google Drive and Docs (and Sheets and Slides) tools over stdio. xaq
// spawns it as
//   node --permission --no-experimental-sqlite --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> dist/server.mjs
// with only XAQ_EXT_NAME, XAQ_EXT_CONNECTION_ID, XAQ_EXT_STATE_DIR, XAQ_EXT_PROTOCOL, TZ and LANG set. It keeps no
// state on disk. Nothing may be written to stdout except the protocol.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpGoogleClient, testOrigin } from "./google.ts";
import { Host } from "./host.ts";
import { createServer } from "./mcp.ts";

async function main(): Promise<void> {
  const env = process.env;
  const host = new Host();
  const origin = testOrigin(env);
  const client = new HttpGoogleClient({
    credentials: () => host.credentials(),
    testOrigin: origin,
    log: host,
    // Test only (never set by xaq, and ignored without the loopback test origin): a shorter per-attempt timeout.
    attemptTimeoutMs: origin && /^\d{3,6}$/.test(env.XAQ_EXT_GOOGLE_TIMEOUT_MS ?? "") ? Number(env.XAQ_EXT_GOOGLE_TIMEOUT_MS) : undefined,
  });
  const mcp = createServer(client);
  host.attach(mcp.server);
  mcp.server.oninitialized = () => {
    host.log("info", "google-workspace extension ready", { protocol: env.XAQ_EXT_PROTOCOL ?? null });
  };
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`google-workspace extension failed to start: ${String((err as Error)?.message ?? err).slice(0, 300)}\n`);
  process.exit(1);
});
