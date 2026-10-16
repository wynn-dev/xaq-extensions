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
  it("is the dashboard's code, verbatim, at the recorded commit", () => {
    const upstream = JSON.parse(read("../src/dashboard/UPSTREAM.json"));
    for (const [file, hash] of Object.entries(upstream.files)) {
      assert.equal(`sha256-${createHash("sha256").update(read(`../src/dashboard/${file}`)).digest("hex")}`, hash, file);
    }
    assert.equal(goldens().source.commit, upstream.commit, "goldens come from the same commit");
  });
});
