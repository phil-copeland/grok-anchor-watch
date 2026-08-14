import { useEffect, useRef, useState } from 'react';
import { speak } from '../speech';
import { mToFt, mToNm, type DistanceUnit } from '../units';

export type { DistanceUnit };

/** Wind-style hold: new high must be sustained this long. */
const HOLD_MS = 1000;

/** Grace after connect / source change so the first sample isn't spoken. */
const WARMUP_MS = 2500;

/** New high must exceed previous high by more than this (200 mm). */
const MIN_INCREASE_M = 0.2;

function speakableDistance(metres: number, unit: DistanceUnit): string {
  switch (unit) {
    case 'ft':
      return `${mToFt(metres).toFixed(1)} feet`;
    case 'nm':
      return `${mToNm(metres).toFixed(3)} nautical miles`;
    default:
      return `${metres.toFixed(1)} metres`;
  }
}

export interface DistanceHighAnnouncement {
  /** Peak distance announced (metres SI) */
  distanceM: number;
  unit: DistanceUnit;
  at: number;
}

/**
 * Session high anchor distance — one shared value for the swing-circle High
 * box and (when enabled) voice/toast announce.
 *
 * A new high is committed when distance exceeds the previous high by more than
 * 200 mm and holds for over 1 second. Warmup seeds the high silently so the
 * first connect sample is not announced.
 *
 * @param minM — do not announce until distance is at least this (metres); 0 = no floor
 * @param announceEnabled — when false, still tracks the same high (for the UI box)
 *   but does not speak or toast
 */
export function useDistanceHighAnnounce(
  distanceM: number | null,
  unit: DistanceUnit,
  announceEnabled: boolean,
  /** Reset session when this changes (e.g. data source) */
  sessionKey = '',
  minM = 0,
) {
  const [announcement, setAnnouncement] =
    useState<DistanceHighAnnouncement | null>(null);
  /**
   * Official session high (metres) — same number that was / would be announced.
   * Updated only on silent seed (warmup / below floor) or confirmed hold peak.
   */
  const [highMarkM, setHighMarkM] = useState<number | null>(null);

  /**
   * Announce baseline (metres). Usually equals highMarkM; may be set to a
   * synthetic floor−0.2m gate so the first announce at the floor still needs
   * +200 mm over prior below-floor seed. Display never uses the synthetic value.
   */
  const announcedHighM = useRef<number | null>(null);
  /** Peak while continuously above (baseline + MIN_INCREASE) */
  const holdPeakM = useRef<number | null>(null);
  const holdSince = useRef<number | null>(null);
  const latestM = useRef<number | null>(null);
  const sessionStart = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef(sessionKey);

  /** Commit a real distance as the session high (UI + announce baseline). */
  const commitHigh = (metres: number) => {
    announcedHighM.current = metres;
    setHighMarkM(metres);
  };

  // New session on data-source / mode change
  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    announcedHighM.current = null;
    holdPeakM.current = null;
    holdSince.current = null;
    sessionStart.current = Date.now();
    setHighMarkM(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [sessionKey]);

  useEffect(() => {
    holdPeakM.current = null;
    holdSince.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [minM]);

  useEffect(() => {
    if (!announcement) return;
    const id = window.setTimeout(() => setAnnouncement(null), 5000);
    return () => clearTimeout(id);
  }, [announcement]);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Always track the session high (for the swing-circle box); announce is optional.
    if (distanceM == null || !Number.isFinite(distanceM)) {
      holdPeakM.current = null;
      holdSince.current = null;
      return;
    }

    const now = Date.now();
    latestM.current = distanceM;
    const floor = minM > 0 && Number.isFinite(minM) ? minM : 0;

    // Warmup: seed silent high so connect / remote open doesn't speak
    if (now - sessionStart.current < WARMUP_MS) {
      if (
        announcedHighM.current == null ||
        distanceM > announcedHighM.current
      ) {
        commitHigh(distanceM);
      }
      holdPeakM.current = null;
      holdSince.current = null;
      return;
    }

    // Below user threshold — seed baseline only (same high for UI, no announce)
    if (floor > 0 && distanceM < floor) {
      if (
        announcedHighM.current == null ||
        distanceM > announcedHighM.current
      ) {
        commitHigh(distanceM);
      }
      holdPeakM.current = null;
      holdSince.current = null;
      return;
    }

    // First rise to/above floor: synthetic baseline so +200 mm rule still applies.
    // Do not push the synthetic value into highMarkM (display stays at last real high).
    if (
      floor > 0 &&
      (announcedHighM.current == null || announcedHighM.current < floor)
    ) {
      const seed = announcedHighM.current;
      if (seed == null || seed < floor - MIN_INCREASE_M) {
        announcedHighM.current = floor - MIN_INCREASE_M;
      }
    }

    const baseline = announcedHighM.current;
    const threshold =
      baseline == null ? Number.NEGATIVE_INFINITY : baseline + MIN_INCREASE_M;

    if (distanceM <= threshold) {
      holdPeakM.current = null;
      holdSince.current = null;
      return;
    }

    // New high territory — track peak; must stay above threshold for HOLD_MS
    if (holdSince.current == null) {
      holdSince.current = now;
      holdPeakM.current = distanceM;
    } else {
      holdPeakM.current = Math.max(holdPeakM.current ?? distanceM, distanceM);
    }

    const since = holdSince.current;
    const remaining = HOLD_MS - (now - since);

    const fire = () => {
      const peak = holdPeakM.current;
      const base = announcedHighM.current;
      if (peak == null) return;
      if (floor > 0 && peak < floor) return;
      if (base != null && peak <= base + MIN_INCREASE_M) return;
      // Dropped back before hold finished
      const live = latestM.current;
      if (live == null || live <= (base ?? 0) + MIN_INCREASE_M) return;

      commitHigh(peak);
      holdPeakM.current = null;
      holdSince.current = null;

      if (!announceEnabled) return;

      const text = `New high distance, ${speakableDistance(peak, unit)}`;
      speak(text);
      setAnnouncement({ distanceM: peak, unit, at: Date.now() });
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
  }, [distanceM, unit, announceEnabled, minM]);

  const dismiss = () => setAnnouncement(null);

  return {
    announcement,
    dismiss,
    /**
     * Session high in metres — same value committed for announce
     * (null until first seed / confirmed high).
     */
    highMarkM,
  };
}
