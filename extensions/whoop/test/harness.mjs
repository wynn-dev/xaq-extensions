// Runs the built extension exactly as xaq's code-extension host does (xaq docs/EXTENSIONS.md, "The code-extension
// host"), and plays xaq's side of the session: an MCP client over newline-delimited JSON-RPC on stdio that answers
// `xaq/credentials/get` and records `xaq/log` and any other notification. Plain Node, no dependencies.
//
//   node --permission --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> <installDir>/dist/server.mjs
//   cwd <stateDir>, stdio pipes only, env: XAQ_EXT_NAME, XAQ_EXT_CONNECTION_ID, XAQ_EXT_STATE_DIR, XAQ_EXT_PROTOCOL=1,
//   TZ, LANG (and, for tests only, XAQ_EXT_WHOOP_API pointing at the loopback fake).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALL_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export const ENTRY = "dist/server.mjs";

export function newStateDir(prefix = "xaq-whoop-state-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(base, "extension-state", "whoop", "conn_test");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The argv xaq uses (repeated --allow-fs-read flags: a comma list is read as one literal path). */
export function spawnArgs(installDir, stateDir) {
  return ["--permission", `--allow-fs-read=${installDir}`, `--allow-fs-read=${stateDir}`, `--allow-fs-write=${stateDir}`, join(installDir, ENTRY)];
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} [opts.apiOrigin]  the fake WHOOP's origin (test only)
 * @param {(n: number) => Promise<object> | object} [opts.credentials]  answers xaq/credentials/get; throw for an error
 * @param {string} [opts.node]  the node binary (default: this one)
 */
export function startExtension(opts) {
  const node = opts.node ?? process.execPath;
  const env = {
    XAQ_EXT_NAME: "whoop",
    XAQ_EXT_CONNECTION_ID: "conn_test",
    XAQ_EXT_STATE_DIR: opts.stateDir,
    XAQ_EXT_PROTOCOL: "1",
    TZ: opts.tz ?? "UTC",
    LANG: "en_US.UTF-8",
    ...(opts.apiOrigin ? { XAQ_EXT_WHOOP_API: opts.apiOrigin } : {}),
  };
  const child = spawn(node, spawnArgs(opts.installDir ?? INSTALL_DIR, opts.stateDir), { cwd: opts.stateDir, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const logs = [];
  const notifications = [];
  const credentialRequests = [];
  const stdoutJunk = [];
  let stderr = "";
  let nextId = 1;
  let buf = "";
  let exited = null;
  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve((exited = { code, signal }))));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

  child.stdout.on("data", async (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        stdoutJunk.push(line);
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // A request from the extension to xaq.
        if (msg.method === "xaq/credentials/get") {
          credentialRequests.push(msg.params);
          try {
            const result = await (opts.credentials ?? (() => ({ accessToken: "test-token", expiresAt: Date.now() + 3_600_000 })))(credentialRequests.length);
            send({ jsonrpc: "2.0", id: msg.id, result });
          } catch (err) {
            // xaq's answer when the connection needs re-authorising.
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32010, message: String(err?.message ?? err), data: { reason: "needs_reauth" } } });
          }
        } else if (msg.method === "ping") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
        }
      } else if (msg.method) {
        notifications.push(msg);
        if (msg.method === "xaq/log") logs.push(msg.params);
      }
    }
  });

  const request = (method, params = {}, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error(`extension exited (${JSON.stringify(exited)}): ${stderr.slice(-500)}`));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  return {
    child,
    logs,
    notifications,
    credentialRequests,
    stdoutJunk,
    get stderr() {
      return stderr;
    },
    request,
    async initialize() {
      const result = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xaq-test-harness", version: "0.0.0" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    },
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exitPromise;
        clearTimeout(t);
      }
      return exited;
    },
    exited: exitPromise,
  };
}
