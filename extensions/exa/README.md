# Exa

A remote extension for [Exa's hosted MCP server](https://github.com/exa-labs/exa-mcp-server), `https://mcp.exa.ai/mcp`.
xaq proxies it, so agents can search the web.

- **Auth:** your Exa API key. Create one at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys), then
  paste it as the API key when you add the connection in xaq's console (Connections → Add → Exa). xaq stores it
  encrypted and sends it as the `x-api-key` header. Searches count against your Exa account's credits.
- **Risk map:** the two tools Exa serves by default (v3.4.2), both **read**:
  - `web_search_exa`: searches the web (`query`, optional `numResults`) and returns each result's title, URL and
    text.
  - `web_fetch_exa`: reads the pages at the given `urls` as clean markdown.
  - A tool Exa adds later falls back to xaq's generic rules.

Install with `xaq ext add exa`.
