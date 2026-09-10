# Docker

Run Showdar Router in a container. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 21298:21298 \
  -v "$HOME/.showdar-router:/app/data" \
  -e DATA_DIR=/app/data \
  --name showdar-router \
  decolua/9router:latest
```

App listens on port `21298`. Open: http://localhost:21298

## Manage container

```bash
docker logs -f showdar-router        # view logs
docker stop showdar-router           # stop
docker start showdar-router          # start again
docker rm -f showdar-router          # remove
```

## Data persistence

```bash
-v "$HOME/.showdar-router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.showdar-router/` (macOS/Linux) or `%APPDATA%\showdar-router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.showdar-router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 21298:21298 \
  -v "$HOME/.showdar-router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=21298 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name showdar-router \
  decolua/9router:latest
```

## Optional Headroom sidecar

The Showdar Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point Showdar Router at that proxy:

```yaml
services:
  showdar-router:
    image: decolua/9router:latest
    ports:
      - "21298:21298"
    volumes:
      - "$HOME/.showdar-router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull decolua/9router:latest
docker rm -f showdar-router
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
cd app && docker build -t showdar-router .

docker run --rm -p 21298:21298 \
  -v "$HOME/.showdar-router:/app/data" \
  -e DATA_DIR=/app/data \
  showdar-router
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:
- `ghcr.io/decolua/9router:v{version}` + `:latest`
- `decolua/9router:v{version}` + `:latest`

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.4.x && git push origin v0.4.x
```

Workflow: `app/.github/workflows/docker-publish.yml`
