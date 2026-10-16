// A fake of the WHOOP v2 API on a loopback port, for the extension running as a real child process. Adapted from
// xaq's test/fake-whoop.ts (same collection semantics: start inclusive, end exclusive, records that overlap the window,
// newest first, limit 1–25, an opaque nextToken). No OAuth here: xaq core does OAuth, and the harness hands the child
// an access token through xaq/credentials/get, so the fake only checks bearer tokens it was told are valid.

import { createServer } from "node:http";

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** The records a collection request returns, before paging: what both the fake and the goldens use. */
export function collection(fixture, kind, startIso, endIso) {
  const start = startIso ? Date.parse(startIso) : Number.NEGATIVE_INFINITY;
  const end = endIso ? Date.parse(endIso) : Number.POSITIVE_INFINITY;
  const sleepOf = (r) => fixture.sleeps.find((s) => s.id === r.sleep_id);
  const spec = {
    cycle: [fixture.cycles, (r) => r.start, (r) => r.end ?? null],
    sleep: [fixture.sleeps, (r) => r.start, (r) => r.end],
    recovery: [fixture.recoveries, (r) => sleepOf(r)?.start ?? r.created_at, (r) => sleepOf(r)?.end ?? null],
    workout: [fixture.workouts, (r) => r.start, (r) => r.end],
  }[kind];
  const [all, startOf, endOf] = spec;
  return all
    .filter((r) => {
      const s = Date.parse(startOf(r));
      const e = endOf(r) ? Date.parse(endOf(r)) : Number.POSITIVE_INFINITY;
      return e >= start && s < end;
    })
    .sort((a, b) => Date.parse(startOf(b)) - Date.parse(startOf(a)));
}

const PATHS = { "/developer/v2/cycle": "cycle", "/developer/v2/recovery": "recovery", "/developer/v2/activity/sleep": "sleep", "/developer/v2/activity/workout": "workout" };

export async function startFakeWhoop(fixture) {
  const state = {
    fixture,
    validTokens: new Set(),
    /** Every API request: `${method} ${path}${search}` plus the authorization header seen. */
    requests: [],
    forced429: 0,
    reset429: "1",
    forced500: 0,
    down: false,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const auth = req.headers.authorization ?? "";
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, query: Object.fromEntries(url.searchParams), auth, at: Date.now() });
    if (state.down) return req.socket.destroy();
    if (state.forced429 > 0) {
      state.forced429--;
      return json(res, 429, { message: "Too Many Requests" }, { "x-ratelimit-limit": "100, 100;window=60, 10000;window=86400", "x-ratelimit-remaining": "0", "x-ratelimit-reset": state.reset429 });
    }
    if (state.forced500 > 0) {
      state.forced500--;
      return json(res, 503, { message: "unavailable" });
    }
    if (req.method !== "GET") return json(res, 405, { message: "method not allowed" });
    const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? "";
    if (!state.validTokens.has(token)) return json(res, 401, { message: "Authorization was not valid" });
    if (url.pathname === "/developer/v2/user/profile/basic") return json(res, 200, state.fixture.profile);
    const kind = PATHS[url.pathname];
    if (!kind) return json(res, 404, { message: "not found" });
    const q = url.searchParams;
    const limit = q.has("limit") ? Number(q.get("limit")) : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return json(res, 400, { message: "limit must be between 1 and 25" });
    const matching = collection(state.fixture, kind, q.get("start"), q.get("end"));
    const offset = q.has("nextToken") ? Number(Buffer.from(q.get("nextToken"), "base64url").toString()) : 0;
    if (!Number.isInteger(offset) || offset < 0) return json(res, 400, { message: "bad nextToken" });
    const records = matching.slice(offset, offset + limit);
    const next = offset + limit < matching.length ? Buffer.from(String(offset + limit)).toString("base64url") : undefined;
    return json(res, 200, next ? { records, next_token: next } : { records, next_token: null });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    apiRequests: () => state.requests.filter((r) => r.path.startsWith("/developer/v2/")),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
