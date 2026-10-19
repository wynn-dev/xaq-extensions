// Google's failures, end to end through the spawned extension: what the agent reads, and how many requests reach
// Google (bounded retries with Retry-After, none for a non-GET 5xx, no retry storm under a long 429).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { errors } from "./fake-google.mjs";
import { IDS, setup, startFake } from "./helpers.mjs";

describe("errors in plain words, and retries", () => {
  let fake;
  before(async () => {
    fake = await startFake();
  });
  after(async () => fake.close());

  /** A fresh extension (its own rate-limit state) on the shared fake. */
  async function withExt(fn, opts = {}) {
    const s = await setup({ fake, ...opts });
    try {
      await fn(s);
    } finally {
      await s.close({ keepFake: true });
    }
  }
  const count = () => fake.requests().length;

  it("a disabled API names it and links to enabling it in the user's project", async () => {
    await withExt(async (s) => {
      fake.fail({ match: (r) => r.host === "docs.googleapis.com", status: 403, body: errors.serviceDisabled("docs.googleapis.com", "Google Docs API") });
      const r = await s.call("docs_append", { documentId: IDS.agenda, markdown: "x" });
      assert.equal(r.isError, true);
      assert.equal(
        r.text,
        "The Google Docs API is turned off in the Google Cloud project this connection uses. Enable it here, wait a minute, and try again: https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123456789012",
      );
      // Drive's legacy shape (accessNotConfigured) maps the same way.
      fake.fail({ status: 403, body: errors.drive(403, "accessNotConfigured", "Access Not Configured. Drive API has not been used in project 42 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=42 then retry.") });
      const d = await s.call("drive_search", { name: "x" });
      assert.match(d.text, /^The Google Drive API is turned off .* https:\/\/console\.developers\.google\.com\/apis\/api\/drive\.googleapis\.com\/overview\?project=42$/);
    });
  });

  it("a missing scope asks for re-consent; a view-only file says so with Google's words", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 403, body: errors.scope() });
      const r = await s.call("docs_replace_text", { documentId: IDS.agenda, find: "a", replace: "b" });
      assert.match(r.text, /missing a permission the extension needs\. Reconnect Google Workspace in xaq and tick every permission/);
      fake.fail({ status: 403, body: errors.rpc(403, "PERMISSION_DENIED", "The caller does not have permission") });
      const v = await s.call("docs_replace_text", { documentId: IDS.agenda, find: "a", replace: "b" });
      assert.equal(v.text, 'Google refused: this account doesn\'t have permission for that (for example, the file is shared view-only). Google said: "The caller does not have permission"');
    });
  });

  it("404 says the file doesn't exist or isn't visible", async () => {
    await withExt(async (s) => {
      const r = await s.call("drive_get", { fileId: "1NoSuChFiLe000000000000000" });
      assert.equal(r.text, "Google found nothing with that id: it doesn't exist, was deleted, or this Google account can't see it.");
      const d = await s.call("docs_append", { documentId: "1NoSuChFiLe000000000000000", markdown: "x" });
      assert.match(d.text, /^Google found nothing with that id/);
    });
  });

  it("a 429 with a short Retry-After is waited out and retried once", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 429, body: errors.rpc(429, "RESOURCE_EXHAUSTED", "Quota exceeded"), headers: { "retry-after": "1" } });
      const n = count();
      const t0 = Date.now();
      const r = await s.call("drive_get", { fileId: IDS.notes });
      assert.equal(r.isError, false, r.text);
      assert.ok(Date.now() - t0 >= 1000, "waited for Retry-After");
      assert.equal(count() - n, 2);
    });
  });

  it("a long Retry-After isn't waited: one request, a clear answer, and nothing more is sent until it passes", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 429, body: errors.rpc(429, "RESOURCE_EXHAUSTED", "Quota exceeded"), headers: { "retry-after": "120" } });
      const n = count();
      const r = await s.call("drive_search", { name: "Q3" });
      assert.equal(r.isError, true);
      assert.match(r.text, /^Google is rate-limiting this connection\. Try again in 1[12]\d seconds\.$/);
      const again = await s.call("drive_get", { fileId: IDS.notes });
      assert.match(again.text, /rate-limiting/);
      assert.equal(count() - n, 1, "no retry storm");
    });
  });

  it("Drive's 403 userRateLimitExceeded retries like a 429; a daily quota doesn't", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 403, body: errors.drive(403, "userRateLimitExceeded", "User Rate Limit Exceeded") });
      const n = count();
      assert.equal((await s.call("drive_search", { name: "Q3" })).isError, false);
      assert.equal(count() - n, 2);
      fake.fail({ status: 403, body: errors.drive(403, "dailyLimitExceeded", "Daily Limit Exceeded") });
      const q = await s.call("drive_search", { name: "Q3" });
      assert.match(q.text, /quota for this project is used up/);
    });
  });

  it("5xx: a GET is tried three times with backoff, then fails in plain words; a POST is never resent", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 503, body: errors.rpc(503, "UNAVAILABLE", "The service is currently unavailable."), times: 2 });
      let n = count();
      assert.equal((await s.call("drive_get", { fileId: IDS.notes })).isError, false, "third try succeeds");
      assert.equal(count() - n, 3);
      fake.fail({ status: 500, body: errors.rpc(500, "INTERNAL", "Internal error encountered."), times: 5 });
      n = count();
      const r = await s.call("drive_get", { fileId: IDS.notes });
      assert.equal(r.text, "Google's Google Drive API is having trouble (HTTP 500). Try again in a minute.");
      assert.equal(count() - n, 3, "bounded");
      fake.state.failures.length = 0;
      fake.fail({ match: (x) => x.method === "POST", status: 503, body: errors.rpc(503, "UNAVAILABLE", "unavailable"), times: 5 });
      n = count();
      const c = await s.call("docs_create", { title: "Once", markdown: "only once" });
      assert.equal(c.isError, true);
      assert.equal(count() - n, 1, "a create is never sent twice");
      fake.state.failures.length = 0;
    });
  });

  it("a request that hangs times out (and a GET is retried) instead of blocking the call", async () => {
    await withExt(
      async (s) => {
        fake.state.hang = 3;
        fake.state.holdMs = 3_000;
        const n = count();
        const r = await s.call("drive_get", { fileId: IDS.notes });
        assert.equal(r.isError, true);
        assert.match(r.text, /^Couldn't reach Google's Google Drive API \(network error or timeout\)/);
        assert.equal(count() - n, 3);
        fake.state.hang = 0;
      },
      { extraEnv: { XAQ_EXT_GOOGLE_TIMEOUT_MS: "300" } },
    );
  });

  it("an answer over the size cap is refused, not buffered", async () => {
    await withExt(async (s) => {
      fake.fail({ match: (r) => r.path.endsWith("/export"), status: 200, body: Buffer.alloc(13 * 1024 * 1024, 0x41), headers: { "content-type": "application/pdf" } });
      const r = await s.call("drive_export", { fileId: IDS.deck, format: "pdf" });
      assert.equal(r.isError, true);
      assert.equal(r.text, "Google's answer is larger than the extension accepts (12 MB).");
    });
  });

  it("a Google 400 passes Google's own message on", async () => {
    await withExt(async (s) => {
      fake.fail({ status: 400, body: errors.rpc(400, "INVALID_ARGUMENT", "Invalid requests[0].insertTable: Tables cannot be inserted here.") });
      const r = await s.call("docs_append", { documentId: IDS.agenda, markdown: "x" });
      assert.equal(r.text, 'Google refused the request (HTTP 400). Google said: "Invalid requests[0].insertTable: Tables cannot be inserted here."');
    });
  });
});
