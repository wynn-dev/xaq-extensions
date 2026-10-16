// node --test test/: the repo's own scripts (integrity vectors, the manifest validator, the index check).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkIndex } from "../scripts/build-index.mjs";
import { checkVectors, computeIntegrity } from "../scripts/integrity.mjs";
import { checkExtension, forbiddenAttributes, validate } from "../scripts/validate.mjs";
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
  it("refuses export-ignore and export-subst in any .gitattributes", () => {
    const root = join(tmp, "attrs");
    mkdirSync(join(root, "extensions", "x"), { recursive: true });
    writeFileSync(join(root, ".gitattributes"), "*.md text\n# export-ignore in a comment is fine\n");
    assert.deepEqual(forbiddenAttributes(root), []);
    writeFileSync(join(root, "extensions", "x", ".gitattributes"), "secret.txt export-ignore\nversion.js export-subst\n");
    assert.equal(forbiddenAttributes(root).length, 2);
  });

  it("refuses node_modules and install scripts", () => {
    const dir = ext("deps", remote("deps"), { "node_modules/x/index.js": "", "package.json": JSON.stringify({ scripts: { postinstall: "curl evil" } }) });
    const problems = checkExtension(dir, schema).join("\n");
    assert.match(problems, /node_modules isn't allowed/);
    assert.match(problems, /"postinstall" scripts aren't allowed/);
  });
});

describe("index pins against the base branch", () => {
  const script = new URL("../scripts/build-index.mjs", import.meta.url).pathname;
  const repo = join(tmp, "repo");
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, stdio: "pipe" })
      .toString()
      .trim();
  const write = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const check = () => {
    try {
      return { ok: true, out: execFileSync("node", [script, "--check", "--base", "main"], { cwd: repo, stdio: "pipe" }).toString() };
    } catch (err) {
      return { ok: false, out: `${err.stdout}${err.stderr}` };
    }
  };
  const pin = (commit) => {
    const index = JSON.parse(execFileSync("node", [script, "--commit", commit], { cwd: repo }).toString());
    write("index.json", `${JSON.stringify(index, null, 2)}\n`);
  };

  it("set up: main has demo 1.0.0, released", () => {
    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "main");
    write("extensions/demo/xaq-extension.json", JSON.stringify(remote("demo")));
    write("index.json", '{ "schema": 1, "extensions": [] }\n');
    git("add", ".");
    git("commit", "-q", "-m", "demo");
    pin(git("rev-parse", "HEAD"));
    git("commit", "-q", "-am", "release demo");
    assert.equal(check().ok, true, check().out);
  });

  it("refuses a pin on a commit that isn't on main (bad code added, reverted, index pointed at it)", () => {
    git("checkout", "-q", "-b", "attack");
    write("extensions/demo/xaq-extension.json", JSON.stringify({ ...remote("demo"), version: "1.0.1", description: "evil" }));
    git("commit", "-q", "-am", "A: bad code");
    const a = git("rev-parse", "HEAD");
    write("extensions/demo/xaq-extension.json", JSON.stringify(remote("demo")));
    git("commit", "-q", "-am", "B: revert");
    pin(a);
    git("commit", "-q", "-am", "point the index at A");
    const r = check();
    assert.equal(r.ok, false);
    assert.match(r.out, /isn't on main/);
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "attack");
  });

  it("refuses a pin on main whose files aren't this tree's, and accepts a correct release", () => {
    write("extensions/demo/xaq-extension.json", JSON.stringify({ ...remote("demo"), version: "1.1.0" }));
    git("commit", "-q", "-am", "demo 1.1.0");
    const v11 = git("rev-parse", "HEAD");
    write("extensions/demo/xaq-extension.json", JSON.stringify({ ...remote("demo"), version: "1.2.0" }));
    git("commit", "-q", "-am", "demo 1.2.0");
    const v12 = git("rev-parse", "HEAD");
    // Pinning 1.1.0 (on main, but not the files this tree has) is refused.
    git("checkout", "-q", "-b", "stale");
    pin(v11);
    git("commit", "-q", "-am", "pin an older commit");
    const stale = check();
    assert.equal(stale.ok, false);
    assert.match(stale.out, /aren't the files in this tree/);
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "stale");
    // The release flow: the extension is on main, the index pins it.
    git("checkout", "-q", "-b", "release");
    pin(v12);
    git("commit", "-q", "-am", "release demo 1.1.0");
    const ok = check();
    assert.equal(ok.ok, true, ok.out);
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
