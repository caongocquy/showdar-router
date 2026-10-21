# Showdar Router Operator Runbook

_Last updated: 2026-10-21_

This runbook covers installing, operating, diagnosing, and rolling back the
local Showdar Router gateway. It describes behavior implemented in this
repository. For component responsibilities and internals, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Do not put API keys, OAuth tokens, request bodies, or personal endpoints in
tickets, chat, Notion, or Git. The data directory contains credentials.

## 1. Requirements and defaults

- Node.js 20.9 or newer is required by the repository engine. Node.js 22.5 or
  newer also enables the built-in `node:sqlite` fallback.
- The default port is `21298`.
- The default data directory is `~/.showdar-router` (Windows:
  `%APPDATA%\showdar-router`). Export it for the commands in this runbook:

```bash
export SHOWDAR_ROUTER_DATA_DIR="${SHOWDAR_ROUTER_DATA_DIR:-$HOME/.showdar-router}"
```
- The API base URL for clients is `http://127.0.0.1:21298/v1`.
- The dashboard is at `http://localhost:21298`.
- Fresh settings require dashboard login (`requireLogin: true`) and a router
  API key for LLM requests (`requireApiKey: true`).

Set a stable data directory when running multiple installs or containers:

```bash
export SHOWDAR_ROUTER_DATA_DIR="$HOME/.showdar-router-prod"
# DATA_DIR is also accepted; SHOWDAR_ROUTER_DATA_DIR wins.
```

Use one gateway process per data directory. Do not point two live processes at
the same SQLite file.

## 2. Install and start

### Global CLI install

```bash
npm install -g showdar-router
showdar-router
```

Common options:

```bash
showdar-router --port 30000     # explicit port; startup fails if occupied
showdar-router --no-browser     # do not open the dashboard
showdar-router --skip-update    # skip the update check
showdar-router --tray           # run in the system tray
showdar-router --version
```

Without `--port`, the CLI tries the next available port (up to 10 attempts) if
`21298` is taken. With an explicit `--port`, it does not silently move.

### From source

```bash
npm ci
npm run build
npm start
# or: node .next/standalone/custom-server.js --port 21298
```

For development only:

```bash
npm run dev
```

### Verify startup

```bash
curl -fsS http://127.0.0.1:21298/api/health
# {"ok":true}

curl -fsS http://127.0.0.1:21298/api/version
```

Check the log line for the selected database driver and file, for example:

```text
[DB] Driver: better-sqlite3 | file: /Users/you/.showdar-router/db/data.sqlite
```

## 3. First login and API key

1. Open `http://localhost:21298`.
2. Complete the dashboard login.
3. Open **Endpoint & Key** (or **Keys**) and create a router API key.
4. Store the key in your client configuration; it is shown only for the
   current setup flow.

CLI token versus API key:

- The dashboard and management APIs accept the dashboard session cookie, or
  the local machine-derived CLI token used by the launcher.
- LLM API clients use a router API key: `Authorization: Bearer <key>`,
  `x-api-key: <key>`, or `?key=<key>`.
- Remote LLM access requires a valid router API key. The machine CLI token is
  for local management and launcher access, not a client API key.
- The chat handler enforces `requireApiKey` (default `true`), so clients need a
  router API key even when the request is local unless that setting is
  disabled.

## 4. Connect an OpenAI-compatible client

```bash
export SHOWDAR_API_KEY="<router-api-key>"

curl -sS http://127.0.0.1:21298/v1/chat/completions \
  -H "Authorization: Bearer $SHOWDAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-combo",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

Streaming:

```bash
curl -N -sS http://127.0.0.1:21298/v1/chat/completions \
  -H "Authorization: Bearer $SHOWDAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-combo",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

SDK configuration:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:21298/v1",
    api_key="<router-api-key>",
)
```

### Always send `stream` explicitly

Send `"stream": true` or `"stream": false` on every chat request.

Omitting `stream` currently has a contract gap: the router may decide to stream
internally while forwarding an OpenAI-compatible body without `stream: true`.
The upstream can then return JSON while the router expects SSE. Combo routes
can return HTTP 502; direct routes can return an SSE content type with a JSON
body. This is a known release risk, not a supported mode. Add
`"stream": false` for JSON clients and `"stream": true` for SSE clients.

## 5. Configure providers, accounts, and nodes

Use the dashboard unless you are automating against a local admin session.

### Built-in provider (API key)

Dashboard: **Providers → Add provider**, choose the provider, paste the API
key, test, and save.

Equivalent management API:

```http
POST /api/providers
Content-Type: application/json

{"provider": "openai", "apiKey": "<provider-key>", "name": "primary-openai"}
```

Multiple accounts for the same provider are separate connections. They are
tried by priority; a failing account is cooled down or model-locked without
disabling the others.

### OAuth provider

Dashboard: **Providers → Add provider**, choose the OAuth provider, and complete
the browser/device flow. Tokens are refreshed before expiry and on auth
failures where the provider supports refresh.

### Custom OpenAI/Anthropic-compatible node

Dashboard: **Providers → Add provider node**.

```http
POST /api/provider-nodes
Content-Type: application/json

{
  "name": "local-vllm",
  "prefix": "vllm",
  "type": "openai-compatible",
  "apiType": "chat",
  "baseUrl": "http://127.0.0.1:8000/v1"
}
```

`apiType` is `chat` or `responses` for OpenAI-compatible nodes. Anthropic
compatible and custom-embedding node types are also supported.

Then create a connection for that node:

```http
POST /api/providers
Content-Type: application/json

{"provider": "<node-id>", "apiKey": "<optional-key>", "name": "local-vllm"}
```

The node's dashboard entry shows the exact model namespace. Normally use the
node prefix:

```text
vllm/<upstream-model-name>
```

Remote endpoints must be reachable from the router host. Use a loopback or
private address for local-only inference; do not expose a local inference
server to the public internet just to satisfy the router.

## 6. Configure combos and routing

Dashboard: **Combos**.

Create a combo with an ordered model list:

```http
POST /api/combos
Content-Type: application/json

{"name": "my-combo", "models": ["anthropic/claude-sonnet-4", "openai/gpt-5"]}
```

Select the strategy per combo in the dashboard, or set it through settings:

```http
PATCH /api/settings
Content-Type: application/json

{
  "comboStrategies": {
    "my-combo": {"fallbackStrategy": "round-robin"}
  }
}
```

Supported values: `fallback`, `round-robin`, `fusion`.

- **Fallback** — try candidates in order; advance on eligible failures.
- **Round-robin** — rotate the primary model per combo with a sticky limit
  (`comboStickyRoundRobinLimit`, default `1`), keeping the rest as fallback.
- **Fusion** — call several models in parallel (non-streaming), then have a
  judge synthesize the answer. If one panel answer survives, it is returned
  directly. The judge defaults to the first panel model unless
  `judgeModel` is configured.

Round-robin position is kept in memory and resets when the gateway restarts.

### Capacity adapter (vision/audio fallback pools)

The capacity adapter adds global fallback models when no configured candidate
supports a hard input modality. Defaults:

- `vision` and `audioInput` enabled;
- `pdf` and `videoInput` disabled;
- enabled pools with no models resolve to `oc/mimo-v2.5-free`, a remote
  OpenCode Free model (`https://opencode.ai`, no auth).

This means a default installation can send an image or audio request to a
remote third party when the selected combo cannot handle it. Use this only if
that is acceptable for your data.

To opt out of all remote capacity fallback, replace the whole
`capacityAdapter` object from an authenticated dashboard session:

```http
PATCH /api/settings
Content-Type: application/json

{
  "capacityAdapter": {
    "vision":    {"enabled": false, "roundRobin": false, "models": []},
    "pdf":       {"enabled": false, "roundRobin": false, "models": []},
    "audioInput":{"enabled": false, "roundRobin": false, "models": []},
    "videoInput":{"enabled": false, "roundRobin": false, "models": []}
  }
}
```

The settings update is a top-level merge: sending `capacityAdapter` replaces
the entire object, so include every pool. Verify:

```bash
curl -fsS http://127.0.0.1:21298/api/settings
```

There is no single "local-only" switch. To keep traffic local:

1. disable every capacity pool as above;
2. configure only local provider nodes;
3. use combos/direct models that reference only those nodes;
4. confirm with the latency trace that `attempts[].model` never names a remote
   provider/model you did not configure;
5. optionally enforce it at the host firewall.

## 7. Read the sanitized latency trace

The trace is opt-in and writes one JSON line per request to stderr:

```bash
SHOWDAR_ROUTER_LATENCY_TRACE=1 showdar-router --no-browser
```

If starting from source:

```bash
SHOWDAR_ROUTER_LATENCY_TRACE=1 node .next/standalone/custom-server.js --port 21298
```

Pretty-print one line:

```bash
# stderr is redirected because the trace is emitted there
SHOWDAR_ROUTER_LATENCY_TRACE=1 showdar-router --no-browser 2>&1 \
  | grep '^\[showdar-latency\]' \
  | sed 's/^\[showdar-latency\] //' \
  | jq .
```

Useful fields:

- `kind` — `completed`, `failed`, or `cancelled`.
- `combo.name`, `combo.strategy`.
- `candidates[]` — eligibility, `healthSkip`, `healthSkipReason`.
- `attempts[]` — `model`, `result`, `status`, `reason`, timing marks,
  `retryDispatches`, `probe`.
- `winner.type` — `CLEAN_WINNER` or `FALLBACK_WINNER`.
- `stats.fallbackAttempts`, `stats.failedAttemptWallMs`,
  `stats.winnerUpstreamTtftMs`.

The trace deliberately contains no prompts, response text, headers, keys, or
raw error bodies. Labels are bounded. It is safe to share a single trace line
only after confirming your model names are not sensitive.

## 8. Diagnose HTTP 429 and cooldowns

A 429 can be handled at three levels:

1. executor retry (usually disabled for 429);
2. switch to another account for the same provider/model;
3. advance to the next combo candidate.

Look for these log/trace signals:

- `FALLBACK ⇄ ACC:<name> UNAVAILABLE (429)` — account fallback.
- `COMBO Trying model N/M` — combo iteration.
- `Skipping model ...` — route health skip.
- Trace `attempts[]` entry with `status: 429`, `result: "failure"`.
- Trace `candidates[]` with `healthSkip: true` and a reason.
- Trace `winner.type: "FALLBACK_WINNER"`.

Inspect persisted route health read-only:

```bash
sqlite3 "$SHOWDAR_ROUTER_DATA_DIR/db/data.sqlite" \
  "SELECT key, value FROM kv WHERE scope = 'routeHealth';"
```

Operational actions:

- Wait until `nextProbeAt`; a half-open probe is allowed after that.
- Check the provider dashboard for quota/reset information.
- Confirm the account is active and not model-locked.
- If all candidates are cooling down, the router returns 503 with a
  `Retry-After` derived from the earliest known reset.
- Do not repeatedly hammer a cooling route; successful probes clear it
  automatically.

Cooldowns are expected behavior, not a reason to restart the gateway.

## 9. Distinguish upstream timeout from client abort

| Symptom | Meaning | Trace / logs |
|---|---|---|
| HTTP 499, `kind: "cancelled"` | Client disconnected or aborted | `⚡ ABORTED`, attempt `result: "cancelled"` |
| HTTP 504 / timeout | Upstream or phase deadline expired | `reason: "timeout"`, high `upstreamTtfbMs` or validation timeout |
| HTTP 502 with empty-stream error | Upstream returned a success shape with no meaningful output | `Successful chat stream contained no content...` |
| HTTP 503 with `Retry-After` | All candidates cooling down | `candidates[].healthSkip` / `nextProbeAt` |

Timeout controls (milliseconds):

```text
FETCH_CONNECT_TIMEOUT_MS=60000
STREAM_FIRST_CHUNK_TIMEOUT_MS=200000
STREAM_STALL_TIMEOUT_MS=360000
COMBO_FIRST_MEANINGFUL_TIMEOUT_MS=30000
```

Raise them for genuinely slow models; do not use them to mask a dead upstream.
A client abort is not an upstream failure and must not be retried server-side.

## 10. Understand post-commit SSE failures

Once the router has sent the response status, headers, and the first meaningful
stream content, the response is committed:

- a later upstream failure cannot trigger combo/account fallback;
- the failure appears as a stream error, a synthesized terminal event where the
  format supports one, or an abnormal close;
- the client should retry the entire request if it did not receive the expected
  terminal event (`[DONE]` for OpenAI chat completions).

Notes:

- OpenAI Responses streams do not use a `[DONE]` sentinel; some clients close
  the socket on normal completion. Do not classify every close as a failure for
  those clients.
- A stream that ends cleanly but with no content is rejected before commitment
  and triggers fallback; a stream that produced content and then died is a
  post-commit failure.
- Check the trace `kind` and the last attempt `status`/`reason` before retrying.

## 11. Run the offline integration smoke

These checks use an isolated temporary data directory, loopback-only ports, and
a controlled upstream. They do not call paid providers.

```bash
npm run build

STANDALONE_SMOKE_SKIP_BUILD=1 npm run test:runtime
STANDALONE_SMOKE_SKIP_BUILD=1 npm run test:integration:routing
```

Optional OpenCode interoperability probe (requires `opencode` on `PATH`):

```bash
SHOWDAR_ROUTER_OPENCODE_SMOKE=1 \
STANDALONE_SMOKE_SKIP_BUILD=1 \
npm run test:integration:routing
```

The routing integration smoke covers non-streaming JSON, streaming framing,
tool calls, 429 fallback, connect/prefill/stall timeouts, cancellation, hard
modality filtering, and the sanitized latency trace. It disables capacity
adapter pools so no remote egress can occur.

## 12. Roll back an unsuccessful deployment

### CLI / npm install

```bash
showdar-router --version                 # current
npm install -g showdar-router@<previous-version>
showdar-router --version                 # verify
```

Stop the running gateway before replacing it. Restart and check
`/api/health`, then send one explicit non-streaming and one explicit streaming
request.

### Source deployment

```bash
# stop the running gateway
git checkout <previous-tag-or-commit>
npm ci
npm run build
npm start
```

### Data directory

Stop the gateway before backing up or restoring SQLite. Back up the whole
database directory, including WAL state:

```bash
cp -a "$SHOWDAR_ROUTER_DATA_DIR/db" \
      "$SHOWDAR_ROUTER_DATA_DIR/db.backup.$(date +%Y%m%d-%H%M%S)"
```

Restore only while stopped:

```bash
rm -f "$SHOWDAR_ROUTER_DATA_DIR/db/data.sqlite-wal" \
      "$SHOWDAR_ROUTER_DATA_DIR/db/data.sqlite-shm"
cp "$SHOWDAR_ROUTER_DATA_DIR/db.backup.<timestamp>/data.sqlite" \
   "$SHOWDAR_ROUTER_DATA_DIR/db/data.sqlite"
```

Schema migrations are additive and may make an older binary unable to read a
newer database. When downgrading, restore a database backup taken before the
upgrade. Do not delete `data.sqlite` to "fix" startup: the one-time legacy
import may run again from old JSON files.

### Verify the rollback

```bash
curl -fsS http://127.0.0.1:21298/api/health
curl -fsS http://127.0.0.1:21298/api/version
```

Then run one request with `"stream": false` and one with `"stream": true`, and
confirm the trace shows the expected model/candidate.

## 13. Troubleshooting quick reference

| Symptom | First check |
|---|---|
| `No SQLite driver available` | Node version; reinstall native runtime packages; check `${DATA_DIR}/runtime` |
| Dashboard says Unauthorized | Dashboard session expired; log in again |
| API returns 401 | Missing/invalid router API key, or remote request without a key |
| API returns 404 "No active credentials" | Provider connection missing, inactive, or not tested |
| API returns 503 with `Retry-After` | All candidates/accounts cooling down; inspect `routeHealth` |
| 502 empty stream | Upstream returned no meaningful content; check provider/model and stream mode |
| SSE content type but JSON body | Client omitted `stream`; send `stream: true`/`false` explicitly |
| Request hangs | Check connect/first-chunk/stall timeouts; check client abort |
| Request goes to an unexpected remote model | Inspect trace candidates; disable capacity adapter pools |

## 14. Security and privacy checklist

- Protect `${DATA_DIR}`: it stores provider API keys and OAuth tokens.
- Use a strong dashboard password; do not expose the dashboard publicly
  without an authenticated reverse proxy.
- Keep `requireLogin` and `requireApiKey` enabled unless you have a specific
  trusted-local reason.
- Do not enable `ENABLE_REQUEST_LOGS=true` on shared or production hosts; it
  can capture full request headers and bodies.
- Review capacity adapter pools before sending images/audio; defaults can
  dispatch to a remote no-auth provider.
- Rotate provider credentials and router API keys after suspected exposure.
- Do not paste raw trace lines, database files, or `.env` contents into public
  issues.
