// The manifest against the contract (xaq docs/EXTENSIONS.md) and the running server: the risk map must equal every
// tool's declared risk and target (the server publishes them in each tool's _meta), so the two can't drift.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { manifest, setup } from "./helpers.mjs";

const m = manifest();

describe("xaq-extension.json", () => {
  it("is a code extension named google-workspace with default slug workspace", () => {
    assert.deepEqual(Object.keys(m).sort(), ["code", "description", "displayName", "kind", "name", "risk", "schema", "setup", "slug", "version"]);
    assert.equal(m.name, "google-workspace");
    assert.equal(m.slug, "workspace");
    assert.equal(m.kind, "code");
    assert.deepEqual(Object.keys(m.code).sort(), ["auth", "entry", "events", "network", "node"]);
    assert.equal(m.code.entry, "dist/server.mjs");
    assert.equal(m.code.node, ">=22.23.2", "xaq's host floor");
    assert.deepEqual(m.code.events, []);
  });

  it("asks core for downscoped Google tokens with exactly the settled scopes and APIs", () => {
    assert.deepEqual(m.code.auth, {
      type: "google",
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      apis: [
        { service: "docs.googleapis.com", label: "Google Docs API" },
        { service: "sheets.googleapis.com", label: "Google Sheets API" },
        { service: "slides.googleapis.com", label: "Google Slides API" },
        { service: "drive.googleapis.com", label: "Google Drive API" },
      ],
    });
  });

  it("declares every Google API host the code builds URLs for", () => {
    assert.deepEqual([...m.code.network].sort(), ["docs.googleapis.com", "sheets.googleapis.com", "slides.googleapis.com", "www.googleapis.com"]);
  });

  it("has short setup copy with only allowed keys and no template variables", () => {
    for (const s of m.setup) {
      for (const k of Object.keys(s)) assert.ok(["id", "title", "body"].includes(k), k);
      assert.ok(!/\{\{/.test(JSON.stringify(s)));
    }
  });

  it("follows the owner's rule: reads read, edits write, overwrite risky, no delete or share tools", () => {
    for (const [name, r] of Object.entries(m.risk.tools)) {
      if (/(^|_)(delete|remove|trash|share|permission)/.test(name)) assert.equal(r.class, "risky", name);
      if (/_(read|search|get|list|export|comments_list|list_folder)$/.test(name)) assert.equal(r.class, "read", name);
    }
    assert.equal(m.risk.tools.docs_overwrite.class, "risky");
  });
});

describe("the risk map equals the tools' declared risk and target", () => {
  let s;
  before(async () => {
    s = await setup();
  });
  after(async () => s.close());

  it("lists exactly the manifest's tools, each with its class and target", async () => {
    const { tools } = await s.ext.request("tools/list");
    const declared = Object.fromEntries(tools.map((t) => [t.name, { class: t._meta["xaq/risk"], ...(t._meta["xaq/target"] ? { target: t._meta["xaq/target"] } : {}) }]));
    assert.deepEqual(declared, m.risk.tools);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, t._meta["xaq/risk"] === "read", t.name);
      assert.equal(t.annotations.destructiveHint, t._meta["xaq/risk"] === "risky", t.name);
      const target = t._meta["xaq/target"];
      if (target) assert.ok(Object.hasOwn(t.inputSchema.properties, target.slice(1)), `${t.name}: ${target} is a top-level argument`);
    }
  });
});
