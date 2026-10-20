// The internal tool shape every module (drive.ts, docs.ts, sheets.ts, slides.ts) exports a list of. server.ts registers
// each ExtTool as an MCP tool; test/manifest checks that the manifest's risk.tools equals the tools' `risk` and
// `target`, so the two can't drift. This interface is shared with the Sheets and Slides writers: change it only with
// them.

import type { z } from "zod";
import type { GoogleClient } from "./google.ts";

export type Risk = "read" | "write" | "risky";

export interface ToolOutput {
  text: string;
  /**
   * The same result as JSON (structuredContent). Kept under 1,000,000 characters of JSON: xaq drops a larger one,
   * and the server drops it first (saying so in the text) when a result is too big.
   */
  structured?: Record<string, unknown>;
  /** Binary content, returned as MCP `resource` blocks (xaq passes blobs up to 5 MB decoded). Optional; added after the first version. */
  resources?: { uri: string; mimeType: string; blob: string }[];
}

export interface ExtTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  risk: Risk;
  /** JSON Pointer into the args naming the target for "always allow for this target" (optional). */
  target?: string;
  run(args: z.infer<z.ZodObject<S>>, g: GoogleClient): Promise<ToolOutput>;
}

/** Identity, for inference: `export const fooTools = [tool({ ... }), ...]`. */
export function tool<S extends z.ZodRawShape>(t: ExtTool<S>): ExtTool<S> {
  return t;
}

/** A problem with the tool's arguments, in plain words for the agent (returned as an isError result, never retried). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
