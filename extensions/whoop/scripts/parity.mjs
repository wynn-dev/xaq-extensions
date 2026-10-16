#!/usr/bin/env node
// Parity check: the WHOOP dashboard's MCP (connection `whoop`) against the WHOOP extension (connection `whoop-ext`),
// both through xaq's /mcp with ONE agent key that has (read) access to both. Plain Node 22+, no dependencies.
//
//   XAQ_URL=http://127.0.0.1:8425 XAQ_PARITY_KEY=aib_… node extensions/whoop/scripts/parity.mjs [options]
//
// Options:
//   --from YYYY-MM-DD        first day to compare (default 2026-08-25)
//   --to YYYY-MM-DD          last day (default yesterday, in this machine's time zone)
//   --days N                 compare the last N days ending --to instead of starting at --from
//   --dashboard-slug S       the dashboard connection's slug (default whoop)
//   --extension-slug S       the extension connection's slug (default whoop-ext)
//   --max-diffs N            diffs to print in full (default 10)
//   --concurrency N          calls in flight per side (default 4)
//   --no-insights            skip get_trends/get_insights per day (the slow part)
//
// What it compares (exit 0 only when everything is equal):
//   - tools/list: names (slug prefix stripped), titles, descriptions, input schemas, annotations except readOnlyHint
//     (xaq sets that from its own read class, which differs for sync_now: generic rules vs the extension's manifest);
//   - get_day for every day; list_days over the window (all 20 fields, in two calls) and list_workouts over the window
//     (every page); get_workout for every workout id either side lists; get_trends and get_insights with range
//     7/30/90 ending on every day;
//   - get_status: only its stable fields, see STATUS_COMPARED (the others changed meaning in the extension);
//   - sync_now: on the extension only, its result's shape (never on the dashboard: that would make it sync);
//   - prompts/list, prompts/get weekly_review, resources/list, resources/templates/list, resources/read of
//     whoop://status (stable fields) and whoop://days/<day> for every day.
//
// Normalised before comparing (and nothing else), see normalise():
//   - xaq's `<tool_output source="<slug>/<tool>" nonce="…" untrusted>` wrapper around each text block: stripped
//     (its source names the connection and its nonce is random per response);
//   - the `<slug>__` prefix of tool, prompt and resource names, and `xaq://<slug>/` resource URIs: mapped back;
//   - get_status / whoop://status: VOLATILE_STATUS_FIELDS are dropped.
// Calls without an explicit end date (which would include today, still changing) are not compared.
// The key is read from the environment and never printed.

import process from "node:process";

const VOLATILE_STATUS_FIELDS = ["syncedAt", "syncing", "syncError", "needsReconnect"];
const STATUS_COMPARED = ["user", "dataSpan.first"];
const STATUS_INFO = ["dataSpan.latest", "dataSpan.days", "workouts", "timezone", "latest"];
const DAY_FIELDS = [
  "recovery", "strain", "calories", "hrv", "rhr", "respiratoryRate", "spo2", "skinTemp", "sleepHours", "sleepNeededHours",
  "sleepPerformance", "sleepEfficiency", "sleepConsistency", "deepHours", "remHours", "lightHours", "awakeHours",
  "disturbances", "bedtime", "wake",
];
const TOOLS = ["get_status", "get_day", "list_days", "list_workouts", "get_workout", "get_trends", "get_insights", "sync_now"];

function parseArgs(argv) {
  const o = { from: "2026-08-25", to: null, days: null, dashboard: "whoop", extension: "whoop-ext", maxDiffs: 10, concurrency: 4, insights: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--from") o.from = val();
    else if (a === "--to") o.to = val();
    else if (a === "--days") o.days = Number(val());
    else if (a === "--dashboard-slug") o.dashboard = val();
    else if (a === "--extension-slug") o.extension = val();
    else if (a === "--max-diffs") o.maxDiffs = Number(val());
    else if (a === "--concurrency") o.concurrency = Number(val());
    else if (a === "--no-insights") o.insights = false;
    else if (a === "-h" || a === "--help") {
      console.log("usage: XAQ_URL=… XAQ_PARITY_KEY=… node parity.mjs [--from D] [--to D] [--days N] [--dashboard-slug whoop] [--extension-slug whoop-ext] [--max-diffs 10] [--concurrency 4] [--no-insights]");
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const slug = /^[a-z0-9-]{1,24}$/;
  if (!o.to) {
    const d = new Date(Date.now() - 86_400_000);
    o.to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (!date.test(o.to) || !date.test(o.from)) throw new Error("--from and --to take YYYY-MM-DD");
  if (o.days !== null) {
    if (!Number.isInteger(o.days) || o.days < 1 || o.days > 3650) throw new Error("--days takes a whole number of days");
    o.from = shiftDate(o.to, 1 - o.days);
  }
  if (o.from > o.to) throw new Error("--from is after --to");
  if (!slug.test(o.dashboard) || !slug.test(o.extension) || o.dashboard === o.extension) throw new Error("the two slugs must be different connection slugs");
  if (!Number.isInteger(o.maxDiffs) || o.maxDiffs < 0) throw new Error("--max-diffs takes a number");
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 16) throw new Error("--concurrency takes 1–16");
  return o;
}

function shiftDate(date, amount) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

// ───────────── a minimal MCP client for xaq's /mcp (Streamable HTTP, JSON or SSE answers) ─────────────

class Mcp {
  constructor(base, key) {
    this.url = new URL("/mcp", base);
    this.key = key;
    this.id = 1;
    this.protocol = null;
  }
  async rpc(method, params = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.key}` };
    if (this.protocol) headers["mcp-protocol-version"] = this.protocol;
    if (this.session) headers["mcp-session-id"] = this.session;
    const id = this.id++;
    let res;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error", signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new Error(`xaq at ${this.url.origin} is unreachable (${err.cause?.code ?? err.name})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`xaq refused the agent key (${res.status}): check XAQ_PARITY_KEY`);
    const session = res.headers.get("mcp-session-id");
    if (session) this.session = session;
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let msg = null;
    if (type.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const m = JSON.parse(data);
        if (m.id === id) msg = m;
      }
    } else {
      try {
        msg = JSON.parse(text);
      } catch {
        throw new Error(`xaq answered ${res.status} with something that isn't JSON`);
      }
    }
    if (!msg) throw new Error(`xaq answered ${res.status} without a response to ${method}`);
    if (msg.error) return { error: { code: msg.error.code, message: msg.error.message } };
    return { result: msg.result };
  }
  async initialize() {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "whoop-parity", version: "1.0.0" } });
    if (r.error) throw new Error(`initialize failed: ${r.error.message}`);
    this.protocol = r.result.protocolVersion;
    await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.key}`, "mcp-protocol-version": this.protocol, ...(this.session ? { "mcp-session-id": this.session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
      .then((r) => r.body?.cancel())
      .catch(() => {});
    return r.result;
  }
}

// ───────────── normalisation ─────────────

const WRAPPER = /^<tool_output source="[^"]*" nonce="[^"]*" untrusted>\n([\s\S]*)\n<\/tool_output>(\n\[output truncated to \d+ characters\])?$/;

/** Strips xaq's wrapper; reports truncation (a truncated result can't be compared fairly). */
function unwrap(text, notes) {
  const m = WRAPPER.exec(text);
  if (!m) return text;
  if (m[2]) notes.add("truncated by xaq's output limit");
  return m[1];
}

function dropPaths(obj, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]];
    if (o && typeof o === "object") delete o[parts.at(-1)];
  }
  return obj;
}
const pick = (obj, paths) => Object.fromEntries(paths.map((p) => [p, p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj)]));

function normaliseStatus(s) {
  return s && typeof s === "object" ? pick(s, STATUS_COMPARED) : s;
}

/** A tool result reduced to what must be equal: text (unwrapped, JSON-parsed when it is JSON), structuredContent and isError. */
function normaliseTool(r, tool, notes) {
  if (r.error) return { rpcError: r.error.message };
  const res = r.result;
  const texts = (res.content ?? []).map((c) => (c.type === "text" ? unwrap(c.text, notes) : { [c.type]: "…" }));
  const parsed = texts.map((t) => {
    if (typeof t !== "string") return t;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  let structured = res.structuredContent;
  let content = parsed;
  if (tool === "get_status" && !res.isError) {
    structured = normaliseStatus(structured);
    content = parsed.map((p) => normaliseStatus(p));
  }
  return { isError: res.isError === true, content, structuredContent: structured ?? null };
}

function normaliseToolList(result, slug) {
  const prefix = `${slug}__`;
  return (result?.tools ?? [])
    .filter((t) => t.name.startsWith(prefix))
    .map((t) => {
      const annotations = { ...(t.annotations ?? {}) };
      delete annotations.readOnlyHint;
      return { name: t.name.slice(prefix.length), title: t.title ?? null, description: t.description ?? null, inputSchema: t.inputSchema ?? null, annotations };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function originalUri(uri, slug) {
  const prefix = `xaq://${slug}/`;
  if (typeof uri !== "string" || !uri.startsWith(prefix)) return uri;
  try {
    return decodeURIComponent(uri.slice(prefix.length));
  } catch {
    return uri;
  }
}
const resourceUri = (slug, uri) => `xaq://${slug}/${encodeURIComponent(uri)}`;

function normaliseNamed(list, slug, key) {
  const prefix = `${slug}__`;
  return (list ?? [])
    .filter((x) => (key === "uri" ? String(x.uri ?? "").startsWith(`xaq://${slug}/`) : String(x.name ?? "").startsWith(prefix)))
    .map((x) => {
      const y = { ...x };
      if (typeof y.name === "string" && y.name.startsWith(prefix)) y.name = y.name.slice(prefix.length);
      if (y.uri) y.uri = originalUri(y.uri, slug);
      if (y.uriTemplate) y.uriTemplate = originalUri(y.uriTemplate, slug);
      return y;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normaliseResource(r, slug, notes, status) {
  if (r.error) return { rpcError: r.error.message };
  return (r.result.contents ?? []).map((c) => {
    let text = typeof c.text === "string" ? unwrap(c.text, notes) : null;
    if (status && text) {
      try {
        const body = JSON.parse(text);
        text = JSON.stringify(body.error ? body : normaliseStatus(body));
      } catch {
        // compare as is
      }
    }
    return { uri: originalUri(c.uri, slug), mimeType: c.mimeType ?? null, text };
  });
}

function normalisePrompt(r, notes) {
  if (r.error) return { rpcError: r.error.message };
  return { description: r.result.description ?? null, messages: (r.result.messages ?? []).map((m) => ({ role: m.role, content: m.content?.type === "text" ? { type: "text", text: unwrap(m.content.text, notes) } : m.content })) };
}

// ───────────── diffing ─────────────

function firstDiff(a, b, path = "$") {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return { path, dashboard: a, extension: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, dashboard: a, extension: b };
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ───────────── main ─────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = process.env.XAQ_URL;
  const key = process.env.XAQ_PARITY_KEY;
  if (!base || !/^https?:\/\//.test(base)) throw new Error("set XAQ_URL to xaq's address, e.g. http://127.0.0.1:8425");
  if (!key) throw new Error("set XAQ_PARITY_KEY to the parity agent's key (it is never printed)");
  const mcp = new Mcp(base, key);
  await mcp.initialize();
  const days = daysBetween(opts.from, opts.to);
  const D = opts.dashboard;
  const E = opts.extension;
  console.log(`WHOOP parity: ${D} (dashboard) vs ${E} (extension), ${days.length} days ${opts.from} → ${opts.to}`);

  const checks = []; // { tool, day, equal, diff, notes }
  let diffsShown = 0;
  const record = (tool, day, a, b, notes = new Set(), info = null) => {
    // A protocol-level error is never a valid answer here, even when both sides fail alike.
    const rpcFailed = [a, b].some((v) => v && typeof v === "object" && "rpcError" in v);
    const diff = rpcFailed ? { path: "$.rpcError", dashboard: a, extension: b } : firstDiff(a, b);
    checks.push({ tool, day, equal: !diff, notes: [...notes] });
    if (diff && diffsShown < opts.maxDiffs) {
      diffsShown++;
      const show = (v) => JSON.stringify(v)?.slice(0, 300);
      console.log(`\n✗ ${tool}${day ? ` ${day}` : ""}${info ? ` ${info}` : ""}: first difference at ${diff.path}\n    dashboard: ${show(diff.dashboard)}\n    extension: ${show(diff.extension)}`);
    }
  };

  // Listings.
  const toolList = (await mcp.rpc("tools/list")).result;
  const listedD = normaliseToolList(toolList, D);
  const listedE = normaliseToolList(toolList, E);
  if (!listedD.length) throw new Error(`the agent sees no ${D}__ tools: grant it (read) on the dashboard connection`);
  if (!listedE.length) throw new Error(`the agent sees no ${E}__ tools: grant it (read) on the extension connection`);
  const visibleD = new Set(listedD.map((t) => t.name));
  // sync_now is listed for the extension (read class) but may be hidden on the dashboard at the read level.
  record("tools/list", null, listedD.filter((t) => t.name !== "sync_now"), listedE.filter((t) => t.name !== "sync_now" || visibleD.has("sync_now")));
  for (const t of TOOLS) if (!listedE.some((x) => x.name === t)) record("tools/list", null, `${t} listed`, `${t} missing`);

  const call = (slug, tool, args) => mcp.rpc("tools/call", { name: `${slug}__${tool}`, arguments: args });
  const both = async (tool, args, day = null, info = null) => {
    const notes = new Set();
    const [a, b] = await Promise.all([call(D, tool, args), call(E, tool, args)]);
    record(tool, day, normaliseTool(a, tool, notes), normaliseTool(b, tool, notes), notes, info ?? JSON.stringify(args));
    return [a, b];
  };

  // get_status: stable fields only.
  const [statusD, statusE] = await both("get_status", {});
  const sd = statusD.result?.structuredContent;
  const se = statusE.result?.structuredContent;
  if (sd && se) {
    console.log(`  dashboard last synced ${sd.syncedAt ?? "never"}; extension last reached WHOOP ${se.syncedAt ?? "never"}${se.syncError ? ` (last error ${se.syncError})` : ""}`);
    if (sd.dataSpan?.first && se.dataSpan?.first && sd.dataSpan.first !== se.dataSpan.first) {
      console.log(
        `  ! the histories start on different days (dashboard ${sd.dataSpan.first}, extension ${se.dataSpan.first}): baselines and insights will differ.\n` +
          `    Set the extension's history start to the dashboard's: write {"historyFrom": "${sd.dataSpan.first}"} to config.json in its state dir\n` +
          `    (<xaq data dir>/extension-state/whoop/<connection id>/), then call ${E}__sync_now (it re-reads config.json) and run this again.`,
      );
    }
    for (const p of STATUS_INFO) {
      const [x, y] = [pick(sd, [p])[p], pick(se, [p])[p]];
      if (JSON.stringify(x) !== JSON.stringify(y)) console.log(`  (info, not compared) get_status ${p}: dashboard ${JSON.stringify(x)}, extension ${JSON.stringify(y)}`);
    }
  }

  // Prompts and resources.
  const prompts = (await mcp.rpc("prompts/list")).result?.prompts;
  record("prompts/list", null, normaliseNamed(prompts, D, "name"), normaliseNamed(prompts, E, "name"));
  for (const args of [{}, { end: opts.to }]) {
    const notes = new Set();
    const [a, b] = await Promise.all([mcp.rpc("prompts/get", { name: `${D}__weekly_review`, arguments: args }), mcp.rpc("prompts/get", { name: `${E}__weekly_review`, arguments: args })]);
    record("prompts/get", null, normalisePrompt(a, notes), normalisePrompt(b, notes), notes, `weekly_review ${JSON.stringify(args)}`);
  }
  const present = (what, ok) => record(`${what} (extension)`, null, true, ok);
  present("prompt weekly_review listed", normaliseNamed(prompts, E, "name").some((p) => p.name === "weekly_review"));
  const resD = (await mcp.rpc("resources/list")).result?.resources;
  present("resource whoop://status listed", normaliseNamed(resD, E, "uri").some((r) => r.uri === "whoop://status"));
  record("resources/list", null, normaliseNamed(resD, D, "uri"), normaliseNamed(resD, E, "uri"));
  const tplD = (await mcp.rpc("resources/templates/list")).result?.resourceTemplates;
  const byTemplate = (list, slug) => normaliseNamed((list ?? []).map((t) => ({ ...t, uri: t.uriTemplate })), slug, "uri").map(({ uri, ...t }) => t);
  record("resources/templates/list", null, byTemplate(tplD, D), byTemplate(tplD, E));
  present("template whoop://days/{date} listed", byTemplate(tplD, E).some((t) => t.uriTemplate === "whoop://days/{date}"));
  {
    const notes = new Set();
    const [a, b] = await Promise.all([mcp.rpc("resources/read", { uri: resourceUri(D, "whoop://status") }), mcp.rpc("resources/read", { uri: resourceUri(E, "whoop://status") })]);
    record("resources/read", null, normaliseResource(a, D, notes, true), normaliseResource(b, E, notes, true), notes, "whoop://status");
  }

  // Per day: get_day, the day resource, and trends/insights ending that day.
  const perDay = [];
  for (const day of days) {
    perDay.push(() => both("get_day", { date: day }, day));
    perDay.push(async () => {
      const notes = new Set();
      const uri = `whoop://days/${day}`;
      const [a, b] = await Promise.all([mcp.rpc("resources/read", { uri: resourceUri(D, uri) }), mcp.rpc("resources/read", { uri: resourceUri(E, uri) })]);
      record("resources/read", day, normaliseResource(a, D, notes, false), normaliseResource(b, E, notes, false), notes, uri);
    });
    if (opts.insights) for (const range of [7, 30, 90]) for (const tool of ["get_trends", "get_insights"]) perDay.push(() => both(tool, { end: day, range }, day));
  }
  let done = 0;
  await pool(perDay, opts.concurrency, async (fn) => {
    await fn();
    if (++done % 50 === 0) process.stderr.write(`  … ${done}/${perDay.length} per-day checks\n`);
  });

  // Windows: list_days (all fields, two calls of ≤12), list_workouts (every page), then every workout.
  for (let end = opts.to; end >= opts.from; end = shiftDate(end, -90)) {
    const n = Math.min(90, daysBetween(opts.from, end).length);
    await both("list_days", { end, days: n, fields: DAY_FIELDS.slice(0, 10) }, null);
    await both("list_days", { end, days: n, fields: DAY_FIELDS.slice(10) }, null);
  }
  const ids = new Set();
  for (let end = opts.to; end >= opts.from; end = shiftDate(end, -90)) {
    const n = Math.min(90, daysBetween(opts.from, end).length);
    let cursor;
    for (let page = 0; page < 100; page++) {
      const args = { end, days: n, limit: 50, ...(cursor ? { cursor } : {}) };
      const [a, b] = await both("list_workouts", args, null);
      for (const r of [a, b]) for (const row of r.result?.structuredContent?.rows ?? []) if (row.date >= opts.from && row.date <= opts.to) ids.add(row.id);
      cursor = a.result?.structuredContent?.nextCursor ?? null;
      if (!cursor) break;
    }
  }
  await pool([...ids], opts.concurrency, (id) => both("get_workout", { id }, null, id));

  // sync_now: the extension only, shape only.
  {
    const r = await call(E, "sync_now", {});
    const s = r.result?.structuredContent;
    const ok = !r.error && (r.result?.isError === true || (s && typeof s.started === "boolean" && typeof s.syncing === "boolean" && typeof s.note === "string" && Object.keys(s).length === 3));
    record("sync_now (extension, shape)", null, true, ok);
  }

  // Summary.
  console.log("\nPer tool:");
  const tools = [...new Set(checks.map((c) => c.tool))];
  for (const t of tools) {
    const cs = checks.filter((c) => c.tool === t);
    const bad = cs.filter((c) => !c.equal).length;
    console.log(`  ${bad ? "✗" : "✓"} ${t.padEnd(28)} ${cs.length - bad}/${cs.length} equal`);
  }
  const badDays = days.map((d) => [d, checks.filter((c) => c.day === d && !c.equal).map((c) => c.tool)]).filter(([, t]) => t.length);
  console.log(`\nPer day: ${days.length - badDays.length}/${days.length} days fully equal`);
  for (const [d, t] of badDays) console.log(`  ✗ ${d}: ${[...new Set(t)].join(", ")}`);
  const notes = [...new Set(checks.flatMap((c) => c.notes))];
  if (notes.length) console.log(`\nNotes: ${notes.join("; ")}`);
  const failed = checks.filter((c) => !c.equal).length;
  console.log(failed ? `\nNOT at parity: ${failed} of ${checks.length} checks differ.` : `\nParity: all ${checks.length} checks equal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`parity: ${err.message}`);
  process.exit(2);
});
