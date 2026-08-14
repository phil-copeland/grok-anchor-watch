import { useCallback, useMemo, useRef, useState } from 'react';
import type { YawChartPoint, YawExtremumMark } from '../hooks/useYaw';

interface Props {
  series: YawChartPoint[];
  extrema: YawExtremumMark[];
  /** Optional TWD (wind direction) series — blue overlay */
  twdSeries?: YawChartPoint[];
  /** How many swings the series is meant to cover (for a11y label) */
  swingCount?: number;
  /** Override a11y description (e.g. "last 5 minutes") */
  windowLabel?: string;
  /** Optional status under the chart */
  status?: string;
}

interface HoverState {
  /** Index into series */
  index: number;
  /** SVG coords for marker */
  x: number;
  y: number;
  /** Matching extremum if near one */
  extremum: YawExtremumMark | null;
}

interface Pt {
  x: number;
  y: number;
  t: number;
  headingDeg: number;
}

function wrapHeadingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function formatHeading(deg: number): string {
  return `${Math.round(wrapHeadingDeg(deg)).toString().padStart(3, '0')}°`;
}

function formatTimeAgo(t: number, now: number): string {
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = sec / 60;
  if (min < 10) return `${min.toFixed(1)} min ago`;
  if (min < 60) return `${Math.round(min)} min ago`;
  return `${(min / 60).toFixed(1)} h ago`;
}

/** Mean of numbers (empty → 0). */
function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * HDG and TWD are unwrapped independently, so they can sit ~360° apart on a
 * linear axis even when only ~10° apart on the compass. Shift TWD by k·360°
 * so it sits nearest the HDG series (same absolute directions, common scale).
 */
function alignTwdToHdg(
  hdg: YawChartPoint[],
  twd: YawChartPoint[],
): YawChartPoint[] {
  if (hdg.length === 0 || twd.length === 0) return twd;
  const hMean = meanOf(hdg.map((p) => p.headingDeg));
  const tMean = meanOf(twd.map((p) => p.headingDeg));
  let bestK = 0;
  let bestDist = Math.abs(tMean - hMean);
  for (const k of [-3, -2, -1, 0, 1, 2, 3]) {
    const dist = Math.abs(tMean + k * 360 - hMean);
    if (dist < bestDist) {
      bestDist = dist;
      bestK = k;
    }
  }
  if (bestK === 0) return twd;
  return twd.map((p) => ({
    ...p,
    headingDeg: p.headingDeg + bestK * 360,
  }));
}

/**
 * Dynamic Y extent from combined series.
 * - Removes only isolated single-sample spikes (neighbours agree, point jumps)
 * - No hard span cap — expands for large real yaw / TWA separation
 * - Pads so peaks aren't clipped
 */
function chartYExtent(
  values: number[],
  minHalfSpan = 3,
): { min: number; max: number; mid: number } {
  if (values.length === 0) {
    return { min: -minHalfSpan, max: minHalfSpan, mid: 0 };
  }

  // Drop only isolated spikes: point far from both neighbours
  const SPIKE_DEG = 35;
  const cleaned: number[] = [];
  if (values.length < 5) {
    cleaned.push(...values);
  } else {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (i === 0 || i === values.length - 1) {
        cleaned.push(v);
        continue;
      }
      const a = values[i - 1]!;
      const c = values[i + 1]!;
      const jumpPrev = Math.abs(v - a);
      const jumpNext = Math.abs(v - c);
      const neighbourGap = Math.abs(c - a);
      if (
        jumpPrev > SPIKE_DEG &&
        jumpNext > SPIKE_DEG &&
        neighbourGap < SPIKE_DEG * 0.5
      ) {
        continue;
      }
      cleaned.push(v);
    }
  }
  const use = cleaned.length >= 2 ? cleaned : values;
  let lo = use[0]!;
  let hi = use[0]!;
  for (const v of use) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mid = (lo + hi) / 2;
  const half = Math.max(minHalfSpan, ((hi - lo) / 2) * 1.15);
  return { min: mid - half, max: mid + half, mid };
}

/**
 * Light 3-point moving average on heading to calm single-sample noise
 * while preserving overall swing shape. Times stay unchanged.
 */
function smoothSeries(series: YawChartPoint[]): YawChartPoint[] {
  if (series.length < 5) return series;
  const out: YawChartPoint[] = new Array(series.length);
  out[0] = series[0]!;
  out[series.length - 1] = series[series.length - 1]!;
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1]!.headingDeg;
    const b = series[i]!.headingDeg;
    const c = series[i + 1]!.headingDeg;
    out[i] = { t: series[i]!.t, headingDeg: (a + 2 * b + c) / 4 };
  }
  return out;
}

/**
 * Monotone cubic Hermite (Fritsch–Carlson) → cubic Bézier path.
 * Smooth through samples without Catmull–Rom overshoot past local min/max
 * (those overshoots looked like false low/high headings).
 */
function smoothPathThrough(points: Pt[]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) {
    return `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  }
  if (n === 2) {
    const a = points[0]!;
    const b = points[1]!;
    return `M${a.x.toFixed(2)},${a.y.toFixed(2)} L${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  }

  // Work in x (time-ordered, strictly increasing after layout)
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1]!.x - points[i]!.x;
    dx.push(h);
    dy.push(h !== 0 ? (points[i + 1]!.y - points[i]!.y) / h : 0);
  }
  m.push(dy[0]!);
  for (let i = 1; i < n - 1; i++) {
    if (dy[i - 1]! === 0 || dy[i]! === 0 || dy[i - 1]! * dy[i]! < 0) {
      m.push(0);
    } else {
      const h0 = dx[i - 1]!;
      const h1 = dx[i]!;
      m.push(
        (3 * (h0 + h1)) /
          ((2 * h1 + h0) / dy[i - 1]! + (h1 + 2 * h0) / dy[i]!),
      );
    }
  }
  m.push(dy[n - 2]!);

  let d = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const h = dx[i]!;
    if (h === 0) {
      d += ` L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
      continue;
    }
    const c1x = p0.x + h / 3;
    const c1y = p0.y + (m[i]! * h) / 3;
    const c2x = p1.x - h / 3;
    const c2y = p1.y - (m[i + 1]! * h) / 3;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  }
  return d;
}

/**
 * Compact sparkline of unwrapped heading over the last few swings / minutes.
 * Smooth spline between samples; Y-axis shows max · mid · min.
 */
export function YawSwingChart({
  series,
  extrema,
  twdSeries = [],
  swingCount = 7,
  windowLabel,
  status,
}: Props) {
  const w = 280;
  const h = 100;
  const padL = 6;
  const padR = 8;
  const padY = 8;
  const innerW = w - padL - padR;
  const innerH = h - padY * 2;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [now] = useState(() => Date.now());

  const layout = useMemo(() => {
    if (series.length < 2) return null;

    const t0 = series[0]!.t;
    const t1 = series[series.length - 1]!.t;
    const spanT = Math.max(1, t1 - t0);

    // Align TWD onto HDG's continuous scale (±k·360) so lines stay near each other
    const twdAligned = alignTwdToHdg(series, twdSeries);

    const drawn = smoothSeries(series);
    const drawnTwd =
      twdAligned.length >= 2 ? smoothSeries(twdAligned) : twdAligned;

    // Dynamic scale from both series after alignment
    const scaleVals: number[] = [];
    for (const p of drawn) scaleVals.push(p.headingDeg);
    for (const p of series) scaleVals.push(p.headingDeg);
    for (const p of drawnTwd) {
      if (p.t >= t0 && p.t <= t1) scaleVals.push(p.headingDeg);
    }
    for (const p of twdAligned) {
      if (p.t >= t0 && p.t <= t1) scaleVals.push(p.headingDeg);
    }

    let { min: yMin, max: yMax, mid } = chartYExtent(scaleVals);
    // Always include every drawn point (dynamic expand for bigger ranges)
    for (const p of drawn) {
      if (p.headingDeg < yMin) yMin = p.headingDeg;
      if (p.headingDeg > yMax) yMax = p.headingDeg;
    }
    for (const p of drawnTwd) {
      if (p.t < t0 || p.t > t1) continue;
      if (p.headingDeg < yMin) yMin = p.headingDeg;
      if (p.headingDeg > yMax) yMax = p.headingDeg;
    }
    {
      const pad = Math.max(2, (yMax - yMin) * 0.08);
      yMin -= pad;
      yMax += pad;
      mid = (yMin + yMax) / 2;
    }
    const minH = yMin;
    const maxH = yMax;
    const spanY = Math.max(1e-6, yMax - yMin);

    const xOf = (t: number) => padL + ((t - t0) / spanT) * innerW;
    const yOf = (deg: number) =>
      padY + innerH - ((deg - yMin) / spanY) * innerH;

    const points: Pt[] = drawn.map((p) => ({
      t: p.t,
      headingDeg: p.headingDeg,
      x: xOf(p.t),
      y: yOf(p.headingDeg),
    }));

    const rawPoints: Pt[] = series.map((p) => ({
      t: p.t,
      headingDeg: p.headingDeg,
      x: xOf(p.t),
      y: yOf(p.headingDeg),
    }));

    const path = smoothPathThrough(points);

    let twdPath = '';
    if (drawnTwd.length >= 1) {
      const timePad = Math.max(2000, spanT * 0.02);
      let twdPts: Pt[] = drawnTwd
        .filter((p) => p.t >= t0 - timePad && p.t <= t1 + timePad)
        .map((p) => ({
          t: p.t,
          headingDeg: p.headingDeg,
          x: xOf(Math.min(t1, Math.max(t0, p.t))),
          y: yOf(p.headingDeg),
        }));
      if (twdPts.length === 1) {
        const p = twdPts[0]!;
        twdPts = [
          { ...p, t: t0, x: xOf(t0) },
          { ...p, t: t1, x: xOf(t1) },
        ];
      } else if (twdPts.length >= 2) {
        const first = twdPts[0]!;
        const last = twdPts[twdPts.length - 1]!;
        if (first.t > t0) {
          twdPts = [{ ...first, t: t0, x: xOf(t0) }, ...twdPts];
        }
        if (last.t < t1) {
          twdPts = [...twdPts, { ...last, t: t1, x: xOf(t1) }];
        }
      }
      if (twdPts.length >= 2) {
        twdPath = smoothPathThrough(twdPts);
      }
    }

    // Hover TWD uses aligned series (same scale as drawn line)
    const twdAt = (t: number): number | null => {
      if (twdAligned.length === 0) return null;
      let best = twdAligned[0]!;
      let bestDt = Math.abs(best.t - t);
      for (const p of twdAligned) {
        const dt = Math.abs(p.t - t);
        if (dt < bestDt) {
          bestDt = dt;
          best = p;
        }
      }
      return bestDt <= 30_000 ? best.headingDeg : null;
    };

    return {
      t0,
      t1,
      spanT,
      mid,
      minH,
      maxH,
      yMin,
      yMax,
      xOf,
      yOf,
      points,
      rawPoints,
      path,
      twdPath,
      twdAt,
      meanY: yOf(mid),
      maxY: yOf(maxH),
      minY: yOf(minH),
    };
  }, [series, twdSeries, innerW, innerH]);

  const findHover = useCallback(
    (clientX: number, clientY: number): HoverState | null => {
      const svg = svgRef.current;
      if (!svg || !layout || layout.rawPoints.length === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const svgX = ((clientX - rect.left) / rect.width) * w;
      const svgY = ((clientY - rect.top) / rect.height) * h;

      const EXT_R2 = 12 * 12;
      let bestExt: YawExtremumMark | null = null;
      let bestExtD = EXT_R2;
      for (const e of extrema) {
        const ex = layout.xOf(e.t);
        const ey = layout.yOf(e.headingDeg);
        const d = (ex - svgX) ** 2 + (ey - svgY) ** 2;
        if (d < bestExtD) {
          bestExtD = d;
          bestExt = e;
        }
      }

      let bestI = 0;
      let bestDx = Infinity;
      for (let i = 0; i < layout.rawPoints.length; i++) {
        const dx = Math.abs(layout.rawPoints[i]!.x - svgX);
        if (dx < bestDx) {
          bestDx = dx;
          bestI = i;
        }
      }
      const pt = layout.rawPoints[bestI]!;

      if (bestExt) {
        const ex = layout.xOf(bestExt.t);
        const ey = layout.yOf(bestExt.headingDeg);
        const dExt = (ex - svgX) ** 2 + (ey - svgY) ** 2;
        const dPt = (pt.x - svgX) ** 2 + (pt.y - svgY) ** 2;
        if (dExt <= dPt && dExt < EXT_R2) {
          let ei = bestI;
          let edt = Math.abs(pt.t - bestExt.t);
          for (let i = 0; i < layout.rawPoints.length; i++) {
            const dt = Math.abs(layout.rawPoints[i]!.t - bestExt.t);
            if (dt < edt) {
              edt = dt;
              ei = i;
            }
          }
          return { index: ei, x: ex, y: ey, extremum: bestExt };
        }
      }

      return { index: bestI, x: pt.x, y: pt.y, extremum: null };
    },
    [layout, extrema, w, h],
  );

  const onPointerMove = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      setHover(findHover(ev.clientX, ev.clientY));
    },
    [findHover],
  );

  const onPointerLeave = useCallback(() => setHover(null), []);

  if (series.length < 2 || !layout) {
    return (
      <div className="yaw-chart yaw-chart-empty">
        <span className="yaw-chart-placeholder">
          {status ?? 'Waiting for heading swings…'}
        </span>
      </div>
    );
  }

  const hoverPt = hover ? series[hover.index] : null;
  const hoverTwd =
    hoverPt && layout ? layout.twdAt(hoverPt.t) : null;
  const hoverLabel = hoverPt
    ? [
        hover?.extremum
          ? hover.extremum.kind === 'peak'
            ? 'Peak'
            : 'Trough'
          : 'HDG',
        formatHeading(hover?.extremum?.headingDeg ?? hoverPt.headingDeg),
        hoverTwd != null ? `TWD ${formatHeading(hoverTwd)}` : null,
        formatTimeAgo(hoverPt.t, now),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const tipW = hoverTwd != null ? 168 : 118;
  const tipH = 18;
  let tipX = hover ? hover.x - tipW / 2 : 0;
  let tipY = hover ? hover.y - tipH - 8 : 0;
  if (hover) {
    tipX = Math.max(2, Math.min(w - tipW - 2, tipX));
    tipY = tipY < 2 ? hover.y + 10 : tipY;
  }

  const yTicks = [
    { y: layout.maxY, label: formatHeading(layout.maxH), kind: 'max' as const },
    { y: layout.meanY, label: formatHeading(layout.mid), kind: 'mid' as const },
    { y: layout.minY, label: formatHeading(layout.minH), kind: 'min' as const },
  ];

  // Collapse labels if range is tiny (all three would stack)
  const showAllTicks = layout.maxH - layout.minH >= 1.5;

  return (
    <div className="yaw-chart">
      <div className="yaw-chart-row">
        <div className="yaw-y-axis" aria-hidden>
          {showAllTicks ? (
            yTicks.map((tick) => (
              <span
                key={tick.kind}
                className={`yaw-y-tick yaw-y-tick-${tick.kind}`}
                style={{ top: `${(tick.y / h) * 100}%` }}
              >
                {tick.label}
              </span>
            ))
          ) : (
            <span
              className="yaw-y-tick yaw-y-tick-mid"
              style={{ top: `${(layout.meanY / h) * 100}%` }}
            >
              {formatHeading(layout.mid)}
            </span>
          )}
        </div>

        <svg
          ref={svgRef}
          className="yaw-chart-svg"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Yaw heading trace, ${windowLabel ?? `last ${swingCount} swings`}. Hover for values.`}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onPointerDown={onPointerMove}
        >
          {/* Horizontal guides at max / mid / min */}
          {showAllTicks && (
            <>
              <line
                className="yaw-chart-grid"
                x1={padL}
                x2={w - padR}
                y1={layout.maxY}
                y2={layout.maxY}
              />
              <line
                className="yaw-chart-grid"
                x1={padL}
                x2={w - padR}
                y1={layout.minY}
                y2={layout.minY}
              />
            </>
          )}
          <line
            className="yaw-chart-mean"
            x1={padL}
            x2={w - padR}
            y1={layout.meanY}
            y2={layout.meanY}
          />

          {/* TWD (wind direction) — blue */}
          {layout.twdPath ? (
            <path
              className="yaw-chart-twd"
              d={layout.twdPath}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Smooth heading trace (gold) */}
          <path
            className="yaw-chart-line"
            d={layout.path}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />

          {/* Extrema markers */}
          {extrema.map((e) => (
            <circle
              key={`${e.t}-${e.kind}`}
              className={
                e.kind === 'peak' ? 'yaw-chart-peak' : 'yaw-chart-trough'
              }
              cx={layout.xOf(e.t)}
              cy={layout.yOf(e.headingDeg)}
              r={2.75}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Hover guide */}
          {hover && hoverPt && (
            <g className="yaw-chart-hover" pointerEvents="none">
              <line
                className="yaw-chart-hover-x"
                x1={hover.x}
                x2={hover.x}
                y1={padY}
                y2={h - padY}
              />
              <circle
                className="yaw-chart-hover-dot"
                cx={hover.x}
                cy={hover.y}
                r={4}
              />
              <g transform={`translate(${tipX}, ${tipY})`}>
                <rect
                  className="yaw-chart-tip-bg"
                  width={tipW}
                  height={tipH}
                  rx={3}
                />
                <text
                  className="yaw-chart-tip-text"
                  x={tipW / 2}
                  y={tipH / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {hoverLabel}
                </text>
              </g>
            </g>
          )}
        </svg>
      </div>
      {status ? <span className="yaw-chart-status">{status}</span> : null}
    </div>
  );
}
