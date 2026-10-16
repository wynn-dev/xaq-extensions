# Brightspace

A remote extension for [brightspace-mcp-server](https://github.com/wynn-dev/brightspace-mcp-server), a Brightspace
(D2L) MCP server you run yourself. It signs in to your school as you.

- **Server:** you enter it yourself (`userServer`). xaq adds `/mcp`. The server's default address is
  `http://127.0.0.1:8787`, and plain http works only on loopback and private ranges, after you allow the address.
- **Auth:** a static bearer token. You make it with `openssl rand -hex 32` and set it as `MCP_AUTH_TOKEN` on the
  server, then paste the same token into xaq. xaq sends it as `Authorization: Bearer <token>`.
- **Setup:** follow the server's own [Install](https://github.com/wynn-dev/brightspace-mcp-server#install) and
  [Remote access](https://github.com/wynn-dev/brightspace-mcp-server#remote-access) steps, then start it with
  `pnpm run start:http`.
- **Risk map:** the server's 19 HTTP tools (v1.8.0), plus `download_file` from its stdio build.
  - **Read:** every data tool (courses, work, grades, announcements, discussions, content, calendar, roster,
    syllabus). The server's API client only sends GET requests to Brightspace, so nothing is submitted, posted or
    sent, and none of them is risky.
  - **Write** (not offered at Read only):
    - `check_auth` can start a new Brightspace sign-in on the server's machine, which may send an MFA prompt.
    - `download_file` writes a file to that machine's disk. It isn't served over HTTP today.

Install with `xaq ext add brightspace`.
