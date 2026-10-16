// node --test test/: the repo's own scripts (integrity vectors, the manifest validator, the index check).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkIndex } from "../scripts/build-index.mjs";
import { checkVectors, computeIntegrity } from "../scripts/integrity.mjs";
import { checkExtension, validate } from "../scripts/validate.mjs";
import { readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../schema/xaq-extension.schema.json", import.meta.url), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "xaq-ext-scripts-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const remote = (name) => ({
  schema: 1,
  name,
  displayName: "Demo",
  version: "1.0.0",
  description: "A demo.",
  kind: "remote",
  slug: "demo",
  remote: { url: "https://mcp.example.com/mcp", auth: { type: "mcp_oauth" } },
});

function ext(name, manifest, files = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "xaq-extension.json"), JSON.stringify(manifest));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe("integrity", () => {
  it("agrees with the shared vectors", () => {
    assert.deepEqual(checkVectors(new URL("./fixtures/extension-integrity", import.meta.url).pathname), []);
  });
  it("refuses symlinks", () => {
    const dir = ext("linked", remote("linked"));
    symlinkSync("xaq-extension.json", join(dir, "link"));
    assert.throws(() => computeIntegrity(dir), /symlink/);
  });
});

describe("validate", () => {
  it("accepts a good remote manifest", () => {
    assert.deepEqual(checkExtension(ext("demo", remote("demo")), schema), []);
  });
  it("refuses unknown keys, a bad kind and a name that isn't the directory's", () => {
    assert.match(validate(schema, { ...remote("demo"), extra: 1 }).join("\n"), /extra: unknown key/);
    assert.ok(validate(schema, { ...remote("demo"), kind: "plugin" }).length > 0);
    assert.match(checkExtension(ext("other", remote("demo")), schema).join("\n"), /must be the directory's name/);
  });
  it("refuses node_modules and install scripts", () => {
    const dir = ext("deps", remote("deps"), { "node_modules/x/index.js": "", "package.json": JSON.stringify({ scripts: { postinstall: "curl evil" } }) });
    const problems = checkExtension(dir, schema).join("\n");
    assert.match(problems, /node_modules isn't allowed/);
    assert.match(problems, /"postinstall" scripts aren't allowed/);
  });
});

describe("index check", () => {
  it("refuses a malformed index", () => {
    assert.ok(checkIndex({ schema: 2 }).length > 0);
    const problems = checkIndex({ schema: 1, extensions: [{ name: "x", displayName: "", description: "", kind: "remote", version: "1.0.0", path: "elsewhere", commit: "abc", integrity: "" }] });
    assert.match(problems.join("\n"), /path must be extensions\/x/);
    assert.match(problems.join("\n"), /40-hex/);
  });
});
