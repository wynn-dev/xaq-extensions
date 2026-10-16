#!/usr/bin/env node
// Extension integrity, exactly as xaq computes it (xaq: server/extensions/integrity.ts; contract: xaq's
// docs/EXTENSIONS.md). Plain Node, no dependencies.
//
// sha256 over a canonical listing of the extension directory: for each regular file, sorted by POSIX path relative to
// the extension root (byte order of the UTF-8 path), the line `<path>\0<mode 644|755>\0<hex sha256 of content>\n`.
// Symlinks, devices and anything that isn't a regular file or a directory are refused. Encoded as `sha256-<base64>`.
//
//   node scripts/integrity.mjs <dir>…                 print each directory's integrity
//   node scripts/integrity.mjs --vectors <dir>        check the shared test vectors (<dir>/vectors.json)
//
// Both repos carry the same vectors (test/fixtures/extension-integrity/): change them together.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ path: string, mode: "644" | "755", sha256: string }} Entry */

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** Sorts entries by the UTF-8 bytes of their path. */
export function sortEntries(entries) {
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
}

/** Every regular file under `root`, in canonical order. Throws on a symlink or anything that isn't a file or directory. */
export function listFiles(root) {
  /** @type {Entry[]} */
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`${path} is a symlink; extensions can't contain symlinks.`);
      if (st.isDirectory()) walk(abs, path);
      else if (st.isFile()) out.push({ path, mode: st.mode & 0o111 ? "755" : "644", sha256: sha256Hex(readFileSync(abs)) });
      else throw new Error(`${path} isn't a regular file or a directory; extensions can only contain files.`);
    }
  };
  const st = lstatSync(root);
  if (!st.isDirectory()) throw new Error(`${root} isn't a directory.`);
  walk(root, "");
  return sortEntries(out);
}

export const canonicalListing = (entries) => entries.map((e) => `${e.path}\0${e.mode}\0${e.sha256}\n`).join("");

export const integrityOf = (entries) => `sha256-${createHash("sha256").update(canonicalListing(entries), "utf8").digest("base64")}`;

export const computeIntegrity = (root) => integrityOf(listFiles(root));

/** Checks `<dir>/vectors.json`; returns the failures (empty when all agree). */
export function checkVectors(dir) {
  const { vectors } = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8"));
  const failures = [];
  for (const v of vectors) {
    const entries = listFiles(join(dir, v.dir));
    const listing = entries.map((e) => [e.path, e.mode, e.sha256]);
    if (JSON.stringify(listing) !== JSON.stringify(v.listing)) failures.push(`${v.dir}: listing differs:\n  got      ${JSON.stringify(listing)}\n  expected ${JSON.stringify(v.listing)}`);
    const got = integrityOf(entries);
    if (got !== v.integrity) failures.push(`${v.dir}: integrity ${got}, expected ${v.integrity}`);
  }
  if (!vectors.length) failures.push("vectors.json has no vectors");
  return failures;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node scripts/integrity.mjs <dir>…\n       node scripts/integrity.mjs --vectors <dir>");
    process.exit(args.length ? 0 : 2);
  }
  if (args[0] === "--vectors") {
    const dir = args[1] ?? "test/fixtures/extension-integrity";
    const failures = checkVectors(dir);
    for (const f of failures) console.error(`✗ ${f}`);
    if (failures.length) process.exit(1);
    console.log(`✓ integrity vectors in ${dir} agree`);
  } else {
    for (const dir of args) console.log(`${computeIntegrity(dir)}  ${dir}`);
  }
}
