#!/usr/bin/env node
// Builds or checks index.json: one entry per extensions/<name>, pinned to a commit and the integrity of the extension
// at that commit. The integrity is computed from the git objects (the modes and contents GitHub's tarball of that
// commit has), with scripts/integrity.mjs's algorithm. Plain Node and the git CLI, no dependencies.
//
//   node scripts/build-index.mjs [--commit <rev>]           print index.json for every extension at <rev> (default HEAD)
//   node scripts/build-index.mjs [--commit <rev>] --write   write it to index.json
//   node scripts/build-index.mjs --check [--base <ref>]     check index.json: each entry's commit exists, its files
//                                                           have that integrity, and its fields match the manifest;
//                                                           and every entry new or changed since <ref>'s index.json
//                                                           (default origin/main) pins a commit already on <ref>
//                                                           whose files are exactly this tree's
//
// Release flow: merge the extension, then `node scripts/build-index.mjs --commit <merged sha> --write` and commit
// index.json. xaq installs exactly the pinned commit and integrity; an unchanged extension keeps its integrity, so
// moving its commit isn't an update.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { integrityOf, sortEntries } from "./integrity.mjs";

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const git = (args, opts = {}) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });

export const resolveCommit = (rev) => git(["rev-parse", "--verify", `${rev}^{commit}`]).toString("utf8").trim();

/** The extension names (directories under extensions/) at `commit`. */
export function extensionNames(commit) {
  const out = git(["ls-tree", "-z", "--full-tree", commit, "--", "extensions/"]).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { type: meta.split(" ")[1], name: path.slice("extensions/".length) };
    })
    .filter((e) => e.type === "tree")
    .map((e) => e.name)
    .sort();
}

/** The integrity of extensions/<name> at `commit`, from git objects. Refuses symlinks and submodules. */
export function integrityAt(commit, name) {
  const prefix = `extensions/${name}/`;
  const out = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", prefix]);
  const entries = [];
  for (const raw of out.toString("utf8").split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    const [mode, type, sha] = raw.slice(0, tab).split(" ");
    const path = raw.slice(tab + 1).slice(prefix.length);
    if (type !== "blob") throw new Error(`${prefix}${path} is a ${type}; extensions can only contain files.`);
    if (mode === "120000") throw new Error(`${prefix}${path} is a symlink; extensions can't contain symlinks.`);
    if (mode !== "100644" && mode !== "100755") throw new Error(`${prefix}${path} has git mode ${mode}.`);
    const content = git(["cat-file", "blob", sha]);
    entries.push({ path, mode: mode === "100755" ? "755" : "644", sha256: createHash("sha256").update(content).digest("hex") });
  }
  if (!entries.length) throw new Error(`There's no ${prefix} at ${commit.slice(0, 12)}.`);
  return integrityOf(sortEntries(entries));
}

export function manifestAt(commit, name) {
  const text = git(["show", `${commit}:extensions/${name}/xaq-extension.json`]).toString("utf8");
  return JSON.parse(text);
}

/** The index entry for extensions/<name> at `commit`. */
export function entryAt(commit, name) {
  if (!NAME_RE.test(name)) throw new Error(`extensions/${name}: the directory name must be 1-32 lowercase letters, digits or dashes.`);
  const m = manifestAt(commit, name);
  if (m.name !== name) throw new Error(`extensions/${name}: the manifest's name is "${m.name}"; it must match the directory.`);
  return {
    name,
    displayName: m.displayName ?? name,
    description: m.description ?? "",
    kind: m.kind,
    version: m.version,
    path: `extensions/${name}`,
    commit,
    integrity: integrityAt(commit, name),
  };
}

export function buildIndex(rev = "HEAD") {
  const commit = resolveCommit(rev);
  return { schema: 1, extensions: extensionNames(commit).map((name) => entryAt(commit, name)) };
}

export function isAncestor(commit, of) {
  try {
    git(["merge-base", "--is-ancestor", commit, of], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** index.json at `ref`, or an empty index when it has none. */
export function indexAt(ref) {
  let text;
  try {
    text = git(["show", `${ref}:index.json`], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    return { schema: 1, extensions: [] };
  }
  return JSON.parse(text);
}

/**
 * What a change to index.json must prove, against the base branch (`base`, e.g. origin/main): every entry that's new
 * or whose commit or integrity moved pins a commit that is already on the base branch, with exactly the files this
 * tree has. Otherwise a PR could pin a commit that never reaches main (add bad code in commit A, revert it in B and
 * point index.json at A: the net diff is a one-line bump) and every xaq would install A as official.
 */
export function checkPinsAgainstBase(index, base, head = "HEAD") {
  const problems = [];
  const before = new Map((indexAt(base).extensions ?? []).map((e) => [e.name, e]));
  for (const e of index.extensions ?? []) {
    const was = before.get(e.name);
    if (was && was.commit === e.commit && was.integrity === e.integrity) continue;
    const where = `index.json: ${e.name}`;
    if (!COMMIT_RE.test(e.commit ?? "")) continue; // reported by checkIndex
    if (!isAncestor(e.commit, base)) {
      problems.push(`${where}: the pinned commit ${e.commit.slice(0, 12)} isn't on ${base}. Merge the extension first, then pin the merged commit.`);
      continue;
    }
    let pinned;
    let current;
    try {
      pinned = integrityAt(e.commit, e.name);
      current = integrityAt(head, e.name);
    } catch (err) {
      problems.push(`${where}: ${err.message.split("\n")[0]}`);
      continue;
    }
    if (pinned !== current) problems.push(`${where}: the files at the pinned commit ${e.commit.slice(0, 12)} (${pinned}) aren't the files in this tree (${current}).`);
  }
  return problems;
}

/** Problems with an index (empty when it's right). `head`: also report extensions at that commit the index lacks. */
export function checkIndex(index, head = null) {
  const problems = [];
  if (index?.schema !== 1 || !Array.isArray(index.extensions)) return ["index.json must be { \"schema\": 1, \"extensions\": [...] }"];
  const seen = new Set();
  for (const e of index.extensions) {
    const where = `index.json: ${e?.name ?? "(no name)"}`;
    if (!NAME_RE.test(e?.name ?? "")) {
      problems.push(`${where}: bad name`);
      continue;
    }
    if (seen.has(e.name)) problems.push(`${where}: listed twice`);
    seen.add(e.name);
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "commit,description,displayName,integrity,kind,name,path,version") problems.push(`${where}: keys must be exactly name, displayName, description, kind, version, path, commit, integrity (has ${keys})`);
    if (e.path !== `extensions/${e.name}`) problems.push(`${where}: path must be extensions/${e.name}`);
    if (!COMMIT_RE.test(e.commit ?? "")) {
      problems.push(`${where}: commit must be a full 40-hex sha`);
      continue;
    }
    let expected;
    try {
      expected = entryAt(e.commit, e.name);
    } catch (err) {
      problems.push(`${where}: ${err.message.split("\n")[0]}`);
      continue;
    }
    for (const k of ["displayName", "description", "kind", "version", "integrity"]) {
      if (e[k] !== expected[k]) problems.push(`${where}: ${k} is ${JSON.stringify(e[k])}, but at ${e.commit.slice(0, 12)} it's ${JSON.stringify(expected[k])}`);
    }
  }
  if (head) {
    for (const name of extensionNames(resolveCommit(head))) if (!seen.has(name)) problems.push(`extensions/${name} isn't in index.json yet (fine until it's released)`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--commit");
  const rev = at >= 0 ? args[at + 1] : "HEAD";
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node scripts/build-index.mjs [--commit <rev>] [--write] | --check");
    process.exit(0);
  }
  if (args.includes("--check")) {
    const index = JSON.parse(readFileSync("index.json", "utf8"));
    const b = args.indexOf("--base");
    const base = b >= 0 ? args[b + 1] : "origin/main";
    try {
      resolveCommit(base);
    } catch {
      console.error(`✗ the base ${base} isn't available: fetch it first (git fetch origin main).`);
      process.exit(1);
    }
    const problems = [...checkIndex(index, "HEAD"), ...checkPinsAgainstBase(index, base)];
    const missing = problems.filter((p) => p.includes("isn't in index.json yet"));
    const errors = problems.filter((p) => !missing.includes(p));
    for (const p of missing) console.log(`! ${p}`);
    for (const p of errors) console.error(`✗ ${p}`);
    if (errors.length) process.exit(1);
    console.log(`✓ index.json: ${index.extensions.length} extension(s), each matching its pinned commit`);
  } else {
    const index = buildIndex(rev);
    const text = `${JSON.stringify(index, null, 2)}\n`;
    if (args.includes("--write")) {
      writeFileSync("index.json", text);
      console.log(`Wrote index.json: ${index.extensions.map((e) => `${e.name} ${e.version}`).join(", ") || "no extensions"} at ${index.extensions[0]?.commit ?? resolveCommit(rev)}`);
    } else process.stdout.write(text);
  }
}
