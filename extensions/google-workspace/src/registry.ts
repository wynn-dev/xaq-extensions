// Every tool the server lists, in this order. The manifest's risk.tools must equal their risk and target
// (test/manifest.test.mjs checks it through the running server, test/unit-cases.mjs against this list).
import { docsTools } from "./docs.ts";
import { driveTools } from "./drive.ts";
import { sheetsTools } from "./sheets.ts";
import { slidesTools } from "./slides.ts";
import type { ExtTool } from "./tool.ts";

export const allTools: ExtTool[] = [...driveTools, ...docsTools, ...sheetsTools, ...slidesTools] as ExtTool[];

const names = new Set<string>();
for (const t of allTools) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`bad tool name ${t.name}`);
  if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
  names.add(t.name);
}
