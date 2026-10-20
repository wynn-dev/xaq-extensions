// The MCP server: every ExtTool from the registry as an MCP tool. Errors come back as isError results in plain words
// (GoogleError and InputError messages are written for the agent); anything unexpected is reported briefly.
//
// Every result is held under MAX_RESULT_BYTES of JSON. xaq kills a child that writes a stdout message over 8 MB
// (five in a row mark the connection as failed), so a big answer must never get there: the structured copy goes
// first (xaq drops one over 1,000,000 characters anyway), then any binary blocks, then the text is cut with a note
// saying how to ask for less.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GoogleError, type GoogleClient } from "./google.ts";
import { allTools } from "./registry.ts";
import { type ExtTool, InputError, type ToolOutput } from "./tool.ts";

export const SERVER_NAME = "xaq-google-workspace";
export const VERSION = "1.0.0";

/** The most a result may serialise to (UTF-8 bytes of JSON): half of xaq's 8 MB message cap. */
export const MAX_RESULT_BYTES = 4_000_000;
/** xaq's MAX_STRUCTURED_CHARS (server/broker/policy/output.ts): a larger structuredContent is dropped by xaq. */
export const MAX_STRUCTURED_CHARS = 1_000_000;

const INSTRUCTIONS = [
  "Google Drive, Docs, Sheets and Slides for this account.",
  "Find files with drive_search or drive_list_folder; every other tool takes a file id or the file's Google link.",
  "Docs are read and written as markdown. docs_read pages long documents: pass nextOffset as offset.",
  "Edits: docs_append, docs_insert (at a heading), docs_replace_text; docs_overwrite replaces everything and asks first.",
].join(" ");

const LESS = "Ask for less: pass a smaller maxChars or pageSize, a narrower range, or continue from an offset or pageToken.";

const bytesOf = (r: CallToolResult) => Buffer.byteLength(JSON.stringify(r), "utf8");

/** Cuts a string to at most n UTF-16 units without splitting a surrogate pair. */
const cut = (s: string, n: number) => {
  let t = s.slice(0, Math.max(0, n));
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return t;
};

/** A tool's output as an MCP result, within MAX_RESULT_BYTES and xaq's structuredContent limit. */
export function shapeResult(out: ToolOutput, maxBytes = MAX_RESULT_BYTES): CallToolResult {
  const notes: string[] = [];
  let structured = out.structured;
  if (structured !== undefined && JSON.stringify(structured).length > MAX_STRUCTURED_CHARS) {
    structured = undefined;
    notes.push("[The structured copy of this result is left out: it's over the 1,000,000 characters xaq passes on. The text above has the result.]");
  }
  let resources = out.resources ?? [];
  let text = out.text;
  const build = (): CallToolResult => ({
    content: [{ type: "text", text: notes.length ? `${text}\n\n${notes.join("\n")}` : text }, ...resources.map((r) => ({ type: "resource" as const, resource: { uri: r.uri, mimeType: r.mimeType, blob: r.blob } }))],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  });
  let result = build();
  if (bytesOf(result) <= maxBytes) return result;
  if (structured !== undefined) {
    structured = undefined;
    notes.push("[The structured copy of this result is left out to keep the answer under 4 MB. The text above has the result.]");
    result = build();
    if (bytesOf(result) <= maxBytes) return result;
  }
  if (resources.length) {
    resources = [];
    notes.push("[The attached file is left out: it would make the answer larger than 4 MB.]");
    result = build();
    if (bytesOf(result) <= maxBytes) return result;
  }
  const total = text.length;
  notes.push(`[Cut here: the full answer is ${total.toLocaleString("en-US")} characters, more than the 4 MB returned at once. ${LESS}]`);
  // Shrink until it fits (multi-byte characters and JSON escapes make bytes ≥ characters).
  for (let i = 0; i < 20 && bytesOf(result) > maxBytes; i++) {
    const over = bytesOf(result) - maxBytes;
    const ratio = text.length / Math.max(1, Buffer.byteLength(JSON.stringify(text), "utf8"));
    text = cut(text, text.length - Math.ceil(over * ratio) - 1024);
    result = build();
  }
  return result;
}

/** The tool's answer as an MCP result. */
export async function toolResult(t: ExtTool, args: Record<string, unknown>, g: GoogleClient): Promise<CallToolResult> {
  try {
    return shapeResult(await t.run(args as never, g));
  } catch (err) {
    if (err instanceof GoogleError || err instanceof InputError) return { isError: true, content: [{ type: "text", text: err.message }] };
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    return { isError: true, content: [{ type: "text", text: `${t.name} failed unexpectedly: ${msg}` }] };
  }
}

export function createServer(g: GoogleClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  for (const t of allTools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: {
          title: t.title,
          readOnlyHint: t.risk === "read",
          destructiveHint: t.risk === "risky",
          idempotentHint: t.risk === "read",
          openWorldHint: true,
        },
        // The risk class and target the manifest must repeat (checked by test/manifest.test.mjs); xaq ignores these.
        _meta: { "xaq/risk": t.risk, ...(t.target ? { "xaq/target": t.target } : {}) },
      },
      async (args: Record<string, unknown>) => toolResult(t, args, g),
    );
  }
  return server;
}
