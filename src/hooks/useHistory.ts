import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint, HistoryRangeMinutes, VesselData } from '../types';

const HISTORY_KEY = 'anchor-watch-history-v2';
/** Absolute hard cap in memory / storage (≈ 4h @ 5s) */
const HARD_MAX_POINTS = 3000;
const RETAIN_MS = 4.5 * 60 * 60 * 1000;
/** Don't rewrite localStorage on every sample — major GC pressure over long runs */
const PERSIST_DEBOUNCE_MS = 30_000;

function loadHistory(): HistoryPoint[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) {
      const legacy = localStorage.getItem('anchor-watch-history');
      if (legacy) {
        const parsed = JSON.parse(legacy) as HistoryPoint[];
        return Array.isArray(parsed) ? prunePoints(parsed) : [];
      }
      return [];
    }
    const parsed = JSON.parse(raw) as HistoryPoint[];
    return Array.isArray(parsed) ? prunePoints(parsed) : [];
  } catch {
    return [];
  }
}

function prunePoints(points: HistoryPoint[], now = Date.now()): HistoryPoint[] {
  const cutoff = now - RETAIN_MS;
  let start = 0;
  while (start < points.length && points[start].t < cutoff) start += 1;
  const trimmed = start > 0 ? points.slice(start) : points;
  return trimmed.length > HARD_MAX_POINTS
    ? trimmed.slice(-HARD_MAX_POINTS)
    : trimmed;
}

/**
 * Append without copying the whole array when under capacity.
 * Falls back to slice only when pruning is needed.
 */
function appendPoint(
  prev: HistoryPoint[],
  point: HistoryPoint,
  cap: number,
  now: number,
): HistoryPoint[] {
  const cutoff = now - RETAIN_MS;
  // Fast path: still within age window and under cap
  if (
    prev.length + 1 <= cap &&
    (prev.length === 0 || prev[0].t >= cutoff)
  ) {
    const next = prev.slice();
    next.push(point);
    return next;
  }
  // Drop from front while over age, then cap length
  let start = 0;
  while (start < prev.length && prev[start].t < cutoff) start += 1;
  const keepFrom = Math.max(start, prev.length + 1 - cap);
  const next = prev.slice(keepFrom);
  next.push(point);
  return next;
}

function persistSync(points: HistoryPoint[]) {
  try {
    const slim = prunePoints(points);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
  } catch {
    /* quota / private mode */
  }
}

export function filterHistoryByRange(
  history: HistoryPoint[],
  rangeMinutes: HistoryRangeMinutes,
  now = Date.now(),
): HistoryPoint[] {
  const cutoff = now - rangeMinutes * 60_000;
  let start = 0;
  while (start < history.length && history[start].t < cutoff) start += 1;
  return start === 0 ? history : history.slice(start);
}

/**
 * Local sampling history, or cloud-provided history when `remoteHistory` is set.
 * Samples on a timer (not on every vessel delta) to avoid runaway updates.
 */
export function useHistory(
  data: VesselData,
  intervalMs: number,
  maxPoints: number,
  enabled: boolean,
  rangeMinutes: HistoryRangeMinutes,
  remoteHistory: HistoryPoint[] | null = null,
) {
  const [localHistory, setLocalHistory] = useState<HistoryPoint[]>(loadHistory);
  const dataRef = useRef(data);
  dataRef.current = data;

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersist = useRef<HistoryPoint[] | null>(null);

  const schedulePersist = useCallback((points: HistoryPoint[]) => {
    pendingPersist.current = points;
    if (persistTimer.current != null) return;
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      if (pendingPersist.current) {
        persistSync(pendingPersist.current);
        pendingPersist.current = null;
      }
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  // Interval-based sampling — independent of how fast Signal K fires
  useEffect(() => {
    if (remoteHistory != null || !enabled) return;

    const cap = Math.min(maxPoints, HARD_MAX_POINTS);
    const ms = Math.max(2000, intervalMs);

    const sample = () => {
      const d = dataRef.current;
      if (!d.updatedAt) return;
      const now = Date.now();
      const point: HistoryPoint = {
        t: now,
        distanceM: d.distanceM,
        windSpeedMs: d.windSpeedMs,
        bearingTrueRad: d.bearingTrueRad,
      };

      setLocalHistory((prev) => {
        const next = appendPoint(prev, point, cap, now);
        schedulePersist(next);
        return next;
      });
    };

    const initial = window.setTimeout(sample, Math.min(ms, 2000));
    const id = window.setInterval(sample, ms);

    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [intervalMs, maxPoints, enabled, remoteHistory, schedulePersist]);

  // Flush pending localStorage write on unmount / page hide
  useEffect(() => {
    const flush = () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      if (pendingPersist.current) {
        persistSync(pendingPersist.current);
        pendingPersist.current = null;
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const history = remoteHistory ?? localHistory;

  const clearHistory = useCallback(() => {
    if (remoteHistory != null) {
      return;
    }
    setLocalHistory([]);
    pendingPersist.current = null;
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem('anchor-watch-history');
    } catch {
      /* ignore */
    }
  }, [remoteHistory]);

  const windowed = useMemo(
    () => filterHistoryByRange(history, rangeMinutes),
    [history, rangeMinutes],
  );

  return {
    history,
    windowed,
    clearHistory,
    isRemote: remoteHistory != null,
  };
}
