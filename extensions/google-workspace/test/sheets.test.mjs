// The Sheets tools against the in-process fake Sheets v4 API (test/fake-sheets-slides.mjs). No live account was used:
// payloads follow Google's documented shapes. Needs esbuild (npm ci --ignore-scripts at the repo root), else skipped.
import assert from "node:assert/strict";
import { beforeEach, describe, it, test } from "node:test";
import { createFakeSheetsSlides, fakeClient } from "./fake-sheets-slides.mjs";
import { SKIP, caller, loadSheetsSlides } from "./sheets-slides-lib.mjs";

const lib = await loadSheetsSlides();
if (!lib) test("sheets tools", { skip: SKIP }, () => {});
else defineTests(lib);

// Google's own sample spreadsheet id, from the Sheets API docs.
const SS = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

function defineTests(lib) {
  const { parseA1, formatA1, gridRange, columnLetters, columnNumber, markdownTable, spreadsheetIdOf, sheetsTools } = lib;

  describe("A1 parsing", () => {
    it("reads a quoted tab name with a space", () => {
      assert.deepEqual(parseA1("'Sheet 1'!A1:B2"), { sheet: "Sheet 1", startCol: 1, startRow: 1, endCol: 2, endRow: 2 });
    });
    it("reads a doubled quote inside a quoted name", () => {
      assert.deepEqual(parseA1("'It''s Q1'!B:B"), { sheet: "It's Q1", startCol: 2, endCol: 2 });
    });
    it("reads unquoted names, including one with a space", () => {
      assert.deepEqual(parseA1("Sheet1!A1:B2"), { sheet: "Sheet1", startCol: 1, startRow: 1, endCol: 2, endRow: 2 });
      assert.deepEqual(parseA1("Sheet 1!C3"), { sheet: "Sheet 1", startCol: 3, startRow: 3, endCol: 3, endRow: 3 });
    });
    it("reads open ranges: whole columns, whole rows, and open-ended rows", () => {
      assert.deepEqual(parseA1("A:C"), { startCol: 1, endCol: 3 });
      assert.deepEqual(parseA1("2:5"), { startRow: 2, endRow: 5 });
      assert.deepEqual(parseA1("A2:C"), { startCol: 1, startRow: 2, endCol: 3 });
      assert.deepEqual(parseA1("Data!A5:B"), { sheet: "Data", startCol: 1, startRow: 5, endCol: 2 });
    });
    it("takes a tab name alone as the whole tab; a bare reference is a cell unless quoted", () => {
      assert.deepEqual(parseA1("Expenses"), { sheet: "Expenses" });
      assert.deepEqual(parseA1("'Q1'"), { sheet: "Q1" });
      assert.deepEqual(parseA1("Q1"), { startCol: 17, startRow: 1, endCol: 17, endRow: 1 });
      assert.deepEqual(parseA1("'My Tab'!"), { sheet: "My Tab" });
    });
    it("drops $, ignores case, and puts reversed corners in order", () => {
      assert.deepEqual(parseA1("$A$1:$B$2"), { startCol: 1, startRow: 1, endCol: 2, endRow: 2 });
      assert.deepEqual(parseA1("b2:a1"), { startCol: 1, startRow: 1, endCol: 2, endRow: 2 });
      assert.deepEqual(parseA1("'T'!zz10"), { sheet: "T", startCol: 702, startRow: 10, endCol: 702, endRow: 10 });
    });
    it("splits at the last ! so a quoted name may contain one", () => {
      assert.deepEqual(parseA1("'Wow!'!A1"), { sheet: "Wow!", startCol: 1, startRow: 1, endCol: 1, endRow: 1 });
    });
    it("refuses malformed ranges with a plain reason", () => {
      assert.throws(() => parseA1(""), /empty/);
      assert.throws(() => parseA1("'Unclosed!A1"), /no closing quote/);
      assert.throws(() => parseA1("'T'A1"), /Expected !/);
      assert.throws(() => parseA1("Sheet1!A0"), /Row 0/);
      assert.throws(() => parseA1("Sheet1!Foo"), /isn't an A1 range/);
      assert.throws(() => parseA1("A1:B2:C3"), /isn't an A1 range/);
      assert.throws(() => parseA1("A1:B99999999"), /out of range/);
      assert.throws(() => parseA1("'bad\u0001tab'!A1"), /control characters/);
    });
    it("serialises with the tab always quoted, quotes doubled", () => {
      assert.equal(formatA1(parseA1("Sheet1!A1:B2")), "'Sheet1'!A1:B2");
      assert.equal(formatA1(parseA1("'It''s'!C3")), "'It''s'!C3");
      assert.equal(formatA1(parseA1("A2:C")), "A2:C");
      assert.equal(formatA1(parseA1("A:C")), "A:C");
      assert.equal(formatA1(parseA1("Data!2:5")), "'Data'!2:5");
      assert.equal(formatA1(parseA1("Expenses")), "'Expenses'");
    });
    it("converts column letters both ways up to ZZZ", () => {
      for (const [n, s] of [[1, "A"], [26, "Z"], [27, "AA"], [702, "ZZ"], [703, "AAA"], [18278, "ZZZ"]]) {
        assert.equal(columnLetters(n), s);
        assert.equal(columnNumber(s), n);
      }
      assert.throws(() => columnLetters(18279), /out of range/);
    });
    it("makes 0-based, end-exclusive GridRanges and leaves open ends out", () => {
      assert.deepEqual(gridRange(parseA1("B2:C3"), 7), { sheetId: 7, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 3 });
      assert.deepEqual(gridRange(parseA1("A2:C"), 7), { sheetId: 7, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 });
      assert.deepEqual(gridRange(parseA1("1:1"), 0), { sheetId: 0, startRowIndex: 0, endRowIndex: 1 });
      assert.deepEqual(gridRange(parseA1("T"), 3), { sheetId: 3 });
    });
  });

  describe("ids and tables", () => {
    it("takes a spreadsheet id or its URL, and refuses anything else", () => {
      assert.equal(spreadsheetIdOf(SS), SS);
      assert.equal(spreadsheetIdOf(`https://docs.google.com/spreadsheets/d/${SS}/edit#gid=0`), SS);
      assert.equal(spreadsheetIdOf(`https://docs.google.com/spreadsheets/u/1/d/${SS}`), SS);
      assert.throws(() => spreadsheetIdOf("../../drive/v3/files"), /isn't a Google spreadsheet id/);
      assert.throws(() => spreadsheetIdOf(`https://evil.example/spreadsheets/d/${SS}`), /isn't a Google spreadsheet id/);
    });
    it("renders a markdown table with the sheet's letters and row numbers, escaping | and newlines", () => {
      assert.equal(markdownTable([["a|b", "x\ny"], [1]], 5, 2), ["| | B | C |", "|---|---|---|", "| 5 | a\\|b | x<br>y |", "| 6 | 1 |  |"].join("\n"));
    });
  });

  describe("tools", () => {
    let fake;
    let client;
    let call;
    beforeEach(() => {
      fake = createFakeSheetsSlides();
      client = fakeClient(fake);
      call = (name, args) => caller(lib, client)(sheetsTools, name, args);
      fake.addSpreadsheet({
        id: SS,
        title: "Q3 budget",
        tabs: [
          { title: "Archive", hidden: true, cells: [["old"]] },
          {
            title: "Sheet 1",
            sheetId: 123,
            rows: 20,
            columns: 5,
            cells: [
              ["Item", "Cost", "Qty", "Total"],
              ["Paper", 2.5, 4, "=B2*C2"],
              ["Pens | blue", 1, 10, "=B3*C3"],
            ],
            computed: { "2,4": 10, "3,4": 10 },
          },
          { title: "It's Q1", sheetId: 9, cells: [["a", "b"], ["c", "d"]] },
        ],
      });
    });
    const paths = () => fake.state.requests.map((r) => `${r.method} ${r.path}`);

    it("sheets_list_tabs lists every tab with its size, hidden and frozen state", async () => {
      fake.sheet(SS, "Sheet 1").properties.gridProperties.frozenRowCount = 1;
      const out = await call("sheets_list_tabs", { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SS}/edit` });
      assert.deepEqual(
        out.structured.tabs.map((t) => [t.title, t.tabId, t.position, t.rows, t.columns, t.frozenRows, t.hidden]),
        [["Archive", 0, 1, 1000, 26, 0, true], ["Sheet 1", 123, 2, 20, 5, 1, false], ["It's Q1", 9, 3, 1000, 26, 0, false]],
      );
      assert.match(out.text, /2\. "Sheet 1" \(tab id 123\): 20 rows × 5 columns, 1 frozen row/);
      assert.equal(fake.state.requests[0].host, "sheets.googleapis.com");
      assert.equal(fake.state.requests[0].query.fields, "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties");
    });

    it("sheets_read reads a whole tab as a markdown table plus structured rows", async () => {
      const out = await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'" });
      assert.deepEqual(out.structured.rows, [["Item", "Cost", "Qty", "Total"], ["Paper", "2.5", "4", "10"], ["Pens | blue", "1", "10", "10"]]);
      assert.equal(out.structured.hasMore, false);
      assert.match(out.text, /\| 3 \| Pens \\\| blue \| 1 \| 10 \| 10 \|/);
      // The tab is clamped to its 20-row grid, and the range travels encoded in one path segment.
      const get = fake.state.requests[1];
      assert.equal(get.path, `/v4/spreadsheets/${SS}/values/'Sheet%201'!1%3A20`);
      assert.equal(get.query.valueRenderOption, "FORMATTED_VALUE");
    });

    it("sheets_read returns formulas, or raw numbers, on request", async () => {
      const f = await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!D2:D3", render: "formula" });
      assert.deepEqual(f.structured.rows, [["=B2*C2"], ["=B3*C3"]]);
      assert.equal(fake.state.requests[1].query.dateTimeRenderOption, "FORMATTED_STRING");
      const u = await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!B2:C2", render: "unformatted" });
      assert.deepEqual(u.structured.rows, [[2.5, 4]]);
    });

    it("sheets_read reads a tab whose name has a quote, and labels from the range's corner", async () => {
      const out = await call("sheets_read", { spreadsheetId: SS, range: "'It''s Q1'!B1:B2" });
      assert.deepEqual(out.structured.rows, [["b"], ["d"]]);
      assert.equal(out.structured.startColumn, "B");
      assert.match(out.text, /\| \| B \|\n\|---\|---\|\n\| 1 \| b \|/);
    });

    it("sheets_read without a tab name reads the first visible tab, not a hidden one", async () => {
      const out = await call("sheets_read", { spreadsheetId: SS, range: "A1:A1" });
      assert.equal(out.structured.tab, "Sheet 1");
      assert.deepEqual(out.structured.rows, [["Item"]]);
    });

    it("sheets_read pages big ranges with maxRows and fromRow", async () => {
      const rows = Array.from({ length: 250 }, (_, i) => [`r${i + 1}`]);
      fake.addSpreadsheet({ id: "1PagedSheetIdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", title: "Big", tabs: [{ title: "Log", cells: rows }] });
      const id = "1PagedSheetIdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const p1 = await call("sheets_read", { spreadsheetId: id, range: "Log!A:A", maxRows: 100 });
      assert.equal(p1.structured.rows.length, 100);
      assert.equal(p1.structured.hasMore, true);
      assert.equal(p1.structured.nextFromRow, 101);
      assert.match(p1.text, /call again with fromRow 101/);
      const p3 = await call("sheets_read", { spreadsheetId: id, range: "Log!A:A", maxRows: 100, fromRow: 201 });
      assert.equal(p3.structured.rows.length, 50);
      assert.equal(p3.structured.rows[0][0], "r201");
      // The open range runs on to the grid's last row (1000), which may still hold data.
      assert.equal(p3.structured.hasMore, true);
      assert.equal(p3.structured.nextFromRow, 301);
      assert.match(p3.text, /runs on to row 1000 \(rows below may be empty\): call again with fromRow 301/);
      const last = await call("sheets_read", { spreadsheetId: id, range: "Log!A:A", maxRows: 1000, fromRow: 201 });
      assert.equal(last.structured.hasMore, false);
      assert.equal(fake.state.requests.at(-1).path, `/v4/spreadsheets/${id}/values/'Log'!A201%3AA1000`, "no row past the page is fetched");
    });

    it("sheets_read reports more rows in the range even when the rows just below the page are empty", async () => {
      fake.addSpreadsheet({ id: "1GappySheetIdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", title: "Gaps", tabs: [{ title: "T", cells: [["a"], ["b"], [null], [null], [null], [null], ["far"]] }] });
      const id = "1GappySheetIdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const p1 = await call("sheets_read", { spreadsheetId: id, range: "T!A1:A10", maxRows: 3 });
      assert.deepEqual(p1.structured.rows, [["a"], ["b"]]);
      assert.equal(p1.structured.hasMore, true);
      assert.equal(p1.structured.nextFromRow, 4);
      const p2 = await call("sheets_read", { spreadsheetId: id, range: "T!A1:A10", maxRows: 3, fromRow: 7 });
      assert.deepEqual(p2.structured.rows, [["far"]]);
      assert.equal(p2.structured.hasMore, true);
      const p3 = await call("sheets_read", { spreadsheetId: id, range: "T!A1:A10", maxRows: 3, fromRow: 10 });
      assert.equal(p3.structured.hasMore, false);
    });

    it("sheets_read clamps a range past the grid instead of failing, and reports an empty range", async () => {
      const out = await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!A1:Z5000" });
      assert.equal(out.structured.rows.length, 3);
      assert.equal(fake.state.requests[1].path, `/v4/spreadsheets/${SS}/values/'Sheet%201'!A1%3AE20`);
      const empty = await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!A10:B12" });
      assert.deepEqual(empty.structured.rows, []);
      assert.match(empty.text, /is empty/);
      await assert.rejects(call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!G1" }), /past the last column of "Sheet 1" \(E\)/);
    });

    it("sheets_read names the tabs when the range's tab doesn't exist", async () => {
      await assert.rejects(call("sheets_read", { spreadsheetId: SS, range: "Nope!A1" }), /no tab named "Nope".*"Archive", "Sheet 1", "It's Q1"/);
    });

    it("sheets_write writes USER_ENTERED values from an anchor cell and returns the updated range", async () => {
      const out = await call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A5", values: [["Ink", "3", "=B5*2"], [null, true, ""]] });
      assert.equal(out.structured.updatedRange, "'Sheet 1'!A5:C6");
      assert.equal(out.structured.updatedCells, 5);
      assert.deepEqual(fake.cell(SS, "Sheet 1", "B5"), { v: 3 });
      assert.deepEqual(fake.cell(SS, "Sheet 1", "C5"), { v: "#FAKE", f: "=B5*2" });
      const put = fake.state.requests.at(-1);
      assert.equal(put.method, "PUT");
      assert.equal(put.query.valueInputOption, "USER_ENTERED");
      assert.equal(put.body.range, "'Sheet 1'!A5");
      assert.equal(put.body.majorDimension, "ROWS");
    });

    it("sheets_write RAW stores strings as given", async () => {
      await call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A7:B7", values: [["=1+1", "007"]], input: "RAW" });
      assert.deepEqual(fake.cell(SS, "Sheet 1", "A7"), { v: "=1+1" });
      assert.deepEqual(fake.cell(SS, "Sheet 1", "B7"), { v: "007" });
      await call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!C7", values: [[42, true]], input: "RAW" });
      assert.deepEqual([fake.cell(SS, "Sheet 1", "C7"), fake.cell(SS, "Sheet 1", "D7")], [{ v: 42 }, { v: true }]);
      const desc = sheetsTools.find((t) => t.name === "sheets_write").input.input.description;
      assert.match(desc, /numbers and booleans stay numbers and booleans/);
      assert.doesNotMatch(desc, /as text\./);
    });

    it("sheets_write refuses values that don't fit a bounded range, before any request", async () => {
      await assert.rejects(call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A1:B1", values: [["a", "b", "c"]] }), /3 columns of values don't fit/);
      await assert.rejects(call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A1:B1", values: [["a"], ["b"]] }), /2 rows of values don't fit/);
      assert.equal(fake.state.requests.length, 0);
    });

    it("sheets_append_rows inserts rows below the table", async () => {
      const out = await call("sheets_append_rows", { spreadsheetId: SS, range: "Sheet 1", rows: [["Tape", 4, 1, "=B4*C4"]] });
      assert.equal(out.structured.updatedRange, "'Sheet 1'!A4:D4");
      assert.equal(out.structured.tableRange, "'Sheet 1'!A1:D3");
      const req = fake.state.requests.at(-1);
      assert.equal(req.path, `/v4/spreadsheets/${SS}/values/'Sheet%201':append`);
      assert.equal(req.query.insertDataOption, "INSERT_ROWS");
      assert.deepEqual(fake.cell(SS, "Sheet 1", "A4"), { v: "Tape" });
    });

    it("sheets_create makes a spreadsheet with a bold, frozen header in one request", async () => {
      const out = await call("sheets_create", { title: "Trips", tabTitle: "2026", header: ["Date", "Place", "Cost"] });
      assert.equal(fake.state.requests.length, 1);
      const body = fake.state.requests[0].body;
      assert.deepEqual(body.sheets[0].properties, { title: "2026", gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } });
      assert.deepEqual(body.sheets[0].data[0].rowData[0].values[0], { userEnteredValue: { stringValue: "Date" }, userEnteredFormat: { textFormat: { bold: true } } });
      const id = out.structured.spreadsheetId;
      assert.equal(out.structured.url, `https://docs.google.com/spreadsheets/d/${id}/edit`);
      assert.deepEqual(fake.cell(id, "2026", "C1"), { v: "Cost" });
      assert.equal(fake.format(id, "2026", "A1").textFormat.bold, true);
      assert.equal(fake.sheet(id, "2026").properties.gridProperties.frozenRowCount, 1);
    });

    it("sheets_create without options sends only the title", async () => {
      const out = await call("sheets_create", { title: "Blank" });
      assert.deepEqual(fake.state.requests[0].body, { properties: { title: "Blank" } });
      assert.deepEqual(out.structured.firstTab, { title: "Sheet1", tabId: 0 });
    });

    it("sheets_create with folderId creates, then moves the file there with Drive files.update", async () => {
      const FOLDER = "1fOlDeRsCrAtCh000000000000000000aa";
      fake.state.folders.add(FOLDER);
      const out = await call("sheets_create", { title: "Filed", folderId: `https://drive.google.com/drive/folders/${FOLDER}` });
      const id = out.structured.spreadsheetId;
      assert.deepEqual(fake.state.requests.map((r) => `${r.method} ${r.host}${r.path}`), ["POST sheets.googleapis.com/v4/spreadsheets", `PATCH www.googleapis.com/drive/v3/files/${id}`]);
      assert.deepEqual(fake.state.requests[1].query, { addParents: FOLDER, removeParents: "root", supportsAllDrives: "true", fields: "id,parents" });
      assert.deepEqual(fake.state.driveFiles.get(id).parents, [FOLDER]);
      assert.equal(out.structured.folderId, FOLDER);
      assert.match(out.text, new RegExp(`in folder ${FOLDER}`));
      // "root" means My Drive: nothing to move.
      await call("sheets_create", { title: "Rooted", folderId: "root" });
      assert.equal(fake.state.requests.at(-1).method, "POST");
    });

    it("sheets_create refuses a bad folder id before creating, and names the file when the move fails", async () => {
      await assert.rejects(call("sheets_create", { title: "X", folderId: "not a folder" }), /isn't a Google folder id/);
      assert.equal(fake.state.requests.length, 0);
      await assert.rejects(call("sheets_create", { title: "X", folderId: "1fOlDeRgOnE0000000000000000000000bb" }), /Created the spreadsheet https:\/\/docs\.google\.com\/spreadsheets\/d\/\S+ \(id \S+\) in My Drive, but moving it into the folder failed: Google API 404: File not found: 1fOlDeRgOnE/);
    });

    it("sheets_add_tab adds a tab at a position, with its header in the same atomic batch", async () => {
      const out = await call("sheets_add_tab", { spreadsheetId: SS, title: "Summary", position: 1, header: ["Metric", "Value"] });
      assert.equal(out.structured.tab.position, 1);
      const [add, cells] = fake.state.requests.at(-1).body.requests;
      assert.equal(add.addSheet.properties.index, 0);
      assert.equal(cells.updateCells.start.sheetId, add.addSheet.properties.sheetId);
      assert.equal(cells.updateCells.fields, "userEnteredValue,userEnteredFormat.textFormat.bold");
      assert.equal(out.structured.tab.tabId, add.addSheet.properties.sheetId);
      assert.deepEqual(fake.cell(SS, "Summary", "B1"), { v: "Value" });
    });

    it("sheets_add_tab surfaces the API's duplicate-name error", async () => {
      await assert.rejects(call("sheets_add_tab", { spreadsheetId: SS, title: "sheet 1" }), /already exists/);
    });

    it("sheets_format sends repeatCell, column width and freeze requests for the range's tab", async () => {
      const out = await call("sheets_format", { spreadsheetId: SS, range: "'Sheet 1'!A1:D1", bold: true, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" }, columnWidth: 140, freezeRows: 1 });
      const reqs = fake.state.requests.at(-1).body.requests;
      assert.deepEqual(reqs[0], {
        repeatCell: {
          range: { sheetId: 123, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat",
        },
      });
      assert.deepEqual(reqs[1], { updateDimensionProperties: { range: { sheetId: 123, dimension: "COLUMNS", startIndex: 0, endIndex: 4 }, properties: { pixelSize: 140 }, fields: "pixelSize" } });
      assert.deepEqual(reqs[2], { updateSheetProperties: { properties: { sheetId: 123, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } });
      assert.equal(fake.format(SS, "Sheet 1", "D1").textFormat.bold, true);
      assert.equal(fake.sheet(SS, "Sheet 1")._columnWidths[2], 140);
      assert.equal(fake.sheet(SS, "Sheet 1").properties.gridProperties.frozenRowCount, 1);
      assert.match(out.text, /bold, number format CURRENCY "\$#,##0.00", column width 140px, 1 frozen row/);
    });

    it("sheets_format needs something to do", async () => {
      await assert.rejects(call("sheets_format", { spreadsheetId: SS, range: "A1" }), /Nothing to format/);
      assert.equal(fake.state.requests.length, 0);
    });

    it("sheets_clear clears values and keeps formatting", async () => {
      await call("sheets_format", { spreadsheetId: SS, range: "'Sheet 1'!A2", bold: true });
      const out = await call("sheets_clear", { spreadsheetId: SS, range: "'Sheet 1'!A2:D3" });
      assert.equal(out.structured.clearedRange, "'Sheet 1'!A2:D3");
      assert.equal(fake.state.requests.at(-1).path, `/v4/spreadsheets/${SS}/values/'Sheet%201'!A2%3AD3:clear`);
      assert.equal(fake.cell(SS, "Sheet 1", "A2"), undefined);
      assert.equal(fake.format(SS, "Sheet 1", "A2").textFormat.bold, true);
      assert.deepEqual(fake.cell(SS, "Sheet 1", "A1"), { v: "Item" });
    });

    it("sheets_delete_tab deletes a tab by name and refuses a spreadsheet's only tab", async () => {
      const out = await call("sheets_delete_tab", { spreadsheetId: SS, tab: "It's Q1" });
      assert.deepEqual(out.structured.deleted, { title: "It's Q1", tabId: 9 });
      assert.deepEqual(fake.state.requests.at(-1).body, { requests: [{ deleteSheet: { sheetId: 9 } }] });
      const solo = await call("sheets_create", { title: "Solo" });
      await assert.rejects(call("sheets_delete_tab", { spreadsheetId: solo.structured.spreadsheetId, tab: "Sheet1" }), /only tab/);
    });

    it("surfaces API errors (an unknown spreadsheet) and refuses bad ids before any request", async () => {
      await assert.rejects(call("sheets_list_tabs", { spreadsheetId: "1MissingSpreadsheetXXXXXXXXXXXXXXXXXXXXXXXX" }), /404: Requested entity was not found/);
      const before = fake.state.requests.length;
      await assert.rejects(call("sheets_read", { spreadsheetId: "a/b?c", range: "A1" }), /isn't a Google spreadsheet id/);
      await assert.rejects(call("sheets_read", { spreadsheetId: SS, range: "Sheet1!A0" }), /Row 0/);
      assert.equal(fake.state.requests.length, before);
    });

    it("only ever calls the Sheets API host", async () => {
      await call("sheets_list_tabs", { spreadsheetId: SS });
      await call("sheets_read", { spreadsheetId: SS, range: "'Sheet 1'!A1:B2" });
      await call("sheets_write", { spreadsheetId: SS, range: "'Sheet 1'!A9", values: [["x"]] });
      assert.deepEqual([...new Set(fake.state.requests.map((r) => r.host))], ["sheets.googleapis.com"]);
      assert.ok(paths().every((p) => p.includes(`/v4/spreadsheets/${SS}`)));
    });
  });

  describe("declared risk", () => {
    it("reads are read, creates and edits write, clearing and deleting risky", () => {
      assert.deepEqual(Object.fromEntries(sheetsTools.map((t) => [t.name, t.risk])), {
        sheets_list_tabs: "read",
        sheets_read: "read",
        sheets_write: "write",
        sheets_append_rows: "write",
        sheets_create: "write",
        sheets_add_tab: "write",
        sheets_format: "write",
        sheets_clear: "risky",
        sheets_delete_tab: "risky",
      });
    });
    it("every tool on an existing spreadsheet targets /spreadsheetId, which its input declares", () => {
      for (const t of sheetsTools) {
        if (t.name === "sheets_create") assert.equal(t.target, undefined);
        else {
          assert.equal(t.target, "/spreadsheetId", t.name);
          assert.ok("spreadsheetId" in t.input, t.name);
        }
        assert.match(t.name, /^[a-z0-9_]{1,64}$/);
        assert.ok(t.title && t.description, t.name);
      }
    });
  });
}
