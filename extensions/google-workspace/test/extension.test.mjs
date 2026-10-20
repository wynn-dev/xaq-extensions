// The built extension as xaq runs it (harness.mjs: node --permission, repeated --allow-fs-read, the minimal env),
// against the loopback fake Google: credentials only through xaq/credentials/get, the token never on stdout, stderr,
// logs, files or tool output, nothing written anywhere, token refresh after a 401, no events, clean exit.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import { INSTALL_DIR, newStateDir, spawnArgs, startExtension } from "./harness.mjs";
import { IDS, filesUnder, setup, startFake } from "./helpers.mjs";

const hashTree = (dir) => {
  const h = createHash("sha256");
  for (const f of filesUnder(dir)) h.update(f).update(readFileSync(f));
  return h.digest("hex");
};

describe("the extension under xaq's sandbox", () => {
  let fake;
  before(async () => {
    fake = await startFake();
  });
  after(async () => fake.close());

  it("is spawned exactly as the contract says, with the minimal env", async () => {
    const stateDir = newStateDir();
    assert.deepEqual(spawnArgs(INSTALL_DIR, stateDir), [
      "--permission",
      "--no-experimental-sqlite",
      `--allow-fs-read=${INSTALL_DIR}`,
      `--allow-fs-read=${stateDir}`,
      `--allow-fs-write=${stateDir}`,
      `${INSTALL_DIR}/dist/server.mjs`,
    ]);
    const ext = startExtension({ stateDir, apiOrigin: fake.origin });
    try {
      const init = await ext.initialize();
      assert.equal(init.serverInfo.name, "xaq-google-workspace");
      assert.deepEqual(Object.keys(init.capabilities).sort(), ["tools"]);
      assert.deepEqual(ext.child.spawnargs.slice(1), spawnArgs(INSTALL_DIR, stateDir));
      if (process.platform === "linux") {
        const environ = readFileSync(`/proc/${ext.child.pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => kv.split("=")[0]).sort();
        assert.deepEqual(environ, ["LANG", "TZ", "XAQ_EXT_CONNECTION_ID", "XAQ_EXT_GOOGLE_API", "XAQ_EXT_NAME", "XAQ_EXT_PROTOCOL", "XAQ_EXT_STATE_DIR"]);
      }
    } finally {
      await ext.stop();
    }
  });

  it("gets the token only from xaq/credentials/get, and it never reaches stdout, stderr, logs, files or tool output", async () => {
    const secret = "ya29.SECRET-" + "x".repeat(40);
    const before = fake.requests().length;
    const s = await setup({ fake, token: secret });
    const outputs = [];
    try {
      for (const [name, args] of [
        ["drive_search", { text: "planning" }],
        ["drive_get", { fileId: IDS.notes }],
        ["docs_read", { documentId: IDS.notes }],
        ["drive_export", { fileId: IDS.budget, format: "csv" }],
        ["docs_append", { documentId: IDS.agenda, markdown: "More." }],
        ["docs_comment_add", { documentId: IDS.notes, text: "refused: not created by the app" }],
        ["docs_read", { documentId: "1NoSuChDoC000000000000000" }],
      ]) {
        outputs.push(JSON.stringify(await s.ext.callTool(name, args)));
      }
      fake.fail({ status: 401, body: { error: { code: 401, message: `Invalid Credentials for ${secret}` } }, times: 1 });
      outputs.push(JSON.stringify(await s.ext.callTool("drive_get", { fileId: IDS.notes })));
      assert.ok(s.ext.credentialRequests.length >= 1);
      for (const p of s.ext.credentialRequests) assert.deepEqual(p, {});
      const reqs = fake.requests().slice(before);
      assert.ok(reqs.length > 8);
      for (const r of reqs) assert.equal(r.auth, `Bearer ${secret}`);
      for (const f of filesUnder(s.stateDir)) assert.ok(!readFileSync(f, "utf8").includes(secret), `${f} has no token`);
      assert.ok(!s.ext.stdoutRaw.includes(secret), "stdout");
      assert.ok(!s.ext.stderr.includes(secret), "stderr");
      assert.ok(!JSON.stringify(s.ext.logs).includes(secret), "xaq/log");
      assert.ok(!outputs.join("\n").includes(secret), "tool output");
      assert.ok(!outputs.join("\n").includes("SECRET"), "not even part of it (Google's message is scrubbed)");
      assert.deepEqual(s.ext.stdoutJunk, []);
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("writes nothing: not in its state dir, its install dir, or next to them", async () => {
    const installBefore = hashTree(INSTALL_DIR);
    const stateDir = newStateDir();
    const s = await setup({ fake, stateDir });
    try {
      await s.call("drive_export", { fileId: IDS.deck, format: "pdf", includeBase64: true });
      await s.call("docs_create", { title: "Scratch", markdown: "# Hi" });
    } finally {
      await s.close({ keepFake: true });
    }
    assert.deepEqual(readdirSync(stateDir), []);
    assert.deepEqual(readdirSync(dirname(stateDir)), ["conn_test"]);
    assert.equal(hashTree(INSTALL_DIR), installBefore);
  });

  it("asks xaq again after a 401 and uses the rotated token; a refused credentials request reads as reconnect", async () => {
    let n = 0;
    fake.state.validTokens.add("rot-2");
    const s = await setup({ fake, token: "rot-1", credentials: () => ({ accessToken: n++ === 0 ? "rot-1" : "rot-2", expiresAt: Date.now() + 3_600_000 }) });
    fake.state.validTokens.delete("rot-1");
    try {
      const r = await s.call("drive_get", { fileId: IDS.notes });
      assert.equal(r.isError, false, r.text);
      assert.equal(s.ext.credentialRequests.length, 2);
    } finally {
      await s.close({ keepFake: true });
    }

    const broken = await setup({
      fake,
      credentials: () => {
        throw new Error("needs reauth");
      },
    });
    try {
      const r = await broken.call("drive_search", { name: "Q3" });
      assert.equal(r.isError, true);
      assert.match(r.text, /Reconnect Google Workspace in xaq/);
    } finally {
      await broken.close({ keepFake: true });
    }
  });

  it("a token Google keeps refusing reads as reconnect, after one fresh token", async () => {
    const s = await setup({ fake, token: "dead", credentials: () => ({ accessToken: "dead", expiresAt: Date.now() + 3_600_000 }) });
    fake.state.validTokens.delete("dead");
    try {
      const before = fake.requests().length;
      const r = await s.call("drive_get", { fileId: IDS.notes });
      assert.equal(r.isError, true);
      assert.match(r.text, /Reconnect Google Workspace in xaq/);
      assert.equal(fake.requests().length - before, 1, "no second request with the same token");
      assert.equal(s.ext.credentialRequests.length, 2, "asked xaq once more");
    } finally {
      await s.close({ keepFake: true });
    }
  });

  it("emits no events and stops on SIGTERM", async () => {
    const s = await setup({ fake });
    await s.call("drive_search", { name: "Q3" });
    assert.deepEqual(s.ext.notifications.filter((x) => x.method !== "xaq/log"), []);
    const exit = await s.ext.stop();
    assert.ok(exit.code === 0 || exit.signal === "SIGTERM", JSON.stringify(exit));
  });

  it("exits when stdin closes (xaq went away)", async () => {
    const ext = startExtension({ stateDir: newStateDir(), apiOrigin: fake.origin });
    await ext.initialize();
    ext.child.stdin.end();
    const exit = await ext.exited;
    assert.equal(exit.code, 0);
  });
});
