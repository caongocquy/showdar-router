# Showdar Router

A local AI routing gateway focused on reliable OpenAI-compatible routing for
OpenCode and other compatible clients.

Showdar Router is a private, independent fork/evolution of an existing router
codebase. It is not affiliated with OpenAI, OpenCode, Anthropic, Google, or any
provider shown in the dashboard.

## Why Showdar Router

Use one local endpoint for multiple AI providers, credentials, models, and
fallback combinations. Configure the gateway in the web dashboard, then point
OpenCode or another OpenAI-compatible client at the local `/v1` endpoint.

## Features

- OpenAI-compatible local API gateway.
- Multiple provider connections and model credentials.
- Ordered model combos with fallback.
- Health-aware route recovery with cooldown and probing.
- Provider and account fallback where supported.
- Usage and quota visibility where provider data is available.
- Dashboard configuration for providers, combos, keys, proxies, and media APIs.
- Local lifecycle CLI, interactive launcher, and system tray controls.
- Existing backup/import compatibility for older router data.

## How It Works

```text
OpenCode / OpenAI-compatible client
                |
                v
       Showdar Router :21298
                |
        +-------+-------+
        |               |
        v               v
   Direct model       Combo
                        |
                 ordered fallback
                        |
              health-aware routing
                        |
                        v
                   Providers
```

In production, the control plane and server are separate:

```text
CLI / interactive launcher / tray
                |
                v
             Daemon
                |
                v
       custom-server.js
                |
                v
      Next standalone server
```

The wrapper supplies the trusted local-peer information used by the security
guard. The generated Next standalone server remains the application server.

## Installation

This repository is private. Clone it using an account with access, or use an
existing checkout:

```sh
git clone <private-repository-url> showdar-router
cd showdar-router
npm install
npm run build
./scripts/install-local.sh
```

The installer creates `~/.local/bin/showdar-router`. Ensure that directory is
on `PATH`, then run the command from any directory:

```sh
showdar-router
```

The production build creates a clean Next standalone tree and includes the
wrapper, static assets, and public assets. Normal operation does not use
`next dev` or `next start`.

## Usage

### Interactive Launcher

Running `showdar-router` in an interactive terminal opens the interface
selector:

```text
Choose Interface (v0.1.x)
Server: http://localhost:21298

Web UI (Open in Browser)
Terminal UI (Interactive CLI)
Hide to Tray (Background)
Exit
```

The launcher starts the existing daemon when needed. Exit closes only the
launcher; it does not stop an already-running server. In a non-interactive
terminal, no arguments start the daemon directly.

### CLI

```sh
showdar-router start
showdar-router stop
showdar-router restart
showdar-router status
showdar-router logs
showdar-router logs -f
showdar-router tray
showdar-router --port <port>
showdar-router version
showdar-router help
```

### Port selection

Showdar Router prefers port `21298`. If it is occupied and no port was
explicitly requested, startup tries `21299`, `21300`, and later candidates up
to ten ports total:

```text
Port 21298 is busy, using 21299
URL: http://localhost:21299
```

Use `showdar-router status` to find the active URL. Explicit ports are stable:

```sh
showdar-router --port 30000
```

If port `30000` is occupied, startup fails instead of switching to another
port.

Defaults:

- URL: `http://localhost:21298`
- Data directory: `~/.showdar-router`
- PID file: `~/.showdar-router/run/showdar-router.pid`
- Log file: `~/.showdar-router/logs/showdar-router.log`

The launcher also accepts `showdar-router --tray` and `showdar-router -t`.

### System Tray

`showdar-router tray` attaches a menu-bar control process to the same daemon.
It does not start a second server. The tray provides:

- Server status and the local URL.
- Open Dashboard.
- Open Logs.
- Restart Server.
- Stop Server.
- Quit Tray.

Quit Tray leaves the daemon running. Stop Server explicitly stops it.

## OpenCode Setup

Start Showdar Router, configure at least one provider/model or combo in the
dashboard, then set the OpenAI-compatible provider base URL to either:

```text
http://127.0.0.1:21298/v1
```

or:

```text
http://localhost:21298/v1
```

If the daemon reports a fallback port, use that port instead. For example,
`URL: http://localhost:21299` means the OpenCode base URL is
`http://127.0.0.1:21299/v1`.

Use a router API key only when required by the dashboard setting. A safe fake
example for client configuration is:

```json
{
  "baseURL": "http://127.0.0.1:21298/v1",
  "apiKey": "sk-showdar-example"
}
```

When **Require API Key** is OFF, trusted local clients may omit the Showdar
Router API key. When it is ON, clients must provide a valid router API key.
Provider credentials configured inside Showdar Router are separate from this
optional client-facing key; never commit real credentials to this repository.

## Routing & Recovery

- Combo candidates keep their configured priority.
- Known unhealthy routes can be skipped during their cooldown.
- Route health is separate from provider credential/account health.
- Recovery uses cooldown and half-open probing; a successful probe restores
  the route to healthy.
- Useful upstream recovery metadata, including `Retry-After`, reset hints, and
  structured retry delays, is honored.
- Account fallback occurs before final route failure where supported.
- Failed or empty chat responses can fall through to the next combo candidate
  according to the current handler behavior.

Showdar Router does not currently reorder candidates based on latency.

## Security

Local trusted requests and remote requests are distinguished before public LLM
API handling. Disabling **Require API Key** is intended for trusted local
access; it does not make remote, LAN, or tunnel traffic automatically trusted.
The production wrapper provides the trusted peer proof used for local access,
and spoofed host or forwarded-IP headers alone are insufficient.

Enable **Require API Key** for client-facing access when appropriate. Dashboard
authentication is a separate setting. Do not expose an unsecured local API
directly to the public internet.

## Dashboard

The current dashboard includes:

- Endpoint & Key
- Providers
- Combo & Vision Adapter
- Usage
- Quota Tracker
- Token Saver
- CLI Tools
- Media Providers: embedding, text-to-image, video, text-to-speech,
  speech-to-text, and combined Web Fetch & Search
- Proxy Pools
- Console Log
- Translator when enabled
- Settings

## Development

```sh
npm install
npm run dev
```

Use `npm run dev` only for development. For production, use `npm run build`
and the `showdar-router` lifecycle commands.

Canonical environment variables are:

```text
SHOWDAR_ROUTER_PORT
SHOWDAR_ROUTER_DATA_DIR
```

The default values are `21298` and `~/.showdar-router`.

## Testing

The focused routing gate covers combo routing, route health, retry metadata,
provider/account recovery, and related fork behavior:

```sh
npm run test:routing
```

The currently verified gate is 8 test files, 62 tests, 0 failures.

Standalone production smoke testing builds the production tree, starts the
same wrapper entrypoint used by the daemon, checks `/login`, `/api/health`,
and `/api/version`, and rejects known standalone startup errors:

```sh
npm run test:runtime
```

The inherited broad suite is available with `npm test`; it is not represented
here as a fully green release gate.

## Project Status

Showdar Router is a private local fork intended for self-hosted development
and use. The project preserves existing provider, model, combo, API, database,
credential, and backup compatibility contracts. There is no public npm or
Docker distribution documented here.

## Upstream

Showdar Router is based on/forked from 9router by decolua.

Upstream: [decolua/9router](https://github.com/decolua/9router)

## License

See [LICENSE](LICENSE). Upstream copyright and license attribution are
preserved.
