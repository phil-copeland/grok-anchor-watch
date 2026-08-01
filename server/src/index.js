import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { BoatStore } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLIENT_DIST = join(ROOT, '..', 'dist');

const PORT = Number(process.env.PORT || 8787);
const BOAT_TOKEN = process.env.BOAT_TOKEN || 'boat-secret-change-me';
const VIEW_TOKEN = process.env.VIEW_TOKEN || 'view-secret-change-me';
const BOAT_NAME = process.env.BOAT_NAME || 'Breeze';

const store = new BoatStore();
const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: '256kb' }));

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || req.query.token || '';
}

function requireBoat(req, res, next) {
  if (bearer(req) !== BOAT_TOKEN) {
    res.status(401).json({ error: 'Unauthorized (boat token)' });
    return;
  }
  next();
}

function requireView(req, res, next) {
  if (bearer(req) !== VIEW_TOKEN) {
    res.status(401).json({ error: 'Unauthorized (view token)' });
    return;
  }
  next();
}

/** Health — no secrets */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'anchor-watch-server',
    boat: BOAT_NAME,
    online: store.isOnline(),
    lastIngestAt: store.lastIngestAt || null,
  });
});

/**
 * Boat → cloud. Prefer outbound HTTPS from the boat (no inbound ports).
 * Body: { vessel: VesselData, sample?: HistoryPoint }
 */
app.post('/api/v1/ingest', requireBoat, (req, res) => {
  const vessel = req.body?.vessel;
  if (!vessel || typeof vessel !== 'object') {
    res.status(400).json({ error: 'Missing vessel object' });
    return;
  }
  const snap = store.ingest(vessel, req.body.sample ?? null);
  broadcast({ type: 'update', vessel: snap.vessel, meta: snap.meta });
  res.json({ ok: true, online: snap.meta.online, historyPoints: snap.meta.historyPoints });
});

/** Phone / browser: current snapshot + history window */
app.get('/api/v1/snapshot', requireView, (req, res) => {
  const minutes = Math.min(240, Math.max(1, Number(req.query.minutes) || 240));
  res.json(store.snapshot(minutes));
});

/**
 * Boat: clear polluted history (e.g. after stopping a demo agent that mixed with live data).
 * Body optional: { keepSeconds?: number } — if set, only prune older than that; else wipe all.
 */
app.post('/api/v1/history/clear', requireBoat, (req, res) => {
  const keep = Number(req.body?.keepSeconds);
  if (Number.isFinite(keep) && keep > 0) {
    store.pruneHistory(keep * 1000);
  } else {
    store.clearHistory();
  }
  const snap = store.snapshot(240);
  broadcast({
    type: 'snapshot',
    vessel: snap.vessel,
    history: snap.history,
    meta: snap.meta,
    boatName: BOAT_NAME,
  });
  res.json({ ok: true, historyPoints: snap.meta.historyPoints });
});

/** Convenience watch URL → SPA with cloud mode + token */
app.get('/watch', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : VIEW_TOKEN;
  // Redirect into the SPA; token only in query (use HTTPS in production)
  const q = new URLSearchParams({
    mode: 'cloud',
    token,
  });
  res.redirect(302, `/?${q.toString()}`);
});

// Static SPA (built client). Must be after API routes.
app.use(express.static(CLIENT_DIST, { index: false }));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }
  res.sendFile(join(CLIENT_DIST, 'index.html'), (err) => {
    if (err) {
      res
        .status(503)
        .type('text')
        .send(
          'Anchor Watch UI not built. From repo root run: npm run build\nThen restart this server.',
        );
    }
  });
});

/** Live watch WebSocket for phones */
const wss = new WebSocketServer({ server, path: '/api/v1/watch' });

/** @type {Set<import('ws').WebSocket>} */
const viewers = new Set();

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of viewers) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || '';
    if (token !== VIEW_TOKEN) {
      ws.close(4401, 'Unauthorized');
      return;
    }
  } catch {
    ws.close(4400, 'Bad request');
    return;
  }

  viewers.add(ws);
  const snap = store.snapshot(240);
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      vessel: snap.vessel,
      history: snap.history,
      meta: snap.meta,
      boatName: BOAT_NAME,
    }),
  );

  // Soft heartbeat so clients detect stalls
  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'meta',
          meta: store.snapshot(1).meta,
          boatName: BOAT_NAME,
        }),
      );
    }
  }, 10_000);

  ws.on('close', () => {
    clearInterval(ping);
    viewers.delete(ws);
  });
});

// Bind all interfaces so Docker / Fly / Suga can reach the process
server.listen(PORT, '0.0.0.0', () => {
  const base = `http://0.0.0.0:${PORT}`;
  console.log(`Anchor Watch cloud server on ${base}`);
  console.log(`  Health:     /api/health`);
  console.log(`  Watch URL:  /watch?token=…`);
  console.log(`  Boat POST:  /api/v1/ingest  (Bearer BOAT_TOKEN)`);
  console.log(`  Boat name:  ${BOAT_NAME}`);
  if (BOAT_TOKEN === 'boat-secret-change-me' || VIEW_TOKEN === 'view-secret-change-me') {
    console.warn('  ⚠  Using default tokens — set BOAT_TOKEN and VIEW_TOKEN in production.');
  }
});
