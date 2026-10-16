// In-process tests of the modules behind dist: the rate gate, the API client's retry rules, the live source and its
// cache, config parsing. Clocks, sleeps and fetch are injected; no sockets.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collection } from "./fake-whoop.mjs";
import { fixture } from "./helpers.mjs";
import { lib } from "./unit.mjs";

const { RateGate, RateLimitedError, WhoopApi, WhoopError, apiBase, retryAfterMs, parseHistoryFrom, readConfig, parseExpiry, CacheStore, createLiveSource, isFinal } = lib;
const silent = { info() {}, warn() {} };
const DAY = 86_400_000;

function clock(start = Date.parse("2026-10-16T12:00:00Z")) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.slept.push(ms);
    c.t += ms;
  };
  return c;
}

const res = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("RateGate", () => {
  it("spends the burst, then waits for the refill", async () => {
    const c = clock();
    const gate = new RateGate({ now: c.now, sleep: c.sleep, random: () => 0, capacity: 2, refillPerMinute: 60 });
    for (let i = 0; i < 3; i++) await gate.run(async () => null);
    assert.deepEqual(c.slept, [1000]);
    assert.equal(gate.used, 3);
  });

  it("holds every request after a 429 block, with jitter, and fails fast past maxWait", async () => {
    const c = clock();
    const gate = new RateGate({ now: c.now, sleep: c.sleep, random: () => 1, maxWaitMs: 10_000 });
    gate.block(5_000);
    await gate.run(async () => null);
    assert.equal(c.slept[0], 6_000, "5 s plus 20% jitter");
    gate.block(60_000);
    await assert.rejects(gate.run(async () => null), RateLimitedError);
  });

  it("stops at the daily budget until the next UTC day", async () => {
    const c = clock(Date.parse("2026-10-16T23:59:00Z"));
    const gate = new RateGate({ now: c.now, sleep: c.sleep, dailyBudget: 2, maxWaitMs: 1 });
    await gate.run(async () => null);
    await gate.run(async () => null);
    await assert.rejects(gate.run(async () => null), RateLimitedError);
    c.t += 120_000;
    await gate.run(async () => null);
  });

  it("allows at most two requests in flight", async () => {
    const gate = new RateGate();
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    assert.equal(peak, 2);
  });
});

describe("apiBase", () => {
  it("is WHOOP unless a loopback http origin is given for tests", () => {
    assert.equal(apiBase({}), "https://api.prod.whoop.com/developer");
    assert.equal(apiBase({ XAQ_EXT_WHOOP_API: "http://127.0.0.1:4567" }), "http://127.0.0.1:4567/developer");
    assert.equal(apiBase({ XAQ_EXT_WHOOP_API: "http://localhost:80/" }), "http://localhost/developer");
    for (const bad of ["https://evil.example", "http://127.0.0.1.evil.example:1", "http://10.0.0.1:1", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/x", "file:///etc", "nonsense"]) {
      assert.equal(apiBase({ XAQ_EXT_WHOOP_API: bad }), "https://api.prod.whoop.com/developer", bad);
    }
  });
});

describe("retryAfterMs", () => {
  it("reads Retry-After (seconds or date), then X-RateLimit-Reset, clamped to 1 s – 1 h", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    assert.equal(retryAfterMs(new Headers({ "retry-after": "7" }), now), 7000);
    assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(now + 30_000).toUTCString() }), now), 30_000);
    assert.equal(retryAfterMs(new Headers({ "x-ratelimit-reset": "12" }), now), 12_000);
    assert.equal(retryAfterMs(new Headers({ "x-ratelimit-reset": "0" }), now), 1000);
    assert.equal(retryAfterMs(new Headers({ "retry-after": "999999" }), now), 3_600_000);
    assert.equal(retryAfterMs(new Headers(), now), 60_000);
  });
});

describe("config and credentials parsing", () => {
  it("parses historyFrom as a date or ISO timestamp in the past", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    assert.equal(parseHistoryFrom("2026-08-25", now), Date.parse("2026-08-25T00:00:00Z"));
    assert.equal(parseHistoryFrom("2026-08-25T14:23:00+02:00", now), Date.parse("2026-08-25T12:23:00Z"));
    for (const bad of ["2027-01-01", "yesterday", "2014-12-31", 5, null]) assert.equal(parseHistoryFrom(bad, now), null);
  });

  it("reads config.json from the state dir and ignores a bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "whoop-config-"));
    assert.equal(readConfig(dir, silent).historyFrom, Date.parse("2026-08-25T00:00:00Z"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ historyFrom: "2026-09-01" }));
    assert.equal(readConfig(dir, silent).historyFrom, Date.parse("2026-09-01T00:00:00Z"));
    writeFileSync(join(dir, "config.json"), "{nope");
    assert.equal(readConfig(dir, silent).historyFrom, Date.parse("2026-08-25T00:00:00Z"));
  });

  it("reads expiresAt as ms, seconds or an ISO string", () => {
    assert.equal(parseExpiry(1_792_000_000_000), 1_792_000_000_000);
    assert.equal(parseExpiry(1_792_000_000), 1_792_000_000_000);
    assert.equal(parseExpiry("2026-10-16T12:00:00Z"), Date.parse("2026-10-16T12:00:00Z"));
    assert.equal(parseExpiry(null), null);
    assert.equal(parseExpiry(undefined), null);
  });
});

function apiWith(fetchImpl, opts = {}) {
  const c = opts.clock ?? clock();
  const tokens = opts.tokens ?? ["tok-1"];
  let asked = 0;
  const api = new WhoopApi({
    base: "https://api.prod.whoop.com/developer",
    credentials: async () => {
      if (opts.credentialsFail) throw new Error("needs reauth");
      return { accessToken: tokens[Math.min(asked++, tokens.length - 1)], expiresAt: opts.expiresAt ?? c.now() + 3_600_000 };
    },
    gate: new RateGate({ now: c.now, sleep: c.sleep, random: () => 0 }),
    fetch: fetchImpl,
    now: c.now,
    sleep: c.sleep,
    random: () => 0,
  });
  return { api, clock: c, asked: () => asked };
}

describe("WhoopApi", () => {
  it("waits out a 429 (Retry-After) and retries, at most twice", async () => {
    const calls = [];
    const statuses = [429, 429, 200];
    const { api, clock: c } = apiWith(async (url, init) => {
      calls.push(init.headers.authorization);
      const s = statuses.shift();
      return s === 429 ? res(429, { message: "slow down" }, { "retry-after": "3" }) : res(200, { ok: true });
    });
    assert.deepEqual(await api.get("/v2/cycle"), { ok: true });
    assert.equal(calls.length, 3);
    assert.ok(c.slept.filter((ms) => ms >= 3000).length === 2, `slept ${c.slept}`);
  });

  it("gives up as rate_limited after three 429s, or at once when the wait is too long", async () => {
    let n = 0;
    const { api } = apiWith(async () => (n++, res(429, {}, { "retry-after": "2" })));
    await assert.rejects(api.get("/v2/cycle"), (e) => e instanceof WhoopError && e.code === "rate_limited");
    assert.equal(n, 3);
    let m = 0;
    const long = apiWith(async () => (m++, res(429, {}, { "x-ratelimit-reset": "600" })));
    await assert.rejects(long.api.get("/v2/cycle"), (e) => e.code === "rate_limited");
    assert.equal(m, 1, "no retry inside a 10-minute block");
  });

  it("on 401 asks xaq again and retries with a new token; the same token means reconnect_required", async () => {
    const seen = [];
    const rotated = apiWith(async (url, init) => (seen.push(init.headers.authorization), init.headers.authorization === "Bearer tok-1" ? res(401, {}) : res(200, { ok: 1 })), { tokens: ["tok-1", "tok-2"] });
    assert.deepEqual(await rotated.api.get("/v2/cycle"), { ok: 1 });
    assert.deepEqual(seen, ["Bearer tok-1", "Bearer tok-2"]);
    const same = apiWith(async () => res(401, {}), { tokens: ["tok-1"] });
    await assert.rejects(same.api.get("/v2/cycle"), (e) => e.code === "reconnect_required");
    const failing = apiWith(async () => res(200, {}), { credentialsFail: true });
    await assert.rejects(failing.api.get("/v2/cycle"), (e) => e.code === "reconnect_required");
  });

  it("reuses the token until a minute before it expires", async () => {
    const c = clock();
    const t = apiWith(async () => res(200, {}), { clock: c, expiresAt: c.now() + 120_000 });
    await t.api.get("/v2/a");
    await t.api.get("/v2/b");
    assert.equal(t.asked(), 1);
    c.t += 61_000;
    await t.api.get("/v2/c");
    assert.equal(t.asked(), 2);
  });

  it("retries a 5xx once with backoff, then whoop_unavailable", async () => {
    let n = 0;
    const { api, clock: c } = apiWith(async () => (n++, res(503, {})));
    await assert.rejects(api.get("/v2/cycle"), (e) => e.code === "whoop_unavailable");
    assert.equal(n, 2);
    assert.ok(c.slept.some((ms) => ms >= 2000));
  });

  it("coalesces concurrent identical requests into one fetch", async () => {
    let n = 0;
    const { api } = apiWith(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 10));
      return res(200, { records: [] });
    });
    await Promise.all(Array.from({ length: 5 }, () => api.get("/v2/cycle", { start: "x" })));
    assert.equal(n, 1);
  });

  it("follows next_token and refuses a repeated one", async () => {
    const pages = { "": { records: [1, 2].map((id) => ({ id })), next_token: "a" }, a: { records: [{ id: 3 }], next_token: null } };
    const { api } = apiWith(async (url) => res(200, pages[new URL(url).searchParams.get("nextToken") ?? ""]));
    assert.deepEqual((await api.collect("/v2/cycle", "2026-01-01T00:00:00Z")).map((r) => r.id), [1, 2, 3]);
    const loop = apiWith(async () => res(200, { records: [{ id: 1 }], next_token: "same" }));
    await assert.rejects(loop.api.collect("/v2/cycle", "x"), (e) => e.code === "incomplete_import");
  });
});

/** The live source over an in-process fake WHOOP (the fixture through collection()), a temp cache and a fake clock. */
function liveSource(opts = {}) {
  const fx = opts.fixture ?? fixture();
  const c = opts.clock ?? clock(Date.parse(fx.now));
  const log = [];
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, start: u.searchParams.get("start"), nextToken: u.searchParams.get("nextToken") });
    if (opts.down?.()) throw new TypeError("fetch failed");
    if (u.pathname.endsWith("/v2/user/profile/basic")) return res(200, fx.profile);
    const kind = { "/developer/v2/cycle": "cycle", "/developer/v2/recovery": "recovery", "/developer/v2/activity/sleep": "sleep", "/developer/v2/activity/workout": "workout" }[u.pathname];
    const all = collection(fx, kind, u.searchParams.get("start"));
    const offset = Number(u.searchParams.get("nextToken") ?? 0);
    const records = all.slice(offset, offset + 25);
    return res(200, { records, next_token: offset + 25 < all.length ? String(offset + 25) : null });
  };
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "whoop-source-"));
  const { api } = apiWith(fetchImpl, { clock: c });
  const cache = new CacheStore(join(dir, "cache-v1.json"), { info: (m) => log.push(m), warn: (m) => log.push(m) });
  const source = createLiveSource({ api, cache, historyFrom: Date.parse("2026-08-25T00:00:00Z"), log: silent, now: c.now, ...opts.sourceOpts });
  return { source, clock: c, calls, dir, log, cachePath: join(dir, "cache-v1.json") };
}

describe("live source", () => {
  it("loads the whole history, then reuses it for a minute, sharing one fetch between concurrent calls", async () => {
    const s = liveSource();
    const [a, b] = await Promise.all([s.source.load(), s.source.load()]);
    assert.equal(a.records.length, b.records.length);
    const first = s.calls.length;
    assert.ok(first > 4);
    await s.source.load();
    assert.equal(s.calls.length, first, "memoised");
    s.clock.t += 61_000;
    await s.source.load();
    assert.ok(s.calls.length > first, "refetched after the memo");
  });

  it("caches only final records before the settle window and the first unscored one", async () => {
    const s = liveSource();
    await s.source.load();
    const cache = JSON.parse(readFileSync(s.cachePath, "utf8"));
    assert.equal(cache.v, 1);
    assert.ok(cache.through <= Date.parse(fixture().now) - 7 * DAY, "never the settle window");
    assert.ok(cache.records.length > 100);
    for (const r of cache.records) {
      assert.ok(isFinal(r), `${r.kind} ${r.id} is final`);
      assert.ok(r.startAt < cache.through);
    }
    assert.ok(!cache.records.some((r) => r.kind === "cycle" && !r.data.end));
    assert.ok(!JSON.stringify(cache).includes("tok-1"), "no token in the cache");
  });

  it("a restart over the cache fetches only the recent window, and the data is the same", async () => {
    const one = liveSource();
    const cold = await one.source.load();
    const two = liveSource({ dir: one.dir });
    const warm = await two.source.load();
    assert.deepEqual(warm.records, cold.records);
    const starts = two.calls.filter((c) => c.start && !c.nextToken).map((c) => c.start);
    const through = JSON.parse(readFileSync(one.cachePath, "utf8")).through;
    for (const start of starts) assert.equal(start, new Date(through - 2 * DAY).toISOString());
    assert.ok(two.calls.length < one.calls.length);
  });

  it("rebuilds the cache after a week, and ignores a corrupt or foreign one", async () => {
    const one = liveSource();
    await one.source.load();
    const builtAt = JSON.parse(readFileSync(one.cachePath, "utf8")).builtAt;
    const later = liveSource({ dir: one.dir, clock: clock(Date.parse(fixture().now) + 8 * DAY) });
    await later.source.load();
    const again = JSON.parse(readFileSync(one.cachePath, "utf8"));
    assert.ok(again.builtAt > builtAt);
    assert.ok(later.calls.some((c) => c.start === "2026-08-25T00:00:00.000Z"), "full refetch");

    writeFileSync(one.cachePath, "{ torn");
    const torn = liveSource({ dir: one.dir });
    assert.ok((await torn.source.load()).records.length > 0);
    assert.ok(torn.calls.some((c) => c.start === "2026-08-25T00:00:00.000Z"));
    assert.doesNotThrow(() => JSON.parse(readFileSync(one.cachePath, "utf8")));

    writeFileSync(one.cachePath, JSON.stringify({ ...again, v: 99 }));
    const foreign = liveSource({ dir: one.dir });
    await foreign.source.load();
    assert.equal(JSON.parse(readFileSync(one.cachePath, "utf8")).v, 1);
  });

  it("serves the last good data with syncError when WHOOP fails, and a sentence when there's nothing", async () => {
    let down = false;
    const s = liveSource({ down: () => down });
    await s.source.load();
    down = true;
    s.clock.t += 61_000;
    const degraded = await s.source.load();
    assert.equal(degraded.syncError, "whoop_unavailable");
    assert.ok(degraded.records.length > 0);
    const empty = liveSource({ down: () => true });
    await assert.rejects(empty.source.load(), /WHOOP can't be reached right now/);
  });

  it("sync() refetches the whole history and reports syncing while it runs", async () => {
    const s = liveSource();
    await s.source.load();
    const before = s.calls.length;
    const p = s.source.sync();
    assert.equal((await s.source.load()).syncing, true);
    assert.deepEqual(await p, { syncing: false });
    assert.ok(s.calls.slice(before).some((c) => c.start === "2026-08-25T00:00:00.000Z"));
    assert.equal((await s.source.load()).syncing, false);
  });
});
