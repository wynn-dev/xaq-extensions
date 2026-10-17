// The built extension as xaq runs it (harness.mjs: node --permission, repeated --allow-fs-read, the minimal env),
// against the loopback fake WHOOP: credentials only through xaq/credentials/get, nothing written outside the state
// dir, no tokens on disk or in logs, rate limits, coalescing, sync_now, config, a corrupt cache, no events.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeWhoop } from "./fake-whoop.mjs";
import { INSTALL_DIR, newStateDir, spawnArgs, startExtension } from "./harness.mjs";
import { filesUnder, fixture, setup } from "./helpers.mjs";

const parse = (r) => JSON.parse(r.content[0].text);
const hashTree = (dir) => {
  const h = createHash("sha256");
  for (const f of filesUnder(dir).filter((p) => !p.includes("/node_modules/"))) h.update(f).update(readFileSync(f));
  return h.digest("hex");
};

describe("the extension under xaq's sandbox", () => {
  let fake;
  before(async () => {
    fake = await startFakeWhoop(fixture());
  });
  after(async () => fake.close());

  it("is spawned exactly as the contract says, with the minimal env", async () => {
    const stateDir = newStateDir();
    assert.deepEqual(spawnArgs(INSTALL_DIR, stateDir), [
      "--permission",
      `--allow-fs-read=${INSTALL_DIR}`,
      `--allow-fs-read=${stateDir}`,
      `--allow-fs-write=${stateDir}`,
      `${INSTALL_DIR}/dist/server.mjs`,
    ]);
    const ext = startExtension({ stateDir, apiOrigin: fake.origin });
    try {
      await ext.initialize();
      assert.deepEqual(ext.child.spawnargs.slice(1), spawnArgs(INSTALL_DIR, stateDir));
      if (process.platform === "linux") {
        const environ = readFileSync(`/proc/${ext.child.pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => kv.split("=")[0]).sort();
        assert.deepEqual(environ, ["LANG", "TZ", "XAQ_EXT_CONNECTION_ID", "XAQ_EXT_NAME", "XAQ_EXT_PROTOCOL", "XAQ_EXT_STATE_DIR", "XAQ_EXT_WHOOP_API"]);
      }
    } finally {
      await ext.stop();
    }
  });

  it("gets the token only from xaq/credentials/get, and never writes or logs it", async () => {
    const secret = "tok-SECRET-" + "x".repeat(24);
    const before = fake.apiRequests().length;
    const s = await setup({ fake, token: secret });
    try {
      await s.ext.callTool("get_status");
      await s.ext.callTool("get_insights", { range: 90 });
      await s.ext.callTool("sync_now");
      assert.ok(s.ext.credentialRequests.length >= 1);
      for (const p of s.ext.credentialRequests) assert.deepEqual(p, {});
      const reqs = fake.apiRequests().slice(before);
      assert.ok(reqs.length > 5);
      for (const r of reqs) assert.equal(r.auth, `Bearer ${secret}`);
      for (const f of filesUnder(s.stateDir)) assert.ok(!readFileSync(f, "utf8").includes(secret), `${f} has no token`);
      assert.ok(!JSON.stringify(s.ext.logs).includes(secret));
      assert.ok(!s.ext.stderr.includes(secret));
      assert.deepEqual(s.ext.stdoutJunk, []);
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("writes nothing outside its state dir (only the cache inside it)", async () => {
    const installBefore = hashTree(INSTALL_DIR);
    const stateDir = newStateDir();
    const parent = dirname(stateDir);
    const s = await setup({ fake, stateDir });
    try {
      await s.ext.callTool("get_trends", { range: 90 });
      await s.ext.callTool("sync_now");
    } finally {
      await s.close({ keepFake: true });
    }
    assert.deepEqual(readdirSync(stateDir), ["cache-v1.json"]);
    assert.deepEqual(readdirSync(parent), ["conn_test"]);
    assert.equal(hashTree(INSTALL_DIR), installBefore);
    const mode = (await import("node:fs")).statSync(join(stateDir, "cache-v1.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("asks xaq again after a 401 and uses the rotated token; a failing credentials request reads as reconnect", async () => {
    let n = 0;
    fake.state.validTokens.add("rot-2");
    const s = await setup({ fake, token: "rot-1", credentials: () => ({ accessToken: n++ === 0 ? "rot-1" : "rot-2", expiresAt: Date.now() + 3_600_000 }) });
    fake.state.validTokens.delete("rot-1");
    try {
      const status = await s.ext.callTool("get_status");
      assert.ok(!status.isError, JSON.stringify(status));
      assert.equal(s.ext.credentialRequests.length, 2);
    } finally {
      await s.close({ keepFake: true });
    }

    const broken = await setup({ fake, credentials: () => {
      throw new Error("needs reauth");
    } });
    try {
      const r = await broken.ext.callTool("get_status");
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Reconnect WHOOP in xaq/);
    } finally {
      await broken.close({ keepFake: true });
    }
  });

  it("reports a dead token in get_status after data was loaded", async () => {
    let ok = true;
    const s = await setup({ fake, token: "dies", credentials: () => {
      if (!ok) throw new Error("revoked");
      return { accessToken: "dies", expiresAt: Date.now() + 3_600_000 };
    } });
    try {
      assert.equal(parse(await s.ext.callTool("get_status")).needsReconnect, false);
      fake.state.validTokens.delete("dies");
      ok = false;
      const sync = await s.ext.callTool("sync_now");
      assert.equal(sync.isError, true);
      assert.match(sync.content[0].text, /reconnect/);
      const status = parse(await s.ext.callTool("get_status"));
      assert.equal(status.needsReconnect, true);
      assert.equal(status.syncError, "reconnect_required");
      assert.ok(status.dataSpan.days > 40, "still serves the data it has");
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("honours a 429 and its reset, and doesn't retry inside a long block", async () => {
    fake.state.forced429 = 1;
    fake.state.reset429 = "1";
    const s = await setup({ fake });
    try {
      const t0 = Date.now();
      const r = await s.ext.callTool("get_status");
      assert.ok(!r.isError, JSON.stringify(r));
      assert.ok(Date.now() - t0 >= 1000, "waited for the reset");
    } finally {
      await s.close({ keepFake: true });
    }

    fake.state.forced429 = 50;
    fake.state.reset429 = "600";
    const before = fake.apiRequests().length;
    const blocked = await setup({ fake });
    try {
      const r = await blocked.ext.callTool("get_status");
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /rate limit/i);
      const again = await blocked.ext.callTool("list_days");
      assert.equal(again.isError, true);
      assert.equal(fake.apiRequests().length - before, 1, "one request, then nothing while blocked");
    } finally {
      fake.state.forced429 = 0;
      await blocked.close({ keepFake: true });
    }
  });

  it("coalesces concurrent tool calls into one round of requests", async () => {
    const s = await setup({ fake });
    try {
      const before = fake.apiRequests().length;
      const calls = ["get_status", "list_days", "list_workouts", "get_trends", "get_insights", "get_day"].map((name) => s.ext.callTool(name));
      const results = await Promise.all(calls);
      for (const r of results) assert.ok(!r.isError);
      const reqs = fake.apiRequests().slice(before);
      const firstPages = reqs.filter((r) => !r.query.nextToken);
      assert.equal(firstPages.length, 5, "profile + 4 collections, once");
      assert.equal(new Set(reqs.map((r) => r.path + r.search)).size, reqs.length, "no request twice");
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("sync_now answers with the dashboard's shape and refetches the whole history", async () => {
    const s = await setup({ fake });
    try {
      await s.ext.callTool("get_status");
      const before = fake.apiRequests().length;
      const r = await s.ext.callTool("sync_now");
      assert.deepEqual(r.structuredContent, { started: true, syncing: false, note: "Sync finished." });
      assert.ok(fake.apiRequests().slice(before).some((q) => q.query.start === "2026-08-25T00:00:00.000Z"));
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("keeps serving with syncError when WHOOP goes down", async () => {
    const s = await setup({ fake });
    try {
      await s.ext.callTool("get_status");
      fake.state.down = true;
      const sync = await s.ext.callTool("sync_now");
      assert.equal(sync.isError, true);
      assert.match(sync.content[0].text, /whoop_unavailable/);
      const status = parse(await s.ext.callTool("get_status"));
      assert.equal(status.syncError, "whoop_unavailable");
      assert.equal(status.needsReconnect, false);
    } finally {
      fake.state.down = false;
      await s.close({ keepFake: true });
    }
  });

  it("reads historyFrom from config.json and survives a corrupt cache", async () => {
    const stateDir = newStateDir();
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ historyFrom: "2026-09-01" }));
    writeFileSync(join(stateDir, "cache-v1.json"), "\u0000garbage{");
    const before = fake.apiRequests().length;
    const s = await setup({ fake, stateDir });
    try {
      const status = parse(await s.ext.callTool("get_status"));
      assert.ok(status.dataSpan.first >= "2026-09-01", status.dataSpan.first);
      assert.ok(fake.apiRequests().slice(before).some((q) => q.query.start === "2026-09-01T00:00:00.000Z"));
      assert.equal(JSON.parse(readFileSync(join(stateDir, "cache-v1.json"), "utf8")).historyFrom, "2026-09-01T00:00:00.000Z");
      assert.deepEqual(readFileSync(join(stateDir, "config.json"), "utf8"), JSON.stringify({ historyFrom: "2026-09-01" }), "never rewrites config");
      writeFileSync(join(stateDir, "config.json"), JSON.stringify({ historyFrom: "2026-09-10" }));
      assert.equal((await s.ext.callTool("sync_now")).isError, undefined);
      assert.ok(parse(await s.ext.callTool("get_status")).dataSpan.first >= "2026-09-10", "sync_now re-reads config.json");
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("emits no events and stops on SIGTERM", async () => {
    const s = await setup({ fake });
    await s.ext.callTool("sync_now");
    assert.deepEqual(s.ext.notifications.filter((n) => n.method !== "xaq/log"), []);
    const exit = await s.ext.stop();
    assert.ok(exit.code === 0 || exit.signal === "SIGTERM", JSON.stringify(exit));
  });
});
