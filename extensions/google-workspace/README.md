# Google Workspace extension for xaq

A `code` extension (xaq `docs/EXTENSIONS.md`): one bundled MCP server, `dist/server.mjs`, that xaq runs out of
process for each Google Workspace connection. It gives agents Google Docs, Sheets and Slides, plus the parts of Drive
they need to find, export and upload files. Agents see the tools as `workspace__<tool>` (default slug `workspace`).

This part covers Drive and Docs. The Sheets and Slides tools (`src/sheets.ts`, `src/slides.ts`) are documented in
their own section once they land.

## Tools

Every file argument takes the id or the file's Google link (`https://docs.google.com/document/d/<id>/…`,
`https://drive.google.com/drive/folders/<id>`, `?id=<id>`). The link is only parsed for the id, never fetched.
Errors come back as `isError` results in plain words.

| Tool | Risk | Input | Output |
| --- | --- | --- | --- |
| `drive_search` | read | `name?`, `text?` (full text; `"…"` for a phrase), `type?` doc\|sheet\|slides\|pdf\|folder\|any, `folderId?`, `modifiedAfter?`, `modifiedBefore?` (date or date-time), `ownedByMe?`, `includeSharedDrives?`, `pageSize?` 1–100 (25), `pageToken?` | `files[]`: id, name, type, mimeType, modifiedTime, owner, webViewLink, size?, shortcutTo?; `nextPageToken` |
| `drive_list_folder` | read | `folderId?` (default `root`), `type?`, `pageSize?`, `pageToken?` | as above, folders first, then by name |
| `drive_get` | read | `fileId` | details: owner, last modified by, created, size, parents, shared, trashed, canEdit, canComment, `exportFormats` |
| `drive_export` | read | `fileId`, `format` markdown\|text\|csv\|pdf\|docx\|xlsx\|pptx, `tab?`, `offset?`, `maxChars?` (20,000), `includeBase64?` | text formats: the text, paged (`nextOffset`, `totalChars`); binary: `size`, and `base64` if asked and ≤ 3 MB |
| `drive_create_folder` | write | `name`, `parentId?` | `folderId`, name, webViewLink, parents |
| `drive_upload` | write | `name`, `folderId?`, `mimeType?` (guessed from the name), `content_base64` (≤ 5 MB decoded) | `fileId`, name, mimeType, size, webViewLink, parents |
| `drive_trash` | **risky** | `fileId` | moves to the Trash (never a permanent delete); `fileId`, name, type, `trashed: true` |
| `docs_read` | read | `documentId`, `offset?`, `maxChars?` (20,000) | the Doc as markdown, paged; first page lists `headings` |
| `docs_create` | write | `title`, `markdown?`, `folderId?` | `documentId`, name, webViewLink |
| `docs_append` | write | `documentId`, `markdown` | paragraphs and tables added |
| `docs_insert` | write | `documentId`, `markdown`, `position` start\|end\|before_heading\|after_heading\|end_of_section, `heading?` | as above |
| `docs_replace_text` | write | `documentId`, `find`, `replace`, `matchCase?` (true) | `occurrencesChanged` (0: nothing changed) |
| `docs_overwrite` | **risky** | `documentId`, `markdown` | replaces the whole body of the first tab |
| `docs_comments_list` | read | `documentId`, `includeResolved?`, `pageSize?` (50), `pageToken?` | `comments[]`: id, author, content, quoted, resolved, createdTime, replies |
| `docs_comment_add` | write | `documentId`, `text`, `replyToCommentId?` | `commentId` (or `replyId`) |

The risk classes follow the owner's rule. Reads are free. Creating and editing (`write`) goes through by default.
Overwriting a whole document and moving files to the Trash are `risky`: xaq asks first. Nothing changes sharing or
permissions. The manifest's `risk.tools` must equal each tool's declared `risk` and `target` (the JSON Pointer
naming the file, for "always allow for this target"). Two tests check that, against the running server (which
publishes them in each tool's `_meta`) and against the source registry.

### Markdown

- **Reading** uses Drive's export to `text/markdown`. Images, which the export embeds as base64 data URIs, are
  replaced by `[image]`.
- **Creating** uploads the markdown to Drive with conversion to a Google Doc, so Google does the conversion.
- **Editing** (`docs_append`, `docs_insert`, `docs_overwrite`) builds Docs API `batchUpdate` requests from the
  markdown, because that works on every Doc the account can edit:
  - headings 1–6 (ATX and setext);
  - paragraphs, with hard line breaks;
  - bullet and numbered lists, nested;
  - block quotes (indented, italic) and fenced code (monospace);
  - tables (header row bold);
  - inline **bold**, *italic*, ~~strike~~, `code` and links.

  Horizontal rules are dropped, and images become a linked `[image: alt]`. Each batch carries
  `writeControl.requiredRevisionId`, so an edit someone makes at the same moment fails the call instead of landing
  in the wrong place.

## Setup (with xaq core)

Core renders the Google account picker, the links to enable each API and the consent steps for `code.auth.type:
"google"`. It hands the extension access tokens through `xaq/credentials/get`, already downscoped to the manifest's
scopes. The manifest's setup copy only says what the extension does and what each permission is for. The APIs to
enable in the user's Google Cloud project are the Docs, Sheets, Slides and Drive APIs (`code.auth.apis`).

### Scopes, and why

| Scope | For |
| --- | --- |
| `documents` | Read and edit any Doc the account can edit (`docs_append`, `docs_insert`, `docs_replace_text`, `docs_overwrite`). |
| `spreadsheets`, `presentations` | The same for Sheets and Slides (and per-tab CSV in `drive_export`). |
| `drive.readonly` | Search, list folders, file details, export, and read comments, for every file. |
| `drive.file` | Create files and folders, upload, and comment on or trash **files the extension created**. |

There is no full `drive` scope. As a result, `docs_comment_add` and `drive_trash` work only on files the extension
created. Google's reference lists only `drive` and `drive.file` for `comments.create`, and `files.update` behaves the
same way. On other files they answer in plain words. Editing a Doc's content works everywhere, through the Docs API.

## Limits

- Text pages are 1,000–100,000 characters (20,000 by default). Drive exports at most 10 MB, and the extension
  refuses any answer over 12 MB.
- Binary exports come back as base64 only on request and only up to 3 MB. Files can't be saved for the agent:
  the sandbox can write only to the extension's own state directory, which the agent can't reach. To send a file by
  email, attach it from Drive by its id. Uploads are at most 5 MB decoded, to stay within xaq's 8 MB message limit.
- A sheet's CSV goes through the Sheets API, one CSV per tab: Drive's CSV export has only the first tab.
- `docs_overwrite`, `docs_insert` and `docs_append` work on the first tab of a Doc with tabs.
  `docs_replace_text` works on all tabs. Headers and footers are untouched.
- A table that isn't preceded by text in the inserted markdown gets an empty paragraph before it: Docs inserts a
  newline before every table. A table at the very end leaves an empty paragraph after it.
- Comments added through the API apply to the whole document: Google's editors don't render API comments anchored
  to text.

## The client (`src/google.ts`)

- **Hosts:** it fetches only `https://<name>.googleapis.com` URLs that the tools build from constants, never one
  taken from tool input.
- **Timeouts:** 25 s per attempt and a 45 s deadline per request, within xaq's 60 s per call.
- **Size cap:** answers over 12 MB are refused before they're buffered.
- **Errors:**
  - 401: one fresh token from xaq, then "Reconnect Google Workspace in xaq".
  - A disabled API: "The Google Docs API is turned off…", with the enable link for the user's project.
  - A missing scope: re-consent.
  - `drive.file` refusals, 404 and a view-only file each get their own plain words.
  - Google's own message is passed on for a 400.
- **Retries:** 429 and Drive's rate-limit 403s are retried for any method, honouring `Retry-After`. 5xx and network
  errors are retried only for GET, so a create is never sent twice. At most three tries, backing off 1 s then 2 s,
  plus jitter. A `Retry-After` over 20 s isn't waited for: the call says when to try again, and the connection sends
  nothing until then.
- **Tokens:** never logged, written or echoed. Google's messages are scrubbed of `ya29.` tokens.

## Building and testing

From the repo root: `npm ci --ignore-scripts`, then:
- `npm run build:google-workspace` writes `dist/server.mjs` and `THIRD_PARTY_LICENSES`; commit both;
- `npm run check:dist:google-workspace` checks they're up to date (CI);
- `npm run typecheck:google-workspace`;
- `npm run test:google-workspace`.

`.github/workflows/google-workspace.yml` runs these on Node 22.13.0 and 24.

The tests run the built `dist/server.mjs` exactly as xaq spawns it: `node --permission --no-experimental-sqlite`,
one `--allow-fs-read`/`--allow-fs-write` flag per path, and the minimal environment. The harness answers
`xaq/credentials/get`. The extension talks to a loopback fake of the Google APIs (`test/fake-google.mjs`): Drive v3
files, export, upload and comments; Docs v1 `documents.get` and `batchUpdate` over a small document model
(`test/fake-docs.mjs`); and Sheets v4 for CSV.

**The fixtures were written by hand from Google's documented response shapes. No live Google account was used.**
The `XAQ_EXT_GOOGLE_API` override that points the extension at the fake is honoured only for a loopback `http`
origin; xaq never sets it.

| File | What |
| --- | --- |
| `test/extension.test.mjs` | The spawn argv and environment. The token reaches nothing: not stdout, stderr, `xaq/log`, files or tool output. Nothing is written. Token rotation after a 401, reconnect, no events, exit on SIGTERM and on stdin close. |
| `test/drive.test.mjs` | Each Drive tool: the `q` it builds (escaping, filters, no `orderBy` with full text), paging, export by type (CSV per tab, base64 cap, 10 MB limit), folders, upload bytes, trash. |
| `test/docs.test.mjs` | Each Docs tool: markdown read and paging, create by upload, append, insert at every position (checked on the document model), replace counts, overwrite in one batch, revision conflicts, comments and replies, ids as links. |
| `test/errors.test.mjs` | Disabled APIs (both error shapes), scope, view-only, 404, 429 short and long, rate-limit 403s, 5xx retry for GET only, timeouts, the size cap, Google's 400 messages. |
| `test/manifest.test.mjs` | The manifest against the contract, and `risk.tools` equal to what the server declares. |
| `test/unit.test.mjs` | In-process (needs esbuild; skipped in the repo's generic CI): the markdown parser, the Docs request builder, error mapping, the client's retry, timeout and URL rules with an injected clock, ids and paging, and the risk map against the registry. |

## Live smoke test

Core's command runs the live check on a real account through xaq: `xaq smoke google-workspace --scratch`. It works
in a scratch folder it creates (`drive_create_folder`), makes and edits its own files there, and moves them to the
Trash afterwards (`drive_trash`). This repository has no separate smoke script.

## Google API facts this relies on (verified 2026-10-19)

- **Drive exports Docs as `text/markdown`** (`.md`): it is listed under Documents in Drive's export MIME types (last
  updated 2026-09-03), <https://developers.google.com/workspace/drive/api/guides/ref-export-formats>. Sheets export
  CSV for the first sheet only. `files.export` is limited to 10 MB and accepts `drive.readonly` and `drive.file`,
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export>.
- **Drive imports Markdown into Google Docs:** "Markdown" is among the formats that convert to Docs. To convert,
  set the Google Workspace `mimeType` in the metadata of a multipart upload,
  <https://developers.google.com/workspace/drive/api/guides/manage-uploads>.
- **Comments:**
  - `comments.create` needs `drive` or `drive.file`, and `fields` is required,
    <https://developers.google.com/workspace/drive/api/reference/rest/v3/comments/create>;
  - Docs editors treat API comments as unanchored,
    <https://developers.google.com/workspace/drive/api/guides/manage-comments>.
- **Docs `batchUpdate`**
  (<https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request>):
  - `insertTable` puts a newline before the table, which starts at location + 1;
  - a new paragraph copies the style and bullets of the paragraph it splits;
  - `createParagraphBullets` takes the nesting from leading tabs and removes them;
  - text can't be inserted at a table's start;
  - the body's last newline can't be deleted.
- **Drive search terms** (`name contains`, `fullText contains`, `mimeType`, `in parents`, `in owners`,
  `modifiedTime` in RFC 3339, `\'` to escape a quote),
  <https://developers.google.com/workspace/drive/api/guides/ref-search-terms>.
