import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint } from '../types';
import {
  headingDeltaRad,
  isPlausibleHeadingRad,
  normalizeHeadingRad,
} from '../units';

/** Keep enough heading history for slow multi-minute swings. */
const BUFFER_MS = 30 * 60 * 1000;
/** Need enough points to see a swing. */
const MIN_SAMPLES = 8;
/** Ignore micro-noise as "yaw" (degrees peak-to-peak of one half-swing). */
const MIN_HALF_SWING_DEG = 1;
/** Period estimates outside this band are discarded. */
const MIN_PERIOD_MS = 15_000;
const MAX_PERIOD_MS = 25 * 60 * 1000;
/** Min gap between live heading samples. */
const LIVE_SAMPLE_MS = 1000;
/** Default how many half-swings (peak↔trough) to draw on the yaw chart. */
export const DEFAULT_YAW_CHART_SWINGS = 7;
/** Default trailing window for yaw metrics + chart (2 minutes). */
export const DEFAULT_YAW_WINDOW_MINUTES = 2;
/** @deprecated Use DEFAULT_YAW_WINDOW_MINUTES — kept for older imports. */
export const YAW_CHART_WINDOW_MS = DEFAULT_YAW_WINDOW_MINUTES * 60_000;

/** Clamp yaw window to a sensible range (1–30 minutes). */
export function clampYawWindowMinutes(minutes: number | undefined): number {
  if (minutes == null || !Number.isFinite(minutes)) {
    return DEFAULT_YAW_WINDOW_MINUTES;
  }
  return Math.min(30, Math.max(1, Math.round(minutes)));
}

export function yawWindowMs(minutes: number | undefined): number {
  return clampYawWindowMinutes(minutes) * 60_000;
}

/** Short label e.g. "2 min" / "1 min" for UI. */
export function formatYawWindowLabel(minutes: number | undefined): string {
  const m = clampYawWindowMinutes(minutes);
  return m === 1 ? '1 min' : `${m} min`;
}
/**
 * Reject single-sample spikes that exceed this turn rate (anchored boat
 * cannot snap 90° in one second). Glitches / second compass → false lows.
 */
const MAX_YAW_RATE_DEG_S = 35;
/** After a long gap, accept any heading (re-sync). */
const RESYNC_GAP_MS = 15_000;

export interface YawChartPoint {
  t: number;
  /** Unwrapped heading in degrees (continuous, not 0–360 wrapped) */
  headingDeg: number;
}

export interface YawExtremumMark {
  t: number;
  headingDeg: number;
  kind: 'peak' | 'trough';
}

export interface YawMetrics {
  /** Half peak-to-peak heading swing (degrees) over the metrics window */
  amplitudeDeg: number | null;
  /** Full port↔starboard heading range (degrees) over the metrics window */
  peakToPeakDeg: number | null;
  /** Estimated full yaw cycle period (seconds), averaged in the metrics window */
  periodSec: number | null;
  /** Sample count used in the analysis window */
  sampleCount: number;
  /** How many full oscillations contributed to the period average */
  oscillationsUsed: number;
  /** Heading trace for the last N half-swings (for sparkline) */
  chartSeries: YawChartPoint[];
  /** Peaks/troughs within the chart window */
  chartExtrema: YawExtremumMark[];
  /** Heading trace for the configured trailing window (Yaw Watch etc.) */
  chartSeriesTimed: YawChartPoint[];
  /** Peaks/troughs within the timed window */
  chartExtremaTimed: YawExtremumMark[];
  /** TWD (wind direction) over the same timed window — for chart overlay */
  chartTwdTimed: YawChartPoint[];
}

export interface YawOptions {
  /**
   * Trailing window in minutes for amplitude, period, and timed chart.
   * Default {@link DEFAULT_YAW_WINDOW_MINUTES} (2).
   */
  windowMinutes?: number;
  /** Half-swings to include in the chart series (default 5). */
  chartSwings?: number;
}

interface HeadingSample {
  t: number;
  headingRad: number;
  /** Absolute wind direction (rad), when known — for TWD chart line */
  windDirectionRad?: number | null;
}

interface Extremum {
  t: number;
  v: number;
  kind: 'peak' | 'trough';
}

/**
 * Unwrap heading series so consecutive samples stay continuous (no 0/360 jumps).
 * Input should already be normalized to [0, 2π); we re-normalize defensively.
 */
function unwrapHeadings(rads: number[]): number[] {
  if (rads.length === 0) return [];
  const out = [normalizeHeadingRad(rads[0]!)];
  for (let i = 1; i < rads.length; i++) {
    const prev = out[i - 1]!;
    const next = normalizeHeadingRad(rads[i]!);
    out.push(prev + headingDeltaRad(prev, next));
  }
  return out;
}

/**
 * Drop impossible single-sample jumps (false 0°, alternate compass, etc.).
 * Uses shortest-arc rate so 359°→1° is ~2° not 358°.
 */
function filterHeadingOutliers(samples: HeadingSample[]): HeadingSample[] {
  if (samples.length === 0) return [];
  const out: HeadingSample[] = [
    {
      t: samples[0]!.t,
      headingRad: normalizeHeadingRad(samples[0]!.headingRad),
      windDirectionRad: samples[0]!.windDirectionRad ?? null,
    },
  ];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    if (!isPlausibleHeadingRad(s.headingRad)) continue;
    const h = normalizeHeadingRad(s.headingRad);
    const wind =
      s.windDirectionRad != null && isPlausibleHeadingRad(s.windDirectionRad)
        ? normalizeHeadingRad(s.windDirectionRad)
        : null;
    const prev = out[out.length - 1]!;
    const dtMs = s.t - prev.t;
    if (dtMs <= 0) continue;
    if (dtMs >= RESYNC_GAP_MS) {
      out.push({ t: s.t, headingRad: h, windDirectionRad: wind });
      continue;
    }
    const dtS = Math.max(dtMs / 1000, LIVE_SAMPLE_MS / 1000);
    const deltaDeg =
      (Math.abs(headingDeltaRad(prev.headingRad, h)) * 180) / Math.PI;
    // Cap absolute step: multi-source 180° flips must never enter the chart
    const maxDeg = Math.min(90, MAX_YAW_RATE_DEG_S * dtS + 2);
    if (deltaDeg > maxDeg) {
      // Spike — skip; do not poison unwrap / chart
      continue;
    }
    out.push({ t: s.t, headingRad: h, windDirectionRad: wind });
  }
  return out;
}

/**
 * Local peaks/troughs with mild smoothing of consecutive same-kind points
 * (keep the more extreme value).
 */
function findExtrema(times: number[], values: number[]): Extremum[] {
  const raw: Extremum[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[i - 1]!;
    const b = values[i]!;
    const c = values[i + 1]!;
    if (b >= a && b > c) {
      raw.push({ t: times[i]!, v: b, kind: 'peak' });
    } else if (b <= a && b < c) {
      raw.push({ t: times[i]!, v: b, kind: 'trough' });
    }
  }

  if (raw.length === 0) return [];

  const merged: Extremum[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const cur = raw[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.kind === last.kind) {
      if (cur.kind === 'peak' ? cur.v >= last.v : cur.v <= last.v) {
        merged[merged.length - 1] = cur;
      }
    } else {
      merged.push(cur);
    }
  }

  const minHalfRad = (MIN_HALF_SWING_DEG * Math.PI) / 180;
  const filtered: Extremum[] = [merged[0]!];
  for (let i = 1; i < merged.length; i++) {
    const cur = merged[i]!;
    const prev = filtered[filtered.length - 1]!;
    if (Math.abs(cur.v - prev.v) < minHalfRad) {
      continue;
    }
    if (cur.kind === prev.kind) {
      if (cur.kind === 'peak' ? cur.v >= prev.v : cur.v <= prev.v) {
        filtered[filtered.length - 1] = cur;
      }
    } else {
      filtered.push(cur);
    }
  }
  return filtered;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pruneBuffer(
  samples: HeadingSample[],
  now: number,
): HeadingSample[] {
  const cutoff = now - BUFFER_MS;
  return samples.filter((s) => s.t >= cutoff);
}

function emptyMetrics(sampleCount = 0): YawMetrics {
  return {
    amplitudeDeg: null,
    peakToPeakDeg: null,
    periodSec: null,
    sampleCount,
    oscillationsUsed: 0,
    chartSeries: [],
    chartExtrema: [],
    chartSeriesTimed: [],
    chartExtremaTimed: [],
    chartTwdTimed: [],
  };
}

function slimSeries(series: YawChartPoint[], maxPts = 240): YawChartPoint[] {
  if (series.length <= maxPts) return series;
  const step = Math.ceil(series.length / maxPts);
  return series.filter((_, i) => i % step === 0 || i === series.length - 1);
}

function seriesFromStart(
  times: number[],
  unwrapped: number[],
  extrema: Extremum[],
  startT: number,
): { series: YawChartPoint[]; marks: YawExtremumMark[] } {
  const series: YawChartPoint[] = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i]! < startT) continue;
    series.push({
      t: times[i]!,
      headingDeg: (unwrapped[i]! * 180) / Math.PI,
    });
  }

  const marks: YawExtremumMark[] = extrema
    .filter((e) => e.t >= startT)
    .map((e) => ({
      t: e.t,
      headingDeg: (e.v * 180) / Math.PI,
      kind: e.kind,
    }));

  return { series: slimSeries(series), marks };
}

/**
 * Build chart series covering the last `chartSwings` half-swings (peak↔trough).
 * Falls back to the last few minutes of samples if extrema are scarce.
 */
function buildChartSeries(
  times: number[],
  unwrapped: number[],
  extrema: Extremum[],
  chartSwings: number,
): { series: YawChartPoint[]; marks: YawExtremumMark[] } {
  if (times.length === 0) return { series: [], marks: [] };

  // Need chartSwings+1 extrema for chartSwings intervals
  let startT = times[0]!;
  if (extrema.length >= chartSwings + 1) {
    const startExt = extrema[extrema.length - (chartSwings + 1)]!;
    startT = startExt.t;
  } else if (extrema.length >= 2) {
    startT = extrema[0]!.t;
  } else {
    // No clear swings yet — show last ~5 minutes of heading
    startT = times[times.length - 1]! - 5 * 60_000;
  }

  return seriesFromStart(times, unwrapped, extrema, startT);
}

/**
 * Build chart series for a fixed trailing time window (e.g. last 5 minutes).
 *
 * Re-unwrap **only inside the window** so older 0/360 wraps outside the
 * window don't leave huge absolute unwrapped degrees that flatten the plot.
 */
function buildChartSeriesTimed(
  times: number[],
  samples: HeadingSample[],
  windowMs: number,
): { series: YawChartPoint[]; marks: YawExtremumMark[] } {
  if (times.length === 0 || samples.length === 0) {
    return { series: [], marks: [] };
  }
  const endT = samples[samples.length - 1]!.t;
  const startT = endT - windowMs;
  const inWin = samples.filter((s) => s.t >= startT);
  if (inWin.length < 2) return { series: [], marks: [] };

  const unwrapped = unwrapHeadings(inWin.map((s) => s.headingRad));
  const series: YawChartPoint[] = inWin.map((s, i) => ({
    t: s.t,
    headingDeg: (unwrapped[i]! * 180) / Math.PI,
  }));
  // Extrema for chart marks within this re-unwrapped window
  const winTimes = inWin.map((s) => s.t);
  const extrema = findExtrema(winTimes, unwrapped);
  const marks: YawExtremumMark[] = extrema.map((e) => ({
    t: e.t,
    headingDeg: (e.v * 180) / Math.PI,
    kind: e.kind,
  }));
  return { series: slimSeries(series), marks };
}

/**
 * Carry last known wind forward so brief nulls don't drop the TWD line.
 */
function forwardFillWind(samples: HeadingSample[]): HeadingSample[] {
  let last: number | null = null;
  // First pass: seed last from first known (also back-fill start of series)
  for (const s of samples) {
    if (s.windDirectionRad != null && Number.isFinite(s.windDirectionRad)) {
      last = normalizeHeadingRad(s.windDirectionRad);
      break;
    }
  }
  return samples.map((s) => {
    if (s.windDirectionRad != null && Number.isFinite(s.windDirectionRad)) {
      last = normalizeHeadingRad(s.windDirectionRad);
      return { ...s, windDirectionRad: last };
    }
    return { ...s, windDirectionRad: last };
  });
}

/** TWD samples over the timed window, unwrapped only within that window. */
function buildTwdSeriesTimed(
  samples: HeadingSample[],
  windowMs: number,
): YawChartPoint[] {
  if (samples.length === 0) return [];
  const endT = samples[samples.length - 1]!.t;
  const startT = endT - windowMs;
  // Forward-fill wind onto every heading sample in the window
  const inWin = forwardFillWind(samples.filter((s) => s.t >= startT)).filter(
    (s) => s.windDirectionRad != null && Number.isFinite(s.windDirectionRad),
  );
  if (inWin.length === 0) return [];
  if (inWin.length === 1) {
    // Single point: still draw a short segment so the line doesn't vanish
    const p = inWin[0]!;
    const deg = (normalizeHeadingRad(p.windDirectionRad!) * 180) / Math.PI;
    return [
      { t: Math.max(startT, p.t - 1000), headingDeg: deg },
      { t: p.t, headingDeg: deg },
    ];
  }
  const unwrapped = unwrapHeadings(
    inWin.map((s) => normalizeHeadingRad(s.windDirectionRad!)),
  );
  const series: YawChartPoint[] = inWin.map((s, i) => ({
    t: s.t,
    headingDeg: (unwrapped[i]! * 180) / Math.PI,
  }));
  return slimSeries(series);
}

/**
 * Yaw from heading: amplitude & period over a trailing time window
 * (same window as the yaw chart). Default 2 minutes.
 */
export function computeYawMetrics(
  samples: HeadingSample[],
  now = Date.now(),
  options: YawOptions = {},
): YawMetrics {
  const windowMs = yawWindowMs(options.windowMinutes);
  const chartSwings = Math.min(
    15,
    Math.max(3, Math.round(options.chartSwings ?? DEFAULT_YAW_CHART_SWINGS)),
  );

  const dense: HeadingSample[] = [];
  const sorted = pruneBuffer(samples, now)
    .filter(
      (s) =>
        Number.isFinite(s.headingRad) &&
        Number.isFinite(s.t) &&
        isPlausibleHeadingRad(s.headingRad),
    )
    .sort((a, b) => a.t - b.t);

  for (const s of sorted) {
    const last = dense[dense.length - 1];
    const wind =
      s.windDirectionRad != null && isPlausibleHeadingRad(s.windDirectionRad)
        ? normalizeHeadingRad(s.windDirectionRad)
        : null;
    const norm: HeadingSample = {
      t: s.t,
      headingRad: normalizeHeadingRad(s.headingRad),
      windDirectionRad: wind,
    };
    if (last && s.t - last.t < 400) {
      dense[dense.length - 1] = {
        ...norm,
        // Keep last known wind if this tick missed it
        windDirectionRad: wind ?? last.windDirectionRad ?? null,
      };
    } else {
      dense.push(norm);
    }
  }

  const compact = filterHeadingOutliers(dense);

  if (compact.length < MIN_SAMPLES) {
    return emptyMetrics(compact.length);
  }

  const times = compact.map((s) => s.t);
  const unwrapped = unwrapHeadings(compact.map((s) => s.headingRad));
  const extrema = findExtrema(times, unwrapped);
  const { series: chartSeries, marks: chartExtrema } = buildChartSeries(
    times,
    unwrapped,
    extrema,
    chartSwings,
  );
  // Timed chart: re-unwrap inside window only (avoids flat lines from old wraps)
  const { series: chartSeriesTimed, marks: chartExtremaTimed } =
    buildChartSeriesTimed(times, compact, windowMs);
  const chartTwdTimed = buildTwdSeriesTimed(compact, windowMs);

  // —— Metrics window (same as the chart) ——
  const endT = times[times.length - 1]!;
  const metricsStartT = endT - windowMs;
  const winSamples = compact.filter((s) => s.t >= metricsStartT);
  if (winSamples.length < MIN_SAMPLES) {
    return {
      ...emptyMetrics(winSamples.length),
      chartSeries,
      chartExtrema,
      chartSeriesTimed,
      chartExtremaTimed,
      chartTwdTimed,
    };
  }

  // Re-unwrap only inside the metrics window (same idea as the timed chart)
  const winTimes = winSamples.map((s) => s.t);
  const winUnwrapped = unwrapHeadings(winSamples.map((s) => s.headingRad));
  const winExtrema = findExtrema(winTimes, winUnwrapped);

  let minU = winUnwrapped[0]!;
  let maxU = winUnwrapped[0]!;
  for (const u of winUnwrapped) {
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
  }
  const rangeP2pDeg = ((maxU - minU) * 180) / Math.PI;

  // Full oscillation period: peak→peak or trough→trough within the window
  const periodsMs: number[] = [];
  for (let i = 2; i < winExtrema.length; i++) {
    const a = winExtrema[i - 2]!;
    const b = winExtrema[i]!;
    if (a.kind !== b.kind) continue;
    const dt = b.t - a.t;
    if (dt >= MIN_PERIOD_MS && dt <= MAX_PERIOD_MS) {
      periodsMs.push(dt);
    }
  }
  const avgPeriodMs = mean(periodsMs);

  if (rangeP2pDeg < MIN_HALF_SWING_DEG * 2) {
    return {
      ...emptyMetrics(winSamples.length),
      amplitudeDeg: 0,
      peakToPeakDeg: 0,
      periodSec: avgPeriodMs != null ? avgPeriodMs / 1000 : null,
      oscillationsUsed: periodsMs.length,
      chartSeries,
      chartExtrema,
      chartSeriesTimed,
      chartExtremaTimed,
      chartTwdTimed,
    };
  }

  return {
    amplitudeDeg: rangeP2pDeg / 2,
    peakToPeakDeg: rangeP2pDeg,
    periodSec: avgPeriodMs != null ? avgPeriodMs / 1000 : null,
    sampleCount: winSamples.length,
    oscillationsUsed: periodsMs.length,
    chartSeries,
    chartExtrema,
    chartSeriesTimed,
    chartExtremaTimed,
    chartTwdTimed,
  };
}

/** Format period for metric sub-line. */
export function formatYawPeriod(periodSec: number | null): string | null {
  if (periodSec == null || !Number.isFinite(periodSec) || periodSec <= 0) {
    return null;
  }
  if (periodSec >= 60) {
    const min = periodSec / 60;
    return min >= 10
      ? `${Math.round(min)} min period`
      : `${min.toFixed(1)} min period`;
  }
  return `${Math.round(periodSec)} s period`;
}

/** Format full peak-to-peak yaw swing (port↔starboard). */
export function formatYawSwing(peakToPeakDeg: number | null): string {
  if (peakToPeakDeg == null || !Number.isFinite(peakToPeakDeg)) return '—';
  if (peakToPeakDeg < 1) return '0°';
  return `${Math.round(peakToPeakDeg)}°`;
}

function historyToSamples(history: HistoryPoint[], now: number): HeadingSample[] {
  const cutoff = now - BUFFER_MS;
  const out: HeadingSample[] = [];
  for (const p of history) {
    if (p.t < cutoff) continue;
    const h = p.headingTrueRad;
    if (h == null || !isPlausibleHeadingRad(h)) continue;
    const wind =
      p.windDirectionRad != null && isPlausibleHeadingRad(p.windDirectionRad)
        ? normalizeHeadingRad(p.windDirectionRad)
        : null;
    out.push({
      t: p.t,
      headingRad: normalizeHeadingRad(h),
      windDirectionRad: wind,
    });
  }
  return out;
}

/**
 * Rolling yaw metrics from a live heading stream, seeded by history.
 * Amplitude, period, and timed chart share `windowMinutes` (default 2).
 *
 * @param resetKey — when this changes, drop live samples and re-seed from history
 */
export function useYaw(
  headingTrueRad: number | null,
  history: HistoryPoint[],
  windowMinutes: number = DEFAULT_YAW_WINDOW_MINUTES,
  chartSwings: number = DEFAULT_YAW_CHART_SWINGS,
  resetKey = 0,
  windDirectionRad: number | null = null,
): YawMetrics {
  const [liveSamples, setLiveSamples] = useState<HeadingSample[]>([]);
  const headingRef = useRef(headingTrueRad);
  headingRef.current = headingTrueRad;
  const windRef = useRef(windDirectionRad);
  windRef.current = windDirectionRad;
  /** Last known good wind so TWD line doesn't drop when SK skips a tick */
  const lastWindRef = useRef<number | null>(null);
  const seededFromHistory = useRef(false);
  const resetKeyRef = useRef(resetKey);
  const winMin = clampYawWindowMinutes(windowMinutes);
  const chartN = Math.min(
    15,
    Math.max(3, Math.round(Number(chartSwings) || DEFAULT_YAW_CHART_SWINGS)),
  );

  // Explicit reset (new anchorage) — wipe buffer so old swings don't linger
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    seededFromHistory.current = false;
    lastWindRef.current = null;
    setLiveSamples([]);
  }, [resetKey]);

  useEffect(() => {
    if (seededFromHistory.current) return;
    const now = Date.now();
    const fromHist = historyToSamples(history, now);
    if (fromHist.length < 2) return;
    seededFromHistory.current = true;
    const filled = forwardFillWind(fromHist);
    for (let i = filled.length - 1; i >= 0; i--) {
      const w = filled[i]!.windDirectionRad;
      if (w != null && Number.isFinite(w)) {
        lastWindRef.current = w;
        break;
      }
    }
    setLiveSamples((prev) => {
      if (prev.length >= filled.length) return prev;
      return pruneBuffer([...filled, ...prev], now);
    });
  }, [history]);

  useEffect(() => {
    const tick = () => {
      const h = headingRef.current;
      if (h == null || !isPlausibleHeadingRad(h)) return;
      const now = Date.now();
      const w = windRef.current;
      if (w != null && isPlausibleHeadingRad(w)) {
        lastWindRef.current = normalizeHeadingRad(w);
      }
      // Always attach last known wind so the blue line stays continuous
      const windOut = lastWindRef.current;
      const sample: HeadingSample = {
        t: now,
        headingRad: normalizeHeadingRad(h),
        windDirectionRad: windOut,
      };
      setLiveSamples((prev) => {
        const last = prev[prev.length - 1];
        if (last && now - last.t < RESYNC_GAP_MS) {
          const dtS = Math.max((now - last.t) / 1000, LIVE_SAMPLE_MS / 1000);
          const deltaDeg =
            (Math.abs(headingDeltaRad(last.headingRad, sample.headingRad)) *
              180) /
            Math.PI;
          const maxDeg = Math.min(90, MAX_YAW_RATE_DEG_S * dtS + 2);
          if (deltaDeg > maxDeg) {
            if (
              sample.windDirectionRad != null &&
              last.windDirectionRad !== sample.windDirectionRad
            ) {
              const next = prev.slice();
              next[next.length - 1] = {
                ...last,
                windDirectionRad: sample.windDirectionRad,
              };
              return next;
            }
            return prev;
          }
        }
        return pruneBuffer([...prev, sample], now);
      });
    };
    tick();
    const id = window.setInterval(tick, LIVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo(
    () =>
      computeYawMetrics(liveSamples, Date.now(), {
        windowMinutes: winMin,
        chartSwings: chartN,
      }),
    [liveSamples, winMin, chartN],
  );
}
