// A fake of the Google Sheets v4 and Slides v1 REST APIs (plus the one Drive v3 call slides_insert_image makes), for
// the google-workspace extension's tests. No live account was used: the request and response shapes follow Google's
// published API reference (developers.google.com/workspace/sheets/api/reference/rest and …/slides/api/reference/rest),
// including proto3 JSON quirks such as zero values being left out. Like the real APIs, batchUpdate is atomic and errors
// come back as { error: { code, message, status } }.
//
// Routing is by path only (/v4/spreadsheets…, /v1/presentations…, /drive/v3/files/…), so the same handler serves the
// real hosts in-process and a single loopback origin when mounted on an http server. It doesn't check credentials:
// whatever mounts it does that.
//
//   const fake = createFakeSheetsSlides();
//   fake.handle(method, url, body)  -> { status, body } | undefined (not a Sheets/Slides/Drive path); in-process, an
//                                      unknown id is a Google-shaped 404
//   fake.claims(method, url)        -> whether it holds what the request names (or it's a create)
//   nodeHandler(fake)               -> async (req, res) => boolean, for mounting on node:http: answers only what it
//                                      claims, so W1's fake keeps serving its own fixture files
//   fakeClient(fake)                -> a GoogleClient-shaped object that calls the fake in-process (unit tests)

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------------------------------------------------
// Shared

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status ?? { 400: "INVALID_ARGUMENT", 404: "NOT_FOUND", 403: "PERMISSION_DENIED" }[code] ?? "UNKNOWN";
  }
}
const bad = (message) => new ApiError(400, message);
const notFound = (message = "Requested entity was not found.") => new ApiError(404, message);
const clone = (v) => structuredClone(v);
const fakeId = () => `1${randomBytes(33).toString("base64url").slice(0, 43)}`;
/** JSON without our internal `_` keys. */
const render = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k.startsWith("_") ? undefined : val)));

// ---------------------------------------------------------------------------------------------------------------------
// Sheets: A1 (an independent, deliberately strict reading of the API's grammar)

const colNum = (s) => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const colStr = (n) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const quoteTab = (t) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !/^[A-Za-z]{1,3}\d+$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

/** -> { sheet?: string, c1?, r1?, c2?, r2? } (1-based inclusive) or throws "Unable to parse range". */
export function fakeParseRange(text) {
  const fail = () => bad(`Unable to parse range: ${text}`);
  let sheet;
  let ref = text;
  const quoted = /^'((?:[^']|'')+)'(?:!(.*))?$/s.exec(text);
  if (quoted) {
    sheet = quoted[1].replace(/''/g, "'");
    ref = quoted[2] ?? "";
  } else if (text.includes("!")) {
    const i = text.lastIndexOf("!");
    sheet = text.slice(0, i);
    ref = text.slice(i + 1);
    if (!/^[A-Za-z0-9_]+$/.test(sheet)) throw fail(); // strict on purpose: the tools always quote tab names
  }
  if (ref === "") return { sheet };
  const m = /^\$?([A-Za-z]{0,3})\$?(\d*)(?::\$?([A-Za-z]{0,3})\$?(\d*))?$/.exec(ref);
  if (!m && sheet === undefined) return { sheet: text }; // an unquoted name alone: the whole tab
  if (!m) throw fail();
  const [, a, b, c, d] = m;
  const r = { sheet };
  if (c === undefined) {
    if (!a || !b) throw fail();
    Object.assign(r, { c1: colNum(a), r1: +b, c2: colNum(a), r2: +b });
  } else {
    if (a) r.c1 = colNum(a);
    if (b) r.r1 = +b;
    if (c) r.c2 = colNum(c);
    if (d) r.r2 = +d;
    if (!a && !c && !(b && d)) throw fail();
    if (Boolean(a) !== Boolean(c)) throw fail();
  }
  if (r.r1 === 0 || r.r2 === 0) throw fail();
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sheets: model

function newSheet(props, index) {
  const gp = props.gridProperties ?? {};
  return {
    properties: {
      sheetId: props.sheetId ?? 0,
      title: props.title ?? `Sheet${index + 1}`,
      index,
      sheetType: "GRID",
      gridProperties: { rowCount: gp.rowCount ?? 1000, columnCount: gp.columnCount ?? 26, ...(gp.frozenRowCount ? { frozenRowCount: gp.frozenRowCount } : {}), ...(gp.frozenColumnCount ? { frozenColumnCount: gp.frozenColumnCount } : {}) },
      ...(props.hidden ? { hidden: true } : {}),
    },
    _cells: {}, // "r,c" (1-based) -> { v, f? }
    _formats: {}, // "r,c" -> userEnteredFormat
    _columnWidths: {}, // c -> px
  };
}

function cellFromUserEntered(uev) {
  if (!uev) return undefined;
  if ("formulaValue" in uev) return { v: "#FAKE", f: uev.formulaValue };
  if ("numberValue" in uev) return { v: uev.numberValue };
  if ("boolValue" in uev) return { v: uev.boolValue };
  if ("stringValue" in uev) return { v: uev.stringValue };
  return undefined;
}

/** A value from a values request, as Sheets stores it. */
function cellFromInput(v, mode) {
  if (typeof v === "number" || typeof v === "boolean") return { v };
  if (mode === "RAW") return { v: String(v) };
  const s = String(v);
  if (s.startsWith("=")) return { v: "#FAKE", f: s };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { v: Number(s) };
  if (/^(true|false)$/i.test(s)) return { v: s.toUpperCase() === "TRUE" };
  return { v: s };
}

function formatted(cell) {
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return String(cell.v);
}

function sheetFor(ss, parsed) {
  if (parsed.sheet === undefined) return ss.sheets.find((s) => !s.properties.hidden) ?? ss.sheets[0];
  const s = ss.sheets.find((x) => x.properties.title.toLowerCase() === parsed.sheet.toLowerCase());
  if (!s) throw bad(`Unable to parse range: ${parsed.raw}`);
  return s;
}

/** The rectangle, with open ends clamped to the grid; bounded ends past the grid are an error, as in the real API. */
function rect(sheet, p, raw) {
  const { rowCount, columnCount } = sheet.properties.gridProperties;
  const r = { c1: p.c1 ?? 1, r1: p.r1 ?? 1, c2: p.c2 ?? columnCount, r2: p.r2 ?? rowCount };
  if (r.c1 > r.c2) [r.c1, r.c2] = [r.c2, r.c1];
  if (r.r1 > r.r2) [r.r1, r.r2] = [r.r2, r.r1];
  if (r.r2 > rowCount || r.c2 > columnCount) throw bad(`Range (${raw}) exceeds grid limits. Max rows: ${rowCount}, max columns: ${columnCount}`);
  return r;
}

const a1Of = (sheet, r) => `${quoteTab(sheet.properties.title)}!${colStr(r.c1)}${r.r1}:${colStr(r.c2)}${r.r2}`;

function lastContentRow(sheet, c1, c2) {
  let last = 0;
  for (const key of Object.keys(sheet._cells)) {
    const [r, c] = key.split(",").map(Number);
    if (c >= c1 && c <= c2 && r > last) last = r;
  }
  return last;
}

function firstContentRow(sheet, c1, c2) {
  let first = Infinity;
  for (const key of Object.keys(sheet._cells)) {
    const [r, c] = key.split(",").map(Number);
    if (c >= c1 && c <= c2 && r < first) first = r;
  }
  return first;
}

function renderSpreadsheet(ss) {
  return render({ spreadsheetId: ss.spreadsheetId, properties: ss.properties, sheets: ss.sheets.map((s) => ({ properties: s.properties })), spreadsheetUrl: ss.spreadsheetUrl });
}

function reindex(ss) {
  ss.sheets.forEach((s, i) => (s.properties.index = i));
}

function sheetById(ss, id, where) {
  const s = ss.sheets.find((x) => x.properties.sheetId === id);
  if (!s) throw bad(`Invalid ${where}: No grid with id: ${id}`);
  return s;
}

function eachCellOf(sheet, gr, fn) {
  const { rowCount, columnCount } = sheet.properties.gridProperties;
  for (let r = (gr.startRowIndex ?? 0) + 1; r <= (gr.endRowIndex ?? rowCount); r++) for (let c = (gr.startColumnIndex ?? 0) + 1; c <= (gr.endColumnIndex ?? columnCount); c++) fn(r, c);
}

function sheetsBatch(ss, requests) {
  if (!Array.isArray(requests) || requests.length === 0) throw bad("Invalid requests: must contain at least one request");
  const work = clone(ss);
  const replies = requests.map((req, i) => {
    const kinds = Object.keys(req);
    if (kinds.length !== 1) throw bad(`Invalid requests[${i}]: exactly one kind of request must be set`);
    const kind = kinds[0];
    const r = req[kind];
    const where = `requests[${i}].${kind}`;
    switch (kind) {
      case "addSheet": {
        const p = r.properties ?? {};
        const title = p.title ?? `Sheet${work.sheets.length + 1}`;
        if (work.sheets.some((s) => s.properties.title.toLowerCase() === title.toLowerCase())) throw bad(`Invalid ${where}: A sheet with the name "${title}" already exists. Please enter another name.`);
        const sheetId = p.sheetId ?? Math.max(0, ...work.sheets.map((s) => s.properties.sheetId)) + 1 + Math.floor(Math.random() * 1000);
        if (work.sheets.some((s) => s.properties.sheetId === sheetId)) throw bad(`Invalid ${where}: Sheet with id ${sheetId} already exists.`);
        const index = p.index ?? work.sheets.length;
        if (index < 0 || index > work.sheets.length) throw bad(`Invalid ${where}: index must be between 0 and ${work.sheets.length}`);
        const sheet = newSheet({ ...p, sheetId, title }, index);
        work.sheets.splice(index, 0, sheet);
        reindex(work);
        return { addSheet: { properties: clone(sheet.properties) } };
      }
      case "deleteSheet": {
        const s = sheetById(work, r.sheetId, where);
        if (work.sheets.length === 1) throw bad(`Invalid ${where}: You can't remove all the sheets in a document.`);
        work.sheets.splice(work.sheets.indexOf(s), 1);
        reindex(work);
        return {};
      }
      case "updateCells": {
        if (!r.fields) throw bad(`Invalid ${where}: At least one field must be updated.`);
        const s = sheetById(work, r.start?.sheetId ?? 0, where);
        const r0 = (r.start?.rowIndex ?? 0) + 1;
        const c0 = (r.start?.columnIndex ?? 0) + 1;
        (r.rows ?? []).forEach((rowData, ri) =>
          (rowData.values ?? []).forEach((cd, ci) => {
            const key = `${r0 + ri},${c0 + ci}`;
            const cell = cellFromUserEntered(cd.userEnteredValue);
            if (cell) s._cells[key] = cell;
            if (cd.userEnteredFormat) s._formats[key] = { ...(s._formats[key] ?? {}), ...clone(cd.userEnteredFormat) };
          }),
        );
        return {};
      }
      case "repeatCell": {
        if (!r.fields) throw bad(`Invalid ${where}: At least one field must be updated.`);
        const s = sheetById(work, r.range?.sheetId ?? 0, where);
        const fmt = r.cell?.userEnteredFormat ?? {};
        eachCellOf(s, r.range ?? {}, (row, col) => {
          const key = `${row},${col}`;
          const cur = (s._formats[key] ??= {});
          for (const f of r.fields.split(",")) {
            const path = f.trim().replace(/^userEnteredFormat\./, "").split(".");
            let src = fmt;
            let dst = cur;
            for (const [j, part] of path.entries()) {
              if (j === path.length - 1) dst[part] = clone(src?.[part]);
              else {
                src = src?.[part];
                dst = dst[part] ??= {};
              }
            }
          }
        });
        return {};
      }
      case "updateDimensionProperties": {
        const s = sheetById(work, r.range?.sheetId ?? 0, where);
        if (r.fields !== "pixelSize") throw bad(`Invalid ${where}: fake supports fields "pixelSize" only`);
        if (r.range.dimension !== "COLUMNS") throw bad(`Invalid ${where}: fake supports COLUMNS only`);
        const end = r.range.endIndex ?? s.properties.gridProperties.columnCount;
        for (let c = (r.range.startIndex ?? 0) + 1; c <= end; c++) s._columnWidths[c] = r.properties.pixelSize;
        return {};
      }
      case "updateSheetProperties": {
        if (!r.fields) throw bad(`Invalid ${where}: At least one field must be updated.`);
        const s = sheetById(work, r.properties?.sheetId, where);
        for (const f of r.fields.split(",")) {
          const m = /^gridProperties\.(frozenRowCount|frozenColumnCount)$/.exec(f.trim());
          if (!m) throw bad(`Invalid ${where}: fake doesn't support field ${f}`);
          const v = r.properties.gridProperties?.[m[1]] ?? 0;
          if (v) s.properties.gridProperties[m[1]] = v;
          else delete s.properties.gridProperties[m[1]];
        }
        return {};
      }
      default:
        throw bad(`Invalid JSON payload received. Unknown name "${kind}" at 'requests[${i}]': Cannot find field.`);
    }
  });
  Object.assign(ss, work);
  return { spreadsheetId: ss.spreadsheetId, replies };
}

function handleSheets(state, method, rest, query, body) {
  if (rest.length === 0) {
    if (method !== "POST") throw new ApiError(405, "Method not allowed");
    const id = fakeId();
    const ss = { spreadsheetId: id, properties: { title: body?.properties?.title ?? "Untitled spreadsheet", locale: "en_US", autoRecalc: "ON_CHANGE", timeZone: "Etc/GMT" }, sheets: [], spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` };
    const specs = body?.sheets?.length ? body.sheets : [{}];
    specs.forEach((spec, i) => {
      const sheet = newSheet({ sheetId: i === 0 ? 0 : 1000 + i, ...(spec.properties ?? {}) }, i);
      for (const gd of spec.data ?? []) {
        (gd.rowData ?? []).forEach((rd, ri) =>
          (rd.values ?? []).forEach((cd, ci) => {
            const key = `${(gd.startRow ?? 0) + ri + 1},${(gd.startColumn ?? 0) + ci + 1}`;
            const cell = cellFromUserEntered(cd.userEnteredValue);
            if (cell) sheet._cells[key] = cell;
            if (cd.userEnteredFormat) sheet._formats[key] = clone(cd.userEnteredFormat);
          }),
        );
      }
      ss.sheets.push(sheet);
    });
    state.spreadsheets.set(id, ss);
    driveEntry(state, id, ss.properties.title, "application/vnd.google-apps.spreadsheet");
    return { status: 200, body: renderSpreadsheet(ss) };
  }
  const [head, ...more] = rest;
  const batch = /^(.+):batchUpdate$/.exec(head);
  const id = decodeURIComponent(batch ? batch[1] : head);
  const ss = state.spreadsheets.get(id);
  if (!ss) throw notFound();
  if (batch) {
    if (method !== "POST") throw new ApiError(405, "Method not allowed");
    return { status: 200, body: sheetsBatch(ss, body?.requests) };
  }
  if (more.length === 0) {
    if (method !== "GET") throw new ApiError(405, "Method not allowed");
    return { status: 200, body: renderSpreadsheet(ss) };
  }
  if (more[0] !== "values" || more.length !== 2) throw notFound();
  // The range is one encoded path segment; a literal ":" (never inside an encoded range) starts the verb.
  const m = /^([^:]+)(?::(append|clear))?$/.exec(more[1]);
  if (!m) throw notFound();
  const raw = decodeURIComponent(m[1]);
  const verb = m[2];
  const parsed = { ...fakeParseRange(raw), raw };
  const sheet = sheetFor(ss, parsed);
  if (!verb && method === "GET") {
    const r = rect(sheet, parsed, raw);
    const opt = query.get("valueRenderOption") ?? "FORMATTED_VALUE";
    if (!["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(opt)) throw bad(`Invalid value at 'value_render_option' (${opt})`);
    const rows = [];
    for (let row = r.r1; row <= r.r2; row++) {
      const vals = [];
      for (let c = r.c1; c <= r.c2; c++) {
        const cell = sheet._cells[`${row},${c}`];
        vals.push(cell === undefined ? "" : opt === "FORMULA" ? (cell.f ?? cell.v) : opt === "UNFORMATTED_VALUE" ? cell.v : formatted(cell));
      }
      while (vals.length && vals[vals.length - 1] === "") vals.pop();
      rows.push(vals);
    }
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    const out = { range: a1Of(sheet, r), majorDimension: "ROWS" };
    if (rows.length) out.values = rows;
    return { status: 200, body: out };
  }
  if (!verb && method === "PUT") {
    const mode = query.get("valueInputOption");
    if (!mode) throw bad("'valueInputOption' is required but not specified");
    if (!["RAW", "USER_ENTERED"].includes(mode)) throw bad(`Invalid value at 'value_input_option' (${mode})`);
    if (body?.range !== undefined && body.range !== raw) throw bad(`Requested range [${raw}] doesn't match the range in the body [${body.range}]`);
    const values = body?.values ?? [];
    const single = parsed.c1 !== undefined && parsed.c1 === parsed.c2 && parsed.r1 === parsed.r2;
    const r1 = parsed.r1 ?? 1;
    const c1 = parsed.c1 ?? 1;
    const width = Math.max(0, ...values.map((v) => v.length));
    const bound = single ? { r2: undefined, c2: undefined } : { r2: parsed.r2, c2: parsed.c2 };
    if (bound.r2 !== undefined && r1 + values.length - 1 > bound.r2) throw bad(`Requested writing within range [${raw}], but tried writing to row [${r1 + values.length - 1}]`);
    if (bound.c2 !== undefined && c1 + width - 1 > bound.c2) throw bad(`Requested writing within range [${raw}], but tried writing to column [${colStr(c1 + width - 1)}]`);
    const { rowCount, columnCount } = sheet.properties.gridProperties;
    if (r1 + values.length - 1 > rowCount || c1 + width - 1 > columnCount) throw bad(`Range (${raw}) exceeds grid limits. Max rows: ${rowCount}, max columns: ${columnCount}`);
    let cells = 0;
    values.forEach((rowVals, i) =>
      rowVals.forEach((v, j) => {
        if (v === null) return;
        const key = `${r1 + i},${c1 + j}`;
        if (v === "") delete sheet._cells[key];
        else sheet._cells[key] = cellFromInput(v, mode);
        cells++;
      }),
    );
    const out = { spreadsheetId: ss.spreadsheetId };
    if (values.length && width) Object.assign(out, { updatedRange: a1Of(sheet, { r1, c1, r2: r1 + values.length - 1, c2: c1 + width - 1 }), updatedRows: values.length, updatedColumns: width, updatedCells: cells });
    return { status: 200, body: out };
  }
  if (verb === "append" && method === "POST") {
    const mode = query.get("valueInputOption");
    if (!mode) throw bad("'valueInputOption' is required but not specified");
    const insert = query.get("insertDataOption") ?? "OVERWRITE";
    const values = body?.values ?? [];
    const { columnCount } = sheet.properties.gridProperties;
    const span = [parsed.c1 ?? 1, parsed.c2 ?? columnCount];
    const last = lastContentRow(sheet, ...span);
    const first = firstContentRow(sheet, ...span);
    let tableC1 = parsed.c1;
    if (tableC1 === undefined) {
      tableC1 = Infinity;
      for (const key of Object.keys(sheet._cells)) tableC1 = Math.min(tableC1, Number(key.split(",")[1]));
      if (tableC1 === Infinity) tableC1 = 1;
    }
    const width = Math.max(1, ...values.map((v) => v.length));
    const start = last + 1;
    const needed = start + values.length - 1;
    if (insert === "INSERT_ROWS" || needed > sheet.properties.gridProperties.rowCount) sheet.properties.gridProperties.rowCount = Math.max(sheet.properties.gridProperties.rowCount + (insert === "INSERT_ROWS" ? values.length : 0), needed);
    let cells = 0;
    values.forEach((rowVals, i) =>
      rowVals.forEach((v, j) => {
        if (v === null) return;
        sheet._cells[`${start + i},${tableC1 + j}`] = cellFromInput(v, mode);
        cells++;
      }),
    );
    const out = { spreadsheetId: ss.spreadsheetId, updates: { spreadsheetId: ss.spreadsheetId, updatedRange: a1Of(sheet, { r1: start, c1: tableC1, r2: needed, c2: tableC1 + width - 1 }), updatedRows: values.length, updatedColumns: width, updatedCells: cells } };
    if (last > 0) out.tableRange = a1Of(sheet, { r1: first, c1: tableC1, r2: last, c2: tableC1 + width - 1 });
    return { status: 200, body: out };
  }
  if (verb === "clear" && method === "POST") {
    const r = rect(sheet, parsed, raw);
    for (const key of Object.keys(sheet._cells)) {
      const [row, c] = key.split(",").map(Number);
      if (row >= r.r1 && row <= r.r2 && c >= r.c1 && c <= r.c2) delete sheet._cells[key];
    }
    return { status: 200, body: { spreadsheetId: ss.spreadsheetId, clearedRange: a1Of(sheet, r) } };
  }
  throw new ApiError(405, "Method not allowed");
}

// ---------------------------------------------------------------------------------------------------------------------
// Slides: model

const LAYOUTS = {
  TITLE: ["CENTERED_TITLE", "SUBTITLE"],
  TITLE_AND_BODY: ["TITLE", "BODY"],
  TITLE_ONLY: ["TITLE"],
  SECTION_HEADER: ["TITLE"],
  BLANK: [],
};
const NEW_ID = /^[A-Za-z0-9_][A-Za-z0-9_\-:]{4,49}$/;
const EMU = (pt) => pt * 12700;

/** Text as Google returns it: ParagraphMarker + TextRun elements, startIndex left out when 0 (proto3). */
function textContent(plain, bullets) {
  if (!plain) return undefined;
  const paras = plain.split("\n");
  if (paras[paras.length - 1] === "") paras.pop();
  const els = [];
  const lists = {};
  let at = 0;
  paras.forEach((p, i) => {
    const content = `${p}\n`;
    const end = at + content.length;
    const marker = { style: { direction: "LEFT_TO_RIGHT", alignment: "START" } };
    const b = bullets[i];
    if (b) {
      marker.bullet = { listId: b.listId, glyph: "●", bulletStyle: {} };
      if (b.level) marker.bullet.nestingLevel = b.level;
      lists[b.listId] = { listId: b.listId, nestingLevel: { 0: { bulletStyle: {} } } };
    }
    els.push({ ...(at ? { startIndex: at } : {}), endIndex: end, paragraphMarker: marker });
    els.push({ ...(at ? { startIndex: at } : {}), endIndex: end, textRun: { content, style: {} } });
    at = end;
  });
  const out = { textElements: els };
  if (Object.keys(lists).length) out.lists = lists;
  return out;
}

function shape(objectId, placeholder, text = "") {
  return { objectId, size: { width: { magnitude: EMU(600), unit: "EMU" }, height: { magnitude: EMU(80), unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, unit: "EMU" }, shape: { shapeType: "TEXT_BOX", ...(placeholder ? { placeholder } : {}) }, _text: text, _bullets: [] };
}

function notesPage(slideId, speakerId, withShape) {
  return {
    objectId: `${slideId}:notes`,
    pageType: "NOTES",
    pageElements: [{ objectId: `${slideId}:notes:thumb`, shape: { shapeType: "TEXT_BOX", placeholder: { type: "SLIDE_IMAGE", parentObjectId: "notes-master-thumb" } } }, ...(withShape ? [shape(speakerId, { type: "BODY", index: 1 })] : [])],
    notesProperties: { speakerNotesObjectId: speakerId },
  };
}

function newSlide(objectId, layoutName, mappings) {
  const placeholders = LAYOUTS[layoutName];
  const elements = placeholders.map((type, i) => {
    const mapped = mappings.find((m) => m.layoutPlaceholder.type === type && (m.layoutPlaceholder.index ?? 0) === 0);
    return shape(mapped?.objectId ?? `${objectId}_ph${i}_${randomBytes(3).toString("hex")}`, { type, index: 0, parentObjectId: `layout_${layoutName}_${type}` });
  });
  return { objectId, pageType: "SLIDE", pageElements: elements, slideProperties: { layoutObjectId: `layout_${layoutName}`, masterObjectId: "master", notesPage: notesPage(objectId, `${objectId}:speaker`, false) } };
}

function renderElement(el) {
  const out = { ...el };
  if (el.shape) {
    const text = textContent(el._text, el._bullets);
    out.shape = { ...el.shape, ...(text ? { text } : {}) };
  }
  if (el.elementGroup) out.elementGroup = { children: el.elementGroup.children.map(renderElement) };
  if (el.table) {
    out.table = {
      ...el.table,
      tableRows: el.table.tableRows.map((r) => ({ ...r, tableCells: r.tableCells.map((c) => ({ ...c, ...(c._text ? { text: textContent(c._text, []) } : {}) })) })),
    };
  }
  return out;
}

function renderPage(p) {
  const out = { ...p, pageElements: (p.pageElements ?? []).map(renderElement) };
  if (p.slideProperties?.notesPage) out.slideProperties = { ...p.slideProperties, notesPage: renderPage(p.slideProperties.notesPage) };
  return out;
}

function renderPresentation(pr) {
  return render({ ...pr, slides: pr.slides.map(renderPage) });
}

function* walkElements(elements) {
  for (const el of elements ?? []) {
    yield el;
    if (el.elementGroup) yield* walkElements(el.elementGroup.children);
  }
}

function allIds(pr) {
  const ids = new Set();
  for (const s of pr.slides) {
    ids.add(s.objectId);
    for (const el of walkElements(s.pageElements)) ids.add(el.objectId);
    const n = s.slideProperties?.notesPage;
    if (n) {
      ids.add(n.objectId);
      ids.add(n.notesProperties.speakerNotesObjectId);
      for (const el of walkElements(n.pageElements)) ids.add(el.objectId);
    }
  }
  return ids;
}

/** -> { el, list, page, slide } for an element on a slide or notes page, or undefined. */
function findElement(pr, id) {
  for (const s of pr.slides) {
    for (const page of [s, s.slideProperties?.notesPage].filter(Boolean)) {
      const search = (list) => {
        for (const el of list ?? []) {
          if (el.objectId === id) return { el, list };
          if (el.elementGroup) {
            const f = search(el.elementGroup.children);
            if (f) return f;
          }
        }
        return undefined;
      };
      const f = search(page.pageElements);
      if (f) return { ...f, page, slide: s };
    }
  }
  return undefined;
}

function paragraphsOf(text) {
  const p = text.split("\n");
  if (p[p.length - 1] === "") p.pop();
  return p.length;
}

function renameIds(node, map) {
  if (Array.isArray(node)) return node.forEach((n) => renameIds(n, map));
  if (!node || typeof node !== "object") return;
  if (typeof node.objectId === "string") node.objectId = map(node.objectId);
  if (node.notesProperties?.speakerNotesObjectId) node.notesProperties.speakerNotesObjectId = map(node.notesProperties.speakerNotesObjectId);
  for (const [k, v] of Object.entries(node)) if (k !== "objectId" && typeof v === "object") renameIds(v, map);
}

function slidesBatch(state, pr, requests) {
  if (!Array.isArray(requests) || requests.length === 0) throw bad("Invalid requests: must contain at least one request");
  const work = clone(pr);
  const checkNewId = (id, where) => {
    if (id === undefined) return;
    if (!NEW_ID.test(id)) throw bad(`Invalid ${where}: The object ID (${id}) should start with a word character [a-zA-Z0-9_] and then be followed by any number of the following characters [a-zA-Z0-9_-:]. Its length must be between 5 and 50 characters.`);
    if (allIds(work).has(id)) throw bad(`Invalid ${where}: The object ID (${id}) should be unique among all pages and page elements.`);
  };
  const replies = requests.map((req, i) => {
    const kinds = Object.keys(req);
    if (kinds.length !== 1) throw bad(`Invalid requests[${i}]: exactly one kind of request must be set`);
    const kind = kinds[0];
    const r = req[kind];
    const where = `requests[${i}].${kind}`;
    switch (kind) {
      case "createSlide": {
        checkNewId(r.objectId, where);
        const layout = r.slideLayoutReference?.predefinedLayout ?? (r.slideLayoutReference ? undefined : "BLANK");
        if (!layout || !(layout in LAYOUTS) || work._missingLayouts?.includes(layout)) throw bad(`Invalid ${where}: The layout ${layout ?? JSON.stringify(r.slideLayoutReference)} is not present in the current master.`);
        const mappings = r.placeholderIdMappings ?? [];
        if (mappings.length && !r.slideLayoutReference) throw bad(`Invalid ${where}: placeholderIdMappings can only be used with slideLayoutReference.`);
        for (const m of mappings) {
          if (!LAYOUTS[layout].includes(m.layoutPlaceholder?.type) || (m.layoutPlaceholder?.index ?? 0) !== 0) throw bad(`Invalid ${where}: The placeholder (${m.layoutPlaceholder?.type}, ${m.layoutPlaceholder?.index ?? 0}) does not exist on the layout.`);
          checkNewId(m.objectId, where);
        }
        const index = r.insertionIndex ?? work.slides.length;
        if (index < 0 || index > work.slides.length) throw bad(`Invalid ${where}: insertion index ${index} is out of range.`);
        const id = r.objectId ?? `g${randomBytes(6).toString("hex")}_0_0`;
        work.slides.splice(index, 0, newSlide(id, layout, mappings));
        return { createSlide: { objectId: id } };
      }
      case "insertText": {
        if (typeof r.text !== "string" || r.text === "") throw bad(`Invalid ${where}: text must not be empty.`); // a conservative fake: tools shouldn't send empty inserts
        let f = findElement(work, r.objectId);
        if (!f) {
          const slide = work.slides.find((s) => s.slideProperties?.notesPage?.notesProperties.speakerNotesObjectId === r.objectId);
          if (!slide) throw bad(`Invalid ${where}: The object (${r.objectId}) could not be found.`);
          // Inserting into a notes page's speakerNotesObjectId creates the shape (NotesProperties docs).
          slide.slideProperties.notesPage.pageElements.push(shape(r.objectId, { type: "BODY", index: 1 }));
          f = findElement(work, r.objectId);
        }
        if (!f.el.shape) throw bad(`Invalid ${where}: The object (${r.objectId}) does not allow text editing.`);
        const at = r.insertionIndex ?? 0;
        const cur = f.el._text;
        if (at < 0 || at > cur.length) throw bad(`Invalid ${where}: The insertion index must be inside the bounds of an existing paragraph.`);
        f.el._text = cur.slice(0, at) + r.text + cur.slice(at);
        f.el._bullets = f.el._bullets.slice(0, paragraphsOf(f.el._text));
        return {};
      }
      case "createParagraphBullets": {
        const f = findElement(work, r.objectId);
        if (!f?.el.shape) throw bad(`Invalid ${where}: The object (${r.objectId}) could not be found.`);
        if (r.textRange?.type !== "ALL") throw bad(`Invalid ${where}: fake supports textRange type ALL only`);
        const listId = `kix.${randomBytes(4).toString("hex")}`;
        const paras = f.el._text.split("\n");
        const last = paras[paras.length - 1] === "" ? paras.pop() : undefined;
        f.el._bullets = paras.map((p) => ({ listId, level: /^\t*/.exec(p)[0].length, preset: r.bulletPreset ?? "BULLET_DISC_CIRCLE_SQUARE" }));
        f.el._text = paras.map((p) => p.replace(/^\t+/, "")).join("\n") + (last !== undefined ? "\n" : "");
        return {};
      }
      case "deleteObject": {
        const si = work.slides.findIndex((s) => s.objectId === r.objectId);
        if (si >= 0) {
          work.slides.splice(si, 1);
          return {};
        }
        const f = findElement(work, r.objectId);
        if (!f) throw bad(`Invalid ${where}: The object (${r.objectId}) could not be found.`);
        f.list.splice(f.list.indexOf(f.el), 1);
        return {};
      }
      case "duplicateObject": {
        const map = r.objectIds ?? {};
        for (const [k, v] of Object.entries(map)) {
          if (!allIds(work).has(k)) throw bad(`Invalid ${where}: The object (${k}) could not be found.`);
          checkNewId(v, where);
        }
        const si = work.slides.findIndex((s) => s.objectId === r.objectId);
        const renamed = new Map(Object.entries(map));
        const rename = (id) => {
          if (!renamed.has(id)) renamed.set(id, `${id.replace(/:.*$/, "")}_d${randomBytes(3).toString("hex")}`);
          return renamed.get(id);
        };
        if (si >= 0) {
          const copy = clone(work.slides[si]);
          renameIds(copy, rename);
          work.slides.splice(si + 1, 0, copy);
          return { duplicateObject: { objectId: copy.objectId } };
        }
        const f = findElement(work, r.objectId);
        if (!f) throw bad(`Invalid ${where}: The object (${r.objectId}) could not be found.`);
        const copy = clone(f.el);
        renameIds(copy, rename);
        f.list.splice(f.list.indexOf(f.el) + 1, 0, copy);
        return { duplicateObject: { objectId: copy.objectId } };
      }
      case "updateSlidesPosition": {
        const ids = r.slideObjectIds ?? [];
        const at = r.insertionIndex;
        if (!Number.isInteger(at) || at < 0 || at > work.slides.length) throw bad(`Invalid ${where}: insertion index must be between 0 and ${work.slides.length}.`);
        const idx = ids.map((id) => work.slides.findIndex((s) => s.objectId === id));
        if (idx.some((x) => x < 0)) throw bad(`Invalid ${where}: The object could not be found.`);
        if (idx.some((x, k) => k > 0 && x <= idx[k - 1])) throw bad(`Invalid ${where}: slide ids must be in presentation order, without duplicates.`);
        const moving = idx.map((x) => work.slides[x]);
        const shift = idx.filter((x) => x < at).length;
        work.slides = work.slides.filter((s) => !moving.includes(s));
        work.slides.splice(at - shift, 0, ...moving);
        return {};
      }
      case "replaceAllText": {
        const find = r.containsText?.text;
        if (!find) throw bad(`Invalid ${where}: containsText.text must not be empty.`);
        const pages = r.pageObjectIds ?? [];
        for (const p of pages) if (!work.slides.some((s) => s.objectId === p || s.slideProperties?.notesPage?.objectId === p)) throw bad(`Invalid ${where}: The page (${p}) could not be found.`);
        const flags = r.containsText.matchCase ? "g" : "gi";
        const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
        let n = 0;
        const fix = (holder) => {
          const hits = holder._text.match(re);
          if (hits) {
            n += hits.length;
            holder._text = holder._text.replace(re, () => r.replaceText ?? "");
          }
        };
        for (const s of work.slides) {
          for (const page of [s, s.slideProperties?.notesPage]) {
            if (!page || (pages.length && !pages.includes(page.objectId))) continue;
            for (const el of walkElements(page.pageElements)) {
              if (el.shape && el._text) fix(el);
              for (const row of el.table?.tableRows ?? []) for (const c of row.tableCells) if (c._text) fix(c);
            }
          }
        }
        return { replaceAllText: n ? { occurrencesChanged: n } : {} };
      }
      case "createImage": {
        checkNewId(r.objectId, where);
        const url = r.url;
        if (typeof url !== "string" || !url.startsWith("https://") || url.length > 2048) throw bad(`Invalid ${where}: The provided image URL is invalid or not publicly accessible.`);
        // Slides fetches the image without credentials: a Drive link works only for a file shared with "anyone", and a
        // Drive thumbnail link (drive-storage) never does.
        if (state.unfetchableImages.has(url) || !publiclyFetchable(state, url)) throw bad(`Invalid ${where}: There was a problem retrieving the image. The provided image should be publicly accessible, within size limit, and in supported formats.`);
        const ep = r.elementProperties ?? {};
        const slide = work.slides.find((s) => s.objectId === ep.pageObjectId);
        if (!slide) throw bad(`Invalid ${where}: The page (${ep.pageObjectId}) could not be found.`);
        const id = r.objectId ?? `g${randomBytes(6).toString("hex")}_0_1`;
        slide.pageElements.push({ objectId: id, size: ep.size, transform: ep.transform, image: { contentUrl: `https://lh7-rt.googleusercontent.com/slidesz/fake-${id}`, sourceUrl: url, imageProperties: {} } });
        return { createImage: { objectId: id } };
      }
      default:
        throw bad(`Invalid JSON payload received. Unknown name "${kind}" at 'requests[${i}]': Cannot find field.`);
    }
  });
  work.revisionId = randomBytes(8).toString("base64url");
  Object.assign(pr, work);
  return { presentationId: pr.presentationId, replies, writeControl: { requiredRevisionId: pr.revisionId } };
}

/** Whether Google could fetch an image URL without signing in, as far as the fake knows: Drive-hosted ones only when public. */
function publiclyFetchable(state, url) {
  const u = new URL(url);
  if (u.hostname.endsWith("googleusercontent.com") && u.pathname.startsWith("/drive-storage/")) return false;
  if (u.hostname !== "drive.google.com" && u.hostname !== "drive.usercontent.google.com") return true;
  const id = u.searchParams.get("id") ?? /\/d\/([A-Za-z0-9_-]+)/.exec(u.pathname)?.[1];
  const f = id && state.driveFiles.get(id);
  if (!f || !(f._permissions ?? f.permissions ?? []).some((p) => p.type === "anyone")) return false;
  return !f.resourceKey || u.searchParams.get("resourcekey") === f.resourceKey;
}

function newPresentation(title) {
  const id = fakeId();
  const first = { objectId: "p", pageType: "SLIDE", pageElements: [shape("i0", { type: "CENTERED_TITLE", parentObjectId: "layout_TITLE_CENTERED_TITLE" }), shape("i1", { type: "SUBTITLE", parentObjectId: "layout_TITLE_SUBTITLE" })], slideProperties: { layoutObjectId: "layout_TITLE", masterObjectId: "master", notesPage: notesPage("p", "i3", true) } };
  return {
    presentationId: id,
    title,
    locale: "en",
    revisionId: randomBytes(8).toString("base64url"),
    pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
    slides: [first],
    masters: [{ objectId: "master", pageType: "MASTER" }],
    layouts: Object.keys(LAYOUTS).map((name) => ({ objectId: `layout_${name}`, pageType: "LAYOUT", layoutProperties: { masterObjectId: "master", name, displayName: name.replace(/_/g, " ").toLowerCase() } })),
  };
}

function handleSlides(state, method, rest, body) {
  if (rest.length === 0) {
    if (method !== "POST") throw new ApiError(405, "Method not allowed");
    const pr = newPresentation(body?.title ?? "Untitled presentation");
    state.presentations.set(pr.presentationId, pr);
    driveEntry(state, pr.presentationId, pr.title, "application/vnd.google-apps.presentation");
    return { status: 200, body: renderPresentation(pr) };
  }
  if (rest.length !== 1) throw notFound();
  const batch = /^(.+):batchUpdate$/.exec(rest[0]);
  const id = decodeURIComponent(batch ? batch[1] : rest[0]);
  const pr = state.presentations.get(id);
  if (!pr) throw notFound();
  if (batch) {
    if (method !== "POST") throw new ApiError(405, "Method not allowed");
    return { status: 200, body: slidesBatch(state, pr, body?.requests) };
  }
  if (method !== "GET") throw new ApiError(405, "Method not allowed");
  return { status: 200, body: renderPresentation(pr) };
}

/** A file the Sheets or Slides create call made: in My Drive's root, and the app's own (drive.file may change it). */
function driveEntry(state, id, name, mimeType) {
  state.driveFiles.set(id, { kind: "drive#file", id, name, mimeType, parents: ["root"], _appCreated: true });
}

function handleDrive(state, method, rest, query) {
  if (rest.length !== 1) throw notFound();
  const id = decodeURIComponent(rest[0]);
  const f = state.driveFiles.get(id);
  if (!f) throw new ApiError(404, `File not found: ${id}.`);
  if (method === "GET") {
    // Drive gives binary (non-Google-Apps) files a download link; `_noWebContentLink` seeds one without.
    const out = render(f);
    if (!out.webContentLink && !f._noWebContentLink && f.mimeType && !f.mimeType.startsWith("application/vnd.google-apps.")) {
      out.webContentLink = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(f.id)}&export=download`;
    }
    return { status: 200, body: out };
  }
  if (method !== "PATCH") throw new ApiError(405, "Method not allowed");
  // files.update, parents only: drive.file lets the app change files it created, nothing else.
  if (!f._appCreated) throw new ApiError(403, `The user has not granted the app 123456789012 write access to the file ${id}.`);
  const list = (k) => (query.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const add = list("addParents");
  const remove = list("removeParents");
  for (const p of add) if (!state.folders.has(p)) throw new ApiError(404, `File not found: ${p}.`);
  for (const p of remove) if (!f.parents.includes(p)) throw bad(`The parent ${p} is not a parent of the file.`);
  f.parents = [...f.parents.filter((p) => !remove.includes(p)), ...add.filter((p) => !f.parents.includes(p))];
  return { status: 200, body: { id: f.id, parents: [...f.parents] } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points

export function createFakeSheetsSlides() {
  const state = {
    spreadsheets: new Map(),
    presentations: new Map(),
    driveFiles: new Map(),
    /** Drive folders files can be moved into (files.update addParents). */
    folders: new Set(),
    /** Image URLs createImage fails to fetch. */
    unfetchableImages: new Set(),
    /** Every request: { method, host, path (raw), query (object), body }. */
    requests: [],
  };
  return {
    state,
    /** -> { status, body } for a Sheets, Slides or Drive files path; undefined for any other path. */
    handle(method, url, body) {
      const u = typeof url === "string" ? new URL(url) : url;
      const segs = u.pathname.split("/").filter(Boolean);
      let route;
      if (segs[0] === "v4" && segs[1] === "spreadsheets") route = () => handleSheets(state, method, segs.slice(2), u.searchParams, body);
      else if (segs[0] === "v1" && segs[1] === "presentations") route = () => handleSlides(state, method, segs.slice(2), body);
      else if (segs[0] === "drive" && segs[1] === "v3" && segs[2] === "files") route = () => handleDrive(state, method, segs.slice(3), u.searchParams);
      else return undefined;
      state.requests.push({ method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body === undefined ? undefined : clone(body) });
      try {
        return route();
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        return { status: err.code, body: { error: { code: err.code, message: err.message, status: err.status } } };
      }
    },
    /**
     * Whether this fake answers the request: a create, or a spreadsheet, presentation or Drive file it holds. Anything
     * else is left to whoever mounted it (W1's fake serves its own fixture spreadsheets and Drive files).
     */
    claims(method, url) {
      const u = typeof url === "string" ? new URL(url) : url;
      const segs = u.pathname.split("/").filter(Boolean);
      const idOf = (s) => decodeURIComponent(s.replace(/:batchUpdate$/, ""));
      if (segs[0] === "v4" && segs[1] === "spreadsheets") return segs.length === 2 ? method === "POST" : state.spreadsheets.has(idOf(segs[2]));
      if (segs[0] === "v1" && segs[1] === "presentations") return segs.length === 2 ? method === "POST" : state.presentations.has(idOf(segs[2]));
      if (segs[0] === "drive" && segs[1] === "v3" && segs[2] === "files") return (method === "GET" || method === "PATCH") && segs.length === 4 && state.driveFiles.has(decodeURIComponent(segs[3]));
      return false;
    },
    addSpreadsheet: (spec) => seedSpreadsheet(state, spec),
    addPresentation: (pr) => {
      state.presentations.set(pr.presentationId, pr);
      return pr;
    },
    /** Reads a cell straight from the model: { v, f? } or undefined. */
    cell(spreadsheetId, tab, a1) {
      const ss = state.spreadsheets.get(spreadsheetId);
      const sheet = ss.sheets.find((s) => s.properties.title === tab);
      const m = /^([A-Z]+)(\d+)$/.exec(a1);
      return sheet._cells[`${m[2]},${colNum(m[1])}`];
    },
    format(spreadsheetId, tab, a1) {
      const sheet = state.spreadsheets.get(spreadsheetId).sheets.find((s) => s.properties.title === tab);
      const m = /^([A-Z]+)(\d+)$/.exec(a1);
      return sheet._formats[`${m[2]},${colNum(m[1])}`];
    },
    sheet(spreadsheetId, tab) {
      return state.spreadsheets.get(spreadsheetId).sheets.find((s) => s.properties.title === tab);
    },
  };
}

/** Seeds a spreadsheet: { id, title, tabs: [{ title, sheetId?, rows?, columns?, hidden?, cells: [[...]] }] } (cells from A1; "=…" is a formula). */
function seedSpreadsheet(state, spec) {
  const id = spec.id ?? fakeId();
  const ss = { spreadsheetId: id, properties: { title: spec.title, locale: "en_US", autoRecalc: "ON_CHANGE", timeZone: "America/New_York" }, sheets: [], spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  spec.tabs.forEach((t, i) => {
    const sheet = newSheet({ sheetId: t.sheetId ?? i, title: t.title, hidden: t.hidden, gridProperties: { rowCount: t.rows ?? 1000, columnCount: t.columns ?? 26 } }, i);
    (t.cells ?? []).forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === null || v === "") return;
        sheet._cells[`${r + 1},${c + 1}`] = typeof v === "object" ? v : typeof v === "string" && v.startsWith("=") ? { v: t.computed?.[`${r + 1},${c + 1}`] ?? "#FAKE", f: v } : { v };
      }),
    );
    ss.sheets.push(sheet);
  });
  state.spreadsheets.set(id, ss);
  return ss;
}

/**
 * For mounting on node:http, e.g. W1's fake Google through `fake.use(...)`: answers what `claims` accepts and returns
 * true, or returns false without reading the body. `req.url` is the path (and query) without a host prefix; the
 * Google host, when the mounting server knows it, comes in the `x-fake-host` header. No token check here: the
 * mounting server does that first.
 */
export function nodeHandler(fake) {
  return async (req, res) => {
    const host = req.headers["x-fake-host"] ?? "fake.googleapis.com";
    const url = new URL(req.url, `https://${host}`);
    if (!fake.claims(req.method, url)) return false;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=UTF-8" });
      res.end(JSON.stringify({ error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" } }));
      return true;
    }
    const out = fake.handle(req.method, url, body) ?? { status: 404, body: { error: { code: 404, message: "Not Found", status: "NOT_FOUND" } } };
    res.writeHead(out.status, { "content-type": "application/json; charset=UTF-8" });
    res.end(JSON.stringify(out.body));
    return true;
  };
}

const HOSTS = new Set(["sheets.googleapis.com", "slides.googleapis.com", "www.googleapis.com"]);

/**
 * A stand-in for W1's GoogleClient that calls the fake in-process: the same json() signature, https Google hosts only,
 * and a thrown Error (with .status and .apiMessage) for a non-2xx answer. It doesn't do W1's error wording or retries.
 */
export function fakeClient(fake) {
  return {
    calls: 0,
    async json(method, url, opts = {}) {
      this.calls++;
      const u = new URL(url);
      if (u.protocol !== "https:" || !HOSTS.has(u.host)) throw new Error(`fakeClient: refusing ${u.origin}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
      const body = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
      const out = fake.handle(method, u, body);
      if (!out) throw Object.assign(new Error(`Google API 404 for ${u.pathname}`), { status: 404 });
      if (out.status >= 400) throw Object.assign(new Error(`Google API ${out.status}: ${out.body.error.message}`), { status: out.status, apiMessage: out.body.error.message });
      return out.body;
    },
    async bytes() {
      throw new Error("fakeClient: bytes() isn't used by the Sheets and Slides tools");
    },
  };
}
