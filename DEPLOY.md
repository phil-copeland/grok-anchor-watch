# Deploy Anchor Watch cloud (phone URL)

Architecture:

```
  Boat (Signal K) ──boat-agent──HTTPS POST──► Cloud server ──WSS──► Phone browser
       LAN only              outbound only      Fly / Suga / etc      /watch?token=…
```

The boat **pushes** every few seconds (no inbound ports on the boat). Your phone opens a normal HTTPS link.

You can run **Fly and Suga at the same time** and switch by changing `CLOUD_URL` (boat) and the phone bookmark. Same app image (`server/Dockerfile`) on both.

---

## 1. Secrets

Generate two long random tokens (use the **same** tokens on every cloud host so switching is only a URL change):

```bash
# examples only — make your own
BOAT_TOKEN=boat_$(openssl rand -hex 16)
VIEW_TOKEN=view_$(openssl rand -hex 16)
```

- **BOAT_TOKEN** — only the boat agent / browser publish knows this (can publish).
- **VIEW_TOKEN** — goes in the phone URL (can only watch).

Local file (gitignored): `fly-secrets.local.env` — see `cloud-hosts.example.env` for dual-host fields:

```env
BOAT_TOKEN=…
VIEW_TOKEN=…
BOAT_NAME=Breeze
CLOUD_HOST=fly
CLOUD_URL_FLY=https://breeze-anchor-watch.fly.dev
CLOUD_URL_SUGA=https://YOUR-SUGA-HTTPS-URL
CLOUD_URL=https://breeze-anchor-watch.fly.dev
```

---

## 2. Fly.io (existing)

```bash
# From repo root
fly secrets set BOAT_TOKEN="…" VIEW_TOKEN="…" BOAT_NAME="Breeze" -a breeze-anchor-watch
fly deploy -a breeze-anchor-watch
# or: .\scripts\fly-deploy.ps1
```

| | URL |
|--|-----|
| Health | https://breeze-anchor-watch.fly.dev/api/health |
| Phone | https://breeze-anchor-watch.fly.dev/watch?token=VIEW_TOKEN |

---

## 3. Suga.app (trial host alongside Fly)

Suga is early-access PaaS: long-running containers, HTTPS, WebSockets. Docs: [docs.suga.app](https://docs.suga.app). Dashboard: [dashboard.suga.app](https://dashboard.suga.app).

The hosted MCP server is the intended way to shape the environment from this repo. It can create the project, container, public HTTPS port, env vars, and secret slots. It **cannot** apply, delete a project/environment, or read a secret value back. You review the draft in the dashboard and click **Deploy Changes** yourself.

MCP endpoint: `https://dashboard.suga.app/api/mcp`  
Docs: [Connect an AI Agent (MCP)](https://docs.suga.app/reference/mcp).

### Recommended: Grok + Suga MCP

1. **Add the server** (once; already in this repo’s `.grok/config.toml` and can also live in `~/.grok/config.toml`):

   ```powershell
   grok mcp add --transport http suga https://dashboard.suga.app/api/mcp
   ```

2. **Authenticate** in Grok: `/mcps` → select **suga** → press `i`. Approve the OAuth consent screen and pick the org the agent may reach.

3. **Install the Suga GitHub App** from the dashboard (the agent cannot start that install). Grant it `phil-copeland/grok-anchor-watch`.

4. Ask Grok to rebuild the Anchor Watch environment. Target spec:

   | Setting | Value |
   |---------|--------|
   | Service | Container, **1 replica** (in-memory store — do not scale out) |
   | Image | Build from GitHub `phil-copeland/grok-anchor-watch`, branch `main` |
   | Dockerfile | `server/Dockerfile` (not a root Dockerfile) |
   | Build context | `.` (repo root) |
   | Listen / public HTTPS | port **8787** |
   | Resources | start small (e.g. 0.25 CPU / 512 MiB if the plan allows) |
   | `PORT` | `8787` |
   | `NODE_ENV` | `production` |
   | `BOAT_NAME` | `Breeze` |
   | `BOAT_TOKEN` / `VIEW_TOKEN` | **secrets**, same values as Fly |

5. Open the deeplink the agent returns, review the canvas diff, click **Deploy Changes**.

6. Copy the generated HTTPS URL into `CLOUD_URL_SUGA=` in `fly-secrets.local.env`.

7. **Smoke test**

   ```text
   https://YOUR-SUGA-URL/api/health
   → { "ok": true, "service": "anchor-watch-server", … }
   ```

### Alternative: dashboard click-ops

Same spec as the table above: **New project** → **Add Service** → **Container** → **Build from GitHub** → public HTTPS on **8787** → env/secrets → **Replicas: 1** → **Deploy Changes**.

### Alternative without GitHub: pre-built image

```powershell
# Build (Linux amd64 — required by Suga)
docker build -f server/Dockerfile --platform linux/amd64 -t YOUR_DOCKERHUB_USER/anchor-watch:latest .
docker push YOUR_DOCKERHUB_USER/anchor-watch:latest
```

On Suga (MCP or dashboard): **Pre-built image** = `YOUR_DOCKERHUB_USER/anchor-watch:latest`, port **8787**, same env vars as above.

### Suga notes for this app

| Topic | Detail |
|-------|--------|
| WebSockets | Supported on HTTPS (`wss://`). Idle timeout 5 min — server already heartbeats every 10s. |
| Free plan | 15s **HTTP** request cap; WSS after upgrade is fine. Ingest POSTs are short. |
| History | In-memory per host — Fly and Suga do **not** share history. |
| Alpha | Suga is early access; keep Fly as the reliable fallback. |

---

## 4. Switching between Fly and Suga

Only the **URL** changes if tokens match on both hosts.

| Client | What to change |
|--------|----------------|
| **Boat agent** | `CLOUD_URL` → Fly or Suga base URL; restart agent |
| **Browser publish** (boat UI Settings) | **Cloud URL** field |
| **Phone** | Open `/watch?token=…` on the host you chose (or update bookmark) |

Helper script (updates local secrets + prints commands):

```powershell
.\scripts\switch-cloud.ps1 -Target suga
.\scripts\switch-cloud.ps1 -Target fly
```

After switching:

1. Confirm health: `$CLOUD_URL/api/health` → `"ok": true`
2. Start/restart boat push to the new URL
3. Health should show `"online": true` within a few seconds
4. Open the phone URL for **that** host

You can leave **both** services running; only the boat needs to point at one at a time (unless you deliberately dual-publish).

---

## 5. Phone URL

```text
https://ACTIVE-HOST/watch?token=VIEW_TOKEN
```

Examples:

- Fly: `https://breeze-anchor-watch.fly.dev/watch?token=…`
- Suga: `https://YOUR-SUGA-URL/watch?token=…`

Bookmark the active one on your phone. It opens the app in **cloud mode** automatically.

---

## 6. Boat agent

```bash
cd boat-agent
npm install
```

```powershell
$env:CLOUD_URL="https://ACTIVE-HOST"   # fly.dev OR suga URL
$env:BOAT_TOKEN="…"                    # same as cloud secrets
$env:SIGNALK_HOST="localhost:3000"
$env:PUSH_INTERVAL_MS="3000"
npm start
```

Demo without instruments:

```powershell
$env:CLOUD_URL="https://ACTIVE-HOST"; $env:BOAT_TOKEN="…"; npm run demo
```

### systemd example

```ini
[Unit]
Description=Anchor Watch boat agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/anchor-watch/boat-agent
Environment=CLOUD_URL=https://ACTIVE-HOST
Environment=BOAT_TOKEN=replace-me
Environment=SIGNALK_HOST=localhost:3000
Environment=PUSH_INTERVAL_MS=3000
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## 7. Local smoke test (no cloud)

```bash
npm run build
cd server && npm install && BOAT_TOKEN=boat VIEW_TOKEN=view npm start

# other terminal
cd boat-agent && CLOUD_URL=http://localhost:8787 BOAT_TOKEN=boat npm run demo
```

Browser: http://localhost:8787/watch?token=view

---

## 8. Checklist

| Step | OK when… |
|------|----------|
| Cloud up | `/api/health` returns `"ok": true` |
| Agent / browser publish | pushes to the **same** host the phone opens |
| Health online | `/api/health` shows `"online": true` |
| Phone | `/watch?token=…` on **that** host shows live data |

If the phone shows **Boat stale**, the boat is not pushing to that host (wrong `CLOUD_URL`, bad `BOAT_TOKEN`, agent down, or tab frozen — prefer boat-agent for unattended use).

---

## Security notes

- Always use **HTTPS** in production (Fly and Suga both terminate TLS).
- Do not put `BOAT_TOKEN` in the phone URL.
- Anyone with `VIEW_TOKEN` can watch — rotate if shared widely.
- Keep `fly-secrets.local.env` out of git (already gitignored).
