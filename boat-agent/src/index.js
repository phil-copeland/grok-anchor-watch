/**
 * Boat agent: Signal K (or local demo) → cloud ingest API.
 *
 * Env:
 *   CLOUD_URL       e.g. https://anchor-watch.example.com
 *   BOAT_TOKEN      must match server BOAT_TOKEN
 *   SIGNALK_HOST    e.g. localhost:3000
 *   SIGNALK_TLS     true/false
 *   PUSH_INTERVAL_MS  default 3000
 *   ALARM_RADIUS_M    guard radius to push for remote viewers (default: SK maxRadius or 40)
 *   DEMO            true to simulate without Signal K
 */

import { SignalKReader } from './signalk.js';
import { DemoSimulator } from './simulator.js';

const args = new Set(process.argv.slice(2));
const CLOUD_URL = (process.env.CLOUD_URL || 'http://localhost:8787').replace(
  /\/$/,
  '',
);
const BOAT_TOKEN = process.env.BOAT_TOKEN || 'boat-secret-change-me';
const SIGNALK_HOST = process.env.SIGNALK_HOST || 'localhost:3000';
const SIGNALK_TLS =
  process.env.SIGNALK_TLS === '1' || process.env.SIGNALK_TLS === 'true';
const PUSH_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.PUSH_INTERVAL_MS || 3000),
);
const ALARM_RADIUS_ENV = process.env.ALARM_RADIUS_M
  ? Number(process.env.ALARM_RADIUS_M)
  : null;
const DEMO =
  args.has('--demo') ||
  process.env.DEMO === '1' ||
  process.env.DEMO === 'true';

/** @type {object|null} */
let latest = null;
let lastPushOk = false;
let pushErrors = 0;

/** Stamp guard radius for remote viewers */
function withAlarmRadius(vessel) {
  const fromEnv =
    ALARM_RADIUS_ENV != null &&
    Number.isFinite(ALARM_RADIUS_ENV) &&
    ALARM_RADIUS_ENV > 0
      ? ALARM_RADIUS_ENV
      : null;
  const fromSk =
    vessel.maxRadiusM != null && vessel.maxRadiusM > 0
      ? vessel.maxRadiusM
      : null;
  const fromDemo =
    vessel.alarmRadiusM != null && vessel.alarmRadiusM > 0
      ? vessel.alarmRadiusM
      : null;
  return {
    ...vessel,
    alarmRadiusM: fromEnv ?? fromDemo ?? fromSk ?? 40,
    // Tag so mixed demo/live sources are easier to spot
    dataSourceLabel: DEMO ? 'demo' : 'signalk',
  };
}

async function pushOnce() {
  if (!latest) return;
  const vessel = withAlarmRadius(latest);
  const sample = {
    t: Date.now(),
    distanceM: vessel.distanceM ?? null,
    windSpeedMs: vessel.windSpeedMs ?? null,
    bearingTrueRad: vessel.bearingTrueRad ?? null,
  };
  const url = `${CLOUD_URL}/api/v1/ingest`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOAT_TOKEN}`,
      },
      body: JSON.stringify({ vessel, sample }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }
    if (!lastPushOk) {
      console.log(`[agent] push ok → ${url}`);
    }
    lastPushOk = true;
    pushErrors = 0;
  } catch (err) {
    lastPushOk = false;
    pushErrors += 1;
    if (pushErrors <= 3 || pushErrors % 10 === 0) {
      console.error(`[agent] push failed (${pushErrors}):`, err.message || err);
    }
  }
}

function startPusher() {
  setInterval(() => {
    void pushOnce();
  }, PUSH_INTERVAL_MS);
  // Immediate first push when data arrives
  const boot = setInterval(() => {
    if (latest) {
      void pushOnce();
      clearInterval(boot);
    }
  }, 500);
}

console.log(
  `[agent] cloud=${CLOUD_URL} interval=${PUSH_INTERVAL_MS}ms demo=${DEMO}` +
    (ALARM_RADIUS_ENV != null ? ` alarmRadius=${ALARM_RADIUS_ENV}m` : ' alarmRadius=auto'),
);

if (DEMO) {
  console.log('[agent] demo simulator (no Signal K)');
  const sim = new DemoSimulator((v) => {
    latest = v;
  });
  sim.start();
  startPusher();
} else {
  const reader = new SignalKReader(
    SIGNALK_HOST,
    SIGNALK_TLS,
    (v) => {
      latest = v;
    },
    (status, msg) => {
      console.log(`[signalk] ${status}${msg ? ' ' + msg : ''}`);
    },
  );
  reader.connect();
  startPusher();
}
