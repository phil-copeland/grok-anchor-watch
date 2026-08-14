import { memo, useId, useMemo, useRef } from 'react';
import {
  formatYawWindowLabel,
  type YawChartPoint,
  type YawExtremumMark,
} from '../hooks/useYaw';
import type { WindUnit } from '../units';
import { formatBearing, formatWind, radToDeg } from '../units';
import { YawSwingChart } from './YawSwingChart';

export type WindDirectionSource =
  | 'directionTrue'
  | 'directionMagnetic'
  | 'angleApparent'
  | null;

interface Props {
  headingTrueRad: number | null;
  windDirectionRad: number | null;
  windDirectionSource: WindDirectionSource;
  windSpeedMs: number | null;
  windUnit: WindUnit;
  /** Peak-to-peak yaw (degrees) */
  yawPeakToPeakDeg: number | null;
  /** Optional yaw period label (already formatted or raw) */
  yawPeriodLabel?: string | null;
  /** Yaw sparkline series (trailing window) */
  yawChartSeries?: YawChartPoint[];
  yawChartExtrema?: YawExtremumMark[];
  /** TWD overlay series (yaw chart, same window) */
  twdChartSeries?: YawChartPoint[];
  /**
   * Trailing window for yaw metrics + chart (minutes). Default 2.
   */
  yawWindowMinutes?: number;
  /**
   * Absolute TWD samples in degrees (0–360, magnetic preferred) for outer-ring
   * heatmap — typically last 30 min from wind history.
   */
  twdHeatSamples?: number[];
  /**
   * Absolute heading samples in degrees (0–360, magnetic preferred) for
   * inner-ring heatmap — typically last 30 min from heading history.
   */
  hdgHeatSamples?: number[];
  yawChartStatus?: string;
  /** Magnetic variation label e.g. "23°E" (when TWD converted from true) */
  variationLabel?: string | null;
  /** TWD was true and converted with WMM */
  windConvertedFromTrue?: boolean;
}

/** Dwell heatmap bins (5° each around full circle, north-up) */
const HEAT_BINS = 72;
const HEAT_BIN_DEG = 360 / HEAT_BINS;

/** Density 0–1 → cool→hot (TWD outer ring — blue→cyan→yellow) */
function twdHeatColor(t: number, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let r: number;
  let g: number;
  let b: number;
  if (clamped < 0.33) {
    const u = clamped / 0.33;
    r = 20 + u * 20;
    g = 80 + u * 100;
    b = 160 + u * 40;
  } else if (clamped < 0.66) {
    const u = (clamped - 0.33) / 0.33;
    r = 40 + u * 180;
    g = 180 + u * 40;
    b = 200 - u * 160;
  } else {
    const u = (clamped - 0.66) / 0.34;
    r = 220 + u * 35;
    g = 220 - u * 180;
    b = 40 - u * 20;
  }
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

/** Density 0–1 → amber→gold→hot (HDG inner ring — matches yaw gold) */
function hdgHeatColor(t: number, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let r: number;
  let g: number;
  let b: number;
  if (clamped < 0.33) {
    const u = clamped / 0.33;
    r = 90 + u * 80;
    g = 60 + u * 50;
    b = 20 + u * 10;
  } else if (clamped < 0.66) {
    const u = (clamped - 0.33) / 0.33;
    r = 170 + u * 55;
    g = 110 + u * 70;
    b = 30 + u * 10;
  } else {
    const u = (clamped - 0.66) / 0.34;
    r = 225 + u * 30;
    g = 180 - u * 40;
    b = 40 - u * 15;
  }
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

type HeatResult = {
  cells: Array<{ path: string; fill: string }>;
  rangePath: string | null;
  rangeLabel: string | null;
};

/** Bin absolute compass samples into an annulus dwell heatmap (north-up). */
function buildDwellHeat(
  samples: number[],
  rInner: number,
  rOuter: number,
  colorFn: (t: number, alpha: number) => string,
): HeatResult {
  if (samples.length === 0) {
    return { cells: [], rangePath: null, rangeLabel: null };
  }

  const counts = new Float32Array(HEAT_BINS);
  let maxC = 0;
  let sinSum = 0;
  let cosSum = 0;
  let n = 0;
  for (const deg of samples) {
    if (!Number.isFinite(deg)) continue;
    const a = ((deg % 360) + 360) % 360;
    const bi = Math.min(HEAT_BINS - 1, Math.floor(a / HEAT_BIN_DEG));
    counts[bi]! += 1;
    if (counts[bi]! > maxC) maxC = counts[bi]!;
    const rad = (a * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
    n += 1;
  }

  const cells: Array<{ path: string; fill: string }> = [];
  if (maxC > 0) {
    for (let i = 0; i < HEAT_BINS; i++) {
      const c = counts[i]!;
      if (c <= 0) continue;
      const t = c / maxC;
      if (t < 0.06) continue;
      const d0 = i * HEAT_BIN_DEG;
      const d1 = d0 + HEAT_BIN_DEG + 0.15;
      cells.push({
        path: annulusSectorPath(CX, CY, rInner, rOuter, d0, d1),
        fill: colorFn(t, 0.18 + t * 0.55),
      });
    }
  }

  let rangePath: string | null = null;
  let rangeLabel: string | null = null;
  if (n >= 2 && maxC > 0) {
    const active: number[] = [];
    for (let i = 0; i < HEAT_BINS; i++) {
      if (counts[i]! / maxC >= 0.15) active.push(i);
    }
    if (active.length > 0) {
      let bestStart = active[0]!;
      let bestLen = 1;
      let runStart = active[0]!;
      let runLen = 1;
      for (let k = 1; k < active.length; k++) {
        if (active[k]! === active[k - 1]! + 1) {
          runLen += 1;
        } else {
          if (runLen > bestLen) {
            bestLen = runLen;
            bestStart = runStart;
          }
          runStart = active[k]!;
          runLen = 1;
        }
      }
      if (active[0] === 0 && active[active.length - 1] === HEAT_BINS - 1) {
        let left = 0;
        while (left < active.length && active[left] === left) left += 1;
        let right = 0;
        while (
          right < active.length &&
          active[active.length - 1 - right] === HEAT_BINS - 1 - right
        ) {
          right += 1;
        }
        const wrapLen = left + right;
        if (wrapLen > bestLen && wrapLen < HEAT_BINS) {
          bestLen = wrapLen;
          bestStart = HEAT_BINS - right;
        }
      } else if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
      const d0 = bestStart * HEAT_BIN_DEG;
      const sweep = bestLen * HEAT_BIN_DEG;
      rangePath = annulusSectorPath(
        CX,
        CY,
        rInner - 1,
        rOuter + 1,
        d0,
        d0 + sweep,
      );
    }
    const mean =
      n > 0
        ? (((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360)
        : null;
    rangeLabel =
      mean != null
        ? `30 min · mean ${Math.round(mean).toString().padStart(3, '0')}°`
        : '30 min dwell';
  }

  return { cells, rangePath, rangeLabel };
}

/** Annulus sector path, 0° = up, clockwise positive (SVG) */
function annulusSectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  degStart: number,
  degEnd: number,
): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  // Sweep clockwise in screen space
  let sweep = degEnd - degStart;
  while (sweep < 0) sweep += 360;
  while (sweep >= 360) sweep -= 360;
  if (sweep < 0.05) sweep = 0.05;
  const large = sweep > 180 ? 1 : 0;
  const a0 = toRad(degStart);
  const a1 = toRad(degStart + sweep);
  const x0o = cx + rOuter * Math.sin(a0);
  const y0o = cy - rOuter * Math.cos(a0);
  const x1o = cx + rOuter * Math.sin(a1);
  const y1o = cy - rOuter * Math.cos(a1);
  const x1i = cx + rInner * Math.sin(a1);
  const y1i = cy - rInner * Math.cos(a1);
  const x0i = cx + rInner * Math.sin(a0);
  const y0i = cy - rInner * Math.cos(a0);
  // Outer arc clockwise (sweep-flag 1 in SVG when y-up is flipped…):
  // With sin/cos polar (0 up, clockwise), increasing angle is clockwise.
  // SVG arc: sweep-flag 1 = clockwise in standard y-down; with our points it matches.
  return [
    `M ${x0o.toFixed(2)} ${y0o.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
    `L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/** ViewBox geometry — dial fills most of the square */
const VB = 360;
const CX = VB / 2;
const CY = VB / 2;
/** Outer bezel edge */
const R_BEZEL = 168;
/** Compass face outer */
const R_FACE = 158;
/** Tick outer / wind track */
const R_TICK = 154;
const R_TICK_MAJ = 140;
const R_TICK_MIN = 146;
/** Label radius (inside ticks) */
const R_LABEL = 126;
/** Inner boat well — HDG badge sits just above this */
const R_WELL = 72;
/** Wind arrow on face rim */
const R_WIND = 152;
/**
 * Heading dwell heat — annulus between boat well and compass labels.
 * HDG badge sits just below this ring (closer to the boat).
 */
const R_HDG_HEAT_OUTER = R_LABEL - 4;
const R_HDG_HEAT_INNER = R_WELL + 18;
/** HDG badge sits under the heading heat, close to the boat well */
const HDG_BADGE_H = 38;
const HDG_BADGE_W = 104;
/** Top of HDG badge = heat inner rim (heat draws above the label) */
const HDG_Y = CY - R_HDG_HEAT_INNER;
/** Deadband (° over ~few samples) before showing HDG trend arrow */
const HDG_TREND_DEADBAND_DEG = 0.7;

const COMPASS_MARKS: Array<{ deg: number; label: string; major: boolean }> = [
  { deg: 0, label: 'N', major: true },
  { deg: 30, label: '30', major: false },
  { deg: 60, label: '60', major: false },
  { deg: 90, label: 'E', major: true },
  { deg: 120, label: '120', major: false },
  { deg: 150, label: '150', major: false },
  { deg: 180, label: 'S', major: true },
  { deg: 210, label: '210', major: false },
  { deg: 240, label: '240', major: false },
  { deg: 270, label: 'W', major: true },
  { deg: 300, label: '300', major: false },
  { deg: 330, label: '330', major: false },
];

function signedDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function polar(cx: number, cy: number, r: number, degClockwiseFromUp: number) {
  const rad = (degClockwiseFromUp * Math.PI) / 180;
  return {
    x: cx + r * Math.sin(rad),
    y: cy - r * Math.cos(rad),
  };
}

function formatTwa(twaDeg: number | null): string {
  if (twaDeg == null || !Number.isFinite(twaDeg)) return '—';
  const abs = Math.abs(Math.round(twaDeg));
  if (abs < 1) return '0°';
  const side = twaDeg > 0 ? 'S' : 'P';
  return `${abs}° ${side}`;
}

function formatTwd(twdRad: number | null, isRelative: boolean): string {
  if (twdRad == null) return '—';
  if (isRelative) return '—';
  return formatBearing(twdRad);
}

/**
 * Yaw Watch dial (B&G SailSteer–inspired), north-up:
 * - Compass fixed (N at top)
 * - Boat and TWA rotate with heading
 * - Wind arrow on rim at TWA relative to bow
 * - Corner quads: TWS · TWA · TWD · YAW
 */
function SailSteerInner({
  headingTrueRad,
  windDirectionRad,
  windDirectionSource,
  windSpeedMs,
  windUnit,
  yawPeakToPeakDeg,
  yawPeriodLabel,
  yawChartSeries = [],
  yawChartExtrema = [],
  twdChartSeries = [],
  yawWindowMinutes = 2,
  twdHeatSamples = [],
  hdgHeatSamples = [],
  yawChartStatus,
  variationLabel = null,
  windConvertedFromTrue = false,
}: Props) {
  const uid = useId().replace(/:/g, '');
  const yawWinLabel = formatYawWindowLabel(yawWindowMinutes);
  const yawWinPhrase =
    yawWindowMinutes === 1 ? 'last 1 minute' : `last ${yawWinLabel}`;

  const headingDeg =
    headingTrueRad != null && Number.isFinite(headingTrueRad)
      ? radToDeg(headingTrueRad)
      : null;

  const isRelativeOnly = windDirectionSource === 'angleApparent';
  const hasAbsoluteWind =
    windDirectionRad != null &&
    (windDirectionSource === 'directionTrue' ||
      windDirectionSource === 'directionMagnetic');

  const twaDeg = useMemo(() => {
    if (windDirectionRad == null) return null;
    if (isRelativeOnly) {
      return signedDeltaDeg(0, radToDeg(windDirectionRad));
    }
    if (headingDeg == null || !hasAbsoluteWind) return null;
    return signedDeltaDeg(headingDeg, radToDeg(windDirectionRad));
  }, [windDirectionRad, isRelativeOnly, headingDeg, hasAbsoluteWind]);

  /**
   * Outer-ring TWD dwell heatmap (north-up, absolute).
   * Samples are magnetic degrees from wind history (~30 min).
   */
  const twdHeat = useMemo(() => {
    const samples =
      twdHeatSamples.length > 0
        ? twdHeatSamples
        : windDirectionRad != null && !isRelativeOnly
          ? [radToDeg(windDirectionRad)]
          : [];
    return buildDwellHeat(samples, R_LABEL + 6, R_TICK - 1, twdHeatColor);
  }, [twdHeatSamples, windDirectionRad, isRelativeOnly]);

  /**
   * Inner-ring heading dwell heatmap (north-up, absolute).
   * Drawn above the HDG badge, inside the compass labels.
   */
  const hdgHeat = useMemo(() => {
    const samples =
      hdgHeatSamples.length > 0
        ? hdgHeatSamples
        : headingDeg != null
          ? [headingDeg]
          : [];
    return buildDwellHeat(
      samples,
      R_HDG_HEAT_INNER,
      R_HDG_HEAT_OUTER,
      hdgHeatColor,
    );
  }, [hdgHeatSamples, headingDeg]);

  const twsLabel = formatWind(windSpeedMs, windUnit);
  const twaLabel = formatTwa(twaDeg);
  const twdLabel = formatTwd(windDirectionRad, isRelativeOnly);
  const yawLabel =
    yawPeakToPeakDeg != null && Number.isFinite(yawPeakToPeakDeg)
      ? `${Math.round(yawPeakToPeakDeg)}°`
      : '—';

  const angleName = isRelativeOnly ? 'AWA' : 'TWA';
  /**
   * Continuous boat rotation (north-up) so 359°→001° does not snap the long way.
   * Display HDG stays wrapped 0–360; boat + TWA accumulate shortest-arc deltas.
   */
  const boatRotationRef = useRef(0);
  const prevHeadingDegRef = useRef<number | null>(null);
  let boatRotation = boatRotationRef.current;
  if (headingDeg != null && Number.isFinite(headingDeg)) {
    const prev = prevHeadingDegRef.current;
    if (prev == null) {
      boatRotation = headingDeg;
    } else if (headingDeg !== prev) {
      let d = headingDeg - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      boatRotation = boatRotationRef.current + d;
    }
    boatRotationRef.current = boatRotation;
    prevHeadingDegRef.current = headingDeg;
  }

  const windPort = twaDeg != null && twaDeg < 0;
  const windColor = windPort ? '#e86a6a' : '#3fd4a8';

  const twdSub =
    windDirectionSource === 'directionMagnetic'
      ? windConvertedFromTrue && variationLabel
        ? `Magnetic · var ${variationLabel}`
        : windConvertedFromTrue
          ? 'Magnetic · from true'
          : 'Magnetic'
      : windDirectionSource === 'directionTrue'
        ? 'True (no position for var)'
        : isRelativeOnly
          ? 'Need wind direction'
          : '—';

  const twaSub = isRelativeOnly ? 'Apparent' : 'P port · S stbd';
  const twdHeatSub = twdHeat.rangeLabel ?? twdSub;

  /**
   * Heading trend from unwrapped chart samples.
   * Left/port (heading decreasing) → ▲ up; right/stbd (increasing) → ▼ down.
   */
  const hdgTrend = useMemo((): 'up' | 'down' | 'steady' => {
    const s = yawChartSeries;
    if (s.length < 4) return 'steady';
    const lookback = Math.min(6, s.length - 1);
    const recent = s[s.length - 1]!.headingDeg;
    const older = s[s.length - 1 - lookback]!.headingDeg;
    const d = recent - older; // continuous unwrapped degrees
    // d > 0: turning starboard (right) → down arrow
    // d < 0: turning port (left) → up arrow
    if (d < -HDG_TREND_DEADBAND_DEG) return 'up';
    if (d > HDG_TREND_DEADBAND_DEG) return 'down';
    return 'steady';
  }, [yawChartSeries]);

  const tips = useMemo(() => {
    const twsTip = [
      `True wind speed: ${twsLabel}`,
      'Speed of the true wind (not apparent).',
    ].join('\n');

    const twaTip = [
      `${angleName}: ${twaLabel}`,
      isRelativeOnly
        ? 'Apparent wind angle relative to the bow.'
        : 'True wind angle relative to the bow (P = port, S = starboard).',
    ].join('\n');

    const twdTip = [
      `True wind direction: ${twdLabel}`,
      twdSub,
      windConvertedFromTrue && variationLabel
        ? `Converted from true using variation ${variationLabel}.`
        : null,
      'Direction the wind is coming from (absolute, magnetic preferred).',
      twdHeat.rangeLabel
        ? `Heatmap: TWD dwell over ${twdHeat.rangeLabel}.`
        : 'Outer ring heatmap: TWD dwell over the last 30 minutes.',
    ]
      .filter(Boolean)
      .join('\n');

    const yawTip = [
      `Yaw peak-to-peak: ${yawLabel}`,
      yawPeriodLabel ? `Period: ${yawPeriodLabel}` : null,
      `Heading range port↔starboard over the ${yawWinPhrase}.`,
      `Chart below shows HDG (gold) and TWD (blue) over the same ${yawWinLabel}.`,
    ]
      .filter(Boolean)
      .join('\n');

    const hdgTip = [
      headingDeg != null
        ? `Heading: ${Math.round(headingDeg).toString().padStart(3, '0')}° magnetic`
        : 'Heading: —',
      hdgTrend === 'up'
        ? 'Trend: ▲ rotating left (port).'
        : hdgTrend === 'down'
          ? 'Trend: ▼ rotating right (starboard).'
          : 'Trend: steady.',
      'North-up display: N is fixed at top; boat and TWA rotate with heading.',
      hdgHeat.rangeLabel
        ? `Heatmap: heading dwell over ${hdgHeat.rangeLabel}.`
        : 'Inner ring heatmap: heading dwell over the last 30 minutes.',
    ].join('\n');

    return { twsTip, twaTip, twdTip, yawTip, hdgTip };
  }, [
    twsLabel,
    angleName,
    twaLabel,
    isRelativeOnly,
    twdLabel,
    twdSub,
    twdHeat.rangeLabel,
    hdgHeat.rangeLabel,
    windConvertedFromTrue,
    variationLabel,
    yawLabel,
    yawPeriodLabel,
    yawWinLabel,
    yawWinPhrase,
    headingDeg,
    hdgTrend,
  ]);

  const seaId = `ss-sea-${uid}`;
  const bezelId = `ss-bezel-${uid}`;
  const boatGradId = `ss-boat-${uid}`;
  const boatStrokeId = `ss-boat-s-${uid}`;
  const glowId = `ss-glow-${uid}`;
  const shadowId = `ss-sh-${uid}`;
  const clipFaceId = `ss-face-${uid}`;
  const heatClipId = `ss-heat-${uid}`;
  const hdgHeatClipId = `ss-hdg-heat-${uid}`;

  return (
    <div className="sailsteer">
      <div className="sailsteer-frame">
        <div
          className="sailsteer-quad sailsteer-quad-tws info-tip"
          data-tip={tips.twsTip}
          title={tips.twsTip}
          tabIndex={0}
        >
          <span className="sailsteer-quad-label">TWS</span>
          <span className="sailsteer-quad-value">{twsLabel}</span>
          <span className="sailsteer-quad-sub">True wind speed</span>
        </div>
        <div
          className="sailsteer-quad sailsteer-quad-twa info-tip"
          data-tip={tips.twaTip}
          title={tips.twaTip}
          tabIndex={0}
        >
          <span className="sailsteer-quad-label">{angleName}</span>
          <span
            className={`sailsteer-quad-value ${
              twaDeg != null ? (windPort ? 'text-port' : 'text-stbd') : ''
            }`}
          >
            {twaLabel}
          </span>
          <span className="sailsteer-quad-sub">{twaSub}</span>
        </div>
        <div
          className="sailsteer-quad sailsteer-quad-twd info-tip"
          data-tip={tips.twdTip}
          title={tips.twdTip}
          tabIndex={0}
        >
          <span className="sailsteer-quad-label">TWD</span>
          <span className="sailsteer-quad-value">{twdLabel}</span>
          <span className="sailsteer-quad-sub">{twdHeatSub}</span>
        </div>
        <div
          className="sailsteer-quad sailsteer-quad-yaw info-tip"
          data-tip={tips.yawTip}
          title={tips.yawTip}
          tabIndex={0}
        >
          <span className="sailsteer-quad-label">YAW</span>
          <span className="sailsteer-quad-value">{yawLabel}</span>
          <span className="sailsteer-quad-sub">
            {yawPeriodLabel ?? 'Peak ↔ peak'}
          </span>
        </div>

        <div className="sailsteer-stage">
          <div className="sailsteer-dial-host">
            <svg
              className="sailsteer-svg"
              viewBox={`0 0 ${VB} ${VB}`}
              role="img"
              aria-label={
                headingDeg != null
                  ? `Yaw Watch, heading ${Math.round(headingDeg)} degrees`
                  : 'Yaw Watch, waiting for heading'
              }
            >
            <defs>
              <radialGradient id={seaId} cx="42%" cy="38%" r="68%">
                <stop offset="0%" stopColor="#143848" />
                <stop offset="55%" stopColor="#0a2430" />
                <stop offset="100%" stopColor="#061418" />
              </radialGradient>
              <linearGradient id={bezelId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#3a5a68" />
                <stop offset="35%" stopColor="#1a3038" />
                <stop offset="70%" stopColor="#2a4854" />
                <stop offset="100%" stopColor="#0e2028" />
              </linearGradient>
              <linearGradient id={boatGradId} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#1a5568" />
                <stop offset="45%" stopColor="#2a7a90" />
                <stop offset="100%" stopColor="#184858" />
              </linearGradient>
              <linearGradient
                id={boatStrokeId}
                x1="0%"
                y1="0%"
                x2="0%"
                y2="100%"
              >
                <stop offset="0%" stopColor="#9ee8ff" />
                <stop offset="100%" stopColor="#3a8aa0" />
              </linearGradient>
              <filter
                id={glowId}
                x="-50%"
                y="-50%"
                width="200%"
                height="200%"
              >
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter
                id={shadowId}
                x="-30%"
                y="-30%"
                width="160%"
                height="160%"
              >
                <feDropShadow
                  dx="0"
                  dy="2"
                  stdDeviation="2.5"
                  floodColor="#000"
                  floodOpacity="0.45"
                />
              </filter>
              <clipPath id={clipFaceId}>
                <circle cx={CX} cy={CY} r={R_FACE} />
              </clipPath>
              <clipPath id={heatClipId}>
                <path
                  d={annulusSectorPath(
                    CX,
                    CY,
                    R_LABEL + 6,
                    R_TICK - 1,
                    0,
                    359.9,
                  )}
                />
              </clipPath>
              <clipPath id={hdgHeatClipId}>
                <path
                  d={annulusSectorPath(
                    CX,
                    CY,
                    R_HDG_HEAT_INNER,
                    R_HDG_HEAT_OUTER,
                    0,
                    359.9,
                  )}
                />
              </clipPath>
            </defs>

            {/* Outer bezel */}
            <circle
              cx={CX}
              cy={CY}
              r={R_BEZEL}
              fill={`url(#${bezelId})`}
              stroke="#4a7080"
              strokeWidth={1.25}
            />
            <circle
              cx={CX}
              cy={CY}
              r={R_BEZEL - 5}
              fill="none"
              stroke="rgba(0,0,0,0.35)"
              strokeWidth={3}
            />

            {/* Face */}
            <circle
              cx={CX}
              cy={CY}
              r={R_FACE}
              fill={`url(#${seaId})`}
              stroke="#1e4050"
              strokeWidth={1}
            />

            {/* Compass track ring (fixed, north-up) */}
            <circle
              cx={CX}
              cy={CY}
              r={(R_TICK + R_LABEL) / 2}
              fill="none"
              stroke="rgba(30, 70, 85, 0.55)"
              strokeWidth={R_TICK - R_LABEL - 6}
            />

            {/* TWD dwell heatmap (outer ring, north-up absolute, last ~30 min) */}
            {twdHeat.cells.length > 0 && (
              <g className="sailsteer-twd-heat" clipPath={`url(#${heatClipId})`}>
                {twdHeat.cells.map((cell, i) => (
                  <path key={i} d={cell.path} fill={cell.fill} stroke="none" />
                ))}
              </g>
            )}
            {twdHeat.rangePath && (
              <path
                d={twdHeat.rangePath}
                fill="none"
                stroke="rgba(126, 200, 232, 0.5)"
                strokeWidth={1.25}
                strokeDasharray="3 3"
              />
            )}

            {/* Heading dwell heatmap (inner ring above HDG badge) */}
            {hdgHeat.cells.length > 0 && (
              <g
                className="sailsteer-hdg-heat"
                clipPath={`url(#${hdgHeatClipId})`}
              >
                {hdgHeat.cells.map((cell, i) => (
                  <path key={i} d={cell.path} fill={cell.fill} stroke="none" />
                ))}
              </g>
            )}
            {hdgHeat.rangePath && (
              <path
                d={hdgHeat.rangePath}
                fill="none"
                stroke="rgba(232, 196, 96, 0.55)"
                strokeWidth={1.25}
                strokeDasharray="3 3"
              />
            )}

            {/* Fixed compass rose — N locked at top */}
            <g className="sailsteer-rose">
              {Array.from({ length: 72 }, (_, i) => i * 5).map((deg) => {
                const is30 = deg % 30 === 0;
                const is10 = deg % 10 === 0;
                if (is30) return null;
                const o = polar(CX, CY, R_TICK, deg);
                const inn = polar(
                  CX,
                  CY,
                  is10 ? R_TICK_MIN : R_TICK - 5,
                  deg,
                );
                return (
                  <line
                    key={deg}
                    x1={inn.x}
                    y1={inn.y}
                    x2={o.x}
                    y2={o.y}
                    stroke={is10 ? '#2a4a58' : '#1e3844'}
                    strokeWidth={is10 ? 1.15 : 0.85}
                    strokeLinecap="round"
                  />
                );
              })}

              {COMPASS_MARKS.map(({ deg, label, major }) => {
                const outer = polar(CX, CY, R_TICK, deg);
                const inner = polar(
                  CX,
                  CY,
                  major ? R_TICK_MAJ - 2 : R_TICK_MAJ + 4,
                  deg,
                );
                const lab = polar(CX, CY, R_LABEL, deg);
                const isN = label === 'N';
                return (
                  <g key={deg}>
                    <line
                      x1={inner.x}
                      y1={inner.y}
                      x2={outer.x}
                      y2={outer.y}
                      stroke={isN ? '#6ed4f0' : major ? '#8ec8d8' : '#4a7080'}
                      strokeWidth={major ? 2.4 : 1.4}
                      strokeLinecap="round"
                    />
                    {major && (
                      <circle
                        cx={outer.x}
                        cy={outer.y}
                        r={isN ? 2.4 : 1.6}
                        fill={isN ? '#6ed4f0' : '#6a9aaa'}
                      />
                    )}
                    <text
                      x={lab.x}
                      y={lab.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className={
                        major ? 'sailsteer-cardinal' : 'sailsteer-tick-label'
                      }
                      fill={
                        isN ? '#7ee0f8' : major ? '#c8e8f2' : '#7a9aa8'
                      }
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* Inner well ring */}
            <circle
              cx={CX}
              cy={CY}
              r={R_WELL}
              fill="rgba(4, 14, 20, 0.55)"
              stroke="#1a3a48"
              strokeWidth={1.25}
            />
            <circle
              cx={CX}
              cy={CY}
              r={R_WELL - 1}
              fill="none"
              stroke="rgba(94, 200, 232, 0.12)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />

            {/* Fixed north pointer (top of dial) */}
            <g className="sailsteer-lubber">
              <path
                d={`M ${CX - 6.5} ${CY - R_FACE + 1} L ${CX} ${CY - R_FACE + 11} L ${CX + 6.5} ${CY - R_FACE + 1} Z`}
                fill="#6ed4f0"
              />
            </g>

            {/* HDG readout (fixed, readable at top) */}
            <g
              className="sailsteer-hdg-badge"
              filter={`url(#${shadowId})`}
            >
              <title>{tips.hdgTip}</title>
              <rect
                x={CX - HDG_BADGE_W / 2}
                y={HDG_Y}
                width={HDG_BADGE_W}
                height={HDG_BADGE_H}
                rx={6}
                fill="rgba(4, 12, 18, 0.94)"
                stroke="#5a8898"
                strokeWidth={1.15}
              />
              <text
                x={CX}
                y={HDG_Y + 12}
                textAnchor="middle"
                className="sailsteer-hdg-label"
                fill="#7a9aaa"
              >
                HDG
              </text>
              <text
                x={CX - (hdgTrend !== 'steady' ? 8 : 0)}
                y={HDG_Y + 30}
                textAnchor="middle"
                className="sailsteer-hdg-value"
                fill="#f2f8fc"
              >
                {headingDeg != null
                  ? `${Math.round(headingDeg).toString().padStart(3, '0')}°`
                  : '—'}
              </text>
              {hdgTrend !== 'steady' && (
                <text
                  x={CX + HDG_BADGE_W / 2 - 15}
                  y={HDG_Y + 31}
                  textAnchor="middle"
                  className={
                    hdgTrend === 'up'
                      ? 'sailsteer-hdg-arrow sailsteer-hdg-arrow-up'
                      : 'sailsteer-hdg-arrow sailsteer-hdg-arrow-down'
                  }
                  fill={hdgTrend === 'up' ? '#e86a6a' : '#3fd4a8'}
                  aria-label={
                    hdgTrend === 'up'
                      ? 'Rotating left (port)'
                      : 'Rotating right (starboard)'
                  }
                >
                  {hdgTrend === 'up' ? '▲' : '▼'}
                </text>
              )}
            </g>

            {/* Boat + wind — rotate with heading (north-up) */}
            <g
              className="sailsteer-boat-layer"
              transform={`rotate(${boatRotation} ${CX} ${CY})`}
            >
              {/* Port / stbd wash (relative to boat) */}
              <g clipPath={`url(#${clipFaceId})`} opacity={0.14}>
                <path
                  d={`M ${CX} ${CY - R_FACE} A ${R_FACE} ${R_FACE} 0 0 0 ${CX} ${CY + R_FACE} Z`}
                  fill="#e07070"
                />
                <path
                  d={`M ${CX} ${CY - R_FACE} A ${R_FACE} ${R_FACE} 0 0 1 ${CX} ${CY + R_FACE} Z`}
                  fill="#3fd4a8"
                />
              </g>

              {/* Heading bug — outer ring at bow (same radius as TWA arrow) */}
              {headingDeg != null && (
                <g
                  className="sailsteer-hdg-bug"
                  transform={`translate(${CX}, ${CY - R_WIND})`}
                  filter={`url(#${glowId})`}
                >
                  <title>
                    {`Boat heading ${Math.round(headingDeg)
                      .toString()
                      .padStart(3, '0')}° — where the bow is pointing`}
                  </title>
                  {/* Outer tip on the rim */}
                  <path
                    d="M0,-18 L9,4 L3,4 L3,10 L-3,10 L-3,4 L-9,4 Z"
                    fill="#f2e6a0"
                    stroke="#1a1410"
                    strokeWidth={0.9}
                    strokeLinejoin="round"
                  />
                  {/* Small center pip so it stays readable under the wind arrow */}
                  <circle
                    cy={1}
                    r={3.2}
                    fill="#0a1218"
                    stroke="#f2e6a0"
                    strokeWidth={1.1}
                  />
                </g>
              )}

              {/* Wind arrow on rim at TWA from bow */}
              {twaDeg != null && (
                <g
                  transform={`rotate(${twaDeg} ${CX} ${CY})`}
                  filter={`url(#${glowId})`}
                >
                  <g transform={`translate(${CX}, ${CY - R_WIND})`}>
                    <path
                      d="M0,4 L12,-14 L4,-14 L4,-28 L-4,-28 L-4,-14 L-12,-14 Z"
                      fill={windColor}
                      stroke="#061018"
                      strokeWidth={0.9}
                      strokeLinejoin="round"
                    />
                    <circle
                      cy={-8}
                      r={9.5}
                      fill="rgba(4,12,18,0.92)"
                      stroke={windColor}
                      strokeWidth={1.4}
                    />
                    <text
                      y={-4.5}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="sailsteer-wind-letter"
                      fill={windColor}
                    >
                      {isRelativeOnly ? 'A' : 'T'}
                    </text>
                  </g>
                </g>
              )}

              {/* Boat silhouette — local bow-up, parent rotates to heading */}
              <g
                className="sailsteer-boat"
                transform={`translate(${CX}, ${CY + 6}) scale(0.88)`}
                filter={`url(#${shadowId})`}
              >
                <path
                  d="M0,-50 C12,-42 16,-8 14,26 C9,40 3.5,46 0,48 C-3.5,46 -9,40 -14,26 C-16,-8 -12,-42 0,-50 Z"
                  fill="rgba(0,0,0,0.35)"
                  transform="translate(1.5, 2)"
                />
                <path
                  d="M0,-50 C12,-42 16,-8 14,26 C9,40 3.5,46 0,48 C-3.5,46 -9,40 -14,26 C-16,-8 -12,-42 0,-50 Z"
                  fill={`url(#${boatGradId})`}
                  stroke={`url(#${boatStrokeId})`}
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                />
                <path
                  d="M0,-46 C8,-38 11,-8 10,20 C6,32 2,38 0,40 C-2,38 -6,32 -10,20 C-11,-8 -8,-38 0,-46 Z"
                  fill="rgba(160, 220, 240, 0.1)"
                />
                <ellipse
                  cx={0}
                  cy={2}
                  rx={6.5}
                  ry={12}
                  fill="#0a1e28"
                  stroke="rgba(94, 200, 232, 0.35)"
                  strokeWidth={0.8}
                />
                <ellipse
                  cx={-1.5}
                  cy={-2}
                  rx={2.2}
                  ry={4}
                  fill="rgba(126, 200, 232, 0.22)"
                />
                <line
                  x1={0}
                  y1={-46}
                  x2={0}
                  y2={40}
                  stroke="rgba(180, 230, 245, 0.28)"
                  strokeWidth={0.9}
                  strokeDasharray="2.5 3"
                />
                <circle cy={-48.5} r={2.2} fill="#9ee8ff" />
                <path
                  d="M-6,40 Q0,46 6,40"
                  fill="none"
                  stroke="rgba(94, 200, 232, 0.4)"
                  strokeWidth={1}
                />
              </g>

              {/* Port / starboard beam marks (boat frame) */}
              <g opacity={0.75}>
                <rect
                  x={CX - 30}
                  y={CY + 3.5}
                  width={7}
                  height={4.5}
                  rx={1.5}
                  fill="#e07070"
                />
                <rect
                  x={CX + 23}
                  y={CY + 3.5}
                  width={7}
                  height={4.5}
                  rx={1.5}
                  fill="#3fd4a8"
                />
              </g>
            </g>
            </svg>
          </div>
        </div>
      </div>

      <div className="sailsteer-yaw">
        <div className="sailsteer-yaw-head">
          <span className="sailsteer-quad-label">
            Yaw · last {yawWinLabel}
            {twdChartSeries.length >= 2 ? (
              <span className="yaw-chart-legend">
                {' '}
                · <span className="yaw-legend-hdg">HDG</span>
                {' / '}
                <span className="yaw-legend-twd">TWD</span>
              </span>
            ) : null}
          </span>
          <span className="sailsteer-yaw-meta muted">
            {yawPeakToPeakDeg != null && Number.isFinite(yawPeakToPeakDeg)
              ? `${Math.round(yawPeakToPeakDeg)}° p–p`
              : '—'}
            {yawPeriodLabel ? ` · ${yawPeriodLabel}` : ''}
          </span>
        </div>
        <YawSwingChart
          series={yawChartSeries}
          extrema={yawChartExtrema}
          twdSeries={twdChartSeries}
          windowLabel={yawWinPhrase}
          status={yawChartStatus}
        />
      </div>

      <p className="sailsteer-footnote muted">
        Yaw Watch · north-up · boat &amp; {isRelativeOnly ? 'AWA' : 'TWA'}{' '}
        rotate with heading
      </p>
    </div>
  );
}

export const SailSteer = memo(SailSteerInner);
