// A fake of the Google APIs the extension calls, on a loopback port, for the extension running as a real child
// process. The extension's test mode sends https://<host>/<path> to <origin>/<host>/<path>, so one server stands in
// for every googleapis.com host. Built from Google's documented request and response shapes (Drive API v3, Docs API
// v1, Sheets API v4); no live account was used. It checks bearer tokens it was told are valid (xaq core does OAuth;
// the harness hands the child a token through xaq/credentials/get).
//
// Modelled: Drive files.list (the `q` terms the extension builds, paging, corpora, the fullText/orderBy refusal),
// files.get, files.create (metadata only, and multipart upload with conversion), files.export (by MIME type, with
// the 10 MB export limit), comments.list/create (fields required) and replies.create, drive.file's per-file rule for
// changes; Docs documents.get and documents.batchUpdate (fake-docs.mjs, with writeControl); Sheets spreadsheets.get
// and values.batchGet. Failures can be injected per request (`fail`), and requests can be held (`hang`).
//
// For the Sheets and Slides tests: chain a node handler with `fake.use((req, res) => handled)` (it sees the path without
// the host prefix, after the token check and injected failures), or add routes with
// `fake.route(host, method, /regex/, (req, ctx) => …)`. Both are tried before the built-in routes; the built-in Sheets
// routes here serve only drive_export's CSV.

import { createServer } from "node:http";
import { BadRequest, FakeDoc, bodyFromMarkdown, bodyFromSpec } from "./fake-docs.mjs";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const FOLDER = "application/vnd.google-apps.folder";
/** My Drive's root folder id, as Drive reports it in `parents` (the alias "root" is accepted in requests, never returned). */
export const ROOT_ID = "0AFaKeRoOtFoLdEr00Uk9PVA";
const resolveRoot = (id) => (id === "root" ? ROOT_ID : id);
const EXPORTS = {
  [DOC]: ["text/markdown", "text/plain", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/html", "application/rtf", "application/vnd.oasis.opendocument.text", "application/epub+zip", "application/zip"],
  [SHEET]: ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/pdf", "text/tab-separated-values", "application/vnd.oasis.opendocument.spreadsheet", "application/zip"],
  [SLIDES]: ["text/plain", "application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.presentation"],
};

/** Google's error bodies. Drive v3 uses the legacy `errors[]` shape; Docs and Sheets the google.rpc shape. */
export const errors = {
  drive: (code, reason, message, extra = {}) => ({ error: { code, message, errors: [{ message, domain: "global", reason, ...extra }] } }),
  rpc: (code, status, message, details) => ({ error: { code, message, status, ...(details ? { details } : {}) } }),
  serviceDisabled: (service, title, project = "123456789012") => ({
    error: {
      code: 403,
      message: `${title} has not been used in project ${project} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${service}/overview?project=${project} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`,
      status: "PERMISSION_DENIED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service, consumer: `projects/${project}`, serviceTitle: title, activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=${project}`, containerInfo: project } },
        { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: `${title} has not been used in project ${project} before or it is disabled.` },
        { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Google developers console API activation", url: `https://console.developers.google.com/apis/api/${service}/overview?project=${project}` }] },
      ],
    },
  }),
  scope: () => ({
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com", metadata: { method: "google.apps.docs.v1.DocumentsService.BatchUpdateDocument", service: "docs.googleapis.com" } }],
    },
  }),
};

/** Splits a Drive `q` on ` and ` outside quoted strings. */
function splitQ(q) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (quoted && c === "\\") {
      cur += c + (q[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'") quoted = !quoted;
    if (!quoted && q.startsWith(" and ", i)) {
      out.push(cur.trim());
      cur = "";
      i += 4;
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
const unq = (s) => s.replace(/\\(.)/g, "$1");
const STR = "'((?:\\\\.|[^'\\\\])*)'";

/** A predicate for one q term, or null when the fake (and here, Drive) wouldn't accept it. */
function term(t, fake) {
  let m;
  if ((m = /^trashed = (true|false)$/.exec(t))) return (f) => !!f.trashed === (m[1] === "true");
  if ((m = new RegExp(`^name contains ${STR}$`).exec(t))) return (f) => f.name.toLowerCase().includes(unq(m[1]).toLowerCase());
  if ((m = new RegExp(`^fullText contains ${STR}$`).exec(t))) {
    const words = unq(m[1]).replace(/"/g, "").toLowerCase();
    return (f) => `${f.name} ${f.description ?? ""} ${f._text ?? ""} ${fake.docText(f.id)}`.toLowerCase().includes(words);
  }
  if ((m = new RegExp(`^mimeType = ${STR}$`).exec(t))) return (f) => f.mimeType === unq(m[1]);
  if ((m = new RegExp(`^${STR} in parents$`).exec(t))) return (f) => (f.parents ?? []).includes(resolveRoot(unq(m[1])));
  if (t === "'me' in owners") return (f) => (f.owners ?? []).some((o) => o.me);
  if ((m = new RegExp(`^modifiedTime (<=|<|>=|>) ${STR}$`).exec(t))) {
    const at = Date.parse(unq(m[2]));
    if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T/.test(unq(m[2]))) return null;
    const cmp = { "<": (a) => a < at, "<=": (a) => a <= at, ">": (a) => a > at, ">=": (a) => a >= at }[m[1]];
    return (f) => cmp(Date.parse(f.modifiedTime));
  }
  return null;
}

const page = (items, q, def, max) => {
  const size = q.has("pageSize") ? Number(q.get("pageSize")) : def;
  if (!Number.isInteger(size) || size < 1 || size > max) return { error: `Invalid value '${q.get("pageSize")}'. Values must be within the range: [1, ${max}]` };
  const offset = q.has("pageToken") ? Number(Buffer.from(q.get("pageToken"), "base64url").toString()) : 0;
  if (!Number.isInteger(offset) || offset < 0) return { error: "Invalid Value" };
  const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : undefined;
  return { items: items.slice(offset, offset + size), next };
};

function parseMultipart(body, contentType) {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType ?? "")?.[2];
  if (!boundary) return null;
  // latin1 maps bytes 1:1 to characters, so binary media survives the split.
  const text = body.toString("latin1");
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const sep = p.indexOf("\r\n\r\n");
      const headers = Object.fromEntries(
        p
          .slice(0, sep)
          .trim()
          .split("\r\n")
          .map((h) => [h.slice(0, h.indexOf(":")).toLowerCase(), h.slice(h.indexOf(":") + 1).trim()]),
      );
      return { headers, body: Buffer.from(p.slice(sep + 4).replace(/\r\n$/, ""), "latin1") };
    });
  return parts.length === 2 ? parts : null;
}

export async function startFakeGoogle(fixture) {
  const files = new Map(fixture.files.map((f) => [f.id, structuredClone(f)]));
  const docs = new Map(Object.entries(fixture.docs ?? {}).map(([id, d]) => [id, Object.assign(new FakeDoc(id, d.title, bodyFromSpec(d.body)), { exportMarkdown: d.exportMarkdown ?? null })]));
  const comments = new Map(Object.entries(fixture.comments ?? {}).map(([id, c]) => [id, structuredClone(c)]));
  const sheets = new Map(Object.entries(fixture.sheets ?? {}));
  const slidesText = new Map(Object.entries(fixture.slidesText ?? {}));
  const routes = [];
  const handlers = [];
  let seq = 0;

  const state = {
    files,
    docs,
    comments,
    sheets,
    validTokens: new Set(),
    /** Every request: { method, host, path, query (URLSearchParams), search, auth, contentType, body (Buffer) }. */
    requests: [],
    /** Injected failures, consumed in order: { match?: (req) => boolean, status, body, headers, times }. */
    failures: [],
    /** Requests to leave unanswered (their sockets are destroyed after holdMs). */
    hang: 0,
    holdMs: 3_000,
    /** Bytes for binary exports, by file id (default 2 KB). */
    exportSizes: new Map(),
    /** Files whose export is over Drive's 10 MB limit: a file id (every format) or "<id> <mimeType>". */
    tooLargeToExport: new Set(),
    user: fixture.user,
  };

  const fake = {
    state,
    docText: (id) => (docs.has(id) ? docs.get(id).plainText() : ""),
    route(host, method, pattern, handler) {
      routes.push({ host, method, pattern, handler });
    },
    /** Chains a node (req, res) => boolean | Promise<boolean> handler before the built-in routes (see the server below). */
    use(handler) {
      handlers.push(handler);
    },
    fail(spec) {
      state.failures.push({ times: 1, headers: {}, ...spec });
    },
    /** Requests to googleapis hosts (not the test's own bookkeeping). */
    requests: () => state.requests,
    newId(prefix = "1NeW") {
      seq++;
      return `${prefix}${String(seq).padStart(4, "0")}${"x".repeat(28)}`;
    },
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "content-type": Buffer.isBuffer(body) || typeof body === "string" ? "application/octet-stream" : "application/json; charset=UTF-8", "content-length": buf.length, ...headers });
    res.end(buf);
  };
  const json = (res, status, body, headers) => send(res, status, body, headers);

  const notFoundFile = (res, id) => json(res, 404, errors.drive(404, "notFound", `File not found: ${id}.`, { location: "fileId", locationType: "parameter" }));
  const publicFile = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("_")));

  function driveFiles(req, res) {
    const q = req.query;
    if (q.get("corpora") === "allDrives" && q.get("includeItemsFromAllDrives") !== "true") return json(res, 400, errors.drive(400, "invalid", "The includeItemsFromAllDrives parameter must be set to true when corpora is set to allDrives."));
    const terms = splitQ(q.get("q") ?? "trashed = false");
    const preds = terms.map((t) => term(t, fake));
    if (preds.some((p) => !p)) return json(res, 400, errors.drive(400, "invalid", "Invalid Value", { location: "q", locationType: "parameter" }));
    if (q.has("orderBy") && terms.some((t) => t.startsWith("fullText"))) return json(res, 403, errors.drive(403, "fullTextSearchSortNotSupported", "Sorting is not supported for queries with fullText terms. Results are always in descending relevance order."));
    let list = [...files.values()].filter((f) => preds.every((p) => p(f)));
    if (q.get("corpora") !== "allDrives") list = list.filter((f) => !f.driveId);
    const order = q.get("orderBy");
    if (order === "modifiedTime desc") list.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
    else if (order === "folder,name_natural") list.sort((a, b) => (b.mimeType === FOLDER) - (a.mimeType === FOLDER) || a.name.localeCompare(b.name, "en", { numeric: true }));
    else if (order) return json(res, 400, errors.drive(400, "invalid", "Invalid Value", { location: "orderBy", locationType: "parameter" }));
    const p = page(list, q, 100, 1000);
    if (p.error) return json(res, 400, errors.drive(400, "invalid", p.error, { location: "pageSize", locationType: "parameter" }));
    return json(res, 200, { kind: "drive#fileList", ...(p.next ? { nextPageToken: p.next } : {}), incompleteSearch: false, files: p.items.map(publicFile) });
  }

  function exportFile(req, res, f) {
    const mime = req.query.get("mimeType");
    if (!mime) return json(res, 400, errors.drive(400, "required", "Required parameter: mimeType", { location: "mimeType", locationType: "parameter" }));
    if (!EXPORTS[f.mimeType]) return json(res, 403, errors.drive(403, "fileNotExportable", "Export only supports Docs Editors files."));
    if (!EXPORTS[f.mimeType].includes(mime)) return json(res, 400, errors.drive(400, "badRequest", "The requested conversion is not supported.", { location: "convertTo", locationType: "parameter" }));
    if (state.tooLargeToExport.has(f.id) || state.tooLargeToExport.has(`${f.id} ${mime}`)) return json(res, 403, errors.drive(403, "exportSizeLimitExceeded", "This file is too large to be exported."));
    const doc = docs.get(f.id);
    if (mime === "text/markdown") return send(res, 200, doc ? (doc.exportMarkdown ?? doc.markdown()) : "", { "content-type": "text/markdown; charset=utf-8" });
    if (mime === "text/plain") return send(res, 200, f.mimeType === SLIDES ? (slidesText.get(f.id) ?? "") : doc ? doc.plainText() : "", { "content-type": "text/plain; charset=utf-8" });
    if (mime === "text/csv") {
      const first = sheets.get(f.id)?.tabs?.[0]?.values ?? [];
      return send(res, 200, first.map((r) => r.join(",")).join("\n"), { "content-type": "text/csv; charset=utf-8" });
    }
    const size = state.exportSizes.get(f.id) ?? 2048;
    const head = mime === "application/pdf" ? `%PDF-1.4\n% fake export of ${f.name}\n` : "PK\u0003\u0004";
    const buf = Buffer.alloc(size, 0x20);
    buf.write(head, 0, "latin1");
    return send(res, 200, buf, { "content-type": mime });
  }

  function createFile(res, meta, media) {
    const id = fake.newId();
    let mimeType = meta.mimeType ?? media?.type ?? "application/octet-stream";
    if (meta.mimeType === DOC && media) {
      if (!/^text\/(markdown|plain|html)/.test(media.type)) return json(res, 400, errors.drive(400, "badContent", `Unsupported content with type: ${media.type}`));
      const text = media.body.toString("utf8");
      docs.set(id, Object.assign(new FakeDoc(id, meta.name ?? "Untitled document", bodyFromMarkdown(text)), { exportMarkdown: media.type.startsWith("text/markdown") ? text.trim() + "\n" : null }));
    } else if (meta.mimeType === DOC) {
      docs.set(id, Object.assign(new FakeDoc(id, meta.name ?? "Untitled document", []), { exportMarkdown: null }));
    } else if (media) mimeType = meta.mimeType ?? media.type.split(";")[0];
    const parents = (meta.parents ?? ["root"]).map(resolveRoot);
    for (const p of parents) if (p !== ROOT_ID && !files.has(p)) return notFoundFile(res, p);
    const now = new Date().toISOString();
    const f = {
      kind: "drive#file",
      id,
      name: meta.name ?? "Untitled",
      mimeType,
      parents,
      createdTime: now,
      modifiedTime: now,
      owners: [{ kind: "drive#user", displayName: state.user.displayName, emailAddress: state.user.emailAddress, me: true }],
      webViewLink: mimeType === DOC ? `https://docs.google.com/document/d/${id}/edit?usp=drivesdk` : mimeType === FOLDER ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view?usp=drivesdk`,
      capabilities: { canEdit: true, canComment: true, canDownload: true },
      _appCreated: true,
      ...(media && meta.mimeType !== DOC ? { size: String(media.body.length), _bytes: media.body } : {}),
    };
    files.set(id, f);
    return json(res, 200, publicFile(f));
  }

  function comment(req, res, f, rest) {
    if (!req.query.get("fields")) return json(res, 400, errors.drive(400, "required", "The 'fields' parameter is required for this method.", { location: "fields", locationType: "parameter" }));
    const list = comments.get(f.id) ?? [];
    if (req.method === "GET" && rest.length === 0) {
      const visible = req.query.get("includeDeleted") === "true" ? list : list;
      const p = page(visible, req.query, 20, 100);
      if (p.error) return json(res, 400, errors.drive(400, "invalid", p.error));
      return json(res, 200, { kind: "drive#commentList", comments: p.items, ...(p.next ? { nextPageToken: p.next } : {}) });
    }
    // Changes need drive (not requested) or drive.file on a file the app created or was given.
    if (!f._appCreated) return json(res, 403, errors.drive(403, "appNotAuthorizedToFile", `The user has not granted the app 123456789012 write access to the file ${f.id}.`, { location: "fileId", locationType: "parameter" }));
    const body = JSON.parse(req.body.toString("utf8") || "{}");
    if (!body.content) return json(res, 400, errors.drive(400, "required", "Required: content", { location: "content", locationType: "other" }));
    const author = { kind: "drive#user", displayName: state.user.displayName, me: true };
    const now = new Date().toISOString();
    if (req.method === "POST" && rest.length === 0) {
      const c = { kind: "drive#comment", id: `AAAA${fake.newId("c").slice(0, 8)}`, createdTime: now, modifiedTime: now, author, content: body.content, htmlContent: body.content, deleted: false, resolved: false, replies: [] };
      list.push(c);
      comments.set(f.id, list);
      return json(res, 200, { id: c.id, content: c.content, createdTime: c.createdTime });
    }
    if (req.method === "POST" && rest.length === 2 && rest[1] === "replies") {
      const c = list.find((x) => x.id === rest[0]);
      if (!c) return json(res, 404, errors.drive(404, "notFound", `Comment not found: ${rest[0]}.`, { location: "commentId", locationType: "parameter" }));
      const r = { kind: "drive#reply", id: `AAAA${fake.newId("r").slice(0, 8)}`, createdTime: now, modifiedTime: now, author, content: body.content, deleted: false };
      c.replies.push(r);
      return json(res, 200, { id: r.id, content: r.content, createdTime: r.createdTime });
    }
    return json(res, 404, errors.drive(404, "notFound", "Not Found"));
  }

  function drive(req, res) {
    const p = req.path;
    if (req.method === "GET" && p === "/drive/v3/files") return driveFiles(req, res);
    if (req.method === "POST" && p === "/drive/v3/files") return createFile(res, JSON.parse(req.body.toString("utf8") || "{}"), null);
    if (req.method === "POST" && p === "/upload/drive/v3/files") {
      if (req.query.get("uploadType") !== "multipart") return json(res, 400, errors.drive(400, "invalid", "Invalid upload type"));
      const parts = parseMultipart(req.body, req.contentType);
      if (!parts || !/^application\/json/.test(parts[0].headers["content-type"] ?? "")) return json(res, 400, errors.drive(400, "badMultipart", "Bad multipart request"));
      const meta = JSON.parse(parts[0].body.toString("utf8"));
      if (typeof meta.mimeType === "string" && meta.mimeType.startsWith("application/vnd.google-apps.") && meta.mimeType !== DOC) return json(res, 400, errors.drive(400, "badContent", "The fake converts uploads to Google Docs only."));
      return createFile(res, meta, { type: parts[1].headers["content-type"] ?? "application/octet-stream", body: parts[1].body });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return json(res, 404, errors.drive(404, "notFound", "Not Found"));
    const f = files.get(decodeURIComponent(m[1]));
    if (!f) return notFoundFile(res, decodeURIComponent(m[1]));
    const rest = m[2] ? m[2].split("/") : [];
    if (req.method === "GET" && !rest.length) return json(res, 200, publicFile(f));
    if (req.method === "PATCH" && !rest.length) {
      // files.update: drive.file allows it only on files the app created; the extension only ever sets trashed.
      if (!f._appCreated) return json(res, 403, errors.drive(403, "appNotAuthorizedToFile", `The user has not granted the app 123456789012 write access to the file ${f.id}.`, { location: "fileId", locationType: "parameter" }));
      const patch = JSON.parse(req.body.toString("utf8") || "{}");
      for (const k of Object.keys(patch)) if (!["trashed", "name", "description"].includes(k)) return json(res, 403, errors.drive(403, "fieldNotWritable", `The resource body includes fields which are not directly writable.`));
      Object.assign(f, patch, { modifiedTime: new Date().toISOString() });
      return json(res, 200, publicFile(f));
    }
    if (req.method === "GET" && rest[0] === "export" && rest.length === 1) return exportFile(req, res, f);
    if (rest[0] === "comments") return comment(req, res, f, rest.slice(1));
    return json(res, 404, errors.drive(404, "notFound", "Not Found"));
  }

  function docsApi(req, res) {
    const m = /^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(req.path);
    if (!m) return json(res, 404, errors.rpc(404, "NOT_FOUND", "Requested entity was not found."));
    const id = decodeURIComponent(m[1]);
    const doc = docs.get(id);
    if (!doc) {
      if (files.has(id)) return json(res, 400, errors.rpc(400, "FAILED_PRECONDITION", "This operation is not supported for this document"));
      return json(res, 404, errors.rpc(404, "NOT_FOUND", "Requested entity was not found."));
    }
    if (!m[2] && req.method === "GET") return json(res, 200, doc.resource());
    if (m[2] && req.method === "POST") {
      const body = JSON.parse(req.body.toString("utf8") || "{}");
      const want = body.writeControl?.requiredRevisionId;
      if (want && want !== doc.revisionId) return json(res, 400, errors.rpc(400, "FAILED_PRECONDITION", `The required revision ID ${want} does not match the latest revision of the document.`));
      try {
        const replies = doc.apply(body.requests ?? []);
        doc.exportMarkdown = null;
        const f = files.get(id);
        if (f) f.modifiedTime = new Date().toISOString();
        return json(res, 200, { documentId: id, replies, writeControl: { requiredRevisionId: doc.revisionId } });
      } catch (err) {
        if (err instanceof BadRequest) return json(res, 400, errors.rpc(400, "INVALID_ARGUMENT", err.message));
        throw err;
      }
    }
    return json(res, 404, errors.rpc(404, "NOT_FOUND", "Requested entity was not found."));
  }

  function sheetsApi(req, res) {
    const m = /^\/v4\/spreadsheets\/([^/]+?)(\/values:batchGet)?$/.exec(req.path);
    const sheet = m && sheets.get(decodeURIComponent(m[1]));
    if (!sheet) return json(res, 404, errors.rpc(404, "NOT_FOUND", "Requested entity was not found."));
    if (!m[2]) {
      return json(res, 200, {
        spreadsheetId: m[1],
        sheets: sheet.tabs.map((t, index) => ({ properties: { sheetId: t.sheetId, title: t.title, index, sheetType: t.sheetType ?? "GRID", ...(t.sheetType === "OBJECT" ? {} : { gridProperties: { rowCount: 1000, columnCount: 26 } }) } })),
      });
    }
    const valueRanges = [];
    for (const r of req.query.getAll("ranges")) {
      const title = /^'((?:[^']|'')*)'$/.exec(r)?.[1]?.replace(/''/g, "'") ?? r;
      const tab = sheet.tabs.find((t) => t.title === title);
      if (!tab) return json(res, 400, errors.rpc(400, "INVALID_ARGUMENT", `Unable to parse range: ${r}`));
      valueRanges.push({ range: `'${title}'!A1:Z1000`, majorDimension: "ROWS", ...(tab.values?.length ? { values: tab.values } : {}) });
    }
    return json(res, 200, { spreadsheetId: m[1], valueRanges });
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const [, host, ...rest] = url.pathname.split("/");
    // The request as recorded. `body` is filled in once read (it stays empty for requests a `use` handler answered).
    const r = {
      method: req.method,
      host,
      path: `/${rest.join("/")}`,
      query: url.searchParams,
      search: url.search,
      auth: req.headers.authorization ?? "",
      contentType: req.headers["content-type"] ?? "",
      body: Buffer.alloc(0),
      at: Date.now(),
    };
    state.requests.push(r);
    if (state.hang > 0) {
      state.hang--;
      setTimeout(() => req.socket.destroy(), state.holdMs).unref();
      return;
    }
    // Injected failures match on method, host, path and query (not the body).
    const failure = state.failures.find((x) => x.times > 0 && (!x.match || x.match(r)));
    if (failure) {
      failure.times--;
      return send(res, failure.status, failure.body ?? {}, failure.headers);
    }
    const token = /^Bearer (.+)$/.exec(r.auth)?.[1] ?? "";
    if (!state.validTokens.has(token)) {
      if (host === "www.googleapis.com") return json(res, 401, errors.drive(401, "authError", "Invalid Credentials", { location: "Authorization", locationType: "header" }), { "www-authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"' });
      return json(res, 401, errors.rpc(401, "UNAUTHENTICATED", "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential."));
    }
    try {
      // Chained node handlers (e.g. the Sheets and Slides fake): they see req.url without the host prefix, the host in
      // x-fake-host, read the body themselves, and return true (or a promise of true) when they answered.
      if (handlers.length) {
        const original = req.url;
        req.url = r.path + url.search;
        req.headers["x-fake-host"] = host;
        for (const h of handlers) if (await h(req, res)) return;
        req.url = original;
      }
      r.body = await readBody(req);
      for (const route of routes) {
        if (route.host === host && route.method === req.method && route.pattern.test(r.path)) return route.handler(r, { json: (status, body, headers) => json(res, status, body, headers), send: (status, body, headers) => send(res, status, body, headers), state, fake });
      }
      if (host === "www.googleapis.com") return drive(r, res);
      if (host === "docs.googleapis.com") return docsApi(r, res);
      if (host === "sheets.googleapis.com") return sheetsApi(r, res);
      return json(res, 404, errors.rpc(404, "NOT_FOUND", "Not Found"));
    } catch (err) {
      if (!res.headersSent) return json(res, 500, errors.rpc(500, "INTERNAL", `fake failed: ${err.message}`));
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  fake.origin = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}
