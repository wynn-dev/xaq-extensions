// The MCP server: every ExtTool from the registry as an MCP tool. Errors come back as isError results in plain words
// (GoogleError and InputError messages are written for the agent); anything unexpected is reported briefly.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GoogleError, type GoogleClient } from "./google.ts";
import { allTools } from "./registry.ts";
import { type ExtTool, InputError } from "./tool.ts";

export const SERVER_NAME = "xaq-google-workspace";
export const VERSION = "1.0.0";

const INSTRUCTIONS = [
  "Google Drive and Google Docs for this account (Sheets and Slides tools too, when listed).",
  "Find files with drive_search or drive_list_folder; every other tool takes a file id or the file's Google link.",
  "Docs are read and written as markdown. docs_read pages long documents: pass nextOffset as offset.",
  "Edits: docs_append, docs_insert (at a heading), docs_replace_text; docs_overwrite replaces everything and asks first.",
].join(" ");

/** The tool's answer as an MCP result. */
export async function toolResult(t: ExtTool, args: Record<string, unknown>, g: GoogleClient): Promise<CallToolResult> {
  try {
    const out = await t.run(args as never, g);
    return { content: [{ type: "text", text: out.text }], ...(out.structured ? { structuredContent: out.structured } : {}) };
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
