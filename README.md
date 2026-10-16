# xaq extensions

Installable connections for [xaq](https://github.com/wynn-dev/xaq), the MCP broker: `xaq ext add <name>`.

- `extensions/<name>/xaq-extension.json`: the manifest (see xaq's `docs/EXTENSIONS.md`).
- `index.json`: the registry. Each entry pins a commit and an integrity hash; xaq installs exactly that.

Two kinds: **remote** (a manifest only: an MCP URL, auth hints, setup copy and a risk map) and **code** (a bundled
Node MCP server that xaq runs out of process, under Node's permission model, with only its own credentials and state).

## Tooling

Plain Node (22.13 or newer), no dependencies:

- `node scripts/validate.mjs`: checks every `extensions/<name>/` against `schema/xaq-extension.schema.json` (xaq's
  manifest schema, copied) and xaq's install rules: no symlinks, at most 20 MB and 5,000 files, one bundled `.mjs`
  entry for a code extension, no `node_modules` and no install scripts.
- `node scripts/integrity.mjs <dir>`: an extension's integrity, exactly as xaq computes it. `--vectors
  test/fixtures/extension-integrity` checks the test vectors xaq shares.
- `node scripts/build-index.mjs --commit <sha> --write`: rebuilds `index.json`, pinning every extension to `<sha>`
  and the integrity of its files there (from the git objects, as GitHub's tarball of that commit has them).
  `--check` verifies each entry against its pinned commit.

To release: merge the extension, run `build-index.mjs --commit <merged sha> --write`, and commit `index.json`. An
unchanged extension keeps its integrity, so xaq doesn't offer it as an update.
