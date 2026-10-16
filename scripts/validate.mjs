#!/usr/bin/env node
// Validates every extensions/<name>/: its xaq-extension.json against schema/xaq-extension.schema.json, its name
// against the directory, and the rules xaq enforces at install (no symlinks, at most 20 MB and 5,000 files; a code
// extension's entry exists and nothing gets installed: no node_modules, no install scripts), and that no
// .gitattributes uses export-ignore or export-subst (GitHub's tarball would differ from the pinned files). Plain Node, no
// dependencies: the JSON Schema subset the manifest schema uses is checked below.
//
//   node scripts/validate.mjs [extensions/<name>…]      (default: every extension)
//
// schema/xaq-extension.schema.json is xaq's MANIFEST_JSON_SCHEMA (server/extensions/manifest.ts, added in
// wynn-dev/xaq#80), copied verbatim. xaq's validateManifest also checks what a schema can't (template variables,
// unique step ids, …); when the two disagree, xaq wins: copy the schema again.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listFiles } from "./integrity.mjs";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5_000;

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codepoints = (s) => [...s].length;

/**
 * The JSON Schema (2020-12) keywords the manifest schema uses: type, const, enum, pattern, min/maxLength,
 * minimum/maximum, required, properties, additionalProperties, propertyNames, min/maxProperties, items, min/maxItems,
 * uniqueItems, not, oneOf, anyOf, allOf, if/then/else. Anything else in a schema is an error, not silently ignored.
 */
const KNOWN = new Set([
  "$schema", "$id", "title", "description", "type", "const", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "required", "properties", "additionalProperties", "propertyNames", "minProperties", "maxProperties", "items", "minItems",
  "maxItems", "uniqueItems", "not", "oneOf", "anyOf", "allOf", "if", "then", "else",
]);

export function validate(schema, value, path = "") {
  if (schema === true) return [];
  if (schema === false) return [`${path || "/"}: not allowed`];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`validate.mjs doesn't support the schema keyword "${k}" (at ${path || "/"})`);
  const errors = [];
  const at = path || "/";
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) return [`${at}: must be ${types.join(" or ")}`];
  }
  if ("const" in schema && !deepEqual(value, schema.const)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && codepoints(value) < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && codepoints(value) > schema.maxLength) errors.push(`${at}: must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: must match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be ≤ ${schema.maximum}`);
  }
  if (typeOf(value) === "object") {
    const keys = Object.keys(value);
    for (const r of schema.required ?? []) if (!(r in value)) errors.push(`${at}: missing "${r}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: must have at least ${schema.minProperties} keys`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${at}: must have at most ${schema.maxProperties} keys`);
    for (const k of keys) {
      const child = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, k, `${child} (name)`));
      if (schema.properties && k in schema.properties) errors.push(...validate(schema.properties[k], value[k], child));
      else if (schema.additionalProperties === false) errors.push(`${child}: unknown key`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, value[k], child));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items must be unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}/${i}`)));
  }
  if (schema.not && validate(schema.not, value, path).length === 0) errors.push(`${at}: must not match ${JSON.stringify(schema.not)}`);
  if (schema.allOf) for (const s of schema.allOf) errors.push(...validate(s, value, path));
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, path).length === 0)) errors.push(`${at}: must match one of the allowed shapes`);
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validate(s, value, path));
    const matches = results.filter((r) => r.length === 0).length;
    if (matches !== 1) {
      // Report the closest alternative's errors: the one with the fewest.
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(matches === 0 ? `${at}: must match exactly one allowed shape; closest: ${best.join("; ")}` : `${at}: matches more than one allowed shape`);
    }
  }
  if (schema.if) {
    const branch = validate(schema.if, value, path).length === 0 ? schema.then : schema.else;
    if (branch) errors.push(...validate(branch, value, path));
  }
  return errors;
}

/** Problems with one extension directory (empty when it's valid). */
export function checkExtension(dir, schema) {
  const name = dir.split("/").filter(Boolean).at(-1);
  const problems = [];
  const manifestPath = join(dir, "xaq-extension.json");
  if (!existsSync(manifestPath)) return [`${dir}: no xaq-extension.json`];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return [`${manifestPath}: not valid JSON (${err.message})`];
  }
  problems.push(...validate(schema, manifest).map((e) => `${manifestPath}: ${e}`));
  if (manifest.name !== name) problems.push(`${manifestPath}: name is ${JSON.stringify(manifest.name)}; it must be the directory's name, "${name}"`);
  let files = [];
  try {
    files = listFiles(dir);
  } catch (err) {
    problems.push(`${dir}: ${err.message}`);
  }
  if (files.length > MAX_FILES) problems.push(`${dir}: ${files.length} files; xaq installs at most ${MAX_FILES}`);
  const bytes = files.reduce((n, f) => n + lstatSync(join(dir, f.path)).size, 0);
  if (bytes > MAX_BYTES) problems.push(`${dir}: ${Math.round(bytes / 1024 / 1024)} MB; xaq installs at most 20 MB`);
  if (files.some((f) => f.path.split("/").includes("node_modules"))) problems.push(`${dir}: node_modules isn't allowed; bundle the server into one ESM file`);
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {};
      for (const s of ["preinstall", "install", "postinstall", "prepare"]) if (scripts[s]) problems.push(`${pkg}: "${s}" scripts aren't allowed; nothing is installed, ever`);
    } catch {
      problems.push(`${pkg}: not valid JSON`);
    }
  }
  if (manifest.kind === "code") {
    const entry = manifest.code?.entry;
    if (typeof entry === "string") {
      if (!files.some((f) => f.path === entry)) problems.push(`${dir}: code.entry ${entry} isn't in the extension (commit the bundled file)`);
      if (!entry.endsWith(".mjs")) problems.push(`${dir}: code.entry must be one ESM file (.mjs)`);
    }
  }
  return problems;
}

/**
 * export-ignore and export-subst make GitHub's tarball differ from the git objects build-index.mjs pins (files left
 * out, or text substituted at download time), so the installed files wouldn't be the pinned ones: refused in every
 * .gitattributes.
 */
export function forbiddenAttributes(root = ".") {
  const problems = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name === ".gitattributes") {
        readFileSync(abs, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/(^|\s)[-!]?export-(ignore|subst)\b/.test(line.replace(/#.*/, ""))) problems.push(`${abs}:${i + 1}: export-ignore and export-subst aren't allowed (GitHub's tarball would differ from the pinned files)`);
          });
      }
    }
  };
  walk(root);
  return problems;
}

export function extensionDirs(root = "extensions") {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => !n.startsWith(".") && lstatSync(join(root, n)).isDirectory())
    .sort()
    .map((n) => join(root, n));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const schema = JSON.parse(readFileSync(new URL("../schema/xaq-extension.schema.json", import.meta.url), "utf8"));
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : extensionDirs();
  let failed = 0;
  for (const dir of dirs) {
    const problems = checkExtension(dir, schema);
    if (problems.length) {
      failed++;
      for (const p of problems) console.error(`✗ ${p}`);
    } else console.log(`✓ ${dir}`);
  }
  for (const p of forbiddenAttributes(".")) {
    console.error(`✗ ${p}`);
    failed++;
  }
  // index.json's shape (its pins are checked by build-index.mjs --check).
  const index = JSON.parse(readFileSync("index.json", "utf8"));
  if (index.schema !== 1 || !Array.isArray(index.extensions)) {
    console.error('✗ index.json must be { "schema": 1, "extensions": [...] }');
    failed++;
  }
  if (failed) process.exit(1);
  console.log(`✓ ${dirs.length} extension(s) valid`);
}
