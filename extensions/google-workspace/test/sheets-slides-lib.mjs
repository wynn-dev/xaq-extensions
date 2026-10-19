// Bundles src/sheets.ts and src/slides.ts (with zod) for the in-process tests, or returns null when esbuild isn't
// installed (`npm ci --ignore-scripts` at the repo root installs it), so a bare `node --test` skips instead of failing.
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));

export async function loadSheetsSlides() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
  mkdirSync(tmp, { recursive: true });
  const out = `${tmp}google-workspace-sheets-slides-${process.pid}.mjs`;
  await esbuild.build({
    // zod too, so the tests validate arguments the way the server does before a tool runs (defaults included).
    stdin: { contents: 'export * from "./src/sheets.ts";\nexport * from "./src/slides.ts";\nexport { z } from "zod";\n', resolveDir: root, loader: "ts", sourcefile: "sheets-slides-entry.ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    outfile: out,
    logLevel: "warning",
  });
  return import(pathToFileURL(out).href);
}

export const SKIP = "esbuild isn't installed (run npm ci --ignore-scripts at the repo root)";

/** Runs a tool as the server would: arguments validated (and defaulted) by the tool's own zod shape first. */
export function caller(lib, client) {
  return async (tools, name, args) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(lib.z.object(tool.input).strict().parse(args), client);
  };
}
