# T3 Code

A remote extension for your own T3 Code server. It reaches T3's MCP endpoint at `<server>/mcp`,
with one connection per server.

- **Server:** you enter it yourself (`userServer`). Plain http works only on loopback and private ranges, after you
  allow the address. T3 usually runs on Tailscale.
- **Auth:** MCP OAuth with T3 as its own authorization server.
  - The sign-in must stay on the server's own origin (`sameOriginIssuer`), because T3's approval page takes a
    one-time pairing code.
  - T3 issues no refresh tokens, so a sign-in lasts 30 days (`tokenLifetimeCapDays: 30`). xaq warns you 7 days and
    1 day before.
  - `settings:write` and `source-control:write` (T3's Full access) are marked as broad scopes, and the console warns
    when a sign-in grants them.
- **Risk map:** T3's 83 tools as listed on 2026-10-16.
  - **Risky:** deleting, settings and environment writes, persistent automation (schedules), and two browser
    preview actions that run in your signed-in browser profile: running page JavaScript (`preview_evaluate`) and
    uploading local files (`preview_upload`).
  - **Write:** starting, messaging and stopping threads, plus the other browser preview actions. T3's own access
    level caps what a thread may run.
  - **Not caught by the name check:** `t3_thread_send`, `t3_thread_send_attachments` and `t3_thread_merge_back`
    stay inside T3, so they are exempt from xaq's risky-verb name check.
  - A tool T3 adds later falls back to the generic rules.

Install with `xaq ext add t3code`.
