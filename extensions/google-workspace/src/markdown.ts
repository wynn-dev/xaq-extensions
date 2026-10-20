// Markdown in and out of Google Docs.
// - In (docs_append, docs_insert, docs_overwrite): parseMarkdown turns CommonMark-ish text into blocks (headings,
//   paragraphs, bullet and numbered lists with nesting, block quotes, fenced code, tables) with inline bold, italic,
//   strikethrough, code and links; docs-write.ts turns the blocks into Docs API batchUpdate requests. docs_create
//   doesn't use this: Drive converts uploaded markdown itself.
// - Out (docs_read, drive_export): Drive exports Docs as text/markdown; stripDataImages drops the base64 images the
//   export embeds, which would otherwise flood the agent's context.

export interface Span {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

export interface Inline {
  text: string;
  spans: Span[];
}

export type ParaStyle = "NORMAL_TEXT" | "TITLE" | "HEADING_1" | "HEADING_2" | "HEADING_3" | "HEADING_4" | "HEADING_5" | "HEADING_6";

export interface ParaBlock {
  kind: "para";
  style: ParaStyle;
  inline: Inline;
  list?: { ordered: boolean; level: number };
  quote?: boolean;
  code?: boolean;
}

export interface TableBlock {
  kind: "table";
  rows: Inline[][];
}

export type Block = ParaBlock | TableBlock;

const LINK_URL = /^(https?:\/\/|mailto:)[^\s<>"]+$/i;

/** Inline markdown: **bold**, __bold__, *italic*, _italic_, ~~strike~~, `code`, [text](url), <url>, \escapes. */
export function parseInline(src: string): Inline {
  const out: Inline = { text: "", spans: [] };
  walk(src, {}, out);
  return out;
}

type Marks = Omit<Span, "start" | "end">;

function push(out: Inline, text: string, marks: Marks) {
  if (!text) return;
  const start = out.text.length;
  out.text += text;
  if (Object.keys(marks).length) out.spans.push({ start, end: out.text.length, ...marks });
}

function walk(src: string, marks: Marks, out: Inline): void {
  let buf = "";
  const flush = () => {
    push(out, buf, marks);
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close > i) {
        flush();
        let code = src.slice(i + run.length, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        push(out, code, { ...marks, code: true });
        i = close + run.length;
        continue;
      }
    }
    if (c === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        flush();
        // Images can't be uploaded from here; keep the alt text, linked to the image.
        const label = m[1] ? `[image: ${m[1]}]` : "[image]";
        push(out, label, LINK_URL.test(m[2]) ? { ...marks, link: m[2] } : marks);
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        const url = m[2];
        walk(m[1], LINK_URL.test(url) ? { ...marks, link: url } : marks, out);
        i += m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        push(out, m[1].replace(/^mailto:/i, ""), { ...marks, link: m[1] });
        i += m[0].length;
        continue;
      }
    }
    const delim = src.startsWith("**", i) ? "**" : src.startsWith("__", i) ? "__" : src.startsWith("~~", i) ? "~~" : c === "*" || c === "_" ? c : null;
    if (delim) {
      const after = src[i + delim.length] ?? "";
      const before = src[i - 1] ?? " ";
      // An opener is followed by a non-space; `_` doesn't open inside a word (snake_case stays as it is).
      const opens = after !== "" && !/\s/.test(after) && !(delim[0] === "_" && /\w/.test(before));
      const close = opens ? findClose(src, i + delim.length, delim) : -1;
      if (close > i + delim.length) {
        flush();
        const inner = src.slice(i + delim.length, close);
        const next: Marks = delim === "~~" ? { ...marks, strike: true } : delim.length === 2 ? { ...marks, bold: true } : { ...marks, italic: true };
        walk(inner, next, out);
        i = close + delim.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
}

/** The closing delimiter: preceded by a non-space; for `_`, not followed by a word character; skipping code spans. */
function findClose(src: string, from: number, delim: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        i = close + run.length;
        continue;
      }
    }
    if (src.startsWith(delim, i) && !/\s/.test(src[i - 1] ?? " ")) {
      // For single * or _, don't take the first half of a ** / __ pair as the closer.
      if (delim.length === 1 && src[i + 1] === delim) {
        i += 2;
        continue;
      }
      if (delim[0] === "_" && /\w/.test(src[i + delim.length] ?? "")) {
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A table row's cells: split on unescaped pipes, outer pipes optional, `\|` kept as a pipe. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** The indent width of leading whitespace (a tab counts 4). */
const indentOf = (ws: string) => [...ws].reduce((n, ch) => n + (ch === "\t" ? 4 : 1), 0);

/** Joins a paragraph's lines: soft breaks become spaces; a hard break (two trailing spaces or a backslash) a line break. */
function joinLines(lines: string[]): string {
  return lines
    .map((l, i) => {
      const last = i === lines.length - 1;
      if (!last && (/ {2,}$/.test(l) || /\\$/.test(l))) return l.replace(/(\\| {2,})$/, "") + "\u000b";
      return l.trim() + (last ? "" : " ");
    })
    .join("")
    .replace(/ \u000b/g, "\u000b")
    .trim();
}

/** Blocks from markdown. Raw HTML is kept as text; horizontal rules are dropped (the Docs API can't insert one). */
export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", style: "NORMAL_TEXT", inline: parseInline(joinLines(para)) });
    para = [];
  };
  // List nesting: the indent widths of the open levels.
  let listIndents: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      listIndents = [];
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      for (const b of body.length ? body : [""]) blocks.push({ kind: "para", style: "NORMAL_TEXT", inline: { text: b.replace(/\t/g, "    "), spans: b ? [{ start: 0, end: b.replace(/\t/g, "    ").length, code: true }] : [] }, code: true });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      listIndents = [];
      blocks.push({ kind: "para", style: `HEADING_${h[1].length}` as ParaStyle, inline: parseInline((h[2] ?? "").trim()) });
      i++;
      continue;
    }
    // Setext headings: a paragraph line underlined with === or ---.
    if (para.length === 1 && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      blocks.push({ kind: "para", style: line.trim()[0] === "=" ? "HEADING_1" : "HEADING_2", inline: parseInline(para[0].trim()) });
      para = [];
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      listIndents = [];
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushPara();
      listIndents = [];
      const header = splitRow(line);
      const rows: string[][] = [header];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cols = header.length;
      blocks.push({ kind: "table", rows: rows.map((r) => Array.from({ length: cols }, (_, c) => parseInline((r[c] ?? "").replace(/\\\|/g, "|")))) });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushPara();
      listIndents = [];
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      // Each blank-line-separated part of the quote is its own quoted paragraph.
      let part: string[] = [];
      const flushQuote = () => {
        if (part.length) blocks.push({ kind: "para", style: "NORMAL_TEXT", inline: parseInline(joinLines(part)), quote: true });
        part = [];
      };
      for (const b of body) {
        if (!b.trim()) flushQuote();
        else part.push(b);
      }
      flushQuote();
      continue;
    }
    const item = ITEM.exec(line);
    if (item && (para.length === 0 || indentOf(item[1]) > 0 || /^[-*+]|^1[.)]/.test(item[2]))) {
      flushPara();
      const indent = indentOf(item[1]);
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (!listIndents.length || indent > listIndents[listIndents.length - 1]) listIndents.push(indent);
      const level = Math.min(listIndents.length - 1, 8);
      const text: string[] = [item[3]];
      i++;
      // Lazy continuation lines: indented, not a new item or block.
      while (i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && /^[ \t]+/.test(lines[i]) && !FENCE.test(lines[i]) && !QUOTE.test(lines[i])) text.push(lines[i++].trim());
      blocks.push({ kind: "para", style: "NORMAL_TEXT", inline: parseInline(joinLines(text)), list: { ordered: /\d/.test(item[2]), level } });
      continue;
    }
    if (!para.length) listIndents = [];
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/**
 * Drive's markdown export embeds each image as a base64 data URI (`[image1]: <data:image/png;base64,…>`); those are
 * replaced by a short placeholder and counted.
 */
export function stripDataImages(md: string): { text: string; omitted: number } {
  let omitted = 0;
  const removedRefs = new Set<string>();
  let text = md.replace(/^\[([^\]\n]+)\]:\s*<?data:[^\s>]*>?[ \t]*$/gm, (_m, ref: string) => {
    omitted++;
    removedRefs.add(ref.toLowerCase());
    return "";
  });
  text = text.replace(/!\[([^\]\n]*)\]\[([^\]\n]+)\]/g, (m, alt: string, ref: string) => (removedRefs.has(ref.toLowerCase()) ? `[image${alt ? `: ${alt}` : ""}]` : m));
  text = text.replace(/!\[([^\]\n]*)\]\(<?data:[^)\s]*>?\)/g, (_m, alt: string) => {
    omitted++;
    return `[image${alt ? `: ${alt}` : ""}]`;
  });
  return { text: omitted ? text.replace(/\n{3,}$/g, "\n").replace(/\s+$/, "\n") : text, omitted };
}

/** The markdown headings (ATX `#` lines outside fenced code), for docs_read's outline. */
export function headingsOf(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence && !f[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h && h[2]) out.push({ level: h[1].length, text: h[2].replace(/\\(.)/g, "$1").replace(/\*\*|__/g, "").trim() });
  }
  return out;
}
