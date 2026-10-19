// Drive: find files and get them out. drive.readonly lets these read every file the account can see; nothing here
// changes Drive. Shared helpers (fileSummary, exportText) are used by docs.ts too.

import { z } from "zod";
import { DRIVE, DRIVE_UPLOAD, type GoogleClient, SHEETS } from "./google.ts";
import { stripDataImages } from "./markdown.ts";
import { InputError, tool, type ToolOutput } from "./tool.ts";
import { MIME, fileId, mimeFromName, multipart, pageText, qString, rfc3339, sizeText, toCsv, typeName } from "./util.ts";

const LIST_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress,me),webViewLink,size,shortcutDetails(targetId,targetMimeType))";
export const FILE_FIELDS =
  "id,name,mimeType,description,createdTime,modifiedTime,owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),webViewLink,size,parents,shared,trashed,starred,driveId,capabilities(canEdit,canComment,canDownload),shortcutDetails(targetId,targetMimeType)";

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
}
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  description?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  shared?: boolean;
  trashed?: boolean;
  starred?: boolean;
  driveId?: string;
  capabilities?: { canEdit?: boolean; canComment?: boolean; canDownload?: boolean };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}
interface FileList {
  files?: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

export const person = (u: DriveUser | undefined): string | null => {
  if (!u) return null;
  if (u.me) return "me";
  if (u.displayName && u.emailAddress) return `${u.displayName} <${u.emailAddress}>`;
  return u.displayName ?? u.emailAddress ?? null;
};

/** The agent-facing summary of a file. */
export function fileSummary(f: DriveFile): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name ?? "",
    type: typeName(f.mimeType),
    mimeType: f.mimeType ?? null,
    modifiedTime: f.modifiedTime ?? null,
    owner: person(f.owners?.[0]),
    webViewLink: f.webViewLink ?? null,
    ...(f.size !== undefined ? { size: Number(f.size) } : {}),
    ...(f.shortcutDetails?.targetId ? { shortcutTo: { id: f.shortcutDetails.targetId, type: typeName(f.shortcutDetails.targetMimeType) } } : {}),
  };
}

const line = (f: DriveFile) => {
  const bits = [`${f.name ?? "(untitled)"} [${typeName(f.mimeType)}]`, `id ${f.id}`];
  if (f.modifiedTime) bits.push(`modified ${f.modifiedTime}`);
  const owner = person(f.owners?.[0]);
  if (owner) bits.push(`owner ${owner}`);
  if (f.shortcutDetails?.targetId) bits.push(`shortcut to ${f.shortcutDetails.targetId}`);
  return `- ${bits.join(" · ")}${f.webViewLink ? `\n  ${f.webViewLink}` : ""}`;
};

function listOutput(list: FileList, empty: string, more: string): ToolOutput {
  const files = list.files ?? [];
  const parts = [files.length ? files.map(line).join("\n") : empty];
  if (list.nextPageToken) parts.push(`More results: ${more} with pageToken "${list.nextPageToken}".`);
  if (list.incompleteSearch) parts.push("Google searched only part of the shared drives; narrow the search for complete results.");
  return { text: parts.join("\n\n"), structured: { files: files.map(fileSummary), nextPageToken: list.nextPageToken ?? null, ...(list.incompleteSearch ? { incompleteSearch: true } : {}) } };
}

const TYPE_FILTER = { doc: MIME.doc, sheet: MIME.sheet, slides: MIME.slides, pdf: MIME.pdf, folder: MIME.folder } as const;
const typeEnum = z.enum(["doc", "sheet", "slides", "pdf", "folder", "any"]);
const pageSize = z.number().int().min(1).max(100).default(25).describe("Results per page (1–100).");
const pageToken = z.string().min(1).max(2000).optional().describe("nextPageToken from the previous page.");

/** The Drive `q` for drive_search's inputs. */
export function searchQuery(a: { name?: string; text?: string; type?: string; folderId?: string; modifiedAfter?: string; modifiedBefore?: string; ownedByMe?: boolean }): string {
  const terms = ["trashed = false"];
  if (a.name) terms.push(`name contains ${qString(a.name)}`);
  if (a.text) terms.push(`fullText contains ${qString(a.text)}`);
  if (a.type && a.type !== "any") terms.push(`mimeType = ${qString(TYPE_FILTER[a.type as keyof typeof TYPE_FILTER])}`);
  if (a.folderId) terms.push(`${qString(fileId(a.folderId, "folder id", true))} in parents`);
  if (a.modifiedAfter) terms.push(`modifiedTime > ${qString(rfc3339(a.modifiedAfter, "modifiedAfter"))}`);
  if (a.modifiedBefore) terms.push(`modifiedTime < ${qString(rfc3339(a.modifiedBefore, "modifiedBefore"))}`);
  if (a.ownedByMe) terms.push("'me' in owners");
  return terms.join(" and ");
}

export async function getFile(g: GoogleClient, id: string, fields = FILE_FIELDS): Promise<DriveFile> {
  return g.json<DriveFile>("GET", `${DRIVE}/files/${encodeURIComponent(id)}`, { query: { fields, supportsAllDrives: true } });
}

/** Text export of a Docs-editors file, decoded. */
export async function exportText(g: GoogleClient, id: string, mimeType: string): Promise<string> {
  const res = await g.bytes("GET", `${DRIVE}/files/${encodeURIComponent(id)}/export`, { query: { mimeType } });
  return res.data.toString("utf8");
}

// What drive_export can make of each Google type, and the MIME type it asks Drive for ("csv" for a sheet goes
// through the Sheets API instead, one CSV per tab: Drive's CSV export has only the first tab).
const FORMATS: Record<string, Record<string, string>> = {
  [MIME.doc]: {
    markdown: "text/markdown",
    text: "text/plain",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  [MIME.sheet]: {
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
  },
  [MIME.slides]: {
    text: "text/plain",
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
};
const TEXT_FORMATS = new Set(["markdown", "text", "csv"]);
export const exportFormats = (mimeType: string | undefined): string[] => Object.keys(FORMATS[mimeType ?? ""] ?? {});

/** Binary exports at most this big are returned as base64 when asked (base64 grows it by a third; xaq drops binaries over 5 MB). */
export const MAX_BASE64_BYTES = 3 * 1024 * 1024;

/** drive_upload's limit, decoded: its base64 (a third larger) plus the JSON-RPC envelope stays under xaq's 8 MB message cap. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BASE64 = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 1024;

interface SheetProps {
  sheetId?: number;
  title?: string;
  sheetType?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

/** Each tab of a spreadsheet as CSV (FORMATTED_VALUE, as the Sheets UI shows them), or only the named one. */
async function sheetCsv(g: GoogleClient, id: string, tab: string | undefined): Promise<{ text: string; tabs: { title: string; rows: number }[] }> {
  const meta = await g.json<{ sheets?: { properties?: SheetProps }[] }>("GET", `${SHEETS}/spreadsheets/${encodeURIComponent(id)}`, { query: { fields: "sheets.properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount))" } });
  let tabs = (meta.sheets ?? []).map((s) => s.properties ?? {}).filter((p) => (p.sheetType ?? "GRID") === "GRID" && typeof p.title === "string");
  if (tab) {
    const want = tab.trim().toLowerCase();
    const hit = tabs.filter((p) => p.title!.toLowerCase() === want);
    if (!hit.length) throw new InputError(`No tab named "${tab}". Tabs: ${tabs.map((p) => `"${p.title}"`).join(", ") || "none"}.`);
    tabs = hit.slice(0, 1);
  }
  if (!tabs.length) return { text: "", tabs: [] };
  if (tabs.length > 50) throw new InputError(`This spreadsheet has ${tabs.length} tabs; pass tab to export one at a time.`);
  const ranges = tabs.map((p) => `ranges=${encodeURIComponent(`'${p.title!.replace(/'/g, "''")}'`)}`).join("&");
  const res = await g.json<{ valueRanges?: { values?: unknown[][] }[] }>("GET", `${SHEETS}/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${ranges}`, {
    query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
  });
  const out: { title: string; rows: number }[] = [];
  const parts: string[] = [];
  tabs.forEach((p, i) => {
    const values = res.valueRanges?.[i]?.values ?? [];
    out.push({ title: p.title!, rows: values.length });
    const csv = toCsv(values);
    parts.push(tabs.length === 1 && tab ? csv : `### Tab: ${p.title}\n${csv}`);
  });
  return { text: parts.join("\n\n"), tabs: out };
}

const fileArg = (what: string) => z.string().min(1).max(2048).describe(`The ${what}: its id, or its Google link.`);

export const driveTools = [
  tool({
    name: "drive_search",
    title: "Search Google Drive",
    description:
      "Find files in Google Drive by name or by the words in them, optionally by type, folder, date or owner. Returns each file's name, type, id, modified time, owner and link, newest first (or by relevance when searching text). Use the id with the other tools.",
    risk: "read",
    input: {
      name: z.string().min(1).max(500).optional().describe("Words the file name starts with or contains (Drive matches name prefixes)."),
      text: z.string().min(1).max(500).optional().describe('Words anywhere in the file\'s name, description or content. Wrap a phrase in double quotes for an exact match, e.g. "quarterly plan".'),
      type: typeEnum.default("any").describe("Only this kind of file."),
      folderId: z.string().min(1).max(2048).optional().describe("Only files directly inside this folder (id or link; not sub-folders)."),
      modifiedAfter: z.string().min(1).max(40).optional().describe("Only files modified after this date (2026-10-01) or date-time (UTC unless an offset is given)."),
      modifiedBefore: z.string().min(1).max(40).optional().describe("Only files modified before this date or date-time."),
      ownedByMe: z.boolean().default(false).describe("Only files this account owns."),
      includeSharedDrives: z.boolean().default(false).describe("Also search shared drives (slower; may be incomplete)."),
      pageSize,
      pageToken,
    },
    async run(a, g) {
      const q = searchQuery(a);
      const list = await g.json<FileList>("GET", `${DRIVE}/files`, {
        query: {
          q,
          fields: LIST_FIELDS,
          pageSize: a.pageSize,
          pageToken: a.pageToken,
          // Drive refuses a sort order on full-text searches (results come by relevance).
          orderBy: a.text ? undefined : "modifiedTime desc",
          spaces: "drive",
          corpora: a.includeSharedDrives ? "allDrives" : "user",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        },
      });
      return listOutput(list, "No files match.", "call drive_search again with the same filters");
    },
  }),

  tool({
    name: "drive_list_folder",
    title: "List a Drive folder",
    description: "List what is directly inside a Google Drive folder (My Drive's top level by default): folders first, then files by name, with each one's type, id, modified time, owner and link.",
    risk: "read",
    target: "/folderId",
    input: {
      folderId: z.string().min(1).max(2048).default("root").describe('The folder: its id or link, or "root" for the top of My Drive.'),
      type: typeEnum.default("any").describe("Only this kind of item."),
      pageSize,
      pageToken,
    },
    async run(a, g) {
      const id = fileId(a.folderId, "folder id", true);
      const list = await g.json<FileList>("GET", `${DRIVE}/files`, {
        query: {
          q: searchQuery({ folderId: id, type: a.type }),
          fields: LIST_FIELDS,
          pageSize: a.pageSize,
          pageToken: a.pageToken,
          orderBy: "folder,name_natural",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        },
      });
      return listOutput(list, "The folder is empty (or has nothing of that type).", "call drive_list_folder again");
    },
  }),

  tool({
    name: "drive_get",
    title: "Get a Drive file's details",
    description: "A Google Drive file's details: name, type, owner, who changed it last and when, size, folder, whether you can edit or comment, its link, and the formats drive_export can give.",
    risk: "read",
    target: "/fileId",
    input: { fileId: fileArg("file") },
    async run(a, g) {
      const f = await getFile(g, fileId(a.fileId));
      const formats = exportFormats(f.mimeType);
      const s = {
        ...fileSummary(f),
        description: f.description ?? null,
        createdTime: f.createdTime ?? null,
        lastModifiedBy: person(f.lastModifyingUser),
        parents: f.parents ?? [],
        shared: f.shared ?? false,
        trashed: f.trashed ?? false,
        canEdit: f.capabilities?.canEdit ?? null,
        canComment: f.capabilities?.canComment ?? null,
        exportFormats: formats,
      };
      const lines = [
        `${f.name ?? "(untitled)"} [${typeName(f.mimeType)}] id ${f.id}`,
        f.webViewLink ? `Link: ${f.webViewLink}` : null,
        `Owner: ${person(f.owners?.[0]) ?? "unknown"}; last modified ${f.modifiedTime ?? "?"}${s.lastModifiedBy ? ` by ${s.lastModifiedBy}` : ""}; created ${f.createdTime ?? "?"}`,
        f.size !== undefined ? `Size: ${sizeText(Number(f.size))}` : null,
        f.description ? `Description: ${f.description}` : null,
        `You can ${[f.capabilities?.canEdit ? "edit" : null, f.capabilities?.canComment ? "comment" : null, "view"].filter(Boolean).join(", ")}.${f.trashed ? " It is in the trash." : ""}`,
        formats.length ? `drive_export formats: ${formats.join(", ")}` : null,
        f.shortcutDetails?.targetId ? `This is a shortcut to ${f.shortcutDetails.targetId}; use that id.` : null,
      ];
      return { text: lines.filter(Boolean).join("\n"), structured: s };
    },
  }),

  tool({
    name: "drive_export",
    title: "Export a Google Doc, Sheet or Slides file",
    description:
      "Get a Google Doc, Sheet or Slides file's content in another format. Text formats come back as text, in pages: doc → markdown or text; sheet → csv (one CSV per tab, or pass tab); slides → text. Binary formats (pdf, docx, xlsx, pptx) come back as their size, plus the bytes as base64 only when includeBase64 is true and the file is at most 3 MB. To email a file, attach it from Drive by its id instead.",
    risk: "read",
    target: "/fileId",
    input: {
      fileId: fileArg("Doc, Sheet or Slides file"),
      format: z.enum(["markdown", "text", "csv", "pdf", "docx", "xlsx", "pptx"]).describe("doc: markdown, text, pdf, docx · sheet: csv, xlsx, pdf · slides: text, pdf, pptx."),
      tab: z.string().min(1).max(200).optional().describe("For csv: only this tab (by name). Default: every tab."),
      offset: z.number().int().min(0).default(0).describe("For text formats: the character to start at (nextOffset from the previous page)."),
      maxChars: z.number().int().min(1000).max(100_000).default(20_000).describe("For text formats: the most characters to return."),
      includeBase64: z.boolean().default(false).describe("For binary formats: also return the file as base64 (at most 3 MB)."),
    },
    async run(a, g) {
      const id = fileId(a.fileId);
      const f = await getFile(g, id, "id,name,mimeType,webViewLink,shortcutDetails(targetId,targetMimeType)");
      const formats = FORMATS[f.mimeType ?? ""];
      if (!formats) {
        const hint = f.shortcutDetails?.targetId ? ` It's a shortcut: use ${f.shortcutDetails.targetId}.` : "";
        throw new InputError(`"${f.name}" is a ${typeName(f.mimeType)}, not a Google Doc, Sheet or Slides file, so it can't be exported.${hint}`);
      }
      const mime = formats[a.format];
      if (!mime) throw new InputError(`A ${typeName(f.mimeType)} exports as ${Object.keys(formats).join(", ")}, not ${a.format}.`);
      const base = { fileId: id, name: f.name ?? "", type: typeName(f.mimeType), format: a.format, webViewLink: f.webViewLink ?? null };
      if (TEXT_FORMATS.has(a.format)) {
        let text: string;
        let extra: Record<string, unknown> = {};
        if (f.mimeType === MIME.sheet) {
          const csv = await sheetCsv(g, id, a.tab);
          text = csv.text;
          extra = { tabs: csv.tabs };
        } else {
          text = await exportText(g, id, mime);
          if (a.format === "markdown") {
            const cleaned = stripDataImages(text);
            text = cleaned.text;
            if (cleaned.omitted) extra = { imagesOmitted: cleaned.omitted };
          }
        }
        const page = pageText(text, a.offset, a.maxChars);
        const tail = page.nextOffset !== null ? `\n\n[Characters ${page.offset}–${page.offset + page.text.length} of ${page.total}. More: call drive_export again with offset ${page.nextOffset}.]` : "";
        return { text: page.text + tail, structured: { ...base, ...extra, offset: page.offset, nextOffset: page.nextOffset, totalChars: page.total } };
      }
      const res = await g.bytes("GET", `${DRIVE}/files/${encodeURIComponent(id)}/export`, { query: { mimeType: mime } });
      const size = res.data.length;
      const fits = size <= MAX_BASE64_BYTES;
      const note = a.includeBase64
        ? fits
          ? "The file is in structuredContent.base64."
          : `It's over 3 MB, so it isn't returned here.`
        : "Its bytes aren't returned (pass includeBase64: true for files up to 3 MB).";
      return {
        text: `Exported "${f.name}" as ${a.format}: ${sizeText(size)}. ${note} To send it by email, attach the Drive file by its id (${id}) rather than the export.`,
        structured: { ...base, mimeType: mime, size, ...(a.includeBase64 && fits ? { base64: res.data.toString("base64") } : {}) },
      };
    },
  }),

  tool({
    name: "drive_create_folder",
    title: "Create a Drive folder",
    description: "Create a folder in Google Drive, at the top of My Drive or inside another folder. Returns its id and link; pass the id as folderId to the create tools to put new files in it.",
    risk: "write",
    input: {
      name: z.string().min(1).max(500).describe("The folder's name."),
      parentId: z.string().min(1).max(2048).optional().describe("Create it inside this folder (id or link). Default: the top of My Drive."),
    },
    async run(a, g) {
      const metadata: Record<string, unknown> = { name: a.name, mimeType: MIME.folder };
      if (a.parentId) metadata.parents = [fileId(a.parentId, "folder id", true)];
      const f = await g.json<DriveFile>("POST", `${DRIVE}/files`, { query: { fields: "id,name,mimeType,webViewLink,parents", supportsAllDrives: true }, body: metadata });
      if (!f.id) throw new Error("Drive didn't return the new folder's id");
      const link = f.webViewLink ?? `https://drive.google.com/drive/folders/${f.id}`;
      return { text: `Created folder "${f.name ?? a.name}": ${link} (id ${f.id})`, structured: { folderId: f.id, name: f.name ?? a.name, webViewLink: link, parents: f.parents ?? [] } };
    },
  }),

  tool({
    name: "drive_upload",
    title: "Upload a file to Drive",
    description:
      "Upload a file to Google Drive as it is (no conversion: use docs_create for a Google Doc), at the top of My Drive or in a folder, and get its id and link, for example to share a link by email. The content is base64 and at most 5 MB once decoded (the limit keeps the call within xaq's message size). The type is guessed from the name's extension when mimeType is missing.",
    risk: "write",
    input: {
      name: z.string().min(1).max(500).describe("The file's name, with its extension (e.g. chart.png)."),
      folderId: z.string().min(1).max(2048).optional().describe("Put it in this folder (id or link). Default: the top of My Drive."),
      mimeType: z
        .string()
        .regex(/^[\w.+-]+\/[\w.+-]+$/)
        .max(200)
        .optional()
        .describe("The file's MIME type, e.g. image/png. Default: guessed from the name. Google Docs, Sheets and Slides types aren't accepted."),
      content_base64: z.string().min(1).max(MAX_UPLOAD_BASE64).describe("The file's bytes, base64-encoded (at most 5 MB decoded)."),
    },
    async run(a, g) {
      const mimeType = a.mimeType ?? mimeFromName(a.name);
      if (mimeType.startsWith("application/vnd.google-apps.")) throw new InputError("drive_upload stores files as they are; it can't make Google Docs, Sheets or Slides files. Use docs_create (or the Sheets and Slides create tools) instead.");
      const b64 = a.content_base64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new InputError("content_base64 isn't valid base64.");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length > MAX_UPLOAD_BYTES) throw new InputError(`That's ${sizeText(bytes.length)}; drive_upload takes at most 5 MB.`);
      const metadata: Record<string, unknown> = { name: a.name, mimeType };
      if (a.folderId) metadata.parents = [fileId(a.folderId, "folder id", true)];
      const { body, contentType } = multipart(metadata, bytes, mimeType);
      const res = await g.bytes("POST", `${DRIVE_UPLOAD}/files`, { query: { uploadType: "multipart", fields: "id,name,mimeType,size,webViewLink,parents", supportsAllDrives: true }, body, contentType });
      const f = JSON.parse(res.data.toString("utf8")) as DriveFile;
      if (!f.id) throw new Error("Drive didn't return the new file's id");
      const size = f.size !== undefined ? Number(f.size) : bytes.length;
      const link = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
      return {
        text: `Uploaded "${f.name ?? a.name}" (${f.mimeType ?? mimeType}, ${sizeText(size)}): ${link} (id ${f.id})`,
        structured: { fileId: f.id, name: f.name ?? a.name, mimeType: f.mimeType ?? mimeType, size, webViewLink: link, parents: f.parents ?? [] },
      };
    },
  }),

  tool({
    name: "drive_trash",
    title: "Move a Drive file or folder to the Trash",
    description:
      "Move a file or folder to the Google Drive Trash (it can be restored from the Trash for 30 days; nothing is deleted permanently). Google allows this only for files and folders the extension created.",
    risk: "risky",
    target: "/fileId",
    input: { fileId: fileArg("file or folder") },
    async run(a, g) {
      const id = fileId(a.fileId);
      const f = await g.json<DriveFile>("PATCH", `${DRIVE}/files/${encodeURIComponent(id)}`, { query: { fields: "id,name,mimeType,trashed,webViewLink", supportsAllDrives: true }, body: { trashed: true } });
      if (f.trashed !== true) throw new Error("Drive didn't confirm the file is in the Trash");
      return {
        text: `Moved "${f.name ?? id}" (${typeName(f.mimeType)}, id ${id}) to the Trash. Restore it from the Trash in Google Drive within 30 days if needed.`,
        structured: { fileId: id, name: f.name ?? null, type: typeName(f.mimeType), trashed: true },
      };
    },
  }),
];
