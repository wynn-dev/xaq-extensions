// The in-process unit tests (unit-cases.mjs) need esbuild to bundle src/ for them: `npm ci --ignore-scripts` at the
// repo root, as the google-workspace workflow does. The repo's generic CI runs extension tests without installing
// anything, so there they're skipped; every other test file runs the committed dist and needs nothing.
import { test } from "node:test";

let available = true;
try {
  await import("esbuild");
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  available = false;
}
if (available) await import("./unit-cases.mjs");
else test("unit tests", { skip: "esbuild isn't installed (run npm ci --ignore-scripts at the repo root)" }, () => {});
