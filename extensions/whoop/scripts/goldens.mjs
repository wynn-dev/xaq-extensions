// Produces test/goldens/goldens.json by running the WHOOP DASHBOARD's own MCP server (src/lib/mcp.ts in a checkout of
// wynn-dev/whoop-dashboard, untouched) over the fixture: a fake McpDataSource returns, as the dashboard's
// dashboardData() would, the records the fake WHOOP API serves from the default history start. Every request in
// test/golden-cases.mjs goes through the SDK's in-memory client, and the raw results are saved.
//
//   git clone https://github.com/wynn-dev/whoop-dashboard /tmp/whoop-dashboard && (cd /tmp/whoop-dashboard && pnpm install)
//   node extensions/whoop/scripts/goldens.mjs /tmp/whoop-dashboard
//
// The dashboard checkout is only read; the runner lives in a temp dir.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dash = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(dash, "src/lib/mcp.ts")) || !existsSync(join(dash, "node_modules/.bin/tsx"))) {
  console.error("usage: node extensions/whoop/scripts/goldens.mjs <whoop-dashboard checkout with node_modules>");
  process.exit(2);
}
const ext = fileURLToPath(new URL("..", import.meta.url));
const head = spawnSync("git", ["-C", dash, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["-C", dash, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
if (dirty) {
  console.error("The dashboard checkout has local changes: goldens must come from a clean commit.");
  process.exit(2);
}

const runner = `
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from ${JSON.stringify(join(dash, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"))};
import { InMemoryTransport } from ${JSON.stringify(join(dash, "node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"))};
import { z } from ${JSON.stringify(join(dash, "node_modules/zod/index.js"))};
import { createFormServer } from ${JSON.stringify(join(dash, "src/lib/mcp.ts"))};
import { buildDailyStats } from ${JSON.stringify(join(dash, "src/lib/whoop.ts"))};
import { collection } from ${JSON.stringify(join(ext, "test/fake-whoop.mjs"))};
import { goldenCases } from ${JSON.stringify(join(ext, "test/golden-cases.mjs"))};

const fixture = JSON.parse(readFileSync(${JSON.stringify(join(ext, "test/fixtures/whoop-fixture.json"))}, "utf8"));
const HISTORY_FROM = "2026-08-25T00:00:00.000Z";
const SYNCED_AT = "2026-10-16T11:58:00.000Z";

// What syncWhoop() stores and dashboardData() reads back: per kind, the API's records (newest first, as WHOOP
// returns them), inserted cycle, sleep, recovery, workout, then "order by start_at asc" (a stable sort).
const fetched = Object.fromEntries(["cycle", "sleep", "recovery", "workout"].map((k) => [k, collection(fixture, k, HISTORY_FROM)]));
const cycleStarts = new Map(fetched.cycle.map((c) => [String(c.id), c.start]));
const rows = [];
for (const kind of ["cycle", "sleep", "recovery", "workout"]) {
  for (const data of fetched[kind]) {
    const startedAt = kind === "recovery" ? (cycleStarts.get(String(data.cycle_id)) ?? data.created_at) : data.start;
    rows.push({ startAt: Date.parse(startedAt), record: { kind, data } });
  }
}
rows.sort((a, b) => a.startAt - b.startAt);
const records = rows.map((r) => r.record);
const dashboardData = () => ({
  user: { firstName: fixture.profile.first_name, lastName: fixture.profile.last_name, email: fixture.profile.email },
  syncedAt: SYNCED_AT,
  syncing: false,
  syncError: null,
  needsReconnect: false,
  records,
});
const source = { load: async () => dashboardData(), sync: async () => ({ syncing: false }) };

const server = createFormServer(source);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "goldens", version: "0.0.0" });
await client.connect(clientTransport);

const dates = buildDailyStats(records).map((d) => d.date);
const workoutIds = records.filter((r) => r.kind === "workout" && r.data.start).sort((a, b) => b.data.start.localeCompare(a.data.start)).map((r) => String(r.data.id));
const Any = z.looseObject({});
const out = [];
for (const c of goldenCases({ dates, workoutIds })) {
  try {
    out.push({ ...c, result: await client.request({ method: c.method, params: c.params }, Any) });
  } catch (err) {
    out.push({ ...c, error: { code: err.code ?? null, message: String(err.message) } });
  }
}
const init = { serverVersion: client.getServerVersion(), instructions: client.getInstructions(), capabilities: client.getServerCapabilities() };
writeFileSync(${JSON.stringify(join(ext, "test/goldens/goldens.json"))}, JSON.stringify({
  source: { repo: "wynn-dev/whoop-dashboard", commit: ${JSON.stringify(head)}, file: "src/lib/mcp.ts" },
  historyFrom: HISTORY_FROM,
  syncedAt: SYNCED_AT,
  dates,
  workoutIds,
  initialize: init,
  cases: out,
}, null, 1) + "\\n");
console.log("goldens: " + out.length + " cases from whoop-dashboard@" + ${JSON.stringify(head.slice(0, 12))});
process.exit(0);
`;

const dir = mkdtempSync(join(tmpdir(), "whoop-goldens-"));
try {
  writeFileSync(join(dir, "runner.mjs"), runner);
  const res = spawnSync(join(dash, "node_modules/.bin/tsx"), [join(dir, "runner.mjs")], { stdio: "inherit", cwd: dir, env: { PATH: process.env.PATH, TZ: "UTC", LANG: "en_US.UTF-8" } });
  process.exit(res.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
