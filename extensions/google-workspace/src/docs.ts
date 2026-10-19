// Google Docs: read as markdown, create from markdown, append, insert, find-and-replace, overwrite, and comments.
// - Reading uses Drive's export to text/markdown (documented for Docs in Drive's export formats).
// - Creating uploads markdown to Drive with conversion to a Google Doc (Markdown is a documented import format).
// - Editing uses the Docs API (documents.batchUpdate), see docs-write.ts.
// - Comments use the Drive comments API.

import { z } from "zod";
import { DRIVE, DRIVE_UPLOAD, DOCS, type GoogleClient } from "./google.ts";
import { exportText, getFile, person, type DriveUser } from "./drive.ts";
import { type Position, docUrl, loadDoc, resolveAnchor, writeBlocks } from "./docs-write.ts";
import { headingsOf, parseMarkdown, stripDataImages } from "./markdown.ts";
import { InputError, tool } from "./tool.ts";
import { MIME, fileId, multipart, pageText, typeName } from "./util.ts";

const docArg = z.string().min(1).max(2048).describe("The Google Doc: its id, or its link.");
const markdownArg = z.string().max(1_000_000);

/** The doc's Drive metadata, refusing anything that isn't a Google Doc. */
async function requireDoc(g: GoogleClient, id: string) {
  const f = await getFile(g, id, "id,name,mimeType,modifiedTime,webViewLink,shortcutDetails(targetId,targetMimeType)");
  if (f.mimeType !== MIME.doc) {
    const hint = f.shortcutDetails?.targetId ? ` It's a shortcut: use ${f.shortcutDetails.targetId}.` : f.mimeType === MIME.sheet || f.mimeType === MIME.slides ? " Use drive_export for it." : "";
    throw new InputError(`"${f.name}" is a ${typeName(f.mimeType)}, not a Google Doc.${hint}`);
  }
  return f;
}

const writeSummary = (verb: string, title: string, id: string, r: { paragraphs: number; tables: number }) =>
  `${verb} ${r.paragraphs} paragraph${r.paragraphs === 1 ? "" : "s"}${r.tables ? ` and ${r.tables} table${r.tables === 1 ? "" : "s"}` : ""} in "${title}": ${docUrl(id)}`;

function blocksOf(markdown: string, allowEmpty = false) {
  const blocks = parseMarkdown(markdown);
  if (!blocks.length && !allowEmpty) throw new InputError("markdown is empty: there's nothing to write.");
  return blocks;
}

interface Comment {
  id: string;
  content?: string;
  author?: DriveUser;
  createdTime?: string;
  modifiedTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  quotedFileContent?: { value?: string };
  replies?: { id: string; content?: string; author?: DriveUser; createdTime?: string; deleted?: boolean; action?: string }[];
}
const COMMENT_FIELDS = "id,content,author(displayName,emailAddress,me),createdTime,modifiedTime,resolved,deleted,quotedFileContent(value),replies(id,content,author(displayName,emailAddress,me),createdTime,deleted,action)";

export const docsTools = [
  tool({
    name: "docs_read",
    title: "Read a Google Doc",
    description:
      "Read a Google Doc as markdown (headings, lists, tables, links, bold and italic), in pages for long documents. The first page lists the document's headings. Images are left out (shown as [image]).",
    risk: "read",
    target: "/documentId",
    input: {
      documentId: docArg,
      offset: z.number().int().min(0).default(0).describe("The character to start at (nextOffset from the previous page)."),
      maxChars: z.number().int().min(1000).max(100_000).default(20_000).describe("The most characters to return."),
    },
    async run(a, g) {
      const id = fileId(a.documentId, "Doc id");
      const f = await requireDoc(g, id);
      const { text, omitted } = stripDataImages(await exportText(g, id, "text/markdown"));
      const page = pageText(text, a.offset, a.maxChars);
      const headings = page.offset === 0 ? headingsOf(text) : undefined;
      const head = `"${f.name}" (modified ${f.modifiedTime ?? "?"}) ${f.webViewLink ?? docUrl(id)}`;
      const range = page.total > page.text.length ? `\n[Characters ${page.offset}–${page.offset + page.text.length} of ${page.total}.${page.nextOffset !== null ? ` More: call docs_read again with offset ${page.nextOffset}.` : " End of document."}]` : "";
      const outline = headings && page.nextOffset !== null && headings.length ? `\nHeadings: ${headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join(" | ").slice(0, 3000)}` : "";
      return {
        text: `${head}${outline}${range}\n\n${page.text}`,
        structured: {
          documentId: id,
          name: f.name ?? "",
          modifiedTime: f.modifiedTime ?? null,
          webViewLink: f.webViewLink ?? docUrl(id),
          offset: page.offset,
          nextOffset: page.nextOffset,
          totalChars: page.total,
          ...(headings ? { headings } : {}),
          ...(omitted ? { imagesOmitted: omitted } : {}),
        },
      };
    },
  }),

  tool({
    name: "docs_create",
    title: "Create a Google Doc",
    description: "Create a new Google Doc from markdown (headings, lists, tables, links, bold, italic, code), optionally in a folder. Google converts the markdown. Returns the new document's id and link.",
    risk: "write",
    input: {
      title: z.string().min(1).max(500).describe("The document's name."),
      markdown: markdownArg.default("").describe("The content, as markdown. Empty for a blank document."),
      folderId: z.string().min(1).max(2048).optional().describe("Put it in this folder (id or link). Default: the top of My Drive."),
    },
    async run(a, g) {
      const metadata: Record<string, unknown> = { name: a.title, mimeType: MIME.doc };
      if (a.folderId) metadata.parents = [fileId(a.folderId, "folder id", true)];
      const query = { fields: "id,name,mimeType,webViewLink", supportsAllDrives: true };
      let created: { id?: string; name?: string; mimeType?: string; webViewLink?: string };
      if (a.markdown.trim()) {
        const { body, contentType } = multipart(metadata, a.markdown, "text/markdown; charset=UTF-8");
        const res = await g.bytes("POST", `${DRIVE_UPLOAD}/files`, { query: { ...query, uploadType: "multipart" }, body, contentType });
        created = JSON.parse(res.data.toString("utf8"));
      } else {
        created = await g.json("POST", `${DRIVE}/files`, { query, body: metadata });
      }
      if (!created.id) throw new Error("Drive didn't return the new file's id");
      if (created.mimeType && created.mimeType !== MIME.doc) throw new Error(`Drive stored the upload as ${created.mimeType} instead of converting it to a Google Doc`);
      const link = created.webViewLink ?? docUrl(created.id);
      return { text: `Created "${created.name ?? a.title}": ${link} (id ${created.id})`, structured: { documentId: created.id, name: created.name ?? a.title, webViewLink: link } };
    },
  }),

  tool({
    name: "docs_append",
    title: "Append to a Google Doc",
    description: "Add markdown (headings, paragraphs, lists, tables, quotes, code, bold, italic, links) to the end of a Google Doc. Nothing already there changes.",
    risk: "write",
    target: "/documentId",
    input: { documentId: docArg, markdown: markdownArg.min(1).describe("What to add, as markdown.") },
    async run(a, g) {
      const id = fileId(a.documentId, "Doc id");
      const blocks = blocksOf(a.markdown);
      const doc = await loadDoc(g, id);
      const r = await writeBlocks(g, doc, resolveAnchor(doc, "end"), blocks);
      return { text: writeSummary("Appended", doc.title, id, r), structured: { documentId: id, title: doc.title, webViewLink: docUrl(id), ...r } };
    },
  }),

  tool({
    name: "docs_insert",
    title: "Insert into a Google Doc",
    description:
      'Insert markdown into a Google Doc at the start, at the end, or at a heading: just before it ("before_heading"), right under it ("after_heading"), or at the end of its section, before the next heading of the same or a higher level ("end_of_section"). Nothing already there changes.',
    risk: "write",
    target: "/documentId",
    input: {
      documentId: docArg,
      markdown: markdownArg.min(1).describe("What to insert, as markdown."),
      position: z.enum(["start", "end", "before_heading", "after_heading", "end_of_section"]).describe("Where to insert."),
      heading: z.string().min(1).max(500).optional().describe("For the heading positions: the heading's text (case and spacing don't matter; a unique part is enough)."),
    },
    async run(a, g) {
      const id = fileId(a.documentId, "Doc id");
      const blocks = blocksOf(a.markdown);
      const doc = await loadDoc(g, id);
      const anchor = resolveAnchor(doc, a.position as Position, a.heading);
      const r = await writeBlocks(g, doc, anchor, blocks);
      return { text: writeSummary("Inserted", doc.title, id, r), structured: { documentId: id, title: doc.title, webViewLink: docUrl(id), position: a.position, ...r } };
    },
  }),

  tool({
    name: "docs_replace_text",
    title: "Find and replace in a Google Doc",
    description: "Replace every occurrence of some text in a Google Doc (all tabs), keeping its formatting. Returns how many were replaced; 0 means nothing matched and nothing changed.",
    risk: "write",
    target: "/documentId",
    input: {
      documentId: docArg,
      find: z.string().min(1).max(10_000).describe("The exact text to find (one paragraph at most)."),
      replace: z.string().max(10_000).describe("The text to put instead (empty deletes the matches)."),
      matchCase: z.boolean().default(true).describe("Match upper and lower case exactly."),
    },
    async run(a, g) {
      const id = fileId(a.documentId, "Doc id");
      if (a.find.includes("\n")) throw new InputError("find can't span paragraphs (it contains a line break).");
      const res = await g.json<{ replies?: { replaceAllText?: { occurrencesChanged?: number } }[] }>("POST", `${DOCS}/documents/${encodeURIComponent(id)}:batchUpdate`, {
        body: { requests: [{ replaceAllText: { containsText: { text: a.find, matchCase: a.matchCase }, replaceText: a.replace } }] },
      });
      const n = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return {
        text: n ? `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${docUrl(id)}` : `No matches for "${a.find.slice(0, 100)}"; nothing changed.`,
        structured: { documentId: id, occurrencesChanged: n, webViewLink: docUrl(id) },
      };
    },
  }),

  tool({
    name: "docs_overwrite",
    title: "Replace a Google Doc's whole content",
    description:
      "Replace the entire body of a Google Doc (its first tab) with new markdown. Everything in it now is removed (Google keeps it in the version history; comments may lose their place). Headers and footers stay. Prefer docs_insert, docs_append or docs_replace_text for partial changes.",
    risk: "risky",
    target: "/documentId",
    input: { documentId: docArg, markdown: markdownArg.describe("The new content, as markdown. Empty clears the document.") },
    async run(a, g) {
      const id = fileId(a.documentId, "Doc id");
      const blocks = blocksOf(a.markdown, true);
      const doc = await loadDoc(g, id);
      const last = doc.elements[doc.elements.length - 1];
      if (!last) throw new Error("the document has no body");
      const prefix = last.end - 1 > 1 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: last.end - 1 } } }] : [];
      // After the delete only the last paragraph's newline is left, at index 1: the place to write.
      const r = await writeBlocks(g, doc, { mode: "use", index: 1 }, blocks, prefix);
      return { text: writeSummary("Replaced the content with", doc.title, id, r), structured: { documentId: id, title: doc.title, webViewLink: docUrl(id), ...r } };
    },
  }),

  tool({
    name: "docs_comments_list",
    title: "List a Google Doc's comments",
    description: "List the comments on a Google Doc (or any Drive file), oldest first, with author, text, the quoted passage, whether resolved, and replies.",
    risk: "read",
    target: "/documentId",
    input: {
      documentId: z.string().min(1).max(2048).describe("The Doc (or other Drive file): its id, or its link."),
      includeResolved: z.boolean().default(true).describe("Include resolved comments."),
      pageSize: z.number().int().min(1).max(100).default(50).describe("Comments per page."),
      pageToken: z.string().min(1).max(2000).optional().describe("nextPageToken from the previous page."),
    },
    async run(a, g) {
      const id = fileId(a.documentId);
      const res = await g.json<{ comments?: Comment[]; nextPageToken?: string }>("GET", `${DRIVE}/files/${encodeURIComponent(id)}/comments`, {
        query: { fields: `nextPageToken,comments(${COMMENT_FIELDS})`, pageSize: a.pageSize, pageToken: a.pageToken, includeDeleted: false },
      });
      const comments = (res.comments ?? []).filter((c) => !c.deleted && (a.includeResolved || !c.resolved));
      const out = comments.map((c) => ({
        id: c.id,
        author: person(c.author),
        content: c.content ?? "",
        quoted: c.quotedFileContent?.value ?? null,
        resolved: c.resolved ?? false,
        createdTime: c.createdTime ?? null,
        replies: (c.replies ?? []).filter((r) => !r.deleted).map((r) => ({ id: r.id, author: person(r.author), content: r.content ?? "", createdTime: r.createdTime ?? null, ...(r.action ? { action: r.action } : {}) })),
      }));
      const lines = out.map((c) =>
        [
          `- [${c.id}] ${c.author ?? "someone"} (${c.createdTime ?? "?"})${c.resolved ? " [resolved]" : ""}: ${c.content}`,
          c.quoted ? `  on: "${c.quoted.slice(0, 300)}"` : null,
          ...c.replies.map((r) => `  ↳ ${r.author ?? "someone"}: ${r.content}${r.action ? ` [${r.action}]` : ""}`),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const more = res.nextPageToken ? `\n\nMore comments: call docs_comments_list again with pageToken "${res.nextPageToken}".` : "";
      return { text: (lines.length ? lines.join("\n") : "No comments.") + more, structured: { documentId: id, comments: out, nextPageToken: res.nextPageToken ?? null } };
    },
  }),

  tool({
    name: "docs_comment_add",
    title: "Comment on a Google Doc",
    description:
      "Add a comment to a Google Doc (shown on the whole document: Google doesn't let apps anchor comments to text), or reply to an existing comment. Google allows this only on files the extension created; on other files it says so.",
    risk: "write",
    target: "/documentId",
    input: {
      documentId: z.string().min(1).max(2048).describe("The Doc (or other Drive file): its id, or its link."),
      text: z.string().min(1).max(30_000).describe("The comment."),
      replyToCommentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional().describe("Reply to this comment (its id from docs_comments_list) instead of starting a new one."),
    },
    async run(a, g) {
      const id = fileId(a.documentId);
      if (a.replyToCommentId) {
        const r = await g.json<{ id?: string; createdTime?: string }>("POST", `${DRIVE}/files/${encodeURIComponent(id)}/comments/${encodeURIComponent(a.replyToCommentId)}/replies`, {
          query: { fields: "id,content,createdTime" },
          body: { content: a.text },
        });
        return { text: `Replied to comment ${a.replyToCommentId} (reply id ${r.id}).`, structured: { documentId: id, commentId: a.replyToCommentId, replyId: r.id ?? null, createdTime: r.createdTime ?? null } };
      }
      const c = await g.json<{ id?: string; createdTime?: string }>("POST", `${DRIVE}/files/${encodeURIComponent(id)}/comments`, { query: { fields: "id,content,createdTime" }, body: { content: a.text } });
      return { text: `Added comment ${c.id}.`, structured: { documentId: id, commentId: c.id ?? null, createdTime: c.createdTime ?? null } };
    },
  }),
];
