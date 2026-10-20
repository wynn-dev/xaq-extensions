// Google Sheets tools (Sheets API v4). Every URL is a fixed base plus encodeURIComponent of a validated id or of an
// A1 range this file parsed and re-serialised itself: tool input never reaches a URL as it was given.
//
// API reference: https://developers.google.com/workspace/sheets/api/reference/rest

import { randomInt } from "node:crypto";
import { z } from "zod";
import { type GoogleClient, SHEETS } from "./google.ts";
import { type ExtTool, InputError, type ToolOutput, tool } from "./tool.ts";
import { afterCreate, folderIdInput, folderIdOf, moveIntoFolder } from "./folders.ts";
import { fileId } from "./util.ts";

export const SHEETS_BASE = `${SHEETS}/spreadsheets`;

// The grid limits of a Google spreadsheet: columns run to ZZZ (18,278), and a spreadsheet holds at most 10 million cells.
export const MAX_COLUMN = 18_278;
export const MAX_ROW = 10_000_000;
const MAX_WRITE_CELLS = 50_000;
const MAX_TABLE_CELL_CHARS = 200;

// ---------------------------------------------------------------------------------------------------------------------
// Ids

/** A spreadsheet id, or the id out of its Google link (util.fileId). */
export function spreadsheetIdOf(input: string): string {
  return fileId(input, "spreadsheet id");
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------------------
// A1 notation

/** A parsed A1 range. Rows and columns are 1-based and inclusive; undefined means open (to the edge of the tab). */
export interface A1Range {
  sheet?: string;
  startCol?: number;
  startRow?: number;
  endCol?: number;
  endRow?: number;
}

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_COLUMN) throw new InputError(`Column ${n} is out of range (1–${MAX_COLUMN}).`);
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,9})$/;
const COL = /^\$?([A-Za-z]{1,3})$/;
const ROW = /^\$?(\d{1,9})$/;

function col(letters: string): number {
  const n = columnNumber(letters);
  if (n > MAX_COLUMN) throw new InputError(`Column ${letters.toUpperCase()} is past the last possible column (ZZZ).`);
  return n;
}

function row(digits: string): number {
  const n = Number(digits);
  if (n < 1 || n > MAX_ROW) throw new InputError(`Row ${digits} is out of range (rows start at 1).`);
  return n;
}

/** The part after `!`, or null when it isn't an A1 reference at all. */
function parseRef(ref: string): Omit<A1Range, "sheet"> | null {
  const parts = ref.split(":");
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const c = CELL.exec(parts[0]);
    if (!c) return null;
    const cc = col(c[1]);
    const rr = row(c[2]);
    return { startCol: cc, startRow: rr, endCol: cc, endRow: rr };
  }
  const [a, b] = parts;
  const ca = CELL.exec(a);
  const cb = CELL.exec(b);
  if (ca && cb) {
    const [c1, c2] = [col(ca[1]), col(cb[1])].sort((x, y) => x - y);
    const [r1, r2] = [row(ca[2]), row(cb[2])].sort((x, y) => x - y);
    return { startCol: c1, startRow: r1, endCol: c2, endRow: r2 };
  }
  const colA = COL.exec(a);
  const colB = COL.exec(b);
  if (ca && colB) {
    // A2:C — columns A to C from row 2 down.
    const [c1, c2] = [col(ca[1]), col(colB[1])].sort((x, y) => x - y);
    return { startCol: c1, startRow: row(ca[2]), endCol: c2 };
  }
  if (colA && colB) {
    const [c1, c2] = [col(colA[1]), col(colB[1])].sort((x, y) => x - y);
    return { startCol: c1, endCol: c2 };
  }
  const rowA = ROW.exec(a);
  const rowB = ROW.exec(b);
  if (rowA && rowB) {
    const [r1, r2] = [row(rowA[1]), row(rowB[1])].sort((x, y) => x - y);
    return { startRow: r1, endRow: r2 };
  }
  return null;
}

function checkTabName(name: string): string {
  if (name.length < 1 || name.length > 100) throw new InputError("A tab name is 1 to 100 characters.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new InputError("A tab name can't contain control characters.");
  return name;
}

/**
 * Parses A1 notation as the Sheets API reads it:
 * - `'Sheet 1'!A1:B2` (a quoted tab name, `''` for a quote inside it), `Sheet1!A1:B2`, `A1:B2` (the first visible tab);
 * - open ranges `A:C` (whole columns), `2:5` (whole rows), `A2:C` (columns A–C from row 2 down);
 * - `'Sheet 1'` or `Sheet1` alone: the whole tab. A bare reference such as `Q1` is a cell; quote it (`'Q1'`) for a
 *   tab of that name.
 * `$` (absolute references) is accepted and dropped. Named ranges and R1C1 notation aren't supported.
 */
export function parseA1(input: string): A1Range {
  const s = input.trim();
  if (!s) throw new InputError("The range is empty. Give A1 notation such as 'Sheet 1'!A1:C10, or a tab name.");
  if (s.length > 300) throw new InputError("The range is too long.");
  if (s.startsWith("'")) {
    let name = "";
    let i = 1;
    for (; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          name += "'";
          i++;
          continue;
        }
        break;
      }
      name += s[i];
    }
    if (i >= s.length) throw new InputError(`The quoted tab name in ${s} has no closing quote. Write a quote inside a name as two quotes ('').`);
    const rest = s.slice(i + 1);
    const sheet = checkTabName(name);
    if (rest === "" || rest === "!") return { sheet };
    if (!rest.startsWith("!")) throw new InputError(`Expected ! after the quoted tab name in ${s}.`);
    const ref = parseRef(rest.slice(1));
    if (!ref) throw new InputError(`${rest.slice(1)} isn't an A1 range (such as A1, A1:C10, A:C, 2:5 or A2:C).`);
    return { sheet, ...ref };
  }
  const bang = s.lastIndexOf("!");
  if (bang >= 0) {
    const sheet = checkTabName(s.slice(0, bang));
    const tail = s.slice(bang + 1);
    if (tail === "") return { sheet };
    const ref = parseRef(tail);
    if (!ref) throw new InputError(`${tail} isn't an A1 range (such as A1, A1:C10, A:C, 2:5 or A2:C). Quote a tab name that contains ! ('My!Tab'!A1).`);
    return { sheet, ...ref };
  }
  const ref = parseRef(s);
  if (ref) return ref;
  if (/^[$A-Za-z0-9]*:[$A-Za-z0-9:]*$/.test(s)) throw new InputError(`${s} isn't an A1 range (such as A1, A1:C10, A:C, 2:5 or A2:C).`);
  return { sheet: checkTabName(s) };
}

export function isSingleCell(r: A1Range): boolean {
  return r.startCol !== undefined && r.startCol === r.endCol && r.startRow !== undefined && r.startRow === r.endRow;
}

/** Serialises a range for the API. The tab name is always quoted, which the API accepts for any name. */
export function formatA1(r: A1Range): string {
  const sheet = r.sheet === undefined ? "" : `'${r.sheet.replace(/'/g, "''")}'`;
  let ref = "";
  if (r.startCol !== undefined) {
    const c1 = columnLetters(r.startCol);
    const c2 = columnLetters(r.endCol ?? r.startCol);
    if (isSingleCell(r)) ref = `${c1}${r.startRow}`;
    else if (r.startRow !== undefined && r.endRow !== undefined) ref = `${c1}${r.startRow}:${c2}${r.endRow}`;
    else if (r.startRow !== undefined) ref = `${c1}${r.startRow}:${c2}`;
    else ref = `${c1}:${c2}`;
  } else if (r.startRow !== undefined) {
    ref = `${r.startRow}:${r.endRow ?? r.startRow}`;
  }
  if (!sheet && !ref) throw new InputError("The range names neither a tab nor cells.");
  if (!ref) return sheet;
  return sheet ? `${sheet}!${ref}` : ref;
}

/** A GridRange (0-based, end-exclusive) for batchUpdate requests. Open ends are left out, as the API expects. */
export function gridRange(r: A1Range, sheetId: number): Record<string, number> {
  const g: Record<string, number> = { sheetId };
  if (r.startRow !== undefined) g.startRowIndex = r.startRow - 1;
  if (r.endRow !== undefined) g.endRowIndex = r.endRow;
  if (r.startCol !== undefined) g.startColumnIndex = r.startCol - 1;
  if (r.endCol !== undefined) g.endColumnIndex = r.endCol;
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tabs

interface SheetProperties {
  sheetId: number;
  title: string;
  index?: number;
  sheetType?: string;
  hidden?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number; frozenColumnCount?: number };
}

interface SpreadsheetMeta {
  spreadsheetId: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: { properties: SheetProperties }[];
}

async function getMeta(g: GoogleClient, id: string): Promise<{ id: string; title: string; url: string; tabs: SheetProperties[] }> {
  const meta = await g.json<SpreadsheetMeta>("GET", `${SHEETS_BASE}/${enc(id)}`, {
    query: { fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties" },
  });
  const tabs = (meta.sheets ?? []).map((s) => s.properties).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { id, title: meta.properties?.title ?? "", url: meta.spreadsheetUrl ?? spreadsheetUrl(id), tabs };
}

function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${enc(id)}/edit`;
}

/** The tab a range names, or the API's default (the first visible tab). Names match exactly, then ignoring case. */
export function pickTab(tabs: SheetProperties[], name: string | undefined): SheetProperties {
  if (tabs.length === 0) throw new InputError("The spreadsheet has no tabs.");
  if (name === undefined) return tabs.find((t) => !t.hidden) ?? tabs[0];
  const exact = tabs.find((t) => t.title === name);
  if (exact) return exact;
  const folded = tabs.filter((t) => t.title.toLowerCase() === name.toLowerCase());
  if (folded.length === 1) return folded[0];
  throw new InputError(`There's no tab named "${name}". The tabs are: ${tabs.map((t) => `"${t.title}"`).join(", ")}.`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
  if (s.length > MAX_TABLE_CELL_CHARS) s = `${s.slice(0, MAX_TABLE_CELL_CHARS - 1)}…`;
  return s;
}

/** A markdown table with the sheet's own column letters and row numbers, so a cell can be addressed from it. */
export function markdownTable(rows: unknown[][], startRow: number, startCol: number): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const letters = Array.from({ length: width }, (_, i) => columnLetters(startCol + i));
  const lines = [`| | ${letters.join(" | ")} |`, `|---|${letters.map(() => "---").join("|")}|`];
  rows.forEach((r, i) => {
    const cells = Array.from({ length: width }, (_, j) => cellText(r[j]));
    lines.push(`| ${startRow + i} | ${cells.join(" | ")} |`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs

const spreadsheetIdInput = z.string().min(1).max(500).describe("The spreadsheet's id (the part after /d/ in its URL) or its docs.google.com URL.");
const rangeInput = z
  .string()
  .min(1)
  .max(300)
  .describe("A1 notation: 'Sheet 1'!A1:C10, Sheet1!A:C, Sheet1!2:5, Sheet1!A2:C (open-ended), or a tab name alone for the whole tab. Without a tab name, the first visible tab.");
const cellValue = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()]);
const valuesInput = z
  .array(z.array(cellValue).max(MAX_COLUMN))
  .min(1)
  .max(10_000)
  .describe("Rows of cell values (strings, numbers, booleans). null leaves a cell unchanged; \"\" clears it.");
const inputMode = z
  .enum(["USER_ENTERED", "RAW"])
  .default("USER_ENTERED")
  .describe("USER_ENTERED (default) parses values as if typed into Sheets: =formulas, numbers, dates. RAW stores them as given, unparsed: strings stay text (an \"=…\" string isn't a formula), numbers and booleans stay numbers and booleans.");
const headerInput = z.array(z.string().max(1000)).min(1).max(1000);

function checkValues(values: unknown[][]): number {
  const cells = values.reduce((n, r) => n + r.length, 0);
  if (cells > MAX_WRITE_CELLS) throw new InputError(`That's ${cells} cells; write at most ${MAX_WRITE_CELLS} per call.`);
  return cells;
}

function headerRow(header: string[]): Record<string, unknown> {
  return { values: header.map((h) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { bold: true } } })) };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function batchUpdate(g: GoogleClient, id: string, requests: unknown[]): Promise<{ replies?: Record<string, any>[] }> {
  return g.json("POST", `${SHEETS_BASE}/${enc(id)}:batchUpdate`, { body: { requests } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Tools

const listTabs = tool({
  name: "sheets_list_tabs",
  title: "List a spreadsheet's tabs",
  description: "Lists a Google Sheets spreadsheet's tabs: title, tab id, position, row and column counts, frozen rows, hidden.",
  input: { spreadsheetId: spreadsheetIdInput },
  risk: "read",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const meta = await getMeta(g, spreadsheetIdOf(args.spreadsheetId));
    const tabs = meta.tabs.map((t) => ({
      title: t.title,
      tabId: t.sheetId,
      position: (t.index ?? 0) + 1,
      type: t.sheetType ?? "GRID",
      rows: t.gridProperties?.rowCount ?? null,
      columns: t.gridProperties?.columnCount ?? null,
      frozenRows: t.gridProperties?.frozenRowCount ?? 0,
      frozenColumns: t.gridProperties?.frozenColumnCount ?? 0,
      hidden: t.hidden === true,
    }));
    const lines = [`**${meta.title || "(untitled)"}** (${plural(tabs.length, "tab")})`, meta.url, ""];
    for (const t of tabs) {
      const extra = [t.hidden ? "hidden" : "", t.frozenRows ? `${plural(t.frozenRows, "frozen row")}` : "", t.type !== "GRID" ? t.type.toLowerCase() : ""].filter(Boolean);
      const size = t.rows === null ? "no grid" : `${t.rows} rows × ${t.columns} columns`;
      lines.push(`${t.position}. "${t.title}" (tab id ${t.tabId}): ${size}${extra.length ? `, ${extra.join(", ")}` : ""}`);
    }
    return { text: lines.join("\n"), structured: { spreadsheetId: meta.id, title: meta.title, url: meta.url, tabs } };
  },
});

const RENDER = { formatted: "FORMATTED_VALUE", unformatted: "UNFORMATTED_VALUE", formula: "FORMULA" } as const;

const read = tool({
  name: "sheets_read",
  title: "Read cells from a spreadsheet",
  description:
    "Reads a range (A1 notation) or a whole tab of a Google Sheets spreadsheet, as a markdown table labelled with the sheet's column letters and row numbers, plus the rows as structured data. At most maxRows rows per call; when there are more, the result says which fromRow to call again with.",
  input: {
    spreadsheetId: spreadsheetIdInput,
    range: rangeInput,
    render: z
      .enum(["formatted", "unformatted", "formula"])
      .default("formatted")
      .describe("formatted (default): values as Sheets shows them. unformatted: raw numbers and booleans. formula: the formulas themselves (=SUM(A1:A3)) instead of their results."),
    maxRows: z.number().int().min(1).max(1000).default(100).describe("Rows per call (1–1000, default 100)."),
    fromRow: z.number().int().min(1).max(MAX_ROW).optional().describe("The sheet row number to start at, for the next page of a big range."),
  },
  risk: "read",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const a1 = parseA1(args.range);
    const meta = await getMeta(g, id);
    const tab = pickTab(meta.tabs, a1.sheet);
    if (tab.sheetType && tab.sheetType !== "GRID") throw new InputError(`"${tab.title}" is a ${tab.sheetType.toLowerCase()} tab, which has no cells.`);
    const rowCount = tab.gridProperties?.rowCount ?? MAX_ROW;
    const colCount = tab.gridProperties?.columnCount ?? MAX_COLUMN;
    if (a1.startCol !== undefined && a1.startCol > colCount) {
      throw new InputError(`Column ${columnLetters(a1.startCol)} is past the last column of "${tab.title}" (${columnLetters(colCount)}).`);
    }
    const maxRows = args.maxRows;
    const firstRow = Math.max(a1.startRow ?? 1, args.fromRow ?? 1);
    const lastRow = Math.min(a1.endRow ?? rowCount, rowCount);
    const startCol = a1.startCol ?? 1;
    const base = { spreadsheetId: id, tab: tab.title, render: args.render, startRow: firstRow, startColumn: columnLetters(startCol) };
    if (firstRow > lastRow) {
      return { text: `No rows: "${tab.title}" has ${rowCount} rows and the range ends at row ${lastRow}.`, structured: { ...base, range: null, rows: [], hasMore: false } };
    }
    const toRow = Math.min(lastRow, firstRow + maxRows - 1);
    const request = formatA1({
      sheet: tab.title,
      startCol: a1.startCol,
      endCol: a1.endCol === undefined ? undefined : Math.min(a1.endCol, colCount),
      startRow: firstRow,
      endRow: toRow,
    });
    const render = RENDER[args.render];
    const res = await g.json<{ range?: string; values?: unknown[][] }>("GET", `${SHEETS_BASE}/${enc(id)}/values/${enc(request)}`, {
      query: { majorDimension: "ROWS", valueRenderOption: render, dateTimeRenderOption: render === "FORMATTED_VALUE" ? undefined : "FORMATTED_STRING" },
    });
    const values = res.values ?? [];
    // More is the rest of the range (clamped to the tab's grid), even when the rows just below the page are empty.
    const hasMore = toRow < lastRow;
    const rows = values.slice(0, maxRows);
    const structured: Record<string, unknown> = { ...base, range: res.range ?? request, rows, lastRow, hasMore };
    if (hasMore) structured.nextFromRow = toRow + 1;
    const more = `The range runs on to row ${lastRow}${rows.length < maxRows ? " (rows below may be empty)" : ""}: call again with fromRow ${toRow + 1}.`;
    if (rows.length === 0) return { text: `${res.range ?? request} is empty.${hasMore ? ` ${more}` : ""}`, structured };
    const parts = [`${res.range ?? request}: rows ${firstRow}–${firstRow + rows.length - 1}`, "", markdownTable(rows, firstRow, startCol)];
    if (hasMore) parts.push("", more);
    return { text: parts.join("\n"), structured };
  },
});

interface UpdateResponse {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

const write = tool({
  name: "sheets_write",
  title: "Write cells in a spreadsheet",
  description:
    "Writes a 2-D array of values into a range of a Google Sheets spreadsheet, overwriting what's there. A single cell (Sheet1!B2) or a tab name is where the values start; a bigger range must fit them. Returns the range actually updated.",
  input: { spreadsheetId: spreadsheetIdInput, range: rangeInput, values: valuesInput, input: inputMode },
  risk: "write",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const a1 = parseA1(args.range);
    checkValues(args.values);
    if (!isSingleCell(a1)) {
      const width = Math.max(...args.values.map((r) => r.length));
      if (a1.startRow !== undefined && a1.endRow !== undefined && args.values.length > a1.endRow - a1.startRow + 1) {
        throw new InputError(`${plural(args.values.length, "row")} of values don't fit in ${formatA1(a1)} (${plural(a1.endRow - a1.startRow + 1, "row")}). Give a bigger range, or just its top-left cell.`);
      }
      if (a1.startCol !== undefined && a1.endCol !== undefined && width > a1.endCol - a1.startCol + 1) {
        throw new InputError(`${plural(width, "column")} of values don't fit in ${formatA1(a1)} (${plural(a1.endCol - a1.startCol + 1, "column")}). Give a bigger range, or just its top-left cell.`);
      }
    }
    const range = formatA1(a1);
    const res = await g.json<UpdateResponse>("PUT", `${SHEETS_BASE}/${enc(id)}/values/${enc(range)}`, {
      query: { valueInputOption: args.input },
      body: { range, majorDimension: "ROWS", values: args.values },
    });
    const cells = res.updatedCells ?? 0;
    return {
      text: `Updated ${res.updatedRange ?? range}: ${plural(cells, "cell")} in ${plural(res.updatedRows ?? 0, "row")} (${args.input}).`,
      structured: { spreadsheetId: id, updatedRange: res.updatedRange ?? null, updatedRows: res.updatedRows ?? 0, updatedColumns: res.updatedColumns ?? 0, updatedCells: cells },
    };
  },
});

const appendRows = tool({
  name: "sheets_append_rows",
  title: "Append rows to a table",
  description:
    "Appends rows below the table in a tab of a Google Sheets spreadsheet (new rows are inserted, so nothing below is overwritten). range is the tab name, or the table's range such as 'Expenses'!A:D. Returns the rows written.",
  input: {
    spreadsheetId: spreadsheetIdInput,
    range: rangeInput.describe("The tab name (appends below its table), or the table's range such as 'Expenses'!A:D."),
    rows: valuesInput.describe("Rows of cell values to add (strings, numbers, booleans; null leaves a cell empty)."),
    input: inputMode,
  },
  risk: "write",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const range = formatA1(parseA1(args.range));
    checkValues(args.rows);
    const res = await g.json<{ tableRange?: string; updates?: UpdateResponse }>("POST", `${SHEETS_BASE}/${enc(id)}/values/${enc(range)}:append`, {
      query: { valueInputOption: args.input, insertDataOption: "INSERT_ROWS" },
      body: { majorDimension: "ROWS", values: args.rows },
    });
    const u = res.updates ?? {};
    return {
      text: `Appended ${plural(u.updatedRows ?? 0, "row")} at ${u.updatedRange ?? "(unknown range)"}${res.tableRange ? `, below the table at ${res.tableRange}` : ""}.`,
      structured: { spreadsheetId: id, tableRange: res.tableRange ?? null, updatedRange: u.updatedRange ?? null, updatedRows: u.updatedRows ?? 0, updatedCells: u.updatedCells ?? 0 },
    };
  },
});

const create = tool({
  name: "sheets_create",
  title: "Create a spreadsheet",
  description: "Creates a Google Sheets spreadsheet in the user's Drive (or in a folder), optionally naming its first tab and giving it a bold, frozen header row. Returns its id and URL.",
  input: {
    title: z.string().min(1).max(500).describe("The spreadsheet's title."),
    tabTitle: z.string().min(1).max(100).optional().describe("The first tab's name (default: Sheets' own, Sheet1)."),
    header: headerInput.optional().describe("Column headings for row 1 of the first tab, in bold."),
    freezeHeader: z.boolean().default(true).describe("Freeze the header row (default true; only with a header)."),
    folderId: folderIdInput,
  },
  risk: "write",
  async run(args, g): Promise<ToolOutput> {
    const folder = folderIdOf(args.folderId);
    const sheet: Record<string, unknown> = {};
    const props: Record<string, unknown> = {};
    if (args.tabTitle !== undefined) props.title = checkTabName(args.tabTitle);
    if (args.header) {
      props.gridProperties = { rowCount: 1000, columnCount: Math.max(26, args.header.length), ...(args.freezeHeader ? { frozenRowCount: 1 } : {}) };
      sheet.data = [{ startRow: 0, startColumn: 0, rowData: [headerRow(args.header)] }];
    }
    if (Object.keys(props).length) sheet.properties = props;
    const body: Record<string, unknown> = { properties: { title: args.title } };
    if (Object.keys(sheet).length) body.sheets = [sheet];
    const res = await g.json<SpreadsheetMeta>("POST", SHEETS_BASE, { body });
    const first = res.sheets?.[0]?.properties;
    const url = res.spreadsheetUrl ?? spreadsheetUrl(res.spreadsheetId);
    if (folder) {
      try {
        await moveIntoFolder(g, res.spreadsheetId, folder);
      } catch (err) {
        throw afterCreate(err, `Created the spreadsheet ${url} (id ${res.spreadsheetId}) in My Drive`, "moving it into the folder failed: ");
      }
    }
    return {
      text: `Created "${res.properties?.title ?? args.title}"${folder ? ` in folder ${folder}` : ""}: ${url}${first ? ` (first tab "${first.title}"${args.header ? `, header ${args.header.length} columns` : ""})` : ""}.`,
      structured: { spreadsheetId: res.spreadsheetId, url, title: res.properties?.title ?? args.title, folderId: folder ?? null, firstTab: first ? { title: first.title, tabId: first.sheetId } : null },
    };
  },
});

const addTab = tool({
  name: "sheets_add_tab",
  title: "Add a tab to a spreadsheet",
  description: "Adds a tab to a Google Sheets spreadsheet, at a position (default: last), optionally with a bold, frozen header row. Returns its tab id.",
  input: {
    spreadsheetId: spreadsheetIdInput,
    title: z.string().min(1).max(100).describe("The new tab's name (unique in the spreadsheet)."),
    position: z.number().int().min(1).max(10_000).optional().describe("1-based position among the tabs (default: last)."),
    rows: z.number().int().min(1).max(MAX_ROW).optional().describe("Row count (default 1000)."),
    columns: z.number().int().min(1).max(MAX_COLUMN).optional().describe("Column count (default 26)."),
    header: headerInput.optional().describe("Column headings for row 1, in bold."),
    freezeHeader: z.boolean().default(true).describe("Freeze the header row (default true; only with a header)."),
  },
  risk: "write",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const props: Record<string, unknown> = { title: checkTabName(args.title) };
    if (args.position !== undefined) props.index = args.position - 1;
    const grid: Record<string, number> = {};
    if (args.rows !== undefined) grid.rowCount = args.rows;
    if (args.columns !== undefined) grid.columnCount = args.columns;
    const requests: unknown[] = [];
    if (args.header) {
      // Our own tab id, so the header goes in with the tab in one atomic batch.
      props.sheetId = randomInt(1, 2 ** 31 - 1);
      if (args.header.length > (args.columns ?? 26)) grid.columnCount = args.header.length;
      if (args.freezeHeader) grid.frozenRowCount = 1;
    }
    if (Object.keys(grid).length) props.gridProperties = grid;
    requests.push({ addSheet: { properties: props } });
    if (args.header) {
      requests.push({
        updateCells: { start: { sheetId: props.sheetId, rowIndex: 0, columnIndex: 0 }, rows: [headerRow(args.header)], fields: "userEnteredValue,userEnteredFormat.textFormat.bold" },
      });
    }
    const res = await batchUpdate(g, id, requests);
    const p = (res.replies?.[0]?.addSheet?.properties ?? {}) as SheetProperties;
    return {
      text: `Added tab "${p.title ?? args.title}" (tab id ${p.sheetId}) at position ${(p.index ?? 0) + 1}.`,
      structured: { spreadsheetId: id, tab: { title: p.title ?? args.title, tabId: p.sheetId ?? null, position: (p.index ?? 0) + 1 } },
    };
  },
});

const NUMBER_FORMATS = ["TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"] as const;

const format = tool({
  name: "sheets_format",
  title: "Format cells in a spreadsheet",
  description:
    "A small set of formatting for a range of a Google Sheets spreadsheet: bold, italic, a number format, column width, and frozen rows or columns (of the range's tab). Give at least one.",
  input: {
    spreadsheetId: spreadsheetIdInput,
    range: rangeInput,
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    numberFormat: z
      .object({
        type: z.enum(NUMBER_FORMATS),
        pattern: z.string().max(200).optional().describe('A Sheets pattern such as "0.00", "#,##0", "yyyy-mm-dd" or "$#,##0.00"; omit for the locale\'s default.'),
      })
      .optional(),
    columnWidth: z.number().int().min(1).max(2000).optional().describe("Width in pixels of the range's columns."),
    freezeRows: z.number().int().min(0).max(1000).optional().describe("Rows to freeze at the top of the tab (0 unfreezes)."),
    freezeColumns: z.number().int().min(0).max(100).optional().describe("Columns to freeze at the left of the tab (0 unfreezes)."),
  },
  risk: "write",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const a1 = parseA1(args.range);
    const wantsCells = args.bold !== undefined || args.italic !== undefined || args.numberFormat !== undefined;
    if (!wantsCells && args.columnWidth === undefined && args.freezeRows === undefined && args.freezeColumns === undefined) {
      throw new InputError("Nothing to format: give bold, italic, numberFormat, columnWidth, freezeRows or freezeColumns.");
    }
    const tab = pickTab((await getMeta(g, id)).tabs, a1.sheet);
    const requests: unknown[] = [];
    const done: string[] = [];
    if (wantsCells) {
      const textFormat: Record<string, boolean> = {};
      const fields: string[] = [];
      if (args.bold !== undefined) {
        textFormat.bold = args.bold;
        fields.push("userEnteredFormat.textFormat.bold");
        done.push(args.bold ? "bold" : "not bold");
      }
      if (args.italic !== undefined) {
        textFormat.italic = args.italic;
        fields.push("userEnteredFormat.textFormat.italic");
        done.push(args.italic ? "italic" : "not italic");
      }
      const userEnteredFormat: Record<string, unknown> = {};
      if (Object.keys(textFormat).length) userEnteredFormat.textFormat = textFormat;
      if (args.numberFormat) {
        userEnteredFormat.numberFormat = args.numberFormat.pattern ? { type: args.numberFormat.type, pattern: args.numberFormat.pattern } : { type: args.numberFormat.type };
        fields.push("userEnteredFormat.numberFormat");
        done.push(`number format ${args.numberFormat.type}${args.numberFormat.pattern ? ` "${args.numberFormat.pattern}"` : ""}`);
      }
      requests.push({ repeatCell: { range: gridRange(a1, tab.sheetId), cell: { userEnteredFormat }, fields: fields.join(",") } });
    }
    if (args.columnWidth !== undefined) {
      const range: Record<string, unknown> = { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: (a1.startCol ?? 1) - 1 };
      if (a1.endCol !== undefined) range.endIndex = a1.endCol;
      requests.push({ updateDimensionProperties: { range, properties: { pixelSize: args.columnWidth }, fields: "pixelSize" } });
      done.push(`column width ${args.columnWidth}px`);
    }
    if (args.freezeRows !== undefined || args.freezeColumns !== undefined) {
      const gp: Record<string, number> = {};
      const fields: string[] = [];
      if (args.freezeRows !== undefined) {
        gp.frozenRowCount = args.freezeRows;
        fields.push("gridProperties.frozenRowCount");
        done.push(`${plural(args.freezeRows, "frozen row")}`);
      }
      if (args.freezeColumns !== undefined) {
        gp.frozenColumnCount = args.freezeColumns;
        fields.push("gridProperties.frozenColumnCount");
        done.push(`${plural(args.freezeColumns, "frozen column")}`);
      }
      requests.push({ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: gp }, fields: fields.join(",") } });
    }
    await batchUpdate(g, id, requests);
    const where = formatA1({ ...a1, sheet: tab.title });
    return { text: `Formatted ${where}: ${done.join(", ")}.`, structured: { spreadsheetId: id, range: where, tabId: tab.sheetId, applied: done } };
  },
});

const clear = tool({
  name: "sheets_clear",
  title: "Clear cells in a spreadsheet",
  description: "Clears the values in a range (or a whole tab) of a Google Sheets spreadsheet. Formatting stays. This can't be undone from here (only through the spreadsheet's version history).",
  input: { spreadsheetId: spreadsheetIdInput, range: rangeInput },
  risk: "risky",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const range = formatA1(parseA1(args.range));
    const res = await g.json<{ clearedRange?: string }>("POST", `${SHEETS_BASE}/${enc(id)}/values/${enc(range)}:clear`, { body: {} });
    return { text: `Cleared ${res.clearedRange ?? range}.`, structured: { spreadsheetId: id, clearedRange: res.clearedRange ?? range } };
  },
});

const deleteTab = tool({
  name: "sheets_delete_tab",
  title: "Delete a tab from a spreadsheet",
  description: "Deletes a tab, and everything on it, from a Google Sheets spreadsheet. A spreadsheet's only tab can't be deleted.",
  input: { spreadsheetId: spreadsheetIdInput, tab: z.string().min(1).max(100).describe("The tab's name.") },
  risk: "risky",
  target: "/spreadsheetId",
  async run(args, g): Promise<ToolOutput> {
    const id = spreadsheetIdOf(args.spreadsheetId);
    const tabs = (await getMeta(g, id)).tabs;
    const tab = pickTab(tabs, args.tab);
    if (tabs.length === 1) throw new InputError(`"${tab.title}" is the spreadsheet's only tab, and a spreadsheet must keep one.`);
    await batchUpdate(g, id, [{ deleteSheet: { sheetId: tab.sheetId } }]);
    return { text: `Deleted tab "${tab.title}" (tab id ${tab.sheetId}).`, structured: { spreadsheetId: id, deleted: { title: tab.title, tabId: tab.sheetId } } };
  },
});

export const sheetsTools = [listTabs, read, write, appendRows, create, addTab, format, clear, deleteTab] as ExtTool[];
