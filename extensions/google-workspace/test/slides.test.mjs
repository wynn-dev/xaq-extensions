// The Slides tools against the in-process fake Slides v1 API (test/fake-sheets-slides.mjs). No live account was used:
// payloads follow Google's documented shapes. Needs esbuild (npm ci --ignore-scripts at the repo root), else skipped.
import assert from "node:assert/strict";
import { beforeEach, describe, it, test } from "node:test";
import { createFakeSheetsSlides, fakeClient } from "./fake-sheets-slides.mjs";
import { SKIP, caller, loadSheetsSlides } from "./sheets-slides-lib.mjs";

const lib = await loadSheetsSlides();
if (!lib) test("slides tools", { skip: SKIP }, () => {});
else defineTests(lib);

// Google's own sample presentation id, from the Slides API docs.
const DECK = "1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc";
const DRIVE_IMG = "1aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";

const EMU = (pt) => pt * 12700;
const box = (objectId, extra) => ({ objectId, size: { width: { magnitude: EMU(300), unit: "EMU" }, height: { magnitude: EMU(50), unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: EMU(40), translateY: EMU(30), unit: "EMU" }, ...extra });
const text = (objectId, placeholder, t, bullets = []) => box(objectId, { shape: { shapeType: "TEXT_BOX", ...(placeholder ? { placeholder: { type: placeholder, index: 0 } } : {}) }, _text: t, _bullets: bullets });
const notes = (slideId, t) => ({
  objectId: `${slideId}:notes`,
  pageType: "NOTES",
  pageElements: t === undefined ? [] : [text(`${slideId}:speaker`, "BODY", t)],
  notesProperties: { speakerNotesObjectId: `${slideId}:speaker` },
});
const slide = (objectId, layout, elements, note) => ({ objectId, pageType: "SLIDE", pageElements: elements, slideProperties: { layoutObjectId: `layout_${layout}`, masterObjectId: "master", notesPage: notes(objectId, note) } });

/** A deck in the fake's model: a title slide, a content slide (nested bullets, a table, a group, an image), an image-only slide. */
function sampleDeck() {
  const list = "kix.list1";
  return {
    presentationId: DECK,
    title: "Quarterly review",
    revisionId: "rev1",
    pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
    layouts: [],
    masters: [],
    slides: [
      slide("g_title", "TITLE", [text("g_title_t", "CENTERED_TITLE", "Quarterly review"), text("g_title_s", "SUBTITLE", "Platform team · Q3")], "Welcome everyone"),
      slide(
        "g_roadmap",
        "TITLE_AND_BODY",
        [
          text("g_rm_t", "TITLE", "Roadmap"),
          text("g_rm_b", "BODY", "Ship v2\nBeta in September\nGA in Q4\n", [{ listId: list, level: 0 }, { listId: list, level: 1 }, { listId: list, level: 0 }]),
          box("g_rm_tbl", {
            table: {
              rows: 2,
              columns: 2,
              tableRows: [
                { tableCells: [{ _text: "Milestone" }, { _text: "Date" }] },
                { tableCells: [{ _text: "Beta" }, { _text: "Sept 30" }] },
              ],
            },
          }),
          box("g_rm_grp", { elementGroup: { children: [text("g_rm_fn", null, "Dates are targets, not promises"), box("g_rm_line", { line: { lineType: "STRAIGHT_LINE" } })] } }),
          box("g_rm_img", { image: { contentUrl: "https://lh7-rt.googleusercontent.com/x", sourceUrl: "https://example.com/chart.png" } }),
        ],
        "Mention hiring. Roadmap is roadmap.",
      ),
      slide("g_photo", "BLANK", [box("g_ph_img", { image: { contentUrl: "https://lh7-rt.googleusercontent.com/y" } })]),
    ],
  };
}

function defineTests(lib) {
  const { slidesTools, outlineSlideRequests, textLines, checkImageUrl, placementBox, presentationIdOf, driveFileIdOf, createImageRequest } = lib;

  describe("text and outline helpers", () => {
    it("reads Google's text elements: bullets with nesting, autoText, soft line breaks, proto3 zero indices left out", () => {
      // Shaped as in the Slides API reference (TextContent), startIndex 0 and nestingLevel 0 omitted as proto3 JSON does.
      const t = {
        textElements: [
          { endIndex: 8, paragraphMarker: { style: {}, bullet: { listId: "kix.a", glyph: "●" } } },
          { endIndex: 8, textRun: { content: "Ship v2\n", style: {} } },
          { startIndex: 8, endIndex: 27, paragraphMarker: { style: {}, bullet: { listId: "kix.a", nestingLevel: 1, glyph: "○" } } },
          { startIndex: 8, endIndex: 20, textRun: { content: "Beta\u000bin Sept", style: {} } },
          { startIndex: 20, endIndex: 21, autoText: { type: "SLIDE_NUMBER", content: "7" } },
          { startIndex: 21, endIndex: 22, textRun: { content: "\n", style: {} } },
          { startIndex: 22, endIndex: 23, paragraphMarker: { style: {} } },
          { startIndex: 22, endIndex: 23, textRun: { content: "\n" } },
          { startIndex: 23, endIndex: 30, paragraphMarker: { style: {} } },
          { startIndex: 23, endIndex: 30, textRun: { content: "Plain.\n" } },
        ],
      };
      assert.deepEqual(textLines(t), ["- Ship v2", "  - Beta\nin Sept7", "Plain."]);
      assert.deepEqual(textLines(undefined), []);
    });

    it("turns an outline item into createSlide (TITLE_AND_BODY, placeholder mapping), title text, body text and bullets", () => {
      const reqs = outlineSlideRequests({ title: " Plan\n2026 ", bullets: ["Hire", "\tTwo engineers", "", "Line\nbreak"] }, { slide: "s_1abc", title: "s_1abc_title", body: "s_1abc_body" }, 2);
      assert.deepEqual(reqs, [
        {
          createSlide: {
            objectId: "s_1abc",
            insertionIndex: 2,
            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: "s_1abc_title" },
              { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: "s_1abc_body" },
            ],
          },
        },
        { insertText: { objectId: "s_1abc_title", insertionIndex: 0, text: "Plan 2026" } },
        { insertText: { objectId: "s_1abc_body", insertionIndex: 0, text: "Hire\n\tTwo engineers\nLine break" } },
        { createParagraphBullets: { objectId: "s_1abc_body", textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
      ]);
    });

    it("leaves out empty inserts and bullets, and the insertion index when appending", () => {
      const reqs = outlineSlideRequests({ title: "", bullets: ["", "  "] }, { slide: "s_2abc", title: "s_2abc_t", body: "s_2abc_b" });
      assert.equal(reqs.length, 1);
      assert.equal("insertionIndex" in reqs[0].createSlide, false);
    });

    it("validates ids and image URLs", () => {
      assert.equal(presentationIdOf(`https://docs.google.com/presentation/d/${DECK}/edit#slide=id.p`), DECK);
      assert.throws(() => presentationIdOf("x/../../y"), /isn't a Google presentation id/);
      assert.equal(driveFileIdOf(`https://drive.google.com/file/d/${DRIVE_IMG}/view?usp=sharing`), DRIVE_IMG);
      assert.equal(driveFileIdOf(`https://drive.google.com/open?id=${DRIVE_IMG}`), DRIVE_IMG);
      assert.equal(checkImageUrl(" https://example.com/a.png "), "https://example.com/a.png");
      assert.throws(() => checkImageUrl("http://example.com/a.png"), /https/);
      assert.throws(() => checkImageUrl("file:///etc/passwd"), /https/);
      assert.throws(() => checkImageUrl("/home/me/a.png"), /isn't a URL/);
      assert.throws(() => checkImageUrl("https://user:pw@example.com/a.png"), /user name or password/);
      assert.throws(() => checkImageUrl("https://localhost/a.png"), /public/);
      assert.throws(() => checkImageUrl(`https://example.com/${"a".repeat(2050)}`), /2 KB/);
    });

    it("places images in points on a 720 × 405 pt slide", () => {
      assert.deepEqual(placementBox("center", 720, 405), { x: 144, y: 81, width: 432, height: 243 });
      assert.deepEqual(placementBox("full", 720, 405), { x: 0, y: 0, width: 720, height: 405 });
      assert.deepEqual(placementBox("left", 720, 405), { x: 36, y: 61, width: 306, height: 284 });
      assert.deepEqual(placementBox("right", 720, 405), { x: 378, y: 61, width: 306, height: 284 });
      assert.deepEqual(createImageRequest("img_12345", "https://e.com/a.png", "p", { x: 1, y: 2, width: 3, height: 4 }).createImage.elementProperties, {
        pageObjectId: "p",
        size: { width: { magnitude: 3, unit: "PT" }, height: { magnitude: 4, unit: "PT" } },
        transform: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: 1, translateY: 2, unit: "PT" },
      });
    });
  });

  describe("tools", () => {
    let fake;
    let call;
    beforeEach(() => {
      fake = createFakeSheetsSlides();
      fake.addPresentation(sampleDeck());
      call = (name, args) => caller(lib, fakeClient(fake))(slidesTools, name, args);
    });
    const batches = () => fake.state.requests.filter((r) => r.path.endsWith(":batchUpdate"));
    const order = (id = DECK) => fake.state.presentations.get(id).slides.map((s) => s.objectId);

    it("slides_read gives each slide's id, title, body (bullets, table, group) and notes", async () => {
      const out = await call("slides_read", { presentationId: DECK });
      const s = out.structured;
      assert.equal(s.slideCount, 3);
      assert.deepEqual(s.slides[0], { position: 1, slideId: "g_title", title: "Quarterly review", body: ["Platform team · Q3"], images: 0, notes: "Welcome everyone" });
      assert.deepEqual(s.slides[1].body, ["- Ship v2", "  - Beta in September", "- GA in Q4", "| Milestone | Date |", "| Beta | Sept 30 |", "Dates are targets, not promises"]);
      assert.equal(s.slides[1].images, 1);
      assert.equal(s.slides[1].notes, "Mention hiring. Roadmap is roadmap.");
      assert.deepEqual(s.slides[2], { position: 3, slideId: "g_photo", title: "", body: [], images: 1, notes: "" });
      assert.match(out.text, /## Slide 2: Roadmap \[id g_roadmap\]\n- Ship v2\n {2}- Beta in September/);
      assert.match(out.text, /Notes: Welcome everyone/);
      assert.equal(fake.state.requests[0].host, "slides.googleapis.com");
      assert.match(fake.state.requests[0].query.fields, /notesPage/);
    });

    it("slides_read limits to slide ids, can leave notes out, and names the slides for an unknown id", async () => {
      const out = await call("slides_read", { presentationId: DECK, slideIds: ["g_photo"], includeNotes: false });
      assert.deepEqual(out.structured.slides.map((x) => x.slideId), ["g_photo"]);
      assert.equal("notes" in out.structured.slides[0], false);
      await assert.rejects(call("slides_read", { presentationId: DECK, slideIds: ["nope1"] }), /no slide nope1.*g_title, g_roadmap, g_photo/);
    });

    it("slides_create builds the deck: title slide, one TITLE_AND_BODY slide per item, then speaker notes", async () => {
      const out = await call("slides_create", {
        title: "Launch plan",
        subtitle: "Draft",
        slides: [
          { title: "Goals", bullets: ["Grow", "\tNew markets"], notes: "Keep it short" },
          { title: "Risks", bullets: [] },
        ],
      });
      const id = out.structured.presentationId;
      const kinds = fake.state.requests.map((r) => `${r.method} ${r.path.replace(id, "ID")}`);
      assert.deepEqual(kinds, ["POST /v1/presentations", "POST /v1/presentations/ID:batchUpdate", "GET /v1/presentations/ID", "POST /v1/presentations/ID:batchUpdate"]);
      const first = batches()[0].body.requests;
      assert.deepEqual(first.slice(0, 2), [{ insertText: { objectId: "i0", insertionIndex: 0, text: "Launch plan" } }, { insertText: { objectId: "i1", insertionIndex: 0, text: "Draft" } }]);
      assert.equal(first.filter((r) => r.createSlide).length, 2);
      assert.ok(first.every((r) => !r.createSlide || r.createSlide.slideLayoutReference.predefinedLayout === "TITLE_AND_BODY"));
      const notesReq = batches()[1].body.requests;
      assert.equal(notesReq.length, 1);
      assert.equal(notesReq[0].insertText.text, "Keep it short");

      const read = await call("slides_read", { presentationId: id });
      assert.deepEqual(
        read.structured.slides.map((x) => [x.title, x.body, x.notes]),
        [["Launch plan", ["Draft"], ""], ["Goals", ["- Grow", "  - New markets"], "Keep it short"], ["Risks", [], ""]],
      );
      assert.deepEqual(out.structured.slides.map((x) => x.slideId), read.structured.slides.map((x) => x.slideId));
      assert.equal(out.structured.url, `https://docs.google.com/presentation/d/${id}/edit`);
    });

    it("slides_create with folderId moves the new deck into the folder before filling it", async () => {
      const FOLDER = "1fOlDeRsCrAtCh000000000000000000aa";
      fake.state.folders.add(FOLDER);
      const out = await call("slides_create", { title: "Filed deck", slides: [{ title: "One" }], folderId: FOLDER });
      const id = out.structured.presentationId;
      assert.deepEqual(fake.state.requests.map((r) => `${r.method} ${r.host}${r.path}`).slice(0, 3), ["POST slides.googleapis.com/v1/presentations", `PATCH www.googleapis.com/drive/v3/files/${id}`, `POST slides.googleapis.com/v1/presentations/${id}:batchUpdate`]);
      assert.equal(fake.state.requests[1].query.removeParents, "root");
      assert.deepEqual(fake.state.driveFiles.get(id).parents, [FOLDER]);
      assert.equal(out.structured.folderId, FOLDER);
      await assert.rejects(call("slides_create", { title: "Lost", slides: [], folderId: "1fOlDeRgOnE0000000000000000000000bb" }), /Created the deck .+ in My Drive, still empty, but moving it into the folder failed: .*404/);
    });

    it("slides_create without a title slide deletes the default first slide", async () => {
      const out = await call("slides_create", { title: "No cover", titleSlide: false, slides: [{ title: "Only" }] });
      const id = out.structured.presentationId;
      assert.equal(order(id).length, 1);
      assert.notEqual(order(id)[0], "p");
      assert.equal(batches().length, 1, "no notes, so no second batch");
      await assert.rejects(call("slides_create", { title: "Empty", titleSlide: false, slides: [] }), /at least one slide/);
    });

    it("slides_create says which deck it made when filling it in fails", async () => {
      const real = fake.handle;
      fake.handle = (method, url, body) => (String(url).includes(":batchUpdate") ? { status: 500, body: { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } } } : real(method, url, body));
      await assert.rejects(call("slides_create", { title: "Doomed", slides: [{ title: "A" }] }), /Created the deck https:\/\/docs\.google\.com\/presentation\/d\/.+ \(id .+\), but filling it in failed: Google API 500/);
    });

    it("slides_add_slide inserts at a 1-based position with notes", async () => {
      const out = await call("slides_add_slide", { presentationId: DECK, title: "Budget", bullets: ["$1M"], notes: "Ask for more", position: 2 });
      assert.equal(order()[1], out.structured.slideId);
      assert.equal(out.structured.position, 2);
      assert.equal(batches()[0].body.requests[0].createSlide.insertionIndex, 1);
      const read = await call("slides_read", { presentationId: DECK, slideIds: [out.structured.slideId] });
      assert.deepEqual([read.structured.slides[0].title, read.structured.slides[0].body, read.structured.slides[0].notes], ["Budget", ["- $1M"], "Ask for more"]);
    });

    it("slides_add_slide says so plainly when the deck's theme has no Title-and-body layout", async () => {
      fake.state.presentations.get(DECK)._missingLayouts = ["TITLE_AND_BODY"];
      await assert.rejects(call("slides_add_slide", { presentationId: DECK, title: "X" }), (err) => err.message === lib.NO_LAYOUT);
      assert.match(lib.NO_LAYOUT, /no "Title and body" layout.*slides_duplicate_slide.*slides_replace_text/);
      assert.equal(order().length, 3);
    });

    it("slides_add_slide appends by default and refuses a position past the end", async () => {
      const out = await call("slides_add_slide", { presentationId: DECK, title: "End" });
      assert.equal(order().at(-1), out.structured.slideId);
      assert.equal(out.structured.position, 4);
      await assert.rejects(call("slides_add_slide", { presentationId: DECK, title: "Far", position: 9 }), /position can be 1 to 5/);
      assert.equal(batches().length, 1);
    });

    it("slides_duplicate_slide puts the copy after the original, or moves it to a position", async () => {
      const a = await call("slides_duplicate_slide", { presentationId: DECK, slideId: "g_title" });
      assert.deepEqual(order(), ["g_title", a.structured.slideId, "g_roadmap", "g_photo"]);
      assert.equal(batches()[0].body.requests.length, 1, "no move needed");
      const b = await call("slides_duplicate_slide", { presentationId: DECK, slideId: "g_photo", position: 1 });
      assert.equal(order()[0], b.structured.slideId);
      await assert.rejects(call("slides_duplicate_slide", { presentationId: DECK, slideId: "g_title", position: 7 }), /position can be 1 to 6/);
      const c = await call("slides_duplicate_slide", { presentationId: DECK, slideId: "g_title", position: 6 });
      assert.equal(order().at(-1), c.structured.slideId);
      assert.equal(order().length, 6);
      assert.equal(c.structured.position, 6);
      assert.equal(batches().at(-1).body.requests[1].updateSlidesPosition.insertionIndex, 6, "past the copy's own slot, counted before the move");
      // The copy's notes came along under the copy's own ids.
      const read = await call("slides_read", { presentationId: DECK, slideIds: [c.structured.slideId] });
      assert.equal(read.structured.slides[0].notes, "Welcome everyone");
    });

    it("slides_duplicate_slide refuses an unknown slide", async () => {
      await assert.rejects(call("slides_duplicate_slide", { presentationId: DECK, slideId: "g_missing" }), /no slide g_missing/);
      assert.equal(batches().length, 0);
    });

    it("slides_delete_slide deletes a slide and refuses an element id, so only slides are deleted", async () => {
      const out = await call("slides_delete_slide", { presentationId: DECK, slideId: "g_roadmap" });
      assert.deepEqual(out.structured.deleted, { slideId: "g_roadmap", position: 2, title: "Roadmap" });
      assert.equal(out.structured.remaining, 2);
      assert.deepEqual(order(), ["g_title", "g_photo"]);
      await assert.rejects(call("slides_delete_slide", { presentationId: DECK, slideId: "g_title_t" }), /no slide g_title_t/);
      assert.equal(batches().length, 1);
    });

    it("slides_replace_text counts matches deck-wide (shapes and tables), or only on the given slides", async () => {
      const none = await call("slides_replace_text", { presentationId: DECK, find: "Beta", replace: "Preview", slideIds: ["g_title"] });
      assert.equal(none.structured.occurrencesChanged, 0, "a zero count is left out of the reply (proto3) and reads as 0");
      assert.match(none.text, /No occurrences/);
      assert.deepEqual(batches()[0].body.requests[0].replaceAllText, { containsText: { text: "Beta", matchCase: true }, replaceText: "Preview", pageObjectIds: ["g_title"] });
      const cased = await call("slides_replace_text", { presentationId: DECK, find: "beta", replace: "Preview" });
      assert.equal(cased.structured.occurrencesChanged, 0);
      const all = await call("slides_replace_text", { presentationId: DECK, find: "beta", replace: "Preview", matchCase: false });
      assert.equal(all.structured.occurrencesChanged, 2);
      assert.equal("pageObjectIds" in batches()[2].body.requests[0].replaceAllText, false);
      const read = await call("slides_read", { presentationId: DECK, slideIds: ["g_roadmap"] });
      assert.deepEqual(read.structured.slides[0].body.slice(1, 5), ["  - Preview in September", "- GA in Q4", "| Milestone | Date |", "| Preview | Sept 30 |"]);
    });

    it("slides_replace_text surfaces an unknown slide id from the API", async () => {
      await assert.rejects(call("slides_replace_text", { presentationId: DECK, find: "x", replace: "y", slideIds: ["g_nope"] }), /400: .*could not be found/);
    });

    it("slides_insert_image hands Google a public https URL, centred on the slide in points", async () => {
      const out = await call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", imageUrl: "https://example.com/team.png" });
      const req = batches()[0].body.requests[0].createImage;
      assert.equal(req.url, "https://example.com/team.png");
      assert.deepEqual(req.elementProperties.size, { width: { magnitude: 432, unit: "PT" }, height: { magnitude: 243, unit: "PT" } });
      assert.equal(req.elementProperties.transform.translateX, 144);
      assert.equal(req.elementProperties.pageObjectId, "g_photo");
      assert.equal(out.structured.imageId, req.objectId);
      const img = fake.state.presentations.get(DECK).slides[2].pageElements.at(-1);
      assert.equal(img.image.sourceUrl, "https://example.com/team.png");
      assert.ok(fake.state.requests.every((r) => r.host === "slides.googleapis.com"), "the extension never fetches the image itself");
    });

    it("slides_insert_image takes an explicit box, and a Drive image shared with anyone through Drive's webContentLink", async () => {
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "logo.png", mimeType: "image/png", size: "20480", resourceKey: "0-abcRK", permissions: [{ type: "anyone", role: "reader" }, { type: "user", role: "owner" }] });
      const out = await call("slides_insert_image", { presentationId: DECK, slideId: "g_title", driveFileId: `https://drive.google.com/file/d/${DRIVE_IMG}/view`, box: { x: 600, y: 20, width: 100, height: 50 } });
      const drive = fake.state.requests.find((r) => r.host === "www.googleapis.com");
      assert.equal(drive.path, `/drive/v3/files/${DRIVE_IMG}`);
      assert.deepEqual(drive.query, { fields: "id,name,mimeType,size,resourceKey,webContentLink,permissions(type,role)", supportsAllDrives: "true" });
      const req = batches()[0].body.requests[0].createImage;
      assert.equal(req.url, `https://drive.usercontent.google.com/download?id=${DRIVE_IMG}&export=download&resourcekey=0-abcRK`);
      assert.deepEqual(out.structured.box, { x: 600, y: 20, width: 100, height: 50 });
      assert.match(out.text, /Drive image "logo.png"/);
    });

    it("slides_insert_image falls back to the /uc link only when Drive gives no webContentLink, and refuses an odd one", async () => {
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "logo.png", mimeType: "image/png", _noWebContentLink: true, resourceKey: "0-abcRK", permissions: [{ type: "anyone", role: "reader" }] });
      await call("slides_insert_image", { presentationId: DECK, slideId: "g_title", driveFileId: DRIVE_IMG });
      assert.equal(batches()[0].body.requests[0].createImage.url, `https://drive.google.com/uc?export=download&id=${DRIVE_IMG}&resourcekey=0-abcRK`);
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "logo.png", mimeType: "image/png", webContentLink: "https://evil.example/download?id=x", permissions: [{ type: "anyone", role: "reader" }] });
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_title", driveFileId: DRIVE_IMG }), /unexpected download link/);
      assert.equal(batches().length, 1);
    });

    it("slides_insert_image refuses a private Drive image before calling Slides", async () => {
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "logo.png", mimeType: "image/png", permissions: [{ type: "user", role: "owner" }, { type: "domain", role: "reader" }] });
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", driveFileId: DRIVE_IMG }), (err) => err.message === lib.NOT_PUBLIC);
      assert.equal(batches().length, 0);
      assert.match(lib.NOT_PUBLIC, /isn't shared publicly.*https imageUrl.*"anyone with the link".*never changes sharing/);
    });

    it("slides_insert_image maps Slides' refusal of a private Drive image (permissions hidden from this account) to the same message", async () => {
      // Drive lists permissions only to someone who can share the file; here it can't, so the pre-check can't tell.
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "logo.png", mimeType: "image/png", _permissions: [{ type: "user", role: "owner" }] });
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", driveFileId: DRIVE_IMG }), (err) => err.message === lib.NOT_PUBLIC);
      assert.equal(batches().length, 1, "Slides was asked, and refused");
      fake.state.driveFiles.get(DRIVE_IMG)._permissions.push({ type: "anyone", role: "reader" });
      const ok = await call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", driveFileId: DRIVE_IMG });
      assert.match(ok.text, /Inserted Drive image "logo.png"/);
    });

    it("the fake refuses Drive thumbnail links and private Drive links, as Slides fetches without credentials", () => {
      const pr = fake.state.presentations.get(DECK);
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "p.png", mimeType: "image/png", permissions: [{ type: "user", role: "owner" }] });
      for (const url of ["https://lh3.googleusercontent.com/drive-storage/AJQWtBabc=s1600", `https://drive.google.com/uc?export=download&id=${DRIVE_IMG}`, `https://drive.usercontent.google.com/download?id=${DRIVE_IMG}&export=download`]) {
        const res = fake.handle("POST", new URL(`https://slides.googleapis.com/v1/presentations/${DECK}:batchUpdate`), { requests: [createImageRequest("img_probe1", url, "g_photo", { x: 0, y: 0, width: 10, height: 10 })] });
        assert.equal(res.status, 400, url);
        assert.match(res.body.error.message, /publicly accessible/);
      }
      assert.equal(pr.slides[2].pageElements.length, 1);
    });

    it("slides_insert_image refuses bad sources before writing anything", async () => {
      fake.state.driveFiles.set(DRIVE_IMG, { id: DRIVE_IMG, name: "notes.pdf", mimeType: "application/pdf", permissions: [{ type: "anyone", role: "reader" }] });
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", driveFileId: DRIVE_IMG }), /application\/pdf; Slides takes PNG, JPEG or GIF/);
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", imageUrl: "http://example.com/a.png" }), /https/);
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo" }), /exactly one of imageUrl and driveFileId/);
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", imageUrl: "https://e.com/a.png", driveFileId: DRIVE_IMG }), /exactly one/);
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_none", imageUrl: "https://e.com/a.png" }), /no slide g_none/);
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", driveFileId: "1MissingDriveFileXXXXXXX" }), /404: File not found/);
      assert.equal(batches().length, 0);
    });

    it("slides_insert_image surfaces Google failing to fetch the image", async () => {
      fake.state.unfetchableImages.add("https://example.com/private.png");
      await assert.rejects(call("slides_insert_image", { presentationId: DECK, slideId: "g_photo", imageUrl: "https://example.com/private.png" }), /^InputError: Google couldn't fetch that image\. The URL must be public/);
    });

    it("surfaces an unknown deck and refuses bad ids before any request", async () => {
      await assert.rejects(call("slides_read", { presentationId: "1MissingDeckXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }), /404/);
      const n = fake.state.requests.length;
      await assert.rejects(call("slides_read", { presentationId: "../x" }), /isn't a Google presentation id/);
      await assert.rejects(call("slides_delete_slide", { presentationId: DECK, slideId: "bad id!" }), /slideId must be/);
      assert.equal(fake.state.requests.length, n);
    });
  });

  describe("declared risk", () => {
    it("reads are read, creates and edits write, deleting a slide risky", () => {
      assert.deepEqual(Object.fromEntries(slidesTools.map((t) => [t.name, t.risk])), {
        slides_read: "read",
        slides_create: "write",
        slides_add_slide: "write",
        slides_duplicate_slide: "write",
        slides_delete_slide: "risky",
        slides_replace_text: "write",
        slides_insert_image: "write",
      });
    });
    it("every tool on an existing deck targets /presentationId, which its input declares", () => {
      for (const t of slidesTools) {
        if (t.name === "slides_create") assert.equal(t.target, undefined);
        else {
          assert.equal(t.target, "/presentationId", t.name);
          assert.ok("presentationId" in t.input, t.name);
        }
        assert.match(t.name, /^[a-z0-9_]{1,64}$/);
      }
    });
    it("says Google's servers fetch image URLs, and takes no local paths", () => {
      const t = slidesTools.find((x) => x.name === "slides_insert_image");
      assert.match(t.description, /Google's servers fetch the image/);
      assert.match(t.description, /No local files/);
      assert.match(t.description, /shared as "anyone with the link" \(the extension never changes sharing/);
      assert.match(t.description, /visible to everyone the deck is shared with/);
      assert.doesNotMatch(t.description, /needn't be shared|thumbnail/);
    });
  });
}
