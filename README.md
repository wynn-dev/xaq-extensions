# xaq extensions

Installable connections for [xaq](https://github.com/wynn-dev/xaq), the MCP broker: `xaq ext add <name>`.

- `extensions/<name>/xaq-extension.json`: the manifest (see xaq's `docs/EXTENSIONS.md`).
- `index.json`: the registry. Each entry pins a commit and an integrity hash; xaq installs exactly that.

Two kinds: **remote** (a manifest only: an MCP URL, auth hints, setup copy and a risk map) and **code** (a bundled
Node MCP server that xaq runs out of process, under Node's permission model, with only its own credentials and state).
