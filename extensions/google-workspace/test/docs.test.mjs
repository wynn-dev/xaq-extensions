// Docs tools against the fake: reading through Drive's markdown export, creating through Drive's markdown import,
// and editing through documents.batchUpdate, checked on the fake document model (fake-docs.mjs) after each call.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { FakeDoc, paragraph } from "./fake-docs.mjs";
import { IDS, fixture, setup, startFake } from "./helpers.mjs";

const H = (style, text) => ({ style, text });
const N = (text, extra = {}) => ({ style: "NORMAL_TEXT", text, ...extra });
const bullet = (level, ordered = false) => ({ bullet: { level, ordered } });

describe("docs tools", () => {
  let s;
  const outline = (id) => s.fake.state.docs.get(id).outline();
  const batches = (id) => s.fake.requests().filter((r) => r.host === "docs.googleapis.com" && r.path === `/v1/documents/${id}:batchUpdate`);
  before(async () => {
    s = await setup();
  });
  after(async () => s.close());
  beforeEach(async () => {
    // A fresh fixture for every test: reset the fake's documents and comments in place.
    const fresh = await startFake(fixture());
    for (const k of ["files", "docs", "comments"]) {
      s.fake.state[k].clear();
      for (const [id, v] of fresh.state[k]) s.fake.state[k].set(id, v);
    }
    await fresh.close();
  });

  it("docs_read returns Drive's markdown export, images left out, with the headings", async () => {
    const r = await s.call("docs_read", { documentId: IDS.notes });
    assert.equal(r.isError, false, r.text);
    const exp = s.fake.requests().filter((x) => x.path.endsWith("/export")).at(-1);
    assert.equal(exp.query.get("mimeType"), "text/markdown");
    assert.ok(r.text.startsWith(`"Q3 Planning Notes" (modified 2026-10-12T15:04:05.123Z) https://docs.google.com/document/d/${IDS.notes}/edit?usp=drivesdk\n\n# Q3 Planning Notes\n\n# Goals\n\n* Ship the **billing** revamp`));
    assert.match(r.text, /\| Billing \| Priya \| On track \|/);
    assert.match(r.text, /See the \[launch checklist\]\(https:\/\/example\.com\/checklist\) before sign-off\./);
    assert.ok(!r.text.includes("base64"));
    assert.deepEqual(r.structured.headings, [
      { level: 1, text: "Q3 Planning Notes" },
      { level: 1, text: "Goals" },
      { level: 2, text: "Budget" },
      { level: 1, text: "Risks" },
      { level: 1, text: "Next steps" },
    ]);
    assert.equal(r.structured.imagesOmitted, 1);
    assert.equal(r.structured.nextOffset, null);
  });

  it("docs_read pages a long document on line breaks, and every page joins back to the whole", async () => {
    const id = "1LoNgDoC0000000000000000000000000iii";
    const body = [paragraph("Long report", "HEADING_1"), ...Array.from({ length: 400 }, (_, i) => paragraph(`Paragraph ${i + 1}: ${"lorem ipsum ".repeat(8).trim()}`))];
    s.fake.state.docs.set(id, Object.assign(new FakeDoc(id, "Long report", body), { exportMarkdown: null }));
    s.fake.state.files.set(id, { ...s.fake.state.files.get(IDS.agenda), id, name: "Long report" });
    const whole = s.fake.state.docs.get(id).markdown();
    let offset = 0;
    let joined = "";
    let pages = 0;
    for (;;) {
      const r = await s.call("docs_read", { documentId: id, offset, maxChars: 5000 });
      pages++;
      const textStart = r.text.indexOf("\n\n") + 2;
      joined += r.text.slice(textStart);
      assert.equal(r.structured.totalChars, whole.length);
      if (pages === 1) {
        assert.ok(r.structured.headings);
        assert.match(r.text, /More: call docs_read again with offset \d+/);
      } else assert.equal(r.structured.headings, undefined);
      if (r.structured.nextOffset === null) break;
      assert.ok(joined.endsWith("\n"), "a page ends at a line break");
      offset = r.structured.nextOffset;
    }
    assert.ok(pages >= 7);
    assert.equal(joined, whole);
  });

  it("docs_read refuses a sheet or a shortcut in plain words", async () => {
    const sheet = await s.call("docs_read", { documentId: IDS.budget });
    assert.equal(sheet.isError, true);
    assert.match(sheet.text, /"Budget 2026" is a sheet, not a Google Doc\. Use drive_export for it\./);
    const shortcut = await s.call("docs_read", { documentId: IDS.shortcut });
    assert.match(shortcut.text, new RegExp(`It's a shortcut: use ${IDS.notes}`));
  });

  it("docs_create uploads markdown for Drive to convert into a Google Doc, in the folder", async () => {
    const r = await s.call("docs_create", { title: "Launch plan", markdown: "# Launch\n\n- step one\n- step two", folderId: IDS.folder });
    assert.equal(r.isError, false, r.text);
    const up = s.fake.requests().filter((x) => x.path === "/upload/drive/v3/files").at(-1);
    assert.equal(up.method, "POST");
    assert.equal(up.query.get("uploadType"), "multipart");
    assert.match(up.contentType, /^multipart\/related; boundary=xaq-[0-9a-f]{24}$/);
    const body = up.body.toString("utf8");
    assert.match(body, /Content-Type: application\/json; charset=UTF-8\r\n\r\n\{"name":"Launch plan","mimeType":"application\/vnd\.google-apps\.document","parents":\["1fOlDeRpLaNnInG0000000000000000aa"\]\}/);
    assert.match(body, /Content-Type: text\/markdown; charset=UTF-8\r\n\r\n# Launch\n\n- step one\n- step two\r\n/);
    const id = r.structured.documentId;
    assert.equal(r.structured.name, "Launch plan");
    assert.equal(s.fake.state.files.get(id).mimeType, "application/vnd.google-apps.document");
    assert.deepEqual(outline(id), [H("HEADING_1", "Launch"), N("step one", bullet(0)), N("step two", bullet(0))]);
    const read = await s.call("docs_read", { documentId: id });
    assert.match(read.text, /# Launch\n\n- step one\n- step two/);
    // drive.file: the extension may comment on a file it created.
    const c = await s.call("docs_comment_add", { documentId: id, text: "Looks good" });
    assert.equal(c.isError, false, c.text);
  });

  it("docs_create with no markdown makes a blank Doc with a metadata-only create", async () => {
    const r = await s.call("docs_create", { title: "Blank" });
    assert.equal(r.isError, false, r.text);
    const req = s.fake.requests().filter((x) => x.path === "/drive/v3/files" && x.method === "POST").at(-1);
    assert.deepEqual(JSON.parse(req.body.toString()), { name: "Blank", mimeType: "application/vnd.google-apps.document" });
    assert.deepEqual(outline(r.structured.documentId), [N("")]);
  });

  it("docs_append adds headings, nested lists, emphasis, links and tables after the last paragraph", async () => {
    const mark = batches(IDS.agenda).length;
    const r = await s.call("docs_append", { documentId: IDS.agenda, markdown: "## Day 3\n\n- **Hike** to [Sintra](https://example.com)\n  - bring water\n- dinner\n\n| a | b |\n|---|---|\n| 1 | *2* |\n\nThe end." });
    assert.equal(r.text, `Appended 5 paragraphs and 1 table in "Team Offsite Agenda": https://docs.google.com/document/d/${IDS.agenda}/edit`);
    assert.deepEqual(outline(IDS.agenda), [
      H("HEADING_1", "Offsite: Lisbon"),
      N("Day 1: strategy."),
      N("Day 2: planning."),
      H("HEADING_2", "Day 3"),
      N("Hike to Sintra", { ...bullet(0), marks: [{ text: "Hike", bold: true }, { text: "Sintra", link: "https://example.com" }] }),
      N("bring water", bullet(1)),
      N("dinner", bullet(0)),
      { table: [["a", "b"], ["1", "2"]] },
      N("The end."),
    ]);
    // The header row is bold and the italic cell italic.
    const res = s.fake.state.docs.get(IDS.agenda).resource();
    const cells = res.body.content.find((e) => e.table).table.tableRows.map((row) => row.tableCells.map((c) => c.content[0].paragraph.elements[0].textRun.textStyle));
    assert.deepEqual(cells, [[{ bold: true }, { bold: true }], [{}, { italic: true }]]);
    // Two batches around the table, each pinned to the revision it was computed from.
    const sent = batches(IDS.agenda).slice(mark).map((b) => JSON.parse(b.body.toString()));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((b) => b.writeControl.requiredRevisionId), ["rev-1DoCoF-1", "rev-1DoCoF-2"]);
  });

  it("docs_append into a doc that ends with an empty paragraph uses it, and keeps UTF-16 indexes right", async () => {
    s.fake.state.docs.get(IDS.agenda).body.push(paragraph(""));
    await s.call("docs_append", { documentId: IDS.agenda, markdown: "Café 🎉 **done** and `x`" });
    const all = outline(IDS.agenda);
    assert.equal(all.length, 4);
    assert.deepEqual(all.at(-1), N("Café 🎉 done and x", { marks: [{ text: "done", bold: true }, { text: "x", font: "Roboto Mono" }] }));
  });

  it("docs_insert at the start, after a heading, before one, and at the end of a section", async () => {
    await s.call("docs_insert", { documentId: IDS.notes, position: "start", markdown: "Intro line" });
    await s.call("docs_insert", { documentId: IDS.notes, position: "after_heading", heading: "risks", markdown: "> Quoted `code` here" });
    await s.call("docs_insert", { documentId: IDS.notes, position: "end_of_section", heading: "Goals", markdown: "1. Third goal 🎉 **now**\n2. Fourth" });
    await s.call("docs_insert", { documentId: IDS.notes, position: "before_heading", heading: "Next", markdown: "### Owners" });
    assert.deepEqual(outline(IDS.notes), [
      N("Intro line"),
      H("TITLE", "Q3 Planning Notes"),
      H("HEADING_1", "Goals"),
      N("Ship the billing revamp", { ...bullet(0), marks: [{ text: "billing", bold: true }] }),
      N("Hire two engineers", bullet(0)),
      H("HEADING_2", "Budget"),
      { table: [["Area", "Owner", "Status"], ["Billing", "Priya", "On track"], ["Hiring", "Wynn", "At risk"]] },
      N(""),
      N("Third goal 🎉 now", { ...bullet(0, true), marks: [{ text: "now", bold: true }] }),
      N("Fourth", bullet(0, true)),
      H("HEADING_1", "Risks"),
      N("Quoted code here", { indent: 36, marks: [{ text: "Quoted ", italic: true }, { text: "code", italic: true, font: "Roboto Mono" }, { text: " here", italic: true }] }),
      N("See the launch checklist before sign-off.", { marks: [{ text: "launch checklist", link: "https://example.com/checklist" }] }),
      H("HEADING_3", "Owners"),
      H("HEADING_1", "Next steps"),
      N("Review with Priya on Friday."),
    ]);
  });

  it("docs_insert says which headings exist when the heading isn't found or is ambiguous", async () => {
    const mark = batches(IDS.notes).length;
    const missing = await s.call("docs_insert", { documentId: IDS.notes, position: "after_heading", heading: "Timeline", markdown: "x" });
    assert.equal(missing.isError, true);
    assert.equal(missing.text, 'No heading "Timeline". The document\'s headings: "Q3 Planning Notes", "Goals", "Budget", "Risks", "Next steps".');
    const many = await s.call("docs_insert", { documentId: IDS.notes, position: "after_heading", heading: "s", markdown: "x" });
    assert.match(many.text, /matches several headings/);
    const none = await s.call("docs_insert", { documentId: IDS.notes, position: "after_heading", markdown: "x" });
    assert.match(none.text, /needs heading/);
    assert.equal(batches(IDS.notes).length, mark, "nothing was written");
  });

  it("docs_replace_text reports the match count, matches case by default, and says when nothing matched", async () => {
    const r = await s.call("docs_replace_text", { documentId: IDS.notes, find: "Priya", replace: "P. Raman" });
    assert.equal(r.structured.occurrencesChanged, 2, "the paragraph and the table cell");
    assert.equal(r.text, `Replaced 2 occurrences in https://docs.google.com/document/d/${IDS.notes}/edit`);
    assert.deepEqual(JSON.parse(batches(IDS.notes).at(-1).body.toString()), { requests: [{ replaceAllText: { containsText: { text: "Priya", matchCase: true }, replaceText: "P. Raman" } }] });
    const none = await s.call("docs_replace_text", { documentId: IDS.notes, find: "goals", replace: "x" });
    assert.equal(none.structured.occurrencesChanged, 0);
    assert.equal(none.text, 'No matches for "goals"; nothing changed.');
    const ci = await s.call("docs_replace_text", { documentId: IDS.notes, find: "goals", replace: "Aims", matchCase: false });
    assert.equal(ci.structured.occurrencesChanged, 1);
  });

  it("docs_overwrite replaces the whole body in one batch, and empty markdown clears it", async () => {
    const mark = batches(IDS.notes).length;
    const end = s.fake.state.docs.get(IDS.notes).end();
    const r = await s.call("docs_overwrite", { documentId: IDS.notes, markdown: "# Fresh\n\nBody ~~old~~ text.\n\n```\ncode line\n```" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(outline(IDS.notes), [H("HEADING_1", "Fresh"), N("Body old text.", { marks: [{ text: "old", strike: true }] }), N("code line", { marks: [{ text: "code line", font: "Roboto Mono" }] })]);
    const sent = batches(IDS.notes).slice(mark).map((b) => JSON.parse(b.body.toString()));
    assert.equal(sent.length, 1, "delete and write together: a refused write changes nothing");
    assert.deepEqual(sent[0].requests[0], { deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }, "everything but the body's last newline");
    await s.call("docs_overwrite", { documentId: IDS.agenda, markdown: "" });
    assert.deepEqual(outline(IDS.agenda), [N("")]);
  });

  it("a document changed by someone else mid-edit fails as a conflict instead of writing in the wrong place", async () => {
    s.fake.fail({
      match: (r) => r.path.endsWith(":batchUpdate"),
      status: 400,
      body: { error: { code: 400, message: "The required revision ID rev-x does not match the latest revision of the document.", status: "FAILED_PRECONDITION" } },
    });
    const r = await s.call("docs_append", { documentId: IDS.agenda, markdown: "x" });
    assert.equal(r.isError, true);
    assert.equal(r.text, "The document changed while this edit was being made. Read it again and retry.");
  });

  it("docs_comments_list shows authors, quotes, resolution and replies; skips deleted ones; pages", async () => {
    const r = await s.call("docs_comments_list", { documentId: IDS.notes });
    const req = s.fake.requests().filter((x) => x.path.endsWith("/comments")).at(-1);
    assert.match(req.query.get("fields"), /^nextPageToken,comments\(id,content,author/);
    assert.equal(
      r.text,
      '- [AAAABcDeFgH] Priya Raman (2026-10-11T09:15:00.000Z): Can we move hiring to Q4?\n  on: "Hire two engineers"\n  ↳ me: Let\'s discuss Friday.\n- [AAAABcDeFgJ] me (2026-10-09T14:00:00.000Z) [resolved]: Typo fixed?\n  ↳ Priya Raman: Yes [resolve]',
    );
    assert.deepEqual(r.structured.comments[0], {
      id: "AAAABcDeFgH",
      author: "Priya Raman",
      content: "Can we move hiring to Q4?",
      quoted: "Hire two engineers",
      resolved: false,
      createdTime: "2026-10-11T09:15:00.000Z",
      replies: [{ id: "AAAABcDeFgI", author: "me", content: "Let's discuss Friday.", createdTime: "2026-10-11T10:02:00.000Z" }],
    });
    const open = await s.call("docs_comments_list", { documentId: IDS.notes, includeResolved: false });
    assert.deepEqual(open.structured.comments.map((c) => c.id), ["AAAABcDeFgH"]);
    const p1 = await s.call("docs_comments_list", { documentId: IDS.notes, pageSize: 1 });
    assert.equal(p1.structured.comments.length, 1);
    assert.match(p1.text, /More comments: call docs_comments_list again with pageToken/);
    const p2 = await s.call("docs_comments_list", { documentId: IDS.notes, pageSize: 1, pageToken: p1.structured.nextPageToken });
    assert.deepEqual(p2.structured.comments.map((c) => c.id), ["AAAABcDeFgJ"]);
    const none = await s.call("docs_comments_list", { documentId: IDS.agenda });
    assert.equal(none.text, "No comments.");
  });

  it("docs_comment_add explains drive.file on a file the extension didn't create, and replies on one it did", async () => {
    const refused = await s.call("docs_comment_add", { documentId: IDS.notes, text: "Ship it" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /only if the extension created it/);
    const made = await s.call("docs_create", { title: "Mine", markdown: "Hello" });
    const c = await s.call("docs_comment_add", { documentId: made.structured.documentId, text: "First" });
    assert.match(c.text, /^Added comment AAAA/);
    const reply = await s.call("docs_comment_add", { documentId: made.structured.documentId, text: "Second", replyToCommentId: c.structured.commentId });
    assert.equal(reply.isError, false, reply.text);
    const listed = await s.call("docs_comments_list", { documentId: made.structured.documentId });
    assert.match(listed.text, /me \(.+\): First\n  ↳ me: Second/);
    const req = s.fake.requests().filter((x) => x.path.endsWith("/replies")).at(-1);
    assert.deepEqual(JSON.parse(req.body.toString()), { content: "Second" });
    assert.equal(req.query.get("fields"), "id,content,createdTime");
  });

  it("doc ids may be given as links; anything else is refused before any request", async () => {
    const ok = await s.call("docs_read", { documentId: `https://docs.google.com/document/d/${IDS.agenda}/edit?tab=t.0` });
    assert.equal(ok.isError, false, ok.text);
    const before = s.fake.requests().length;
    for (const bad of ["https://evil.example/document/d/1DoCoFfSiTeAgEnDa000000000000000000000000bbb/edit", "../../etc/passwd", "not an id"]) {
      const r = await s.call("docs_read", { documentId: bad });
      assert.equal(r.isError, true, bad);
      assert.match(r.text, /isn't a Google Doc id/);
    }
    assert.equal(s.fake.requests().length, before, "a URL from the input is parsed, never fetched");
  });
});
