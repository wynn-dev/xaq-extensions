// Bundles src/testing.ts for in-process unit tests (the modules behind dist, with injectable clocks and fetch).
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = fileURLToPath(new URL("../../../.tmp/google-workspace-testing.mjs", import.meta.url));
mkdirSync(fileURLToPath(new URL("../../../.tmp/", import.meta.url)), { recursive: true });
await build({ entryPoints: [`${root}src/testing.ts`], bundle: true, platform: "node", format: "esm", target: "node22.13", outfile: out, logLevel: "warning", banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' } });
export const lib = await import(pathToFileURL(out).href);
