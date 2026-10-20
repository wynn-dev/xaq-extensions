// A small model of a Google Doc's body for the fake Docs API (fake-google.mjs), following the Docs API reference
// (developers.google.com/workspace/docs/api): indexes in UTF-16 code units; a section break at 0; a paragraph is its
// text plus a newline; a table is 1 index, each row 1, each cell 1 plus its paragraphs; insertTable puts a newline
// before the table (table start = location + 1); a new paragraph copies the style and bullet of the paragraph it was
// split from; createParagraphBullets takes the nesting level from leading tabs and removes them; text can only be
// inserted inside a paragraph; the body's last newline can't be deleted. Only what the extension's requests use is
// modelled; anything else is refused with a 400, as Docs refuses an invalid request.

const clone = (v) => structuredClone(v);
// Docs counts UTF-16 code units, like JS string indexes.
const units = (text) => Array.from({ length: text.length }, (_, i) => text[i]);

export class BadRequest extends Error {}

export function paragraph(text = "", style = "NORMAL_TEXT", bullet = null, charStyle = {}) {
  return { chars: units(text).map((c) => ({ c, s: { ...charStyle } })), style, bullet, indent: null };
}

/** A body from a fixture spec: [{ p, style?, bullet?: { level, ordered }, bold?: [[from, to]], link?: [[from, to, url]] } | { table: string[][] }]. */
export function bodyFromSpec(spec) {
  return spec.map((e) => {
    if (e.table) return { table: e.table.map((row, r) => row.map((cell) => [paragraph(cell, "NORMAL_TEXT", null, r === 0 ? { bold: true } : {})])) };
    const p = paragraph(e.p ?? "", e.style ?? "NORMAL_TEXT", e.bullet ?? null);
    for (const [from, to] of e.bold ?? []) for (let i = from; i < to; i++) p.chars[i].s.bold = true;
    for (const [from, to] of e.italic ?? []) for (let i = from; i < to; i++) p.chars[i].s.italic = true;
    for (const [from, to, url] of e.link ?? []) for (let i = from; i < to; i++) p.chars[i].s.link = url;
    return p;
  });
}

const textOf = (p) => p.chars.map((x) => x.c).join("");
const plen = (p) => p.chars.length + 1;
const tlen = (t) => 1 + t.table.reduce((n, row) => n + 1 + row.reduce((m, cell) => m + 1 + cell.reduce((k, q) => k + plen(q), 0), 0), 0);
const elen = (e) => (e.table ? tlen(e) : plen(e));

export class FakeDoc {
  constructor(id, title, body) {
    this.id = id;
    this.title = title;
    this.body = body.length ? body : [paragraph("")];
    this.revision = 1;
  }

  get revisionId() {
    return `rev-${this.id.slice(0, 6)}-${this.revision}`;
  }

  /** Every paragraph with its absolute start and its container (array + position), cells included. */
  paragraphs() {
    const out = [];
    let at = 1;
    this.body.forEach((e, i) => {
      if (e.table) {
        let k = at + 1;
        for (const row of e.table) {
          k++;
          for (const cell of row) {
            k++;
            cell.forEach((q, j) => {
              out.push({ p: q, start: k, container: cell, pos: j, top: false });
              k += plen(q);
            });
          }
        }
        at += tlen(e);
      } else {
        out.push({ p: e, start: at, container: this.body, pos: i, top: true });
        at += plen(e);
      }
    });
    return out;
  }

  /** The paragraph whose text or newline holds index (insertion before that unit). */
  locate(index) {
    for (const x of this.paragraphs()) if (index >= x.start && index < x.start + plen(x.p)) return x;
    return null;
  }

  end() {
    return 1 + this.body.reduce((n, e) => n + elen(e), 0);
  }

  /** Applies a batchUpdate atomically; returns the replies. */
  apply(requests) {
    const saved = clone(this.body);
    try {
      const replies = requests.map((r, i) => {
        try {
          return this.one(r);
        } catch (err) {
          if (err instanceof BadRequest) throw new BadRequest(`Invalid requests[${i}].${Object.keys(r)[0]}: ${err.message}`);
          throw err;
        }
      });
      this.revision++;
      return replies;
    } catch (err) {
      this.body = saved;
      throw err;
    }
  }

  one(r) {
    const [kind, a] = Object.entries(r)[0];
    switch (kind) {
      case "insertText":
        return this.insertText(a.location?.index, a.text), {};
      case "deleteContentRange":
        return this.deleteRange(a.range.startIndex, a.range.endIndex), {};
      case "updateParagraphStyle":
        return this.paraStyle(a.range, a.paragraphStyle ?? {}, a.fields), {};
      case "updateTextStyle":
        return this.textStyle(a.range, a.textStyle ?? {}, a.fields), {};
      case "createParagraphBullets":
        return this.bullets(a.range, a.bulletPreset), {};
      case "deleteParagraphBullets":
        for (const x of this.overlapping(a.range)) x.p.bullet = null;
        return {};
      case "insertTable":
        return this.insertTable(a.rows, a.columns, a.location?.index), {};
      case "replaceAllText":
        return this.replaceAll(a.containsText, a.replaceText ?? "");
      default:
        throw new BadRequest(`the fake doesn't model ${kind}`);
    }
  }

  overlapping(range) {
    if (!range || !(range.startIndex < range.endIndex)) throw new BadRequest("The range must not be empty.");
    if (range.endIndex > this.end()) throw new BadRequest(`Index ${range.endIndex - 1} must be less than the end index of the referenced segment, ${this.end()}.`);
    return this.paragraphs().filter((x) => x.start < range.endIndex && x.start + plen(x.p) > range.startIndex);
  }

  insertText(index, text) {
    if (typeof index !== "number" || !text) throw new BadRequest("Insert text requests must specify text to insert.");
    const x = this.locate(index);
    if (!x) throw new BadRequest(`Index ${index} must be inside the bounds of an existing paragraph. You can still create new paragraphs by inserting newlines.`);
    const { p, container, pos } = x;
    const o = index - x.start;
    const inherit = { ...(p.chars[o - 1] ?? p.chars[o] ?? { s: {} }).s };
    const pieces = text.split("\n");
    const left = p.chars.slice(0, o);
    const right = p.chars.slice(o);
    const mk = (s) => units(s).map((c) => ({ c, s: { ...inherit } }));
    const made = pieces.map((piece, k) => ({ chars: [...(k === 0 ? left : []), ...mk(piece), ...(k === pieces.length - 1 ? right : [])], style: p.style, bullet: clone(p.bullet), indent: p.indent }));
    container.splice(pos, 1, ...made);
  }

  deleteRange(start, end) {
    if (!(start < end)) throw new BadRequest("The range must not be empty.");
    if (start < 1) throw new BadRequest("The range can't include the section break at index 0.");
    const a = this.locate(start);
    const b = this.locate(end);
    if (!a || !b) throw new BadRequest("Invalid deletion range: it must start and end inside paragraphs.");
    const last = this.paragraphs().filter((x) => x.top).at(-1);
    if (end > last.start + last.p.chars.length) throw new BadRequest("Invalid deletion range. Cannot delete the last newline character of the body.");
    if (a.p === b.p) {
      a.p.chars.splice(start - a.start, end - start);
      return;
    }
    if (!a.top || !b.top) throw new BadRequest("the fake only deletes across top-level paragraphs");
    const merged = { ...b.p, chars: [...a.p.chars.slice(0, start - a.start), ...b.p.chars.slice(end - b.start)] };
    this.body.splice(a.pos, b.pos - a.pos + 1, merged);
  }

  paraStyle(range, style, fields) {
    for (const x of this.overlapping(range)) {
      for (const f of String(fields).split(",")) {
        if (f === "namedStyleType") x.p.style = style.namedStyleType ?? "NORMAL_TEXT";
        else if (f === "indentStart") x.p.indent = style.indentStart?.magnitude ?? null;
      }
    }
  }

  textStyle(range, style, fields) {
    const xs = this.overlapping(range);
    for (const x of xs) {
      x.p.chars.forEach((ch, k) => {
        const at = x.start + k;
        if (at < range.startIndex || at >= range.endIndex) return;
        for (const f of String(fields).split(",")) {
          const key = { bold: "bold", italic: "italic", strikethrough: "strike", link: "link", weightedFontFamily: "font" }[f];
          if (!key) continue;
          const v = f === "link" ? style.link?.url : f === "weightedFontFamily" ? style.weightedFontFamily?.fontFamily : style[f];
          if (v === undefined || v === false) delete ch.s[key];
          else ch.s[key] = v;
        }
      });
    }
  }

  bullets(range, preset) {
    const ordered = String(preset).startsWith("NUMBERED");
    for (const x of this.overlapping(range)) {
      let level = 0;
      while (x.p.chars[0]?.c === "\t") {
        x.p.chars.shift();
        level++;
      }
      x.p.bullet = { level, ordered };
    }
  }

  insertTable(rows, columns, index) {
    if (!(rows >= 1 && columns >= 1)) throw new BadRequest("A table needs at least one row and one column.");
    const x = this.locate(index);
    if (!x) throw new BadRequest(`Index ${index} must be inside the bounds of an existing paragraph.`);
    if (!x.top) throw new BadRequest("the fake doesn't nest tables");
    const o = index - x.start;
    const before = { chars: x.p.chars.slice(0, o), style: x.p.style, bullet: clone(x.p.bullet), indent: x.p.indent };
    const after = { ...x.p, chars: x.p.chars.slice(o) };
    const table = { table: Array.from({ length: rows }, () => Array.from({ length: columns }, () => [paragraph("")])) };
    this.body.splice(x.pos, 1, before, table, after);
  }

  replaceAll(contains, replaceText) {
    const find = contains?.text;
    if (!find) throw new BadRequest("containsText.text must not be empty.");
    let n = 0;
    for (const x of this.paragraphs()) {
      const hay = contains.matchCase ? textOf(x.p) : textOf(x.p).toLowerCase();
      const needle = contains.matchCase ? find : find.toLowerCase();
      const hits = [];
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
      for (const i of hits.reverse()) {
        const s = { ...(x.p.chars[i]?.s ?? {}) };
        x.p.chars.splice(i, needle.length, ...units(replaceText).map((c) => ({ c, s: { ...s } })));
      }
      n += hits.length;
    }
    return n ? { replaceAllText: { occurrencesChanged: n } } : { replaceAllText: {} };
  }

  // ---- rendering ----

  /** The documents.get resource (all fields; the real API trims to `fields`, which the extension doesn't rely on). */
  resource() {
    const renderPara = (p, start) => {
      const runs = [];
      let k = start;
      for (const ch of p.chars) {
        const style = textStyleOf(ch.s);
        const last = runs[runs.length - 1];
        if (last && JSON.stringify(last.textRun.textStyle) === JSON.stringify(style)) {
          last.textRun.content += ch.c;
          last.endIndex++;
        } else runs.push({ startIndex: k, endIndex: k + 1, textRun: { content: ch.c, textStyle: style } });
        k++;
      }
      const last = runs[runs.length - 1];
      if (last) {
        last.textRun.content += "\n";
        last.endIndex++;
      } else runs.push({ startIndex: k, endIndex: k + 1, textRun: { content: "\n", textStyle: {} } });
      const paragraphStyle = { namedStyleType: p.style, direction: "LEFT_TO_RIGHT", ...(p.style.startsWith("HEADING") ? { headingId: `h.${start}` } : {}), ...(p.indent ? { indentStart: { magnitude: p.indent, unit: "PT" }, indentFirstLine: { magnitude: p.indent, unit: "PT" } } : {}) };
      return { startIndex: start, endIndex: start + plen(p), paragraph: { elements: runs, paragraphStyle, ...(p.bullet ? { bullet: { listId: `kix.list${p.bullet.ordered ? "n" : "b"}`, nestingLevel: p.bullet.level || undefined, textStyle: {} } } : {}) } };
    };
    const content = [{ endIndex: 1, sectionBreak: { sectionStyle: { columnSeparatorStyle: "NONE", contentDirection: "LEFT_TO_RIGHT", sectionType: "CONTINUOUS" } } }];
    let at = 1;
    for (const e of this.body) {
      if (e.table) {
        const start = at;
        let k = at + 1;
        const tableRows = e.table.map((row) => {
          const rs = k++;
          const tableCells = row.map((cell) => {
            const cs = k++;
            const cellContent = cell.map((q) => {
              const r = renderPara(q, k);
              k += plen(q);
              return r;
            });
            return { startIndex: cs, endIndex: k, content: cellContent, tableCellStyle: { rowSpan: 1, columnSpan: 1 } };
          });
          return { startIndex: rs, endIndex: k, tableCells, tableRowStyle: { minRowHeight: { unit: "PT" } } };
        });
        content.push({ startIndex: start, endIndex: k, table: { rows: e.table.length, columns: e.table[0].length, tableRows, tableStyle: {} } });
        at = k;
      } else {
        content.push(renderPara(e, at));
        at += plen(e);
      }
    }
    return {
      documentId: this.id,
      title: this.title,
      revisionId: this.revisionId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      body: { content },
      documentStyle: { pageSize: { height: { magnitude: 792, unit: "PT" }, width: { magnitude: 612, unit: "PT" } } },
      namedStyles: { styles: [] },
    };
  }

  /** Markdown the way Drive's text/markdown export writes it (close enough for tests: headings, lists, emphasis, links, tables). */
  markdown() {
    const inline = (p) => {
      let out = "";
      let i = 0;
      while (i < p.chars.length) {
        const s = p.chars[i].s;
        let j = i;
        while (j < p.chars.length && JSON.stringify(p.chars[j].s) === JSON.stringify(s)) j++;
        let t = p.chars
          .slice(i, j)
          .map((x) => x.c)
          .join("")
          .replace(/\u000b/g, "  \n");
        if (s.font) t = `\`${t}\``;
        if (s.bold) t = `**${t}**`;
        if (s.italic) t = `*${t}*`;
        if (s.strike) t = `~~${t}~~`;
        if (s.link) t = `[${t}](${s.link})`;
        out += t;
        i = j;
      }
      return out;
    };
    const lines = [];
    let inList = false;
    for (const e of this.body) {
      if (inList && !e.bullet) lines.push("");
      inList = !!e.bullet && !e.table;
      if (e.table) {
        const rows = e.table.map((row) => `| ${row.map((cell) => cell.map(inline).join(" ").replace(/\*\*(.*?)\*\*/g, "$1")).join(" | ")} |`);
        lines.push(rows[0], `| ${e.table[0].map(() => ":---").join(" | ")} |`, ...rows.slice(1), "");
        continue;
      }
      const text = inline(e);
      if (e.bullet) {
        lines.push(`${"  ".repeat(e.bullet.level)}${e.bullet.ordered ? "1." : "*"} ${text}`);
        continue;
      }
      if (!text) continue;
      const h = /^HEADING_(\d)$/.exec(e.style);
      if (h) lines.push(`${"#".repeat(Number(h[1]))} ${text}`, "");
      else if (e.style === "TITLE") lines.push(`# ${text}`, "");
      else if (e.indent) lines.push(`> ${text}`, "");
      else lines.push(text, "");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  plainText() {
    return this.body.map((e) => (e.table ? e.table.map((row) => row.map((cell) => cell.map(textOf).join(" ")).join("\t")).join("\n") : textOf(e))).join("\n") + "\n";
  }

  /** A compact view for assertions: [{ style, text, bullet?, indent?, spans? }] and tables as string[][]. */
  outline() {
    return this.body.map((e) => {
      if (e.table) return { table: e.table.map((row) => row.map((cell) => cell.map(textOf).join("\n"))) };
      const o = { style: e.style, text: textOf(e) };
      if (e.bullet) o.bullet = e.bullet;
      if (e.indent) o.indent = e.indent;
      const marks = [];
      e.chars.forEach((ch, i) => {
        const key = JSON.stringify(ch.s);
        const last = marks[marks.length - 1];
        if (key === "{}") return;
        if (last && last.key === key && last.end === i) last.end++;
        else marks.push({ key, start: i, end: i + 1 });
      });
      if (marks.length) o.marks = marks.map((m) => ({ text: textOf(e).slice(m.start, m.end), ...JSON.parse(m.key) }));
      return o;
    });
  }
}

function textStyleOf(s) {
  const t = {};
  if (s.bold) t.bold = true;
  if (s.italic) t.italic = true;
  if (s.strike) t.strikethrough = true;
  if (s.link) t.link = { url: s.link };
  if (s.font) t.weightedFontFamily = { fontFamily: s.font, weight: 400 };
  return t;
}

/** A doc from uploaded markdown, roughly as Drive's import makes one (headings, bullets, paragraphs). */
export function bodyFromMarkdown(md) {
  const body = [];
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (h) body.push(paragraph(h[2], `HEADING_${h[1].length}`));
    else if (b) body.push(paragraph(b[2], "NORMAL_TEXT", { level: Math.floor(b[1].length / 2), ordered: false }));
    else body.push(paragraph(line));
  }
  return body;
}
