// A stand-in for xaq's /mcp in front of two connections, for testing scripts/parity.mjs: Streamable HTTP, stateless
// JSON, one bearer agent key, and the contract's naming (tools and prompts `<slug>__<name>`, resources
// `xaq://<slug>/<encodeURIComponent(uri)>`), with xaq's untrusted-output wrapper (fresh nonce per response), no
// outputSchema in listings, and readOnlyHint from the read class (a "read"-level agent doesn't see write tools).

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/**
 * @param {{ key: string, connections: { slug: string, ext: { request: Function }, readTools: Set<string> | null }[] }} opts
 *   readTools: tools in the read class (null: the generic rule, readOnlyHint from the upstream annotations)
 */
export async function startFakeXaq(opts) {
  const bySlug = new Map(opts.connections.map((c) => [c.slug, c]));
  const isRead = (c, tool) => (c.readTools ? c.readTools.has(tool.name) : tool.annotations?.readOnlyHint === true);
  const wrap = (slug, tool, text) => `<tool_output source="${slug}/${tool}" nonce="${randomBytes(8).toString("hex")}" untrusted>\n${text}\n</tool_output>`;
  const split = (name) => {
    const i = name.indexOf("__");
    return i < 0 ? null : { c: bySlug.get(name.slice(0, i)), name: name.slice(i + 2) };
  };
  const fromUri = (uri) => {
    const m = /^xaq:\/\/([a-z0-9-]+)\/(.*)$/.exec(uri);
    return m ? { c: bySlug.get(m[1]), uri: decodeURIComponent(m[2]) } : null;
  };

  async function handle(method, params) {
    switch (method) {
      case "initialize":
        return { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: "xaq", version: "0" } };
      case "tools/list": {
        const tools = [];
        for (const c of opts.connections) {
          for (const t of (await c.ext.request("tools/list")).tools) {
            if (!isRead(c, t)) continue; // the agent is at the read level
            const { outputSchema: _o, ...rest } = t;
            tools.push({ ...rest, name: `${c.slug}__${t.name}`, annotations: { ...t.annotations, readOnlyHint: true } });
          }
        }
        return { tools };
      }
      case "tools/call": {
        const s = split(params.name);
        if (!s?.c) throw { code: -32602, message: `Unknown tool ${params.name}` };
        const r = await s.c.ext.request("tools/call", { name: s.name, arguments: params.arguments ?? {} });
        return { ...r, content: r.content.map((b) => (b.type === "text" ? { type: "text", text: wrap(s.c.slug, s.name, b.text) } : b)) };
      }
      case "prompts/list": {
        const prompts = [];
        for (const c of opts.connections) for (const p of (await c.ext.request("prompts/list")).prompts) prompts.push({ ...p, name: `${c.slug}__${p.name}` });
        return { prompts };
      }
      case "prompts/get": {
        const s = split(params.name);
        if (!s?.c) throw { code: -32602, message: "Unknown prompt" };
        return s.c.ext.request("prompts/get", { name: s.name, arguments: params.arguments ?? {} });
      }
      case "resources/list": {
        const resources = [];
        for (const c of opts.connections) for (const r of (await c.ext.request("resources/list")).resources) resources.push({ ...r, name: `${c.slug}__${r.name}`, uri: `xaq://${c.slug}/${encodeURIComponent(r.uri)}` });
        return { resources };
      }
      case "resources/templates/list": {
        const resourceTemplates = [];
        for (const c of opts.connections)
          for (const t of (await c.ext.request("resources/templates/list")).resourceTemplates) resourceTemplates.push({ ...t, name: `${c.slug}__${t.name}`, uriTemplate: `xaq://${c.slug}/${encodeURIComponent(t.uriTemplate)}` });
        return { resourceTemplates };
      }
      case "resources/read": {
        const s = fromUri(params.uri);
        if (!s?.c) throw { code: -32602, message: "Unknown resource" };
        const r = await s.c.ext.request("resources/read", { uri: s.uri });
        return { contents: r.contents.map((x) => ({ ...x, uri: params.uri })) };
      }
      default:
        throw { code: -32601, message: "Method not found" };
    }
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      if (req.url !== "/mcp" || req.method !== "POST") return res.writeHead(404).end();
      if (req.headers.authorization !== `Bearer ${opts.key}`) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      const msg = JSON.parse(body);
      if (msg.id === undefined) return res.writeHead(202).end();
      let out;
      try {
        out = { jsonrpc: "2.0", id: msg.id, result: await handle(msg.method, msg.params ?? {}) };
      } catch (err) {
        out = { jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message ?? String(err) } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(() => r())) };
}
