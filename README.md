# Anchor Watch

Boat-side web app that monitors **distance to your anchor** (or active waypoint), plus **depth** and **wind**, using data from a [Signal K](https://signalk.org/) server (NMEA 0183 / NMEA 2000 bridged into Signal K).

It records a rolling **history of wind speed and distance to the anchor**, draws a north-up swing-circle view, and raises a visual/audio alarm when you leave the set radius.

**Remote / phone watch:** a cloud relay lets the boat push telemetry every few seconds so you can open a URL on your phone off the boat. Full deploy detail: **[DEPLOY.md](./DEPLOY.md)**.

## Features

- **Signal K WebSocket** subscription (`/signalk/v1/stream`)
- **Cloud mode** — boat agent → cloud server → phone (`/watch?token=…`)
- **Guard radius** pushed from the boat; phones follow it by default and can override
- Live instruments:
  - Distance & bearing to anchor / active waypoint
  - Depth (below transducer / keel / surface)
  - Wind speed & direction (true preferred, apparent fallback)
  - SOG, heading, GPS position
- **Swing-circle radar** with dwell heatmap
- **History charts** for distance and wind speed (configurable 5 min–4 h window)
- Configurable **alarm radius** with optional audio
- **Demo mode** simulator (no server required)
- Dark, tablet-friendly UI for cabin / night use

## Quick start (on boat)

```bash
cd anchor-watch
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

1. Open **Settings** → data source **Signal K** or **Demo**
2. Set your Signal K host (e.g. `192.168.1.50:3000`)
3. Set the **alarm / guard radius** on the main page (bottom controls)
4. Drop the anchor (or set it as the active waypoint) so distance & bearing are published

### Production build (UI only)

```bash
npm run build
npm run preview
```

## Phone / off-boat (cloud)

```text
Boat:  boat-agent (or browser publish) → HTTPS every ~3s → Fly and/or Suga
Phone: https://ACTIVE-HOST/watch?token=VIEW_TOKEN
```

You can run **Fly and Suga together** and switch with `CLOUD_URL` only (use the same `BOAT_TOKEN` / `VIEW_TOKEN` on both). See **[DEPLOY.md](./DEPLOY.md)** for dual-host setup and `.\scripts\switch-cloud.ps1 -Target fly|suga`.

### Live deployment (example — Fly)

| | URL |
|--|-----|
| App / health | https://breeze-anchor-watch.fly.dev/api/health |
| Phone watch | https://breeze-anchor-watch.fly.dev/watch?token=VIEW_TOKEN |

`VIEW_TOKEN` and `BOAT_TOKEN` are set as **cloud secrets** (not in the repo). Local copies may live in gitignored `fly-secrets.local.env` (see `cloud-hosts.example.env` for Fly + Suga URLs).

### Start the boat agent

On a machine that can reach Signal K (and the internet):

```bash
cd boat-agent
npm install

# PowerShell example:
$env:CLOUD_URL="https://breeze-anchor-watch.fly.dev"
$env:BOAT_TOKEN="your-boat-token"       # same as Fly BOAT_TOKEN
$env:SIGNALK_HOST="localhost:3000"    # or your Signal K host
$env:PUSH_INTERVAL_MS="3000"
$env:ALARM_RADIUS_M="40"              # guard radius (metres) for remote phones
npm start
```

Test without instruments:

```bash
$env:CLOUD_URL="https://breeze-anchor-watch.fly.dev"
$env:BOAT_TOKEN="your-boat-token"
npm run demo
```

When the agent is pushing, `/api/health` shows `"online": true`.

### Guard radius on remote phones

- The boat pushes `alarmRadiusM` with each update.
- **Boat agent:** set `ALARM_RADIUS_M` (else uses Signal K `maxRadius`, else 40 m).
- **Optional browser publish:** on the boat UI, Settings → set **Cloud URL** + **Boat publish token** while using Signal K/Demo; the **local alarm slider** is what remotes follow.
- **Phone default:** follow boat guard radius.
- **Phone override:** move the alarm slider → “local override”. Use **Use boat radius** to follow the boat again.

### Local cloud test (no Fly)

```bash
npm install
npm run build
cd server && npm install
# PowerShell:
$env:BOAT_TOKEN="boat"; $env:VIEW_TOKEN="view"; npm start

# other terminal:
cd boat-agent && npm install
$env:CLOUD_URL="http://localhost:8787"; $env:BOAT_TOKEN="boat"; npm run demo
```

Browser: http://localhost:8787/watch?token=view

### Redeploy to Fly

From the repo root (after code changes):

```bash
fly deploy -a breeze-anchor-watch
```

Secrets (once):

```bash
fly secrets set BOAT_TOKEN="…" VIEW_TOKEN="…" BOAT_NAME="Breeze" -a breeze-anchor-watch
```

More detail: **[DEPLOY.md](./DEPLOY.md)** — Fly deploy (`scripts/fly-deploy.ps1`), **Suga trial host**, and switching hosts (`scripts/switch-cloud.ps1`).

## Do I need to restart?

| Component | After a code / config change |
|-----------|------------------------------|
| **Browser tab** (local Vite or phone on Fly) | **Refresh** the page (hard refresh if UI looks stale: Ctrl+Shift+R / pull-to-refresh). Settings stay in browser storage. |
| **Vite dev server** (`npm run dev`) | Usually hot-reloads. If something looks wrong: stop and run `npm run dev` again. |
| **Boat agent** (`npm start` / `npm run demo`) | **Yes — restart** so it loads new code and env vars (`ALARM_RADIUS_M`, tokens, etc.). |
| **Cloud on Fly** | Run `fly deploy` (no local restart). Machines update automatically. |
| **Local cloud server** (`server` npm start) | Restart the Node process after server code changes. |

**Typical after a Fly redeploy:** refresh the phone page; restart the boat agent only if you also changed agent code or env vars.

## Signal K data paths

The app subscribes to `vessels.self` for:

| Path | Use |
|------|-----|
| `navigation.anchor.currentRadius` | Distance to anchor (m) |
| `navigation.anchor.maxRadius` | Server / Signal K alarm radius (m) |
| `navigation.anchor.position` | Anchor lat/lon — used to compute distance/bearing if needed |
| `navigation.courseGreatCircle.nextPoint.distance` | Distance to active waypoint (m) |
| `navigation.courseGreatCircle.nextPoint.bearingTrue` | Bearing to waypoint (rad) |
| `navigation.courseRhumbline.nextPoint.*` | Fallback for rhumbline course |
| `environment.depth.belowTransducer` / `belowKeel` / `belowSurface` | Depth (m) |
| `environment.wind.speedTrue` / `speedApparent` / `speedOverGround` | Wind speed (m/s) |
| `environment.wind.directionTrue` / `directionMagnetic` / `angleApparent` | Wind direction (rad) |
| `navigation.position` | Vessel lat/lon |
| `navigation.headingTrue` | Heading (rad) |
| `navigation.speedOverGround` | SOG (m/s) |
| `navigation.destination.commonName` | Waypoint name |

Signal K always uses **SI units** (metres, m/s, radians). Display units (knots, feet, etc.) are converted in the UI.

### Typical boat setup

1. Run **Signal K server** (e.g. on a Raspberry Pi / OpenPlotter) with NMEA sources.
2. When you anchor, either:
   - Use a Signal K **anchor watch** plugin / Freeboard-SK “set anchor”, or  
   - Mark a waypoint at the anchor and make it the **active** waypoint (RMB/APB or equivalent into Signal K).
3. Point this app at the server (same LAN as the boat network).
4. For remote watch, run **boat-agent** (or browser publish) so phones can open the Fly URL.

**Public demo server:** try `demo.signalk.org` with TLS enabled (data may not include an anchor — use local demo mode for a full swing simulation).

## Settings (persisted in the browser)

| Setting | Default | Notes |
|---------|---------|--------|
| Data source | Signal K | Also **Cloud** or **Demo** |
| Signal K server | `localhost:3000` | On-boat LAN |
| TLS (wss) | off | Required if page is https |
| Cloud URL | (empty) | e.g. `https://breeze-anchor-watch.fly.dev` |
| View token | (empty) | Phone / watch token |
| Boat publish token | (empty) | Optional; pushes from boat UI including alarm radius |
| Follow boat guard radius | on | Cloud mode: use boat’s radius until you override |
| Alarm radius | 40 m | Local / override value |
| History window | 30 min | 5 min–4 hours |
| History sample interval | 5 s | Local sources only |
| Distance / depth / wind units | m / m / kn | |
| Audio alarm | on | |

## Project layout

```
anchor-watch/
  src/                    # React UI
    App.tsx
    cloud/                # Cloud watch WebSocket client
    signalk/              # Signal K client + demo simulator
    hooks/                # Settings, data, history, alarm, cloud publish
    components/
  server/                 # Cloud API + static UI host
  boat-agent/             # Boat → cloud pusher
  scripts/fly-deploy.ps1  # Deploy helper
  fly.toml
  DEPLOY.md
  dist/                   # Production UI build
```

## Notes

- The browser must be able to reach the Signal K WebSocket. Mixed content rules mean an **https** page can only use **wss** (enable TLS in Settings).
- Local history is stored in the browser; cloud history is kept on the server while the boat is pushing.
- This is a monitoring display; it does not write anchor state back to Signal K.
- Do not put `BOAT_TOKEN` in the phone URL — only `VIEW_TOKEN`.

## License

MIT — use freely aboard.
