// scripts/parity.mjs against a fake xaq with two connections. Both are the extension here (the dashboard can't run
// in this repo's tests; the goldens cover dashboard ≡ extension), so the test checks the script's mechanics: xaq's
// naming and wrapper are normalised away, a real difference is found and fails the run, and the key is never printed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { lastCompleteDay, suggestedHistoryFrom } from "../scripts/parity.mjs";
import { startFakeWhoop } from "./fake-whoop.mjs";
import { startFakeXaq } from "./fake-xaq.mjs";
import { newStateDir } from "./harness.mjs";
import { fixture, setup } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/parity.mjs", import.meta.url));
const KEY = "aib_parity_" + "k".repeat(30);
const READ_ALL = new Set(["get_status", "get_day", "list_days", "list_workouts", "get_workout", "get_trends", "get_insights", "sync_now"]);

function run(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, TZ: "UTC", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("parity script", () => {
  let a;
  let b;
  let xaq;
  let tamperedB;
  let xaqTampered;
  before(async () => {
    a = await setup();
    b = await setup();
    const f = fixture();
    f.workouts[f.workouts.length - 6].score.strain += 1;
    tamperedB = await setup({ fake: await startFakeWhoop(f) });
    // The dashboard as a generic connection: generic read rule, so its sync_now (readOnlyHint false) is hidden.
    xaq = await startFakeXaq({ key: KEY, connections: [{ slug: "whoop", ext: a.ext, readTools: null }, { slug: "whoop-ext", ext: b.ext, readTools: READ_ALL }] });
    xaqTampered = await startFakeXaq({ key: KEY, connections: [{ slug: "whoop", ext: a.ext, readTools: null }, { slug: "whoop-ext", ext: tamperedB.ext, readTools: READ_ALL }] });
  });
  after(async () => {
    await xaq.close();
    await xaqTampered.close();
    await a.close();
    await b.close();
    await tamperedB.close();
  });

  it("exits 0 at parity, through xaq's naming and wrapper", async () => {
    const r = await run({ XAQ_URL: xaq.url, XAQ_PARITY_KEY: KEY }, ["--from", "2026-09-20", "--to", "2026-10-15"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Parity: all \d+ checks equal/);
    assert.match(r.out, /26\/26 days fully equal/);
    assert.ok(!r.out.includes(KEY));
  });

  it("finds a difference, names the tool and day, and exits 1", async () => {
    const r = await run({ XAQ_URL: xaqTampered.url, XAQ_PARITY_KEY: KEY }, ["--days", "60", "--to", "2026-10-15", "--max-diffs", "3", "--no-insights"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ get_workout/);
    assert.match(r.out, /NOT at parity/);
    assert.ok(!r.out.includes(KEY));
  });

  it("ends the window the day before the dashboard's last sync, and suggests the history start instant", () => {
    assert.equal(lastCompleteDay("2026-10-16T09:00:00Z", "+02:00"), "2026-10-15");
    // 01:00 on the 17th locally is still the 16th in UTC: the earlier of the two wins.
    assert.equal(lastCompleteDay("2026-10-16T23:00:00Z", "+02:00"), "2026-10-15");
    assert.equal(lastCompleteDay("2026-10-17T02:00:00Z", "-04:00"), "2026-10-15");
    assert.equal(suggestedHistoryFrom("2026-09-03", "11:42\u202fPM", "+02:00"), "2026-09-02T21:43:00.000Z");
    assert.equal(suggestedHistoryFrom("2026-09-03", "12:20 AM", "+02:00"), "2026-09-02T22:21:00.000Z");
    assert.equal(suggestedHistoryFrom("2026-09-03", null, "+02:00"), null);
  });

  it("converges when the dashboard's history starts at an instant: the hint's historyFrom gives parity", async () => {
    // The "dashboard" here starts its history in the night of 2 to 3 September (as a first sync minus 90 days would).
    const dash = await setup({ fake: a.fake, stateDir: (() => {
      const d = newStateDir();
      writeFileSync(join(d, "config.json"), JSON.stringify({ historyFrom: "2026-09-03T01:00:00Z" }));
      return d;
    })() });
    const extn = await setup({ fake: a.fake });
    const x = await startFakeXaq({ key: KEY, connections: [{ slug: "whoop", ext: dash.ext, readTools: null }, { slug: "whoop-ext", ext: extn.ext, readTools: READ_ALL }] });
    try {
      const args = ["--from", "2026-09-01", "--to", "2026-09-30"];
      const first = await run({ XAQ_URL: x.url, XAQ_PARITY_KEY: KEY }, args);
      assert.equal(first.code, 1, first.out);
      const m = /write (\{"historyFrom": "[^"]+"\})/.exec(first.out);
      assert.ok(m, first.out);
      writeFileSync(join(extn.stateDir, "config.json"), m[1]);
      assert.ok(!(await extn.ext.callTool("sync_now")).isError);
      const second = await run({ XAQ_URL: x.url, XAQ_PARITY_KEY: KEY }, args);
      assert.equal(second.code, 0, second.out);
    } finally {
      await x.close();
      await dash.ext.stop();
      await extn.ext.stop();
    }
  });

  it("refuses a bad key without printing it, and takes slugs as flags", async () => {
    const r = await run({ XAQ_URL: xaq.url, XAQ_PARITY_KEY: "aib_wrong_secret_value" }, []);
    assert.equal(r.code, 2);
    assert.match(r.out, /refused the agent key/);
    assert.ok(!r.out.includes("aib_wrong_secret_value"));
    const s = await run({ XAQ_URL: xaq.url, XAQ_PARITY_KEY: KEY }, ["--extension-slug", "nope", "--days", "2", "--to", "2026-10-15"]);
    assert.equal(s.code, 2);
    assert.match(s.out, /sees no nope__ tools/);
  });
});
