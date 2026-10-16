// Parity with the dashboard: every request in golden-cases.mjs, answered by the built extension (spawned under the
// permission model against the fake WHOOP serving the fixture), must equal what the dashboard's own mcp.ts answered
// over the same data (test/goldens/goldens.json, made by scripts/goldens.mjs). Only `syncedAt` is normalised.
// Run twice: cold (empty cache) and warm (a restart reading the cache the first run wrote).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeWhoop } from "./fake-whoop.mjs";
import { newStateDir, startExtension } from "./harness.mjs";
import { fixture, goldens, normalise, setup } from "./helpers.mjs";

const g = goldens();

async function runAll(ext) {
  const out = [];
  for (const c of g.cases) {
    try {
      out.push({ name: c.name, result: await ext.request(c.method, c.params) });
    } catch (err) {
      out.push({ name: c.name, error: { code: err.rpc?.code ?? null, message: String(err.message) } });
    }
  }
  return out;
}

function compare(actual, label) {
  const diffs = [];
  g.cases.forEach((c, i) => {
    const want = c.error ? { error: c.error } : normalise(c.result);
    const got = actual[i].error ? { error: actual[i].error } : normalise(actual[i].result);
    try {
      assert.deepStrictEqual(got, want);
    } catch {
      diffs.push(`${label}: ${c.name}\n  want ${JSON.stringify(want).slice(0, 400)}\n  got  ${JSON.stringify(got).slice(0, 400)}`);
    }
  });
  assert.equal(diffs.length, 0, `${diffs.length} of ${g.cases.length} differ:\n${diffs.slice(0, 8).join("\n")}`);
}

describe("golden parity with the dashboard's mcp.ts", () => {
  let fake;
  let stateDir;
  before(async () => {
    fake = await startFakeWhoop(fixture());
  });
  after(async () => fake.close());

  it("cold: initialize, listings, prompts, resources and every tool match", async () => {
    const s = await setup({ fake });
    stateDir = s.stateDir;
    try {
      const init = await s.ext.request("tools/list");
      assert.ok(init.tools.length === 8);
      compare(await runAll(s.ext), "cold");
      assert.ok(existsSync(join(stateDir, "cache-v1.json")), "the cache was written");
      assert.deepEqual(s.ext.notifications.filter((n) => n.method === "xaq/events/emit"), []);
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("warm: a restart over the cache gives the same answers and fetches less", async () => {
    const before = fake.apiRequests().length;
    const s = await setup({ fake, stateDir });
    try {
      compare(await runAll(s.ext), "warm");
      const starts = fake.apiRequests().slice(before).filter((r) => r.path !== "/developer/v2/user/profile/basic" && !r.query.nextToken).map((r) => r.query.start);
      assert.ok(starts.length > 0);
      for (const start of starts) assert.ok(start > g.historyFrom, `warm fetch starts after the history start (${start})`);
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("initialize matches the dashboard's server info, instructions and capabilities", async () => {
    const ext = startExtension({ stateDir: newStateDir(), apiOrigin: fake.origin });
    try {
      const init = await ext.initialize();
      assert.deepEqual(init.serverInfo, g.initialize.serverVersion);
      assert.equal(init.instructions, g.initialize.instructions);
      assert.deepEqual(init.capabilities, g.initialize.capabilities);
    } finally {
      await ext.stop();
    }
  });
});
