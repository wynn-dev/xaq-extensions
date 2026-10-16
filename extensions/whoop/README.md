# WHOOP extension for xaq

A `code` extension (xaq `docs/EXTENSIONS.md`): one bundled MCP server, `dist/server.mjs`, that xaq runs out of
process for each WHOOP connection. It serves the **WHOOP dashboard's own MCP** (wynn-dev/whoop-dashboard,
`src/lib/mcp.ts`, copied into `src/dashboard/`, verbatim but for four error texts, see `NOTICE`) over the WHOOP API, read live, so agents that
called the dashboard's tools get the same answers from xaq under the same names (`whoop__<tool>`), and the dashboard
can be retired.

## What it serves

Exactly the dashboard's surface, with the same names, titles, descriptions, input and output schemas, annotations,
text and `structuredContent`. The only change: four error texts that sent the reader to the dashboard's UI ("reconnect
in the dashboard", "No WHOOP account is connected to this dashboard yet…") now point at xaq, for example "reconnect
WHOOP in xaq (Connections → WHOOP → Reconnect)". They are listed in `INTENTIONAL_DIFFERENCES` in `scripts/parity.mjs`
and in `NOTICE`.

| Kind | Name | Notes |
| --- | --- | --- |
| tool | `get_status` | Same fields; four of them now describe the live API, see below. |
| tool | `get_day` | |
| tool | `list_days` | |
| tool | `list_workouts` | |
| tool | `get_workout` | |
| tool | `get_trends` | |
| tool | `get_insights` | |
| tool | `sync_now` | Same answer shape; now a cache refresh, see below. |
| prompt | `weekly_review` | |
| resource | `whoop://status` | Same as `get_status`. |
| resource template | `whoop://days/{date}` | |

Server info `form-whoop` 1.0.0 and its `instructions` are the dashboard's too. Through xaq, prompts are
`whoop__weekly_review` and resources `xaq://whoop/<encodeURIComponent(uri)>`.

`test/goldens/goldens.json` holds the dashboard's answers to 224 requests over the fixture, made by running the
dashboard's `mcp.ts` itself (`scripts/goldens.mjs`), including sync_now's two reconnect errors; the reworded error
texts are applied to it and listed in the file. `test/goldens.test.mjs` requires the extension to give the identical
answers (only `syncedAt` is normalised), cold and from its cache.

## How it gets the data

There is no database, no history import and no background polling.

- **Live reads.** A tool call loads the history from `historyFrom` (default `2026-08-25`) to now from WHOOP's v2
  collections (`/v2/cycle`, `/v2/activity/sleep`, `/v2/recovery`, `/v2/activity/workout`, 25 a page, following
  `next_token`) plus the profile, and hands it to the dashboard's code as its `dashboardData()` did: the same records,
  in the dashboard's `start_at` order (a recovery dated by its cycle's start).
- **Cache of finished days.** `cache-v1.json` in `$XAQ_EXT_STATE_DIR` keeps every record that starts before
  `through`: the start of the first record WHOOP hasn't finished (score `PENDING_SCORE`, or a cycle still open), and
  never later than 7 days ago. Everything after it, including today and anything unscored, is fetched live on every
  load (from a day before `through`, plus a day of margin for the recovery filter). The cache is versioned and tied
  to `historyFrom` (either changing rebuilds it), bounded (20,000 records, 16 MiB), written atomically with mode 0600,
  and safe to delete: a file that doesn't parse or validate is ignored and rebuilt. Once a week it is rebuilt from
  scratch in the background, after a load it still served. It holds WHOOP records only, never a token.
- **Bursts.** Concurrent calls share one load, identical requests share one fetch, and a load is reused for 60 s, so
  a cron calling five tools costs one round: the profile plus four collections, about 5–8 requests warm.
- **`sync_now`** answers `{ started, syncing, note }` as before. It now re-reads `config.json` and downloads the whole
  history again, replacing the cache (picking up any edit WHOOP made to an old day). It waits up to 40 s, inside
  xaq's 60 s per call: "Sync finished." (`syncing: false`), or, for a longer refresh, "Sync started; poll get_status."
  (`syncing: true`) while it carries on. While it runs, `get_status` says `syncing: true`. After a successful refresh,
  further `sync_now` calls for 5 minutes answer "Sync finished." without refetching, so an agent can't spend the
  app's daily quota (shared with the dashboard during parity) by calling it in a loop.
- **`get_status`** keeps the dashboard's fields; these four changed meaning:
  - `syncedAt`: when WHOOP last answered a request (was: the last finished sync);
  - `syncing`: a `sync_now` refresh is running (was: a sync is running);
  - `syncError`: the last API error code, `null` after a success: `reconnect_required`, `rate_limited`,
    `whoop_unavailable`, `invalid_response`, `incomplete_import`, `request_failed` (was: the last sync's error);
  - `needsReconnect`: xaq's token for this connection doesn't work (was: the dashboard's stored token failed).
- **When WHOOP fails**, the last good data (or the cached finished days after a restart) is still served, with
  `syncError` set, as the dashboard served its stored data after a failed sync. With nothing at all to serve, a call
  fails with a sentence (for example "WHOOP rejected this connection's token. Reconnect WHOOP in xaq…"). After a
  failure, loads aren't retried for 30 s.

### Rate limits

WHOOP allows 100 requests a minute and 10,000 a day per app (shared by everything using the same app). The
extension's gate (`src/ratelimit.ts`): a token bucket (bursts of 20, then 60 a minute), a daily budget of 5,000, at
most 2 requests in flight, and after a 429 a shared block for `Retry-After` (or `X-RateLimit-Reset`) plus up to 20%
jitter that holds every request, restarting with a small burst. A request retries a 429 at most twice and gives up at
once rather than wait more than 20 s; a 5xx or network error is retried once after 2–2.5 s. Pagination is bounded per collection by the span asked for
(`ceil(days × records a day ÷ 25) + 10` pages, counting generously: 1 a day for cycles and recoveries, 3 for sleeps, 6
for workouts), and a response body over 2 MiB is refused. A cold load of the
default history is about 15 requests and takes seconds; a year is about 65 requests, about 50 s at this rate, near
xaq's 60 s per call. A load cut off by that limit still finishes and fills the cache, so the next call is fast.

### Configuration

Optional, by hand, in the state dir (`<xaq data dir>/extension-state/whoop/<connection id>/config.json`):

```json
{ "historyFrom": "2026-08-25" }
```

A date (UTC midnight) or an ISO instant such as `"2026-08-24T21:41:00Z"`. Read at start and by every `sync_now` (a
changed value always gets its refresh, even inside the cooldown). The connection id is the last part of the
connection's page address in xaq's console (`…/connections/<id>`), and the one directory under
`<xaq data dir>/extension-state/whoop/` (data dir `~/.xaq` by default).

For parity it must reproduce where the dashboard's data starts: baselines, correlations and `dataSpan` depend on it.
WHOOP returns every record that overlaps the start, and the dashboard's start is an instant (its first sync minus 90
days), so a date alone rarely lines up. `get_status` (read-only) only gives that start as a day, `dataSpan.first`;
the parity script reads the dashboard's first night from its own `get_day` for that day and prints the instant to
use: a minute after that night's bedtime (`sleep.bedtime` in the day's `timezone`), which keeps the first day's
cycle, sleep and recovery and drops the day before. By hand: call the dashboard's `whoop__get_day` with
`{"date": "<dataSpan.first>"}` and convert `day.sleep.bedtime` (the evening before that date, or the date itself for
a bedtime after midnight) at `day.timezone` to UTC, plus a minute. If the dashboard's first day has no sleep (its
start fell after that night ended), the script suggests a minute before the second night instead, and that first day
may still differ.

## Security

- **Tokens** come only from xaq: the `xaq/credentials/get` request (`src/host.ts`), kept in memory, re-asked a minute
  before `expiresAt` and once after a 401. Never written to disk, logged or sent anywhere but WHOOP. The client
  secret never reaches the extension. Tests check the token is in no state file, log or stderr.
- **Sandbox**: xaq runs it as
  `node --permission --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> <installDir>/dist/server.mjs`
  with `cwd` the state dir and only `XAQ_EXT_NAME`, `XAQ_EXT_CONNECTION_ID`, `XAQ_EXT_STATE_DIR`, `XAQ_EXT_PROTOCOL`,
  `TZ` and `LANG` set. It needs nothing else: no child processes, workers or addons. The permission model doesn't
  restrict the network; the extension only ever calls `https://api.prod.whoop.com` (the manifest's `network`).
- `XAQ_EXT_WHOOP_API` exists for the test harness only (pointing at the fake WHOOP) and is honoured only for a
  loopback `http://127.0.0.1|localhost|[::1]:<port>` origin, so it can't send the token elsewhere. xaq never sets it.
- **Events**: none (`events: []`). With no polling there is nothing to announce, and the extension never sends
  `xaq/events/emit`.
- Everything in the manifest's risk map is `read`, `sync_now` included (it only refreshes the extension's own cache),
  so a read-level agent such as Hermes's keeps every tool.

## Requirements

Node 22.13 or newer runs it, but **use a Node with the January 2026 security releases or later** (about 22.22 or 24.13;
xaq will require them for code extensions, being verified in xaq's host work): earlier versions have known
permission-model bypasses, and the permission model is this extension's sandbox. The manifest's `node` field is the
contract's floor; xaq enforces its own.

## Build and test

From the repo root:

```sh
npm ci --ignore-scripts
npm run build        # src/ → dist/server.mjs (one file: MCP SDK, zod and their deps bundled) + THIRD_PARTY_LICENSES
npm run check:dist   # CI: fails when the committed dist or licenses are stale
npm run typecheck
npm test             # unit, goldens, sandbox, parity-script tests
```

CI (`.github/workflows/whoop.yml`) runs all of it on Node 22.13.0 and 24. The repo's generic CI (`ci.yml`) also runs
these test files without installing anything; there the in-process unit tests (which need esbuild) are skipped and the
rest run against the committed dist. `test/harness.mjs` spawns the built file
exactly as xaq does and plays xaq's side (it answers `xaq/credentials/get`); `test/fake-whoop.mjs` is a loopback fake
of the WHOOP v2 collections (adapted from xaq's `test/fake-whoop.ts`) serving `test/fixtures/whoop-fixture.json`
(`node extensions/whoop/test/fixtures/generate.mjs` regenerates it). Nothing touches the real WHOOP API.

Regenerating the goldens (only when the fixture, the cases or the upstream dashboard commit change):

```sh
git clone https://github.com/wynn-dev/whoop-dashboard /tmp/whoop-dashboard
(cd /tmp/whoop-dashboard && pnpm install --frozen-lockfile)
node extensions/whoop/scripts/goldens.mjs /tmp/whoop-dashboard
```

The dashboard checkout is only read. After an upstream change, copy its `src/lib/{mcp,whoop,health,insights,analysis,stats}.ts`
into `src/dashboard/`, update `src/dashboard/UPSTREAM.json` and `NOTICE`, then regenerate.

## Parity check against the dashboard

`scripts/parity.mjs` compares the dashboard's MCP and the extension through xaq, on Wynn's machine, before the
dashboard is retired. Plain Node 22+, no dependencies. It needs one xaq agent with **read** access to both the
dashboard connection (slug `whoop`, a generic MCP connection to the dashboard) and the extension connection (slug
`whoop-ext`), and that agent's key.

**Before every run** (the first one, and step 4 of the swap): open the WHOOP dashboard in a browser, press **Sync
now** and wait for it to finish. The dashboard only syncs while it's open in a browser (MCP reads never sync), so
otherwise it's missing the latest days. If it says to reconnect, its WHOOP grant was revoked: use a separate WHOOP
app for xaq (below).

```sh
XAQ_URL=http://127.0.0.1:8425 XAQ_PARITY_KEY=aib_… node extensions/whoop/scripts/parity.mjs
# options: --from 2026-08-25 (default) | --days N
#          --to D (default: the day before the dashboard's last sync, from its get_status syncedAt, never after yesterday)
#          --dashboard-slug whoop --extension-slug whoop-ext --max-diffs 10 --concurrency 4 --no-insights
```

The script prints the dashboard's last sync and the window it compares; `--to` overrides the end. The key is read
from the environment and never printed. For every day from `--from` to `--to` it compares
`get_day`, the `whoop://days/<day>` resource, and `get_trends` and `get_insights` with range 7, 30 and 90 ending that
day; over the window, `list_days` (all 20 fields), `list_workouts` (every page) and `get_workout` for every workout;
`tools/list`, `prompts/list`, `prompts/get weekly_review`, `resources/list`, `resources/templates/list` and
`whoop://status`. It prints a per-tool and per-day summary and the first differences, and exits 0 only on full
parity (1 on a difference, 2 when it can't run).

Normalised, and nothing else: xaq's `<tool_output source=… nonce=… untrusted>` wrapper, the `<slug>__` and
`xaq://<slug>/` prefixes, in `get_status`/`whoop://status` the fields `syncedAt`, `syncing`, `syncError` and
`needsReconnect` (their meaning changed, above), and the dashboard's four reworded error texts
(`INTENTIONAL_DIFFERENCES`, exact whole-text matches). `get_status` is compared on `user` and `dataSpan.first` only;
`dataSpan.latest`, `dataSpan.days`, `workouts`, `timezone` and `latest` are printed for information (they include
today, which the dashboard only knows as of its last sync). `tools/list` ignores `readOnlyHint`, which xaq sets from
its own read class (`sync_now` is a write by the generic rules on the dashboard connection, a read in this
manifest); `sync_now`'s listing is left out of both sides (an agent at the read level may not see it on the dashboard)
and compared on its own when both list it. `sync_now` is called on the extension only, and checked for its shape:
calling it on the dashboard would make the dashboard sync. If the two histories start on different days the script
prints the `historyFrom` instant to set (Configuration, above); set it, call `whoop-ext__sync_now`, and run again.

## Connecting WHOOP (Wynn)

**Recommended: a separate WHOOP app for xaq.** WHOOP may keep only one grant per app and person. If xaq is approved
with the app the WHOOP dashboard uses, the dashboard's grant can be revoked: the dashboard stops syncing, the parity
check compares against stale data, and Hermes's crons (still on the dashboard until the swap) break. A separate app
also gives xaq its own rate limit (100 requests a minute per app).

In the WHOOP Developer Dashboard (https://developer-dashboard.whoop.com, signed in with the WHOOP account):

1. **Create App** (if asked for a team first: **Get Started**, any name, **Create Team**). Name it, for example, xaq.
2. Tick the scopes `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile`,
   `read:body_measurement`, and `offline` if the dashboard lists it (xaq requests `offline` when connecting; that's
   what gives it a refresh token).
3. In **Redirect URIs**, paste xaq's `<publicUrl>/oauth/connections/callback` (xaq's console shows the exact value
   to copy in the setup step). WHOOP wants https; without an https public URL use
   `https://localhost/oauth/connections/callback` and paste the error page's address back into xaq after approving.
   Leave the Webhook URL empty. Click **Create**.
4. The app's page shows its **Client ID** and **Client Secret** (later: Apps → the app). Copy both.

In xaq's console:

5. **Extensions** → add **whoop** (official registry) → confirm. This works once the registry pins whoop, which
   the lead does after this PR merges (`index.json`); before that, `npx xaq-cli ext add <path to extensions/whoop>`
   installs it from a local checkout, as a third-party install.
6. **Connections** → **Add** → **WHOOP** → short name (slug) `whoop-ext` → paste the Client ID and the Client
   Secret → **Connect** → sign in to WHOOP and approve every scope → back in xaq the connection shows as connected.
7. Give the parity agent **read** on both `whoop` (the dashboard) and `whoop-ext`, and hand its key to whoever runs
   `parity.mjs` as `XAQ_PARITY_KEY`.

**Not recommended: reusing the dashboard's app.** Only if a new app isn't possible (an account may have 5). The risk,
plainly: approving xaq with the dashboard's app may revoke the dashboard's grant, breaking the dashboard, the parity
window and Hermes's crons until the dashboard is reconnected, and reconnecting the dashboard may in turn revoke xaq's.
The two also share one rate limit. If you accept that, instead of steps 1–3: Apps → the dashboard's app → the
**pencil icon** → under **Redirect URIs** add xaq's `<publicUrl>/oauth/connections/callback` as one more URI (keep
the existing ones) → check the six scopes → save (not the red trash can: it deletes the app). Then steps 4–7. Right
after step 6, open the dashboard and press **Sync now**: if it asks to reconnect, the grant was revoked; switch to a
separate app. (Its `get_status` can't tell you: the dashboard only notices on a sync, and MCP reads never sync.)

## The swap: the extension takes the slug `whoop`

Hermes calls `whoop__*` and must not change. After parity, the extension connection takes the slug `whoop`.
Connection slugs can be changed (`PATCH /api/connections/:id {slug}` in xaq core; it renames the exposed tool names,
and keeps grants, levels and always-allow rules), with the CLI's `connections rename` and the console's "Change
short name" control. The commands below are `npx xaq-cli …` (or just `xaq …` where it's installed):

1. Move the dashboard connection out of the way, keeping it for rollback: `npx xaq-cli connections rename whoop --slug whoop-dash`
   (console: Connections → the dashboard connection → Change short name). From here until step 2, `whoop__*` calls
   fail, so do it between Hermes's cron runs.
2. `npx xaq-cli connections rename whoop-ext --slug whoop`.
3. Connections → `whoop` (now the extension) → Agents: Hermes's agent has access at **read** (grant it if not).
4. Check: open the dashboard and press **Sync now** (as before every parity run), then
   `node extensions/whoop/scripts/parity.mjs --dashboard-slug whoop-dash --extension-slug whoop` exits 0, and a
   Hermes cron's `whoop__get_status` answers.
5. After the dashboard's teardown: `npx xaq-cli connections remove whoop-dash`.

Rollback: `npx xaq-cli connections rename whoop --slug whoop-ext`, then
`npx xaq-cli connections rename whoop-dash --slug whoop`.

Fallback without the rename command: `npx xaq-cli connections remove whoop` (the dashboard) and
`npx xaq-cli connections remove whoop-ext`, then Connections → Add → WHOOP → slug `whoop` with the same Client ID and
Secret (xaq's own app) → Connect → approve, and grant Hermes's agent read on it. This is a new connection with a new
id, so its state dir is new: the cache starts cold (about 15 requests on the first call) and **`historyFrom` is back
to the default**. Write the `config.json` from parity again in the new state dir
(`<xaq data dir>/extension-state/whoop/<new connection id>/`, the id being the last part of the connection's page
address in the console), then call `whoop__sync_now`.
