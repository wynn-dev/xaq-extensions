# Notion

A remote extension for [Notion's hosted MCP server](https://developers.notion.com/guides/mcp/mcp-supported-tools),
`https://mcp.notion.com/mcp`. xaq proxies it. You sign in with Notion (MCP OAuth); there's no app to create.

- **Auth:** MCP OAuth, discovered from the server.
- **Reconnect:** at least every 180 days, and after 30 days without use (Notion's rules). xaq warns you before
  either happens.
- **Risk map:** all 56 tools Notion documented on 2026-10-16, plus its short aliases (`fetch`, `search`,
  `ai-search`).
  - **Risky** (asks at the "ask" level): deleting pages, databases or comments; spawning a Custom Agent session or
    messaging one. Those agents act on their own, so delegating to one asks like the action itself.
  - **Write** (goes through): everything that creates or edits.
  - **Read**: everything else.
  - A tool Notion adds later falls back to xaq's generic rules.
- **Targets:** "always allow … for this target" uses the first id argument the live tool declares, for example
  `/page_ids` or `/comment_id`.

Install with `xaq ext add notion`.
