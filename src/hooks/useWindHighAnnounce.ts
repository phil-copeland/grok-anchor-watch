import { useEffect, useRef, useState } from 'react';
import { speak } from '../speech';
import {
  msToKmh,
  msToKnots,
  msToMph,
  type WindUnit,
} from '../units';

export type { WindUnit };

/** Wind must hold a new high level for this long before we announce. */
const HOLD_MS = 1000;

/** Grace after connect / source change so the first sample isn't spoken immediately. */
const WARMUP_MS = 2500;

function toDisplay(ms: number, unit: WindUnit): number {
  switch (unit) {
    case 'm/s':
      return ms;
    case 'km/h':
      return msToKmh(ms);
    case 'mph':
      return msToMph(ms);
    default:
      return msToKnots(ms);
  }
}

function unitLabel(unit: WindUnit): string {
  switch (unit) {
    case 'm/s':
      return 'metres per second';
    case 'km/h':
      return 'kilometres per hour';
    case 'mph':
      return 'miles per hour';
    default:
      return 'knots';
  }
}

/** Whole-number “level” in the active display unit (e.g. 12 kn, 6 m/s). */
function windLevel(ms: number, unit: WindUnit): number {
  return Math.floor(toDisplay(ms, unit));
}

/**
 * Minimum whole level that may be announced, from SI threshold.
 * 0 (or negative) min → no floor.
 */
function minAnnounceLevel(minMs: number, unit: WindUnit): number {
  if (!(minMs > 0) || !Number.isFinite(minMs)) return Number.NEGATIVE_INFINITY;
  // ceil so a threshold of 15.2 kn requires level 16; exact 15.0 → level 15
  return Math.ceil(toDisplay(minMs, unit) - 1e-9);
}

export interface WindHighAnnouncement {
  /** Display level that was announced (integer) */
  level: number;
  unit: WindUnit;
  /** When the announcement fired */
  at: number;
}

/**
 * Session high wind levels: when wind reaches a new whole-unit high and holds
 * it for over 1 second, speak + surface a short toast.
 * Also tracks continuous session peak for the wind chart high-mark line.
 * Runs on any live feed including cloud/remote phone UI.
 *
 * @param minMs — do not announce until wind is at least this (m/s); 0 = no floor
 */
export function useWindHighAnnounce(
  windSpeedMs: number | null,
  unit: WindUnit,
  enabled: boolean,
  /** Reset session when this changes (e.g. data source) */
  sessionKey = '',
  minMs = 0,
) {
  const [announcement, setAnnouncement] =
    useState<WindHighAnnouncement | null>(null);
  /** Session peak wind (m/s) — drives the red high-mark line on the wind chart */
  const [sessionHighMs, setSessionHighMs] = useState<number | null>(null);

  /** Highest whole level already announced this session */
  const announcedLevel = useRef(-1);
  /** Candidate level currently being held */
  const holdLevel = useRef<number | null>(null);
  const holdSince = useRef<number | null>(null);
  const latestLevel = useRef(-1);
  const sessionStart = useRef(Date.now());
  const unitRef = useRef(unit);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef(sessionKey);

  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    announcedLevel.current = -1;
    holdLevel.current = null;
    holdSince.current = null;
    sessionStart.current = Date.now();
    setSessionHighMs(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [sessionKey]);

  // Unit change: re-seed announce levels without clearing continuous SI peak
  useEffect(() => {
    if (unitRef.current === unit) return;
    unitRef.current = unit;
    holdLevel.current = null;
    holdSince.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    announcedLevel.current = -1;
  }, [unit]);

  // Threshold change: drop any in-progress hold (new floor may apply)
  useEffect(() => {
    holdLevel.current = null;
    holdSince.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [minMs]);

  useEffect(() => {
    if (!announcement) return;
    const id = window.setTimeout(() => setAnnouncement(null), 5000);
    return () => clearTimeout(id);
  }, [announcement]);

  // Continuous session peak (for chart) — always, independent of announce toggle
  useEffect(() => {
    if (windSpeedMs == null || !Number.isFinite(windSpeedMs)) return;
    setSessionHighMs((prev) =>
      prev == null || windSpeedMs > prev ? windSpeedMs : prev,
    );
  }, [windSpeedMs]);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!enabled || windSpeedMs == null || !Number.isFinite(windSpeedMs)) {
      holdLevel.current = null;
      holdSince.current = null;
      return;
    }

    const now = Date.now();
    const level = windLevel(windSpeedMs, unit);
    const floor = minAnnounceLevel(minMs, unit);
    latestLevel.current = level;

    // Still warming up — seed the high silently so connect doesn't speak
    if (now - sessionStart.current < WARMUP_MS) {
      if (level > announcedLevel.current) {
        announcedLevel.current = level;
      }
      holdLevel.current = null;
      holdSince.current = null;
      return;
    }

    // Below user threshold — keep silent; seed baseline so first announce is a true new high above floor
    if (level < floor) {
      if (level > announcedLevel.current) {
        announcedLevel.current = level;
      }
      holdLevel.current = null;
      holdSince.current = null;
      return;
    }

    // Ensure baseline is at least (floor - 1) so the first level at/above floor can announce
    if (announcedLevel.current < floor - 1) {
      announcedLevel.current = floor - 1;
    }

    if (level <= announcedLevel.current) {
      holdLevel.current = null;
      holdSince.current = null;
      return;
    }

    // New high territory — must hold *this* whole-unit level for HOLD_MS
    if (holdLevel.current !== level) {
      holdLevel.current = level;
      holdSince.current = now;
    }

    const since = holdSince.current ?? now;
    const remaining = HOLD_MS - (now - since);

    const fire = () => {
      const held = holdLevel.current;
      if (held == null || held <= announcedLevel.current) return;
      if (held < floor) return;
      if (latestLevel.current < held) return;

      announcedLevel.current = held;
      holdLevel.current = null;
      holdSince.current = null;

      const text = `New high wind, ${held} ${unitLabel(unit)}`;
      speak(text);
      setAnnouncement({ level: held, unit, at: Date.now() });
    };

    if (remaining <= 0) {
      fire();
    } else {
      timerRef.current = setTimeout(fire, remaining);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [windSpeedMs, unit, enabled, minMs]);

  const dismiss = () => setAnnouncement(null);

  /** Session high in the active display unit (for chart red line), or null */
  const highMark =
    sessionHighMs != null && Number.isFinite(sessionHighMs)
      ? toDisplay(sessionHighMs, unit)
      : null;

  return { announcement, dismiss, highMark };
}
