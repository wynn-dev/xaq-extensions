// Drive tools against the fake, on the fixture's documented payloads: what each sends to Google and what the agent
// gets back.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { IDS, setup } from "./helpers.mjs";

describe("drive tools", () => {
  let s;
  const last = (pred = () => true) => s.fake.requests().filter(pred).at(-1);
  before(async () => {
    s = await setup();
  });
  after(async () => s.close());

  it("drive_search by text: fullText, not trashed, no sort order (Drive refuses one with fullText), user corpus", async () => {
    const r = await s.call("drive_search", { text: "planning" });
    assert.equal(r.isError, false, r.text);
    const q = last((x) => x.path === "/drive/v3/files").query;
    assert.equal(q.get("q"), "trashed = false and fullText contains 'planning'");
    assert.equal(q.get("orderBy"), null);
    assert.equal(q.get("corpora"), "user");
    assert.equal(q.get("pageSize"), "25");
    assert.match(q.get("fields"), /nextPageToken/);
    assert.deepEqual(
      r.structured.files.map((f) => f.name),
      ["Planning", "Q3 Planning Notes", "Team Offsite Agenda", "Q3 Planning Notes (shortcut)"],
    );
    assert.deepEqual(r.structured.files[1], {
      id: IDS.notes,
      name: "Q3 Planning Notes",
      type: "doc",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-10-12T15:04:05.123Z",
      owner: "me",
      webViewLink: `https://docs.google.com/document/d/${IDS.notes}/edit?usp=drivesdk`,
    });
    assert.deepEqual(r.structured.files[3].shortcutTo, { id: IDS.notes, type: "doc" });
    assert.match(r.text, /Team Offsite Agenda \[doc\] · id 1DoCoFf\S+ · modified 2026-09-30T17:45:00.000Z · owner Priya Raman <priya@example.com>/);
    assert.equal(r.structured.nextPageToken, null);
  });

  it("drive_search with every filter builds one escaped q, newest first", async () => {
    const r = await s.call("drive_search", { name: "Wynn's \\ notes", type: "doc", folderId: `https://drive.google.com/drive/folders/${IDS.folder}`, modifiedAfter: "2026-10-01", modifiedBefore: "2026-10-31T12:00:00+02:00", ownedByMe: true });
    assert.equal(r.isError, false, r.text);
    const q = last((x) => x.path === "/drive/v3/files").query;
    assert.equal(
      q.get("q"),
      `trashed = false and name contains 'Wynn\\'s \\\\ notes' and mimeType = 'application/vnd.google-apps.document' and '${IDS.folder}' in parents and modifiedTime > '2026-10-01T00:00:00.000Z' and modifiedTime < '2026-10-31T10:00:00.000Z' and 'me' in owners`,
    );
    assert.equal(q.get("orderBy"), "modifiedTime desc");
    assert.equal(r.text, "No files match.");
  });

  it("drive_search finds by type, date and owner on the fixture", async () => {
    const sheets = await s.call("drive_search", { type: "sheet" });
    assert.deepEqual(sheets.structured.files.map((f) => f.id), [IDS.budget]);
    const recent = await s.call("drive_search", { modifiedAfter: "2026-10-05", type: "doc" });
    assert.deepEqual(recent.structured.files.map((f) => f.name), ["Q3 Planning Notes"]);
    const others = await s.call("drive_search", { name: "Team", ownedByMe: true });
    assert.deepEqual(others.structured.files, []);
    const shared = await s.call("drive_search", { name: "Eng", includeSharedDrives: true });
    assert.deepEqual(shared.structured.files.map((f) => f.name), ["Eng Roadmap"]);
    assert.equal(last((x) => x.path === "/drive/v3/files").query.get("corpora"), "allDrives");
  });

  it("drive_search pages with nextPageToken", async () => {
    const first = await s.call("drive_search", { pageSize: 3 });
    assert.equal(first.structured.files.length, 3);
    assert.ok(first.structured.nextPageToken);
    assert.match(first.text, /More results: call drive_search again with the same filters with pageToken "[^"]+"/);
    const second = await s.call("drive_search", { pageSize: 3, pageToken: first.structured.nextPageToken });
    const third = await s.call("drive_search", { pageSize: 3, pageToken: second.structured.nextPageToken });
    const all = [...first.structured.files, ...second.structured.files, ...third.structured.files].map((f) => f.id);
    assert.equal(new Set(all).size, 7, "every non-trashed My Drive file once");
    assert.equal(third.structured.nextPageToken, null);
    assert.ok(!all.includes(IDS.trashed));
  });

  it("drive_search refuses a bad date in plain words, without calling Google", async () => {
    const before = s.fake.requests().length;
    const r = await s.call("drive_search", { modifiedAfter: "last tuesday" });
    assert.equal(r.isError, true);
    assert.match(r.text, /modifiedAfter must be a date like 2026-10-01/);
    assert.equal(s.fake.requests().length, before);
  });

  it("drive_list_folder lists My Drive's top level, folders first then by name", async () => {
    const r = await s.call("drive_list_folder", {});
    assert.equal(last((x) => x.path === "/drive/v3/files").query.get("q"), "trashed = false and 'root' in parents");
    assert.deepEqual(r.structured.files.map((f) => f.name), ["Planning", "Product Review Deck", "Q3 Planning Notes (shortcut)", "Signed Contract.pdf", "Team Offsite Agenda"]);
    assert.equal(last((x) => x.path === "/drive/v3/files").query.get("orderBy"), "folder,name_natural");
    assert.equal(r.structured.files[0].type, "folder");
    const inside = await s.call("drive_list_folder", { folderId: IDS.folder });
    assert.deepEqual(inside.structured.files.map((f) => f.name), ["Budget 2026", "Q3 Planning Notes"]);
  });

  it("drive_get gives details and the export formats", async () => {
    const r = await s.call("drive_get", { fileId: `https://docs.google.com/document/d/${IDS.notes}/edit#heading=h.1` });
    assert.equal(r.isError, false, r.text);
    assert.equal(last().path, `/drive/v3/files/${IDS.notes}`);
    assert.equal(last().query.get("supportsAllDrives"), "true");
    assert.deepEqual(
      { ...r.structured },
      {
        id: IDS.notes,
        name: "Q3 Planning Notes",
        type: "doc",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-12T15:04:05.123Z",
        owner: "me",
        webViewLink: `https://docs.google.com/document/d/${IDS.notes}/edit?usp=drivesdk`,
        description: "Working notes for the Q3 plan",
        createdTime: "2026-07-01T10:11:12.000Z",
        lastModifiedBy: "Priya Raman <priya@example.com>",
        parents: [IDS.folder],
        shared: true,
        trashed: false,
        canEdit: true,
        canComment: true,
        exportFormats: ["markdown", "text", "pdf", "docx"],
      },
    );
    const pdf = await s.call("drive_get", { fileId: IDS.pdf });
    assert.equal(pdf.structured.size, 482133);
    assert.deepEqual(pdf.structured.exportFormats, []);
    assert.match(pdf.text, /Size: 470\.8 KB/);
  });

  it("drive_export: a doc as markdown (images left out) and as text, paged", async () => {
    const md = await s.call("drive_export", { fileId: IDS.notes, format: "markdown" });
    assert.equal(last().path, `/drive/v3/files/${IDS.notes}/export`);
    assert.equal(last().query.get("mimeType"), "text/markdown");
    assert.ok(md.text.startsWith("# Q3 Planning Notes\n"));
    assert.ok(!md.text.includes("data:image"));
    assert.match(md.text, /\n\[image\]\n/);
    assert.equal(md.structured.imagesOmitted, 1);
    assert.equal(md.structured.nextOffset, null);
    const paged = await s.call("drive_export", { fileId: IDS.notes, format: "text", maxChars: 1000 });
    assert.equal(last().query.get("mimeType"), "text/plain");
    assert.equal(paged.structured.nextOffset, null);
  });

  it("drive_export: a sheet as CSV per tab through the Sheets API (Drive's CSV has only the first tab)", async () => {
    const r = await s.call("drive_export", { fileId: IDS.budget, format: "csv" });
    const batch = last((x) => x.host === "sheets.googleapis.com");
    assert.equal(batch.path, `/v4/spreadsheets/${IDS.budget}/values:batchGet`);
    assert.deepEqual(batch.query.getAll("ranges"), ["'Summary'", "'Q3 Detail'"], "chart sheets skipped");
    assert.equal(batch.query.get("valueRenderOption"), "FORMATTED_VALUE");
    assert.equal(
      r.text,
      '### Tab: Summary\nCategory,Q3,Q4\nTravel,"$1,200.00",$900.00\nSoftware,"$4,310.50","$4,310.50"\n\n### Tab: Q3 Detail\nDate,Vendor,Note\n2026-07-03,"Acme, Inc.","said ""rush"""\n2026-08-14,Globex,',
    );
    assert.deepEqual(r.structured.tabs, [
      { title: "Summary", rows: 3 },
      { title: "Q3 Detail", rows: 3 },
    ]);
    const one = await s.call("drive_export", { fileId: IDS.budget, format: "csv", tab: "q3 detail" });
    assert.ok(one.text.startsWith("Date,Vendor,Note\n"));
    const missing = await s.call("drive_export", { fileId: IDS.budget, format: "csv", tab: "Nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No tab named "Nope". Tabs: "Summary", "Q3 Detail"/);
  });

  it("drive_export: slides as text; binary formats as size, attached as a resource blob only on request and up to 2.5 MB", async () => {
    const text = await s.call("drive_export", { fileId: IDS.deck, format: "text" });
    assert.match(text.text, /^Product Review\nOctober 2026/);
    const pdf = await s.call("drive_export", { fileId: IDS.deck, format: "pdf" });
    assert.equal(pdf.structured.size, 2048);
    assert.equal(pdf.structured.attached, false);
    assert.equal(pdf.raw.content.length, 1, "no resource block");
    assert.match(pdf.text, /2\.0 KB\. Its bytes aren't returned \(pass includeBase64: true to attach files up to 2\.5 MB\)/);
    assert.match(pdf.text, /attach the Drive file by its id/);
    const withBytes = await s.call("drive_export", { fileId: IDS.budget, format: "xlsx", includeBase64: true });
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    assert.equal(last().query.get("mimeType"), xlsx);
    const block = withBytes.raw.content[1];
    assert.deepEqual(Object.keys(block.resource).sort(), ["blob", "mimeType", "uri"]);
    assert.equal(block.type, "resource");
    assert.equal(block.resource.mimeType, xlsx);
    assert.equal(block.resource.uri, `gdrive-export:${IDS.budget}.xlsx`);
    assert.equal(Buffer.from(block.resource.blob, "base64").subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    assert.equal(withBytes.structured.base64, undefined, "never in structuredContent (xaq drops it over 1,000,000 characters)");
    assert.deepEqual([withBytes.structured.attached, withBytes.structured.resourceUri], [true, `gdrive-export:${IDS.budget}.xlsx`]);
    assert.match(withBytes.text, /attached to this result as an embedded resource/);
    // At the cap: attached, and the whole message stays under the 4 MB result cap.
    s.fake.state.exportSizes.set(IDS.deck, 2.5 * 1024 * 1024);
    const atCap = await s.call("drive_export", { fileId: IDS.deck, format: "pdf", includeBase64: true });
    assert.equal(atCap.raw.content[1].type, "resource");
    assert.equal(Buffer.from(atCap.raw.content[1].resource.blob, "base64").length, 2.5 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(atCap.raw)) < 4_000_000);
    s.fake.state.exportSizes.set(IDS.deck, 2.5 * 1024 * 1024 + 1);
    const big = await s.call("drive_export", { fileId: IDS.deck, format: "pptx", includeBase64: true });
    assert.equal(big.raw.content.length, 1);
    assert.equal(big.structured.attached, false);
    assert.match(big.text, /It's over 2\.5 MB, so it isn't attached\./);
    assert.doesNotMatch(big.text, /is attached/);
    s.fake.state.exportSizes.delete(IDS.deck);
  });

  it("drive_create_folder makes a folder (in a parent when given) that the create tools can fill", async () => {
    const top = await s.call("drive_create_folder", { name: "xaq scratch" });
    assert.equal(top.isError, false, top.text);
    const req = last((x) => x.path === "/drive/v3/files" && x.method === "POST");
    assert.deepEqual(JSON.parse(req.body.toString()), { name: "xaq scratch", mimeType: "application/vnd.google-apps.folder" });
    assert.equal(req.query.get("supportsAllDrives"), "true");
    const id = top.structured.folderId;
    assert.equal(top.structured.webViewLink, `https://drive.google.com/drive/folders/${id}`);
    assert.equal(top.text, `Created folder "xaq scratch": https://drive.google.com/drive/folders/${id} (id ${id})`);
    const sub = await s.call("drive_create_folder", { name: "inner", parentId: `https://drive.google.com/drive/folders/${id}` });
    assert.deepEqual(JSON.parse(last((x) => x.path === "/drive/v3/files" && x.method === "POST").body.toString()).parents, [id]);
    const doc = await s.call("docs_create", { title: "In scratch", markdown: "hi", folderId: id });
    const listed = await s.call("drive_list_folder", { folderId: id });
    assert.deepEqual(listed.structured.files.map((f) => [f.name, f.type]), [["inner", "folder"], ["In scratch", "doc"]]);
    assert.equal(listed.structured.files[1].id, doc.structured.documentId);
    const missing = await s.call("drive_create_folder", { name: "x", parentId: "1NoSuChFoLdEr0000000000000" });
    assert.match(missing.text, /^Google found nothing with that id/);
    assert.equal(sub.isError, false);
  });

  it("drive_upload stores bytes as they are, typed from the name, in the folder", async () => {
    // A 1x1 PNG, as an agent (or the smoke run's Slides image step) would send it.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const r = await s.call("drive_upload", { name: "dot.png", folderId: IDS.folder, content_base64: png.toString("base64") });
    assert.equal(r.isError, false, r.text);
    const up = last((x) => x.path === "/upload/drive/v3/files");
    assert.equal(up.query.get("uploadType"), "multipart");
    assert.equal(up.query.get("fields"), "id,name,mimeType,size,webViewLink,parents");
    assert.match(up.body.toString("latin1"), /\{"name":"dot\.png","mimeType":"image\/png","parents":\["1fOlDeRpLaNnInG0000000000000000aa"\]\}\r\n--xaq-[0-9a-f]+\r\nContent-Type: image\/png\r\n\r\n/);
    const stored = s.fake.state.files.get(r.structured.fileId);
    assert.ok(stored._bytes.equals(png), "the bytes arrive unchanged");
    assert.deepEqual(r.structured, { fileId: stored.id, name: "dot.png", mimeType: "image/png", size: png.length, webViewLink: `https://drive.google.com/file/d/${stored.id}/view?usp=drivesdk`, parents: [IDS.folder] });
    assert.match(r.text, /^Uploaded "dot\.png" \(image\/png, 70 B\): https:\/\/drive\.google\.com\/file\/d\/\S+ \(id \S+\)$/);
    const typed = await s.call("drive_upload", { name: "notes", mimeType: "text/plain", content_base64: Buffer.from("héllo").toString("base64") });
    assert.equal(typed.structured.mimeType, "text/plain");
    assert.equal(s.fake.state.files.get(typed.structured.fileId)._bytes.toString("utf8"), "héllo");
    const unknown = await s.call("drive_upload", { name: "blob.bin", content_base64: "AAEC" });
    assert.equal(unknown.structured.mimeType, "application/octet-stream");
  });

  it("drive_upload refuses Google-native types, bad base64 and more than 5 MB, before any request", async () => {
    const before = s.fake.requests().length;
    const native = await s.call("drive_upload", { name: "x", mimeType: "application/vnd.google-apps.document", content_base64: "AAAA" });
    assert.match(native.text, /can't make Google Docs, Sheets or Slides files\. Use docs_create/);
    const bad = await s.call("drive_upload", { name: "x.png", content_base64: "not base64!" });
    assert.equal(bad.text, "content_base64 isn't valid base64.");
    const big = await s.call("drive_upload", { name: "big.bin", content_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") });
    assert.equal(big.isError, true);
    assert.match(big.text, /at most 5 MB/);
    assert.equal(s.fake.requests().length, before);
    const exact = await s.call("drive_upload", { name: "five.bin", content_base64: Buffer.alloc(5 * 1024 * 1024, 1).toString("base64") });
    assert.equal(exact.isError, false, exact.text);
    assert.equal(exact.structured.size, 5 * 1024 * 1024);
  });

  it("drive_trash moves a file the extension created to the Trash, and refuses others in plain words", async () => {
    const folder = await s.call("drive_create_folder", { name: "to trash" });
    const doc = await s.call("docs_create", { title: "Temp", markdown: "x", folderId: folder.structured.folderId });
    const r = await s.call("drive_trash", { fileId: doc.structured.documentId });
    assert.equal(r.isError, false, r.text);
    const req = last((x) => x.method === "PATCH");
    assert.equal(req.path, `/drive/v3/files/${doc.structured.documentId}`);
    assert.deepEqual(JSON.parse(req.body.toString()), { trashed: true }, "trash, never delete");
    assert.deepEqual(r.structured, { fileId: doc.structured.documentId, name: "Temp", type: "doc", trashed: true });
    assert.match(r.text, /^Moved "Temp" \(doc, id \S+\) to the Trash\. Restore it from the Trash in Google Drive within 30 days if needed\.$/);
    const gone = await s.call("drive_list_folder", { folderId: folder.structured.folderId });
    assert.deepEqual(gone.structured.files, []);
    assert.equal((await s.call("drive_trash", { fileId: folder.structured.folderId })).structured.type, "folder");
    const refused = await s.call("drive_trash", { fileId: IDS.notes });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /only if the extension created it/);
    assert.equal(s.fake.state.files.get(IDS.notes).trashed, false);
    assert.equal(s.fake.requests().filter((x) => x.method === "DELETE").length, 0);
  });

  it("drive_export: wrong format, a non-Google file, a shortcut and Drive's 10 MB limit, in plain words", async () => {
    const wrong = await s.call("drive_export", { fileId: IDS.deck, format: "csv" });
    assert.match(wrong.text, /A slides exports as text, pdf, pptx, not csv/);
    const pdf = await s.call("drive_export", { fileId: IDS.pdf, format: "text" });
    assert.match(pdf.text, /is a pdf, not a Google Doc, Sheet or Slides file/);
    const shortcut = await s.call("drive_export", { fileId: IDS.shortcut, format: "markdown" });
    assert.match(shortcut.text, new RegExp(`It's a shortcut: use ${IDS.notes}`));
    s.fake.state.tooLargeToExport.add(IDS.notes);
    const huge = await s.call("drive_export", { fileId: IDS.notes, format: "pdf" });
    s.fake.state.tooLargeToExport.delete(IDS.notes);
    assert.equal(huge.isError, true);
    assert.match(huge.text, /too large for Google to export \(Google's limit is 10 MB\)/);
  });
});
