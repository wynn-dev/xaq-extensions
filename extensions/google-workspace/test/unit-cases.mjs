// Imported by unit.test.mjs when esbuild is installed. In-process tests of the modules behind dist: the markdown
// parser, the Docs request builder, Google's error mapping, the HTTP client's retry/timeout/URL rules (fetch, clock
// and sleep injected; no sockets), ids and paging, and the risk map against the source registry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { lib } from "./unit.mjs";

const { parseMarkdown, parseInline, stripDataImages, headingsOf, chunkRequests, cellRequests, classify, checkedUrl, serviceOf, testOrigin, retryAfterMs, HttpGoogleClient, GoogleError, fileId, pageText, qString, rfc3339, toCsv, searchQuery, multipart, parseExpiry, allTools } = lib;

const manifest = JSON.parse(readFileSync(new URL("../xaq-extension.json", import.meta.url), "utf8"));

describe("risk map", () => {
  it("equals every registered tool's risk and target, in the source", () => {
    const declared = Object.fromEntries(allTools.map((t) => [t.name, { class: t.risk, ...(t.target ? { target: t.target } : {}) }]));
    assert.deepEqual(declared, manifest.risk.tools);
  });
});

describe("parseInline", () => {
  it("bold, italic, strike, code, links and escapes, with UTF-16 offsets", () => {
    assert.deepEqual(parseInline("a **b** *c* ~~d~~ `e*f` [g](https://x.y/z) \\*h\\* 🎉 __i__"), {
      text: "a b c d e*f g *h* 🎉 i",
      spans: [
        { start: 2, end: 3, bold: true },
        { start: 4, end: 5, italic: true },
        { start: 6, end: 7, strike: true },
        { start: 8, end: 11, code: true },
        { start: 12, end: 13, link: "https://x.y/z" },
        { start: 21, end: 22, bold: true },
      ],
    });
  });
  it("leaves unmatched markers, snake_case and arithmetic alone", () => {
    assert.deepEqual(parseInline("2 * 3 = 6 and snake_case_name"), { text: "2 * 3 = 6 and snake_case_name", spans: [] });
    assert.deepEqual(parseInline("**open"), { text: "**open", spans: [] });
  });
  it("nests emphasis inside links and drops unsafe link targets", () => {
    assert.deepEqual(parseInline("[**go** there](https://a.b)"), { text: "go there", spans: [{ start: 0, end: 2, bold: true, link: "https://a.b" }, { start: 2, end: 8, link: "https://a.b" }] });
    assert.deepEqual(parseInline("[x](javascript:alert(1))").spans, []);
    assert.deepEqual(parseInline("<https://a.b/c>"), { text: "https://a.b/c", spans: [{ start: 0, end: 13, link: "https://a.b/c" }] });
  });
});

describe("parseMarkdown", () => {
  it("headings (ATX and setext), paragraphs, nested and ordered lists, quotes, code, tables; rules dropped", () => {
    const blocks = parseMarkdown("# Title\n\nPara one\ncontinues  \nhard break\n\nSub\n---\n\n- a\n  - b\n    1. c\n- d\n\n1. x\n2. y\n\n> q1\n> q2\n\n```js\nconst a = 1;\n\n```\n\n***\n\n| h1 | h\\|2 |\n|:--|--:|\n| **v** | w |\n");
    const view = blocks.map((b) => (b.kind === "table" ? { table: b.rows.map((r) => r.map((c) => c.text)) } : [b.style, b.inline.text, b.list ? `${b.list.ordered ? "ol" : "ul"}${b.list.level}` : "", b.quote ? "quote" : "", b.code ? "code" : ""].filter(Boolean).join(" | ")));
    assert.deepEqual(view, [
      "HEADING_1 | Title",
      "NORMAL_TEXT | Para one continues\u000bhard break",
      "HEADING_2 | Sub",
      "NORMAL_TEXT | a | ul0",
      "NORMAL_TEXT | b | ul1",
      "NORMAL_TEXT | c | ol2",
      "NORMAL_TEXT | d | ul0",
      "NORMAL_TEXT | x | ol0",
      "NORMAL_TEXT | y | ol0",
      "NORMAL_TEXT | q1 q2 | quote",
      "NORMAL_TEXT | const a = 1; | code",
      "NORMAL_TEXT | code",
      { table: [["h1", "h|2"], ["v", "w"]] },
    ]);
  });
});

describe("Drive's markdown export", () => {
  it("drops base64 images and counts them", () => {
    const md = "# T\n\n![][image1] and ![logo](data:image/png;base64,AAAA)\n\n[image1]: <data:image/png;base64,iVBORw0KGgo=>\n";
    assert.deepEqual(stripDataImages(md), { text: "# T\n\n[image] and [image: logo]\n", omitted: 2 });
    assert.deepEqual(stripDataImages("no images"), { text: "no images", omitted: 0 });
  });
  it("lists headings outside code fences", () => {
    assert.deepEqual(headingsOf("# A\n```\n# not\n```\n## B \\#1\n"), [
      { level: 1, text: "A" },
      { level: 2, text: "B #1" },
    ]);
  });
});

describe("Docs requests", () => {
  it("a run of paragraphs: one insert, explicit styles, then bullets bottom-up, and where E ends up", () => {
    const blocks = parseMarkdown("## H\n\n- **a**\n  - b\n\nend");
    const { requests, eStart, eLen } = chunkRequests(blocks, 10);
    assert.deepEqual(requests[0], { insertText: { location: { index: 10 }, text: "H\na\n\tb\nend" } });
    assert.deepEqual(requests[1].updateTextStyle.range, { startIndex: 10, endIndex: 20 });
    assert.deepEqual(requests[2], { deleteParagraphBullets: { range: { startIndex: 10, endIndex: 21 } } });
    assert.deepEqual(
      requests.filter((r) => r.updateParagraphStyle).map((r) => [r.updateParagraphStyle.paragraphStyle.namedStyleType, r.updateParagraphStyle.range]),
      [
        ["HEADING_2", { startIndex: 10, endIndex: 12 }],
        ["NORMAL_TEXT", { startIndex: 12, endIndex: 21 }],
      ],
    );
    assert.deepEqual(requests.find((r) => r.updateTextStyle?.textStyle.bold), { updateTextStyle: { range: { startIndex: 12, endIndex: 13 }, textStyle: { bold: true }, fields: "bold" } });
    assert.deepEqual(requests.at(-1), { createParagraphBullets: { range: { startIndex: 12, endIndex: 17 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    // "end" starts after H\n a\n b\n (one tab removed): 10 + 2 + 2 + 2 = 16.
    assert.deepEqual({ eStart, eLen }, { eStart: 16, eLen: 3 });
  });
  it("table cells are filled last first, header bold, at the indexes Docs reported", () => {
    const table = { table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 5 }] }, { content: [{ startIndex: 7 }] }] }, { tableCells: [{ content: [{ startIndex: 10 }] }, { content: [{ startIndex: 12 }] }] }] } };
    const rows = parseMarkdown("| a | b |\n|-|-|\n| c | |")[0].rows;
    const { requests, inserted } = cellRequests(table, rows);
    assert.deepEqual(requests.filter((r) => r.insertText).map((r) => [r.insertText.location.index, r.insertText.text]), [
      [10, "c"],
      [7, "b"],
      [5, "a"],
    ]);
    assert.equal(inserted, 3);
    assert.ok(requests.some((r) => r.updateTextStyle?.textStyle.bold && r.updateTextStyle.range.startIndex === 5));
    assert.ok(!requests.some((r) => r.updateTextStyle?.textStyle.bold && r.updateTextStyle.range.startIndex === 10));
  });
});

describe("Google's errors", () => {
  const body = (o) => o;
  it("maps each documented failure to plain words", () => {
    assert.equal(classify(401, {}, "drive.googleapis.com").error.code, "reconnect_required");
    const disabled = classify(403, body({ message: "Google Sheets API has not been used in project 9 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { consumer: "projects/9", service: "sheets.googleapis.com" } }] }), "sheets.googleapis.com").error;
    assert.equal(disabled.code, "api_disabled");
    assert.match(disabled.message, /The Google Sheets API is turned off .* https:\/\/console\.cloud\.google\.com\/apis\/library\/sheets\.googleapis\.com\?project=9$/);
    assert.equal(classify(403, body({ errors: [{ reason: "insufficientPermissions" }], message: "Insufficient Permission" }), "drive.googleapis.com").error.code, "insufficient_scope");
    assert.equal(classify(403, body({ errors: [{ reason: "appNotAuthorizedToFile" }] }), "drive.googleapis.com").error.code, "no_file_access");
    assert.deepEqual(
      [429, 500, 502, 503, 504].map((s) => classify(s, {}, "docs.googleapis.com").retry),
      [true, true, true, true, true],
    );
    assert.equal(classify(404, {}, "docs.googleapis.com").error.code, "not_found");
    assert.equal(classify(400, body({ message: "This operation is not supported for this document" }), "docs.googleapis.com").error.message.startsWith("That file isn't a Google Doc"), true);
  });
  it("never repeats an access token Google echoes", () => {
    const e = classify(400, body({ message: "bad ya29.a0AfH6SMBsecret thing" }), "docs.googleapis.com").error;
    assert.ok(!e.message.includes("a0AfH6SMBsecret"));
  });
  it("reads Retry-After as seconds or a date", () => {
    assert.equal(retryAfterMs(new Headers({ "retry-after": "3" }), 0), 3000);
    assert.equal(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" }), 4000), 6000);
    assert.equal(retryAfterMs(new Headers(), 0), null);
  });
});

describe("URLs", () => {
  it("only https://<name>.googleapis.com, and query values set, never appended raw", () => {
    assert.equal(checkedUrl("https://docs.googleapis.com/v1/documents/x", { a: "b c", skip: undefined, n: 2 }).href, "https://docs.googleapis.com/v1/documents/x?a=b+c&n=2");
    for (const bad of ["http://docs.googleapis.com/x", "https://evil.example/x", "https://googleapis.com.evil.example/x", "https://docs.googleapis.com:8443/x", "https://u:p@docs.googleapis.com/x", "https://a.b.googleapis.com/x", "file:///etc/passwd"]) {
      assert.throws(() => checkedUrl(bad, {}), /refusing|not a URL/, bad);
    }
    assert.equal(serviceOf(new URL("https://www.googleapis.com/upload/drive/v3/files")), "drive.googleapis.com");
    assert.equal(serviceOf(new URL("https://slides.googleapis.com/v1/presentations/x")), "slides.googleapis.com");
  });
  it("the test origin is honoured only for a bare loopback http origin", () => {
    assert.equal(testOrigin({ XAQ_EXT_GOOGLE_API: "http://127.0.0.1:4100" }), "http://127.0.0.1:4100");
    for (const v of ["https://127.0.0.1:1", "http://example.com", "http://127.0.0.1:1/x", "http://u:p@127.0.0.1:1", "nonsense", undefined]) assert.equal(testOrigin({ XAQ_EXT_GOOGLE_API: v }), null, String(v));
  });
});

describe("HttpGoogleClient", () => {
  function harness(responses, opts = {}) {
    const c = { t: 1_000_000, slept: [], calls: [], tokens: 0 };
    const client = new HttpGoogleClient({
      credentials: async () => ({ accessToken: `tok${++c.tokens}`, expiresAt: c.t + 3_600_000 }),
      now: () => c.t,
      sleep: async (ms) => {
        c.slept.push(ms);
        c.t += ms;
      },
      random: () => 0,
      fetch: async (url, init) => {
        c.calls.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next() : next;
      },
      ...opts,
    });
    return { c, client };
  }
  const res = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("caches the token, refreshes once on 401, then says reconnect", async () => {
    const { c, client } = harness([res(200, { a: 1 }), res(200, { b: 2 }), res(401), res(200, { c: 3 }), res(401), res(401)]);
    assert.deepEqual(await client.json("GET", "https://www.googleapis.com/drive/v3/files"), { a: 1 });
    await client.json("GET", "https://www.googleapis.com/drive/v3/files");
    assert.equal(c.tokens, 1);
    assert.deepEqual(await client.json("GET", "https://www.googleapis.com/drive/v3/files"), { c: 3 });
    assert.deepEqual(c.calls.map((x) => x.auth), ["Bearer tok1", "Bearer tok1", "Bearer tok1", "Bearer tok2"]);
    await assert.rejects(client.json("GET", "https://www.googleapis.com/drive/v3/files"), (e) => e instanceof GoogleError && e.code === "reconnect_required");
  });

  it("backs off 1 s then 2 s for GET 5xx, at most three tries; POST 5xx isn't retried", async () => {
    const { c, client } = harness([res(503), res(503), res(503), res(503)]);
    await assert.rejects(client.json("GET", "https://docs.googleapis.com/v1/documents/x"), (e) => e.code === "unavailable");
    assert.equal(c.calls.length, 3);
    assert.deepEqual(c.slept, [1000, 2000]);
    await assert.rejects(client.json("POST", "https://docs.googleapis.com/v1/documents/x:batchUpdate", { body: {} }), (e) => e.code === "unavailable");
    assert.equal(c.calls.length, 4);
  });

  it("honours Retry-After for any method, and holds other requests during a long one", async () => {
    const { c, client } = harness([res(429, {}, { "retry-after": "2" }), res(200, { ok: true }), res(429, {}, { "retry-after": "300" })]);
    assert.deepEqual(await client.json("POST", "https://docs.googleapis.com/v1/documents/x:batchUpdate", { body: {} }), { ok: true });
    assert.deepEqual(c.slept, [2000]);
    await assert.rejects(client.json("GET", "https://docs.googleapis.com/v1/documents/x"), (e) => e.code === "rate_limited" && /300 seconds/.test(e.message));
    await assert.rejects(client.json("GET", "https://docs.googleapis.com/v1/documents/y"), (e) => e.code === "rate_limited");
    assert.equal(c.calls.length, 3, "the held request never left");
  });

  it("refuses bodies over the cap and network errors on POST without a retry", async () => {
    const big = () => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array(600)); ctl.enqueue(new Uint8Array(600)); ctl.close(); } }), { status: 200 });
    const { c, client } = harness([big, new TypeError("fetch failed")], { maxBytes: 1000 });
    await assert.rejects(client.bytes("GET", "https://www.googleapis.com/drive/v3/files/x/export"), (e) => e.code === "too_large");
    await assert.rejects(client.json("POST", "https://www.googleapis.com/drive/v3/files", { body: {} }), (e) => e.code === "unavailable");
    assert.equal(c.calls.length, 2);
  });

  it("refuses a URL that isn't googleapis.com before asking for a token", async () => {
    const { c, client } = harness([]);
    await assert.rejects(client.json("GET", "https://evil.example/steal"), /refusing/);
    assert.equal(c.tokens, 0);
  });
});

describe("helpers", () => {
  it("fileId takes an id or a Google link, nothing else", () => {
    const id = "1DoCq3PlAnNiNgNoTeS0000000000000000000000aaa";
    for (const v of [id, ` ${id} `, `https://docs.google.com/document/d/${id}/edit`, `https://drive.google.com/file/d/${id}/view`, `https://drive.google.com/drive/folders/${id}`, `https://drive.google.com/open?id=${id}`]) assert.equal(fileId(v), id, v);
    assert.equal(fileId("root", "folder id", true), "root");
    for (const v of ["root", "short", `https://evil.example/d/${id}`, `http://docs.google.com/document/d/${id}`, "a/b/../../c0000000000"]) assert.throws(() => fileId(v), /isn't a Google/, v);
  });
  it("search q escaping, dates, CSV, paging, expiry, multipart", () => {
    assert.equal(qString("it's a \\ test"), "'it\\'s a \\\\ test'");
    assert.equal(searchQuery({ text: '"exact phrase"', ownedByMe: true }), "trashed = false and fullText contains '\"exact phrase\"' and 'me' in owners");
    assert.equal(rfc3339("2026-10-01", "x"), "2026-10-01T00:00:00.000Z");
    assert.equal(toCsv([["a,b", 'c"d', " e", null, 3]]), '"a,b","c""d"," e",,3');
    assert.deepEqual(pageText("ab\ncd\nef", 0, 6), { text: "ab\ncd\n", offset: 0, nextOffset: 6, total: 8 });
    assert.deepEqual(pageText("ab\ncd\nef", 0, 5), { text: "ab\ncd", offset: 0, nextOffset: 5, total: 8 }, "no line break in the last fifth: cut at maxChars");
    assert.deepEqual(pageText("😀😀😀", 0, 3).text, "😀");
    assert.equal(parseExpiry(1_700_000_000), 1_700_000_000_000);
    assert.equal(parseExpiry(null), null);
    const m = multipart({ name: "n" }, "# md", "text/markdown");
    const b = m.contentType.split("boundary=")[1];
    assert.equal(m.body.toString(), `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"n"}\r\n--${b}\r\nContent-Type: text/markdown\r\n\r\n# md\r\n--${b}--\r\n`);
  });
});
