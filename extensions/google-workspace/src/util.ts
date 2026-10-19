// Small helpers shared by every tool module: file ids (an id or a Google URL that contains one), text paging, CSV,
// dates and Drive's MIME types.

import { InputError } from "./tool.ts";

export const MIME = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
  shortcut: "application/vnd.google-apps.shortcut",
  drawing: "application/vnd.google-apps.drawing",
  form: "application/vnd.google-apps.form",
  pdf: "application/pdf",
} as const;

const TYPE_NAMES: Record<string, string> = {
  [MIME.doc]: "doc",
  [MIME.sheet]: "sheet",
  [MIME.slides]: "slides",
  [MIME.folder]: "folder",
  [MIME.shortcut]: "shortcut",
  [MIME.drawing]: "drawing",
  [MIME.form]: "form",
  [MIME.pdf]: "pdf",
};

/** A short type name for a MIME type: doc, sheet, slides, folder, pdf, … or "file". */
export function typeName(mimeType: string | undefined): string {
  if (!mimeType) return "file";
  if (TYPE_NAMES[mimeType]) return TYPE_NAMES[mimeType];
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("application/vnd.google-apps.")) return mimeType.slice("application/vnd.google-apps.".length);
  return "file";
}

const ID = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * A Drive file id from what the agent passed: the id itself, or a Google link that contains it
 * (docs.google.com/document/d/<id>/…, drive.google.com/file/d/<id>, …/folders/<id>, ?id=<id>). The link is only
 * parsed, never fetched. `allowRoot` accepts "root" (My Drive) for folders.
 */
export function fileId(input: string, what = "file id", allowRoot = false): string {
  const s = input.trim();
  if (allowRoot && s === "root") return s;
  if (ID.test(s)) return s;
  let u: URL | null = null;
  try {
    u = new URL(s);
  } catch {
    u = null;
  }
  if (u && u.protocol === "https:" && /(^|\.)google\.com$/.test(u.hostname)) {
    const m = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,200})(?:[/?#]|$)/.exec(u.pathname);
    const id = m?.[1] ?? u.searchParams.get("id") ?? "";
    if (ID.test(id)) return id;
  }
  throw new InputError(`"${s.slice(0, 80)}" isn't a Google ${what}. Pass the id (the long code in the file's link) or the link itself.`);
}

/** RFC 3339 UTC from a date (YYYY-MM-DD, taken as UTC midnight) or a date-time. */
export function rfc3339(value: string, field: string): string {
  const s = value.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  if (Number.isNaN(t)) throw new InputError(`${field} must be a date like 2026-10-01 or a date-time like 2026-10-01T09:00:00Z.`);
  return new Date(t).toISOString();
}

export interface Page {
  text: string;
  offset: number;
  /** Where the next page starts, or null at the end. */
  nextOffset: number | null;
  total: number;
}

/**
 * One page of a long text: up to maxChars from offset, cut at the last line break in the page's final fifth when
 * there is one (so a page rarely ends mid-line), and never inside a UTF-16 surrogate pair.
 */
export function pageText(text: string, offset: number, maxChars: number): Page {
  const total = text.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(total, start + maxChars);
  if (end < total) {
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl >= start + Math.floor(maxChars * 0.8)) end = nl + 1;
    else if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  }
  return { text: text.slice(start, end), offset: start, nextOffset: end < total ? end : null, total };
}

/** RFC 4180 CSV of rows of cells. */
export function toCsv(rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

/** Bytes in plain words. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A Drive search string literal: single quotes and backslashes escaped. */
export function qString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
