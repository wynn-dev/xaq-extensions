// The Sheets and Slides tools through the real extension: dist/server.mjs spawned by W1's harness under xaq's flags,
// talking MCP over stdio, its GoogleClient pointed at W1's fake Google with the Sheets/Slides fake mounted on it. No
// live account was used. Needs nothing installed (it runs the committed dist).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeGoogle } from "./fake-google.mjs";
import { createFakeSheetsSlides, nodeHandler } from "./fake-sheets-slides.mjs";
import { IDS, fixture, setup } from "./helpers.mjs";

const SS = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

describe("Sheets and Slides tools in the spawned extension", () => {
  let s;
  let mine;
  before(async () => {
    const google = await startFakeGoogle(fixture());
    mine = createFakeSheetsSlides();
    mine.addSpreadsheet({ id: SS, title: "Q3 budget", tabs: [{ title: "Sheet 1", rows: 50, columns: 6, cells: [["Item", "Cost"], ["Paper", 2.5]] }] });
    mine.state.folders.add(IDS.folder);
    google.use(nodeHandler(mine));
    s = await setup({ fake: google });
  });
  after(async () => s?.close());

  it("lists the Sheets and Slides tools with their risk in _meta", async () => {
    const { tools } = await s.ext.request("tools/list");
    const risk = Object.fromEntries(tools.filter((t) => /^(sheets|slides)_/.test(t.name)).map((t) => [t.name, t._meta["xaq/risk"]]));
    assert.equal(Object.keys(risk).length, 16);
    assert.equal(risk.sheets_clear, "risky");
    assert.equal(risk.slides_delete_slide, "risky");
    assert.equal(risk.sheets_read, "read");
  });

  it("reads and writes a spreadsheet", async () => {
    const w = await s.call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A3", values: [["Ink", 3]] });
    assert.equal(w.isError, false, w.text);
    assert.equal(w.structured.updatedRange, "'Sheet 1'!A3:B3");
    const r = await s.call("sheets_read", { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SS}/edit`, range: "Sheet 1" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.structured.rows, [["Item", "Cost"], ["Paper", "2.5"], ["Ink", "3"]]);
    assert.match(r.text, /\| 3 \| Ink \| 3 \|/);
    const seen = mine.state.requests.map((x) => `${x.host} ${x.method}`);
    assert.ok(seen.includes("sheets.googleapis.com PUT"), seen.join(", "));
  });

  it("falls through to W1's fake for a spreadsheet it doesn't hold (its fixture budget)", async () => {
    const r = await s.call("sheets_list_tabs", { spreadsheetId: IDS.budget });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.structured.tabs.map((t) => t.title), ["Summary", "Q3 Detail", "Chart1"]);
  });

  it("creates a spreadsheet and a deck in a folder, then reads the deck back", async () => {
    const sheet = await s.call("sheets_create", { title: "Scratch sheet", header: ["A", "B"], folderId: IDS.folder });
    assert.equal(sheet.isError, false, sheet.text);
    assert.deepEqual(mine.state.driveFiles.get(sheet.structured.spreadsheetId).parents, [IDS.folder]);
    const deck = await s.call("slides_create", { title: "Scratch deck", slides: [{ title: "Plan", bullets: ["One", "\tSub"], notes: "Say hi" }], folderId: IDS.folder });
    assert.equal(deck.isError, false, deck.text);
    const id = deck.structured.presentationId;
    assert.deepEqual(mine.state.driveFiles.get(id).parents, [IDS.folder]);
    const read = await s.call("slides_read", { presentationId: id });
    assert.deepEqual(read.structured.slides.map((x) => [x.title, x.body, x.notes]), [["Scratch deck", [], ""], ["Plan", ["- One", "  - Sub"], "Say hi"]]);
    const del = await s.call("slides_delete_slide", { presentationId: id, slideId: deck.structured.slides[1].slideId });
    assert.equal(del.isError, false, del.text);
    assert.equal(del.structured.remaining, 1);
  });

  it("returns argument problems verbatim and Google's errors in plain words, as isError results", async () => {
    const bad = await s.call("sheets_read", { spreadsheetId: SS, range: "Sheet1!Foo" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /^Foo isn't an A1 range/);
    const url = await s.call("slides_insert_image", { presentationId: "1MissingDeckXXXXXXXXXXXXXXXXXXXXXXXXX", slideId: "p", imageUrl: "http://example.com/a.png" });
    assert.equal(url.isError, true);
    assert.equal(url.text, "imageUrl must be an https:// URL.");
    // A private Drive image: refused before Slides is called; with its permissions hidden, Slides' 400 says the same.
    const deck = await s.call("slides_create", { title: "Images", slides: [] });
    const img = "1PrIvAtEiMaGe00000000000000000000aa";
    mine.state.driveFiles.set(img, { id: img, name: "private.png", mimeType: "image/png", permissions: [{ type: "user", role: "owner" }] });
    const priv = await s.call("slides_insert_image", { presentationId: deck.structured.presentationId, slideId: "p", driveFileId: img });
    assert.equal(priv.isError, true);
    assert.match(priv.text, /^This image isn't shared publicly, and Slides can only insert public images/);
    mine.state.driveFiles.set(img, { id: img, name: "private.png", mimeType: "image/png", _permissions: [{ type: "user", role: "owner" }] });
    const hidden = await s.call("slides_insert_image", { presentationId: deck.structured.presentationId, slideId: "p", driveFileId: img });
    assert.equal(hidden.text, priv.text);
    const missing = await s.call("slides_read", { presentationId: "1MissingDeckXXXXXXXXXXXXXXXXXXXXXXXXX" });
    assert.equal(missing.isError, true);
    assert.doesNotMatch(missing.text, /failed unexpectedly/);
  });
});
