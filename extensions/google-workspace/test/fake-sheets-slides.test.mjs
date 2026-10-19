// The fake Sheets/Slides handlers mounted on a loopback http server, as W1's fake Google server mounts them. Needs
// nothing installed. Loopback only: no real network, no Google account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createFakeSheetsSlides, fakeParseRange, nodeHandler } from "./fake-sheets-slides.mjs";

describe("fake Sheets/Slides mounted on node:http", () => {
  const fake = createFakeSheetsSlides();
  const handle = nodeHandler(fake);
  let origin;
  let server;
  before(async () => {
    server = createServer(async (req, res) => {
      if (await handle(req, res)) return;
      res.writeHead(418).end("not mine");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const req = async (method, path, body) => {
    const res = await fetch(origin + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };

  it("serves the Sheets paths: create, write, read back", async () => {
    const created = await req("POST", "/v4/spreadsheets", { properties: { title: "Mounted" }, sheets: [{ properties: { title: "Data Tab" } }] });
    assert.equal(created.status, 200);
    const id = created.body.spreadsheetId;
    const range = encodeURIComponent("'Data Tab'!A1:B2");
    const put = await req("PUT", `/v4/spreadsheets/${id}/values/${range}?valueInputOption=RAW`, { range: "'Data Tab'!A1:B2", values: [["a", "b"], ["c", "d"]] });
    assert.equal(put.body.updatedRange, "'Data Tab'!A1:B2");
    const got = await req("GET", `/v4/spreadsheets/${id}/values/${range}`);
    assert.deepEqual(got.body.values, [["a", "b"], ["c", "d"]]);
  });

  it("serves the Slides paths and answers Google-shaped errors", async () => {
    const created = await req("POST", "/v1/presentations", { title: "Mounted deck" });
    assert.equal(created.body.slides[0].objectId, "p");
    const bad = await req("POST", `/v1/presentations/${created.body.presentationId}:batchUpdate`, { requests: [{ deleteObject: { objectId: "nope1" } }] });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.body.error).sort(), ["code", "message", "status"]);
    assert.equal(bad.body.error.status, "INVALID_ARGUMENT");
  });

  it("leaves other paths, and files it doesn't hold, to whoever mounted it (body unread)", async () => {
    for (const [method, path, body] of [
      ["GET", "/v1/documents/abc"],
      ["GET", "/v1/presentations/1MissingDeckXXXXXXXXXXXXXXXXXXXXXXXXX"],
      ["GET", "/v4/spreadsheets/1ShEeTbUdGeT2026000000000000000000000000ccc/values:batchGet?ranges=Sheet1"],
      ["POST", "/v4/spreadsheets/1ShEeTbUdGeT2026000000000000000000000000ccc:batchUpdate", { requests: [] }],
      ["GET", "/drive/v3/files/1DoCq3PlAnNiNgNoTeS0000000000000000000000aaa"],
    ]) {
      const other = await req(method, path, body);
      assert.equal(other.status, 418, path);
      assert.equal(other.body, "not mine");
    }
  });

  it("batchUpdate is atomic: a failing request leaves the deck untouched", async () => {
    const created = await req("POST", "/v1/presentations", { title: "Atomic" });
    const id = created.body.presentationId;
    const res = await req("POST", `/v1/presentations/${id}:batchUpdate`, { requests: [{ createSlide: { objectId: "slide_ok1" } }, { deleteObject: { objectId: "nope1" } }] });
    assert.equal(res.status, 400);
    const deck = await req("GET", `/v1/presentations/${id}`);
    assert.deepEqual(deck.body.slides.map((s) => s.objectId), ["p"]);
  });

  it("the fake's own A1 reading is strict (unquoted names with spaces refused), so a tool that forgets to quote fails here", () => {
    assert.deepEqual(fakeParseRange("'Sheet 1'!A2:C"), { sheet: "Sheet 1", c1: 1, r1: 2, c2: 3 });
    assert.deepEqual(fakeParseRange("Sheet1"), { sheet: "Sheet1" });
    assert.throws(() => fakeParseRange("Sheet 1!A1"), /Unable to parse range/);
  });
});
