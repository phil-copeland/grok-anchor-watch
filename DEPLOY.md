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

Suga is early-access PaaS: long-running containers, HTTPS, WebSockets. Docs: [docs.suga.app](https://docs.suga.app). Dashboard: [dashboard.suga.app](https://dashboard.suga.app/signup).

### Recommended: Build from GitHub

This repo is not required to leave Fly; Suga just needs a Git remote it can build.

1. **Put the project on GitHub** (once):

   ```powershell
   cd C:\Users\prcop\grok\development\grok-anchor-watch
   git init
   git add .
   git commit -m "Anchor Watch cloud server + UI"
   # Create empty repo on GitHub, then:
   git remote add origin https://github.com/YOUR_USER/grok-anchor-watch.git
   git push -u origin main
   ```

2. **Sign up** at [dashboard.suga.app](https://dashboard.suga.app/signup)  
   - Prefer region **Sydney** if you want AU latency (org region is chosen at setup).

3. **New project** → **Add Service** → **Container**.

4. **Image → Build from GitHub**
   - Install the Suga GitHub App for that repo.
   - Branch: `main` (or whatever you push).
   - **Dockerfile path:** `server/Dockerfile`  
     (important — not root `Dockerfile`)
   - **Build context:** `.` (repo root)

5. **Private / public networking**
   - App listens on **8787** (`PORT` default in the image).
   - **Public Networking → Enable Suga Domain (HTTPS)** → target port **8787**.
   - Copy the generated URL, e.g.  
     `https://….production….suga-….com`  
     → put it in `CLOUD_URL_SUGA=` in `fly-secrets.local.env`.

6. **Environment variables** (Config → Environment Variables) — mark tokens Sensitive:

   | Key | Value |
   |-----|--------|
   | `PORT` | `8787` |
   | `BOAT_TOKEN` | same as Fly |
   | `VIEW_TOKEN` | same as Fly |
   | `BOAT_NAME` | `Breeze` |
   | `NODE_ENV` | `production` |

7. **Resources**
   - **Replicas: 1** (in-memory store — do not scale out).
   - Start small (e.g. 0.25 CPU / 512 MiB if plan allows). Free tier is tight but enough to try.

8. **Deploy Changes** in the Suga UI.

9. **Smoke test**

   ```text
   https://YOUR-SUGA-URL/api/health
   → { "ok": true, "service": "anchor-watch-server", … }
   ```

### Alternative without GitHub: pre-built image

```powershell
# Build (Linux amd64 — required by Suga)
docker build -f server/Dockerfile --platform linux/amd64 -t YOUR_DOCKERHUB_USER/anchor-watch:latest .
docker push YOUR_DOCKERHUB_USER/anchor-watch:latest
```

On Suga: **Pre-built image** = `YOUR_DOCKERHUB_USER/anchor-watch:latest`, port **8787**, same env vars as above.

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
