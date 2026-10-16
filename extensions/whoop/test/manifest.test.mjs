// The manifest against the contract (xaq docs/EXTENSIONS.md) and the server, and the verbatim dashboard copies.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { goldens } from "./helpers.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url));
const manifest = JSON.parse(read("../xaq-extension.json"));

describe("xaq-extension.json", () => {
  it("has only the contract's keys, and is a code extension with default slug whoop", () => {
    assert.deepEqual(Object.keys(manifest).sort(), ["code", "description", "displayName", "kind", "name", "risk", "schema", "setup", "slug", "version"]);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.name, "whoop");
    assert.match(manifest.name, /^[a-z0-9-]{1,32}$/);
    assert.equal(manifest.slug, "whoop");
    assert.equal(manifest.kind, "code");
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(manifest.code).sort(), ["auth", "entry", "events", "network", "node"]);
    assert.equal(manifest.code.entry, "dist/server.mjs");
    assert.equal(manifest.code.node, ">=22.13");
    assert.deepEqual(manifest.code.network, ["api.prod.whoop.com"]);
    assert.deepEqual(manifest.code.events, [], "no polling, so no events");
  });

  it("uses xaq's WHOOP OAuth facts (user_app, offline for refresh)", () => {
    assert.deepEqual(manifest.code.auth, {
      type: "user_app",
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      scopes: ["read:recovery", "read:cycles", "read:workout", "read:sleep", "read:profile", "read:body_measurement", "offline"],
      clientIdInput: "client_id",
      clientSecretInput: "client_secret",
      refreshScope: "offline",
    });
  });

  it("classifies every tool the server lists, all as read", () => {
    const listed = goldens().cases.find((c) => c.name === "tools/list").result.tools.map((t) => t.name).sort();
    assert.deepEqual(Object.keys(manifest.risk.tools).sort(), listed);
    for (const [name, cls] of Object.entries(manifest.risk.tools)) assert.deepEqual(cls, { class: "read" }, name);
  });

  it("has setup steps with the redirect URI to copy and both app inputs, using only allowed placeholders", () => {
    const ids = manifest.setup.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of manifest.setup) {
      for (const k of Object.keys(s)) assert.ok(["id", "title", "body", "link", "copy", "input"].includes(k), k);
      for (const m of JSON.stringify(s).matchAll(/\{\{(\w+)\}\}/g)) assert.ok(["publicUrl", "redirectUri", "webhookUrl"].includes(m[1]), m[1]);
    }
    assert.ok(manifest.setup.some((s) => s.id === "reuse" && s.copy?.value === "{{redirectUri}}"));
    assert.deepEqual(manifest.setup.filter((s) => s.input).map((s) => s.input.key), ["client_id", "client_secret"]);
    assert.equal(manifest.setup.find((s) => s.input?.key === "client_secret").input.secret, true);
  });
});

describe("src/dashboard", () => {
  const upstream = JSON.parse(read("../src/dashboard/UPSTREAM.json"));
  const sha = (buf) => `sha256-${createHash("sha256").update(buf).digest("hex")}`;

  it("is the dashboard's code at the recorded commit, verbatim except the files listed as changed", () => {
    for (const [file, hash] of Object.entries(upstream.files)) {
      assert.equal(sha(read(`../src/dashboard/${file}`)), hash, file);
      if (!upstream.changed[file]) assert.equal(hash, upstream.upstreamFiles[file], `${file} is verbatim`);
    }
    assert.deepEqual(Object.keys(upstream.changed), ["mcp.ts"]);
    assert.equal(goldens().source.commit, upstream.commit, "goldens come from the same commit");
  });

  it("changes in mcp.ts are exactly the listed rewordings of dashboard-UI error texts", async () => {
    const { INTENTIONAL_DIFFERENCES, intended } = await import("../scripts/parity.mjs");
    let source = read("../src/dashboard/mcp.ts").toString("utf8");
    for (const [from, to] of INTENTIONAL_DIFFERENCES) {
      assert.ok(!source.includes(`'${from}'`), `old text gone: ${from}`);
      assert.ok(source.includes(`'${to}'`), `new text present: ${to}`);
      assert.ok(/\bxaq\b/.test(to) && !/dashboard/i.test(to), to);
      assert.equal(intended(from), to);
      assert.equal(intended(to), to);
      // Undoing the rewording must give back the upstream file byte for byte.
      source = source.replace(`'${to}'`, `'${from}'`);
    }
    assert.equal(sha(Buffer.from(source, "utf8")), upstream.upstreamFiles["mcp.ts"]);
    for (const [from, to] of goldens().intentionalDifferences) assert.equal(intended(from), to);
  });
});
