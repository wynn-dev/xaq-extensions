// Writing markdown blocks into an existing Google Doc with the Docs API (documents.batchUpdate), for docs_append,
// docs_insert and docs_overwrite. The `documents` scope covers every Doc the account can edit (Drive's import would
// need the file to be one the extension created).
//
// How the indexes stay right (Docs indexes are UTF-16 code units, like JS strings):
// - Everything goes into one empty paragraph E: an existing empty paragraph, or one made by inserting "\n" before
//   paragraph X (E takes X's old start) or at the end of paragraph Y (E takes Y's old end).
// - A run of paragraphs is inserted at E's start as "p1\n…\npn" with no final newline, so pn becomes E. Each inserted
//   paragraph then gets its style set explicitly (a new paragraph copies the style and bullets of the paragraph it
//   split), inline styles reset and reapplied, and list runs get bullets last, from the bottom up: bullets take
//   their nesting from leading tabs and remove them, which shifts what follows.
// - A table goes at the end of E's text: Docs inserts a newline before a table, which ends E; the table starts at that
//   index + 1 (documented), and E's old newline becomes the empty paragraph after it, the next E. The document is
//   read back to find the cells, which are filled last cell first so earlier indexes don't move.
// - Every batchUpdate carries the revision it was computed from (writeControl.requiredRevisionId), so an edit made by
//   someone else in between fails instead of landing in the wrong place.

import { DOCS, type GoogleClient } from "./google.ts";
import type { Block, Inline, ParaBlock, TableBlock } from "./markdown.ts";
import { InputError } from "./tool.ts";

export interface DocPara {
  kind: "para";
  start: number;
  end: number;
  text: string;
  style: string;
}
export interface DocTable {
  kind: "table";
  start: number;
  end: number;
}
export interface DocOther {
  kind: "other";
  start: number;
  end: number;
}
export type DocElement = DocPara | DocTable | DocOther;

export interface DocState {
  documentId: string;
  title: string;
  revisionId: string | null;
  elements: DocElement[];
}

interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { paragraphStyle?: { namedStyleType?: string }; elements?: { startIndex?: number; endIndex?: number; textRun?: { content?: string } }[] };
  table?: { rows?: number; columns?: number; tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[] };
  sectionBreak?: unknown;
}
interface DocResource {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: StructuralElement[] };
}

const STRUCTURE_FIELDS = "documentId,title,revisionId,body.content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType),elements(textRun(content))),table(rows,columns),sectionBreak(sectionStyle(sectionType)))";
const TABLE_FIELDS = "revisionId,body.content(startIndex,endIndex,table(rows,columns,tableRows(tableCells(content(startIndex,endIndex)))))";

export const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** The first tab's body as a flat list of top-level paragraphs and tables. */
export async function loadDoc(g: GoogleClient, id: string): Promise<DocState> {
  const doc = await g.json<DocResource>("GET", `${DOCS}/documents/${encodeURIComponent(id)}`, { query: { fields: STRUCTURE_FIELDS } });
  const elements: DocElement[] = [];
  for (const el of doc.body?.content ?? []) {
    const start = el.startIndex ?? 0;
    const end = el.endIndex ?? start;
    if (el.paragraph) {
      const text = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
      elements.push({ kind: "para", start, end, text, style: el.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT" });
    } else if (el.table) elements.push({ kind: "table", start, end });
    else elements.push({ kind: "other", start, end });
  }
  return { documentId: doc.documentId ?? id, title: doc.title ?? "", revisionId: doc.revisionId ?? null, elements };
}

const HEADING_LEVEL: Record<string, number> = { TITLE: 0, HEADING_1: 1, HEADING_2: 2, HEADING_3: 3, HEADING_4: 4, HEADING_5: 5, HEADING_6: 6 };
export const headingLevel = (style: string): number | null => HEADING_LEVEL[style] ?? null;

/** Where E comes from. */
export type Anchor = { mode: "use"; index: number } | { mode: "before"; index: number } | { mode: "after"; endIndex: number };
export type Position = "start" | "end" | "before_heading" | "after_heading" | "end_of_section";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
/** A paragraph with only its newline (or nothing visible) is empty: E can be it. */
const isEmpty = (p: DocPara) => p.end - p.start <= 1;

export function findHeading(doc: DocState, heading: string): DocPara {
  const headings = doc.elements.filter((e): e is DocPara => e.kind === "para" && headingLevel(e.style) !== null && e.text.trim() !== "");
  const want = norm(heading);
  const exact = headings.filter((h) => norm(h.text) === want);
  if (exact.length) return exact[0];
  const partial = headings.filter((h) => norm(h.text).includes(want));
  if (partial.length === 1) return partial[0];
  const list = headings.slice(0, 40).map((h) => `"${h.text.trim()}"`).join(", ");
  if (partial.length > 1) throw new InputError(`"${heading}" matches several headings: ${partial.map((h) => `"${h.text.trim()}"`).join(", ")}. Give the full heading.`);
  throw new InputError(headings.length ? `No heading "${heading}". The document's headings: ${list}.` : `The document has no headings; use position "start" or "end".`);
}

/** Where to put new content, for docs_insert's positions (and "end" for docs_append). */
export function resolveAnchor(doc: DocState, position: Position, heading?: string): Anchor {
  const els = doc.elements.filter((e) => e.kind !== "other" || e.start > 0);
  const atEnd = (): Anchor => {
    const last = doc.elements[doc.elements.length - 1];
    if (!last || last.kind !== "para") throw new InputError("The document's body doesn't end with a paragraph; open it in Google Docs to check it.");
    return isEmpty(last) ? { mode: "use", index: last.start } : { mode: "after", endIndex: last.end };
  };
  if (position === "end") return atEnd();
  if (position === "start") {
    const first = els.find((e) => e.start >= 1);
    if (!first || first.kind !== "para") throw new InputError("The document starts with a table, so nothing can go before it; use a heading position instead.");
    return isEmpty(first) ? { mode: "use", index: first.start } : { mode: "before", index: first.start };
  }
  if (!heading?.trim()) throw new InputError(`position "${position}" needs heading: the text of the heading to insert at.`);
  const h = findHeading(doc, heading);
  if (position === "before_heading") return { mode: "before", index: h.start };
  if (position === "after_heading") return { mode: "after", endIndex: h.end };
  // end_of_section: before the next heading of the same or a higher level, or at the end.
  const level = headingLevel(h.style)!;
  const idx = doc.elements.indexOf(h);
  const next = doc.elements.slice(idx + 1).find((e): e is DocPara => e.kind === "para" && headingLevel(e.style) !== null && headingLevel(e.style)! <= level && e.text.trim() !== "");
  if (!next) return atEnd();
  const prev = doc.elements[doc.elements.indexOf(next) - 1];
  return prev && prev.kind === "para" ? { mode: "after", endIndex: prev.end } : { mode: "before", index: next.start };
}

/** Characters insertText can't carry become spaces (one for one, so span offsets stay right). */
const sanitize = (s: string) => s.replace(/[\u0000-\u0008\u000a\u000c-\u001f\u007f]/g, " ");

const RESET_TEXT_FIELDS = "bold,italic,underline,strikethrough,smallCaps,baselineOffset,link,weightedFontFamily,fontSize,foregroundColor,backgroundColor";
const MONO = { fontFamily: "Roboto Mono" };
const QUOTE_INDENT = { magnitude: 36, unit: "PT" };

type Req = Record<string, unknown>;
const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex });

function spanRequests(inline: Inline, at: number, extra: Record<string, unknown> = {}): Req[] {
  const out: Req[] = [];
  const len = inline.text.length;
  if (len && Object.keys(extra).length) out.push({ updateTextStyle: { range: range(at, at + len), textStyle: extra, fields: Object.keys(extra).join(",") } });
  for (const s of inline.spans) {
    if (s.end <= s.start) continue;
    const style: Record<string, unknown> = {};
    if (s.bold) style.bold = true;
    if (s.italic) style.italic = true;
    if (s.strike) style.strikethrough = true;
    if (s.code) style.weightedFontFamily = MONO;
    if (s.link) style.link = { url: s.link };
    const fields = Object.keys(style);
    if (fields.length) out.push({ updateTextStyle: { range: range(at + s.start, at + s.end), textStyle: style, fields: fields.join(",") } });
  }
  return out;
}

/** Requests that insert a run of paragraphs at E (`base`, empty), the last one becoming E; and where E is after. */
export function chunkRequests(paras: ParaBlock[], base: number): { requests: Req[]; eStart: number; eLen: number } {
  const tabsOf = (p: ParaBlock) => (p.list ? p.list.level : 0);
  const texts = paras.map((p) => "\t".repeat(tabsOf(p)) + sanitize(p.inline.text));
  const text = texts.join("\n");
  const starts: number[] = [];
  let at = base;
  for (const t of texts) {
    starts.push(at);
    at += t.length + 1;
  }
  const reqs: Req[] = [];
  if (text.length) {
    reqs.push({ insertText: { location: { index: base }, text } });
    reqs.push({ updateTextStyle: { range: range(base, base + text.length), textStyle: {}, fields: RESET_TEXT_FIELDS } });
  }
  reqs.push({ deleteParagraphBullets: { range: range(base, base + text.length + 1) } });
  // Paragraph styles, merging neighbours that share one.
  let i = 0;
  while (i < paras.length) {
    let j = i;
    while (j + 1 < paras.length && paras[j + 1].style === paras[i].style && !!paras[j + 1].quote === !!paras[i].quote) j++;
    const paragraphStyle: Record<string, unknown> = { namedStyleType: paras[i].style };
    if (paras[i].quote) Object.assign(paragraphStyle, { indentStart: QUOTE_INDENT, indentFirstLine: QUOTE_INDENT });
    reqs.push({ updateParagraphStyle: { range: range(starts[i], starts[j] + texts[j].length + 1), paragraphStyle, fields: "namedStyleType,indentStart,indentFirstLine" } });
    i = j + 1;
  }
  paras.forEach((p, k) => reqs.push(...spanRequests({ text: sanitize(p.inline.text), spans: p.inline.spans }, starts[k] + tabsOf(p), p.quote ? { italic: true } : {})));
  // Bullets, one request per list run, bottom run first (each removes its tabs).
  const runs: { from: number; to: number; ordered: boolean }[] = [];
  paras.forEach((p, k) => {
    if (!p.list) return;
    const last = runs[runs.length - 1];
    if (last && last.to === k - 1 && !(p.list.level === 0 && p.list.ordered !== last.ordered)) last.to = k;
    else runs.push({ from: k, to: k, ordered: p.list.ordered });
  });
  for (const r of runs.reverse()) {
    reqs.push({ createParagraphBullets: { range: range(starts[r.from], starts[r.to] + texts[r.to].length + 1), bulletPreset: r.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE" } });
  }
  const last = paras.length - 1;
  const tabsBefore = paras.slice(0, last).reduce((n, p) => n + tabsOf(p), 0);
  return { requests: reqs, eStart: starts[last] - tabsBefore, eLen: texts[last].length - tabsOf(paras[last]) };
}

const resetParagraph = (start: number): Req[] => [
  { updateParagraphStyle: { range: range(start, start + 1), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType,indentStart,indentFirstLine" } },
  { deleteParagraphBullets: { range: range(start, start + 1) } },
];

/** Requests that fill a freshly inserted table, read back from the document; and how many characters they add. */
export function cellRequests(table: StructuralElement, rows: Inline[][]): { requests: Req[]; inserted: number } {
  const reqs: Req[] = [];
  let inserted = 0;
  const tableRows = table.table?.tableRows ?? [];
  for (let r = rows.length - 1; r >= 0; r--) {
    for (let c = rows[r].length - 1; c >= 0; c--) {
      const at = tableRows[r]?.tableCells?.[c]?.content?.[0]?.startIndex;
      if (typeof at !== "number") throw new Error(`table cell ${r},${c} not found after inserting the table`);
      const inline = rows[r][c];
      const text = sanitize(inline.text);
      reqs.push({ updateParagraphStyle: { range: range(at, at + text.length + 1), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
      if (!text) continue;
      reqs.push({ insertText: { location: { index: at }, text } });
      reqs.push({ updateTextStyle: { range: range(at, at + text.length), textStyle: {}, fields: RESET_TEXT_FIELDS } });
      reqs.push(...spanRequests({ text, spans: inline.spans }, at, r === 0 ? { bold: true } : {}));
      inserted += text.length;
    }
  }
  return { requests: reqs, inserted };
}

export interface WriteResult {
  paragraphs: number;
  tables: number;
  revisionId: string | null;
}

/** Most table cells one call fills (each is a few requests). */
const MAX_CELLS = 2000;

/**
 * Writes blocks at the anchor. `prefix` requests (docs_overwrite's delete) go first, in the same batchUpdate as the
 * first run of paragraphs, so a refused write changes nothing. With tables there are more batches, each pinned to the
 * revision the previous one produced.
 */
export async function writeBlocks(g: GoogleClient, doc: DocState, anchor: Anchor, blocks: Block[], prefix: Req[] = []): Promise<WriteResult> {
  const cells = blocks.reduce((n, b) => n + (b.kind === "table" ? b.rows.length * (b.rows[0]?.length ?? 0) : 0), 0);
  if (cells > MAX_CELLS) throw new InputError(`That's ${cells} table cells; write at most ${MAX_CELLS} in one call.`);
  const url = `${DOCS}/documents/${encodeURIComponent(doc.documentId)}:batchUpdate`;
  let revision = doc.revisionId;
  let reqs: Req[] = [...prefix];
  let eStart: number;
  let eLen = 0;
  if (anchor.mode === "use") eStart = anchor.index;
  else if (anchor.mode === "before") {
    reqs.push({ insertText: { location: { index: anchor.index }, text: "\n" } });
    eStart = anchor.index;
  } else {
    reqs.push({ insertText: { location: { index: anchor.endIndex - 1 }, text: "\n" } });
    eStart = anchor.endIndex;
  }
  const send = async () => {
    if (!reqs.length) return;
    const res = await g.json<{ writeControl?: { requiredRevisionId?: string } }>("POST", url, { body: { requests: reqs, ...(revision ? { writeControl: { requiredRevisionId: revision } } : {}) } });
    revision = res.writeControl?.requiredRevisionId ?? null;
    reqs = [];
  };
  // Consecutive paragraphs form one run; tables stand alone.
  const segments: (ParaBlock[] | TableBlock)[] = [];
  for (const b of blocks) {
    const last = segments[segments.length - 1];
    if (b.kind === "para" && Array.isArray(last)) last.push(b);
    else segments.push(b.kind === "para" ? [b] : b);
  }
  let paragraphs = 0;
  let tables = 0;
  for (const seg of segments) {
    if (Array.isArray(seg)) {
      const chunk = chunkRequests(seg, eStart);
      reqs.push(...chunk.requests);
      eStart = chunk.eStart;
      eLen = chunk.eLen;
      paragraphs += seg.length;
      continue;
    }
    const rows = seg.rows.length;
    const columns = seg.rows[0]?.length ?? 0;
    if (!rows || !columns) continue;
    const loc = eStart + eLen;
    reqs.push({ insertTable: { rows, columns, location: { index: loc } } });
    // With E empty, the newline Docs adds before the table is an empty paragraph that keeps E's style: reset it.
    if (eLen === 0) reqs.push(...resetParagraph(loc));
    await send();
    const fresh = await g.json<DocResource>("GET", `${DOCS}/documents/${encodeURIComponent(doc.documentId)}`, { query: { fields: TABLE_FIELDS } });
    const table = (fresh.body?.content ?? []).find((e) => e.table && e.startIndex === loc + 1);
    if (!table || typeof table.endIndex !== "number") throw new Error("the inserted table wasn't where Docs said it would be");
    if (fresh.revisionId) revision = fresh.revisionId;
    const fill = cellRequests(table, seg.rows);
    reqs.push(...fill.requests);
    eStart = table.endIndex + fill.inserted;
    eLen = 0;
    tables++;
  }
  // A table at the very end leaves E as the empty paragraph after it, with whatever style it had: make it plain.
  // So does writing nothing at all (docs_overwrite with empty markdown).
  if (!segments.length || !Array.isArray(segments[segments.length - 1])) reqs.push(...resetParagraph(eStart));
  await send();
  return { paragraphs, tables, revisionId: revision };
}
