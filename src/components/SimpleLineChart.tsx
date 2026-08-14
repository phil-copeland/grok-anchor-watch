import { memo, useId, useMemo, useState, type MouseEvent } from 'react';

export interface ChartSeriesPoint {
  t: number;
  /** Primary series value (null = gap) */
  y: number | null;
  /**
   * Optional constant reference (legacy single ref). Prefer {@link ChartRefLine}
   * via the chart `refLines` prop when multiple marks are needed.
   */
  ref?: number | null;
}

export interface ChartRefLine {
  /** Y value in the same units as the series */
  value: number;
  /** Legend name */
  name?: string;
  /** Stroke colour (default alarm red) */
  color?: string;
  /** Dash pattern (default "6 4") */
  dasharray?: string;
  /** Draw value + unit on the right end of the line */
  labelOnRight?: boolean;
}

interface Props {
  data: ChartSeriesPoint[];
  /** Stroke / fill colour for the main series */
  color: string;
  /** Unit label for Y axis */
  unitLabel: string;
  /** Height of the chart area in px */
  height?: number;
  /** Y domain floor (e.g. 0 for wind) */
  yMin?: number;
  /** Series name for legend */
  seriesName: string;
  /**
   * Reference lines (alarm, high mark, …). When provided, used instead of
   * per-point `ref` / `refName` / `refLabelOnRight`.
   */
  refLines?: ChartRefLine[];
  /** @deprecated Prefer refLines — single ref name from data[].ref */
  refName?: string;
  /**
   * @deprecated Prefer refLines — label the single data[].ref on the right
   */
  refLabelOnRight?: boolean;
  /** Format y for tooltip / axis */
  formatY?: (v: number) => string;
}

const PAD = { top: 12, right: 10, bottom: 28, left: 42 };
/** Extra right padding when any reference line has an end label */
const PAD_RIGHT_WITH_REF_LABEL = 48;
const DEFAULT_REF_COLOR = '#e05050';

function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * exp;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

type DrawnRef = {
  value: number;
  y: number;
  name?: string;
  color: string;
  dasharray: string;
  label: string | null;
};

/**
 * Lightweight SVG line/area chart — no Recharts.
 * Stable memory for long-running dashboards (path strings only).
 */
function SimpleLineChartInner({
  data,
  color,
  unitLabel,
  height = 200,
  yMin,
  seriesName,
  refLines,
  refName,
  refLabelOnRight = false,
  formatY = (v) =>
    Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 1 : 0),
}: Props) {
  const gradId = useId().replace(/:/g, '');
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);

  const layout = useMemo(() => {
    const w = 600; // viewBox width; scales via preserveAspectRatio
    const h = height;

    let maxY = 0;
    let minY = yMin ?? Infinity;

    // Resolve reference lines (explicit prop wins; else legacy data[].ref)
    let resolved: ChartRefLine[] = [];
    if (refLines && refLines.length > 0) {
      resolved = refLines.filter(
        (r) => r != null && Number.isFinite(r.value),
      );
    } else {
      let legacyRef: number | null = null;
      for (const p of data) {
        if (p.ref != null && Number.isFinite(p.ref)) {
          legacyRef = p.ref;
          break;
        }
      }
      if (legacyRef != null) {
        resolved = [
          {
            value: legacyRef,
            name: refName,
            labelOnRight: refLabelOnRight,
          },
        ];
      }
    }

    for (const p of data) {
      if (p.y != null && Number.isFinite(p.y)) {
        if (p.y > maxY) maxY = p.y;
        if (p.y < minY) minY = p.y;
      }
    }
    for (const r of resolved) {
      if (r.value > maxY) maxY = r.value;
      if (r.value < minY) minY = r.value;
    }

    const anyRightLabel = resolved.some((r) => r.labelOnRight);
    const padRight = anyRightLabel ? PAD_RIGHT_WITH_REF_LABEL : PAD.right;
    const innerW = w - PAD.left - padRight;
    const innerH = h - PAD.top - PAD.bottom;

    if (yMin != null) minY = yMin;
    else if (!Number.isFinite(minY)) minY = 0;
    if (maxY <= minY) maxY = minY + 1;
    // pad top
    maxY = niceMax(maxY * 1.08);
    if (yMin != null) minY = yMin;
    else minY = Math.min(0, minY);

    const ySpan = maxY - minY || 1;
    const n = data.length;

    const xAt = (i: number) =>
      PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yAt = (v: number) =>
      PAD.top + innerH - ((v - minY) / ySpan) * innerH;

    // Build line / area paths, splitting on nulls
    const lineParts: string[] = [];
    const areaParts: string[] = [];
    let seg: Array<{ x: number; y: number }> = [];

    const flush = () => {
      if (seg.length === 0) return;
      const dLine = seg
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`,
        )
        .join(' ');
      lineParts.push(dLine);
      const baseY = yAt(minY);
      const dArea =
        dLine +
        ` L${seg[seg.length - 1]!.x.toFixed(1)},${baseY.toFixed(1)}` +
        ` L${seg[0]!.x.toFixed(1)},${baseY.toFixed(1)} Z`;
      areaParts.push(dArea);
      seg = [];
    };

    for (let i = 0; i < n; i++) {
      const v = data[i]!.y;
      if (v == null || !Number.isFinite(v)) {
        flush();
        continue;
      }
      seg.push({ x: xAt(i), y: yAt(v) });
    }
    flush();

    const yTicks = 4;
    const ticks: Array<{ v: number; y: number; label: string }> = [];
    for (let i = 0; i <= yTicks; i++) {
      const v = minY + (ySpan * i) / yTicks;
      ticks.push({ v, y: yAt(v), label: formatY(v) });
    }

    // ~4 time labels
    const xLabels: Array<{ x: number; label: string }> = [];
    if (n > 0) {
      const steps = Math.min(4, n - 1);
      for (let i = 0; i <= steps; i++) {
        const idx = steps === 0 ? 0 : Math.round((i * (n - 1)) / steps);
        xLabels.push({ x: xAt(idx), label: formatTime(data[idx]!.t) });
      }
    }

    const drawnRefs: DrawnRef[] = resolved.map((r) => ({
      value: r.value,
      y: yAt(r.value),
      name: r.name,
      color: r.color ?? DEFAULT_REF_COLOR,
      dasharray: r.dasharray ?? '6 4',
      label: r.labelOnRight
        ? `${formatY(r.value)} ${unitLabel}`.trim()
        : null,
    }));

    return {
      w,
      h,
      innerW,
      innerH,
      padRight,
      lineParts,
      areaParts,
      ticks,
      xLabels,
      xAt,
      yAt,
      drawnRefs,
      minY,
      maxY,
    };
  }, [
    data,
    height,
    yMin,
    formatY,
    unitLabel,
    refLines,
    refName,
    refLabelOnRight,
  ]);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * layout.w;
    // nearest index
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const x = layout.xAt(i);
      const d = Math.abs(x - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (data[best]!.y == null) {
      setHover(null);
      return;
    }
    setHover({
      i: best,
      x: layout.xAt(best),
      y: layout.yAt(data[best]!.y!),
    });
  };

  return (
    <div className="simple-chart">
      <svg
        className="simple-chart-svg"
        viewBox={`0 0 ${layout.w} ${layout.h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${seriesName} chart`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Grid */}
        {layout.ticks.map((t) => (
          <line
            key={`g-${t.v}`}
            x1={PAD.left}
            x2={PAD.left + layout.innerW}
            y1={t.y}
            y2={t.y}
            stroke="#1a3540"
            strokeDasharray="3 3"
          />
        ))}

        {/* Y labels */}
        {layout.ticks.map((t) => (
          <text
            key={`yl-${t.v}`}
            x={PAD.left - 6}
            y={t.y + 3}
            textAnchor="end"
            className="simple-chart-tick"
          >
            {t.label}
          </text>
        ))}

        {/* X labels */}
        {layout.xLabels.map((l, i) => (
          <text
            key={`xl-${i}`}
            x={l.x}
            y={layout.h - 8}
            textAnchor="middle"
            className="simple-chart-tick"
          >
            {l.label}
          </text>
        ))}

        {/* Area + line */}
        {layout.areaParts.map((d, i) => (
          <path key={`a-${i}`} d={d} fill={`url(#${gradId})`} stroke="none" />
        ))}
        {layout.lineParts.map((d, i) => (
          <path
            key={`l-${i}`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Reference lines + optional right labels */}
        {layout.drawnRefs.map((r, i) => (
          <g key={`ref-${i}`} className="simple-chart-ref">
            <line
              x1={PAD.left}
              x2={PAD.left + layout.innerW}
              y1={r.y}
              y2={r.y}
              stroke={r.color}
              strokeWidth={1.5}
              strokeDasharray={r.dasharray}
              vectorEffect="non-scaling-stroke"
            />
            {r.label && (
              <text
                x={PAD.left + layout.innerW + 4}
                y={r.y + 3.5}
                textAnchor="start"
                className="simple-chart-ref-label"
                fill={r.color}
              >
                {r.label}
              </text>
            )}
          </g>
        ))}

        {/* Hover crosshair */}
        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={PAD.top + layout.innerH}
              stroke="#6a8a98"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hover.x}
              cy={hover.y}
              r={4}
              fill={color}
              stroke="#0a1a20"
              strokeWidth={1}
            />
          </g>
        )}
      </svg>

      <div className="simple-chart-legend">
        <span className="simple-chart-legend-item">
          <i style={{ background: color }} />
          {seriesName} ({unitLabel})
        </span>
        {layout.drawnRefs.map((r, i) =>
          r.name ? (
            <span key={`leg-${i}`} className="simple-chart-legend-item">
              <i
                className="ref"
                style={{
                  borderTopColor: r.color,
                  background: 'transparent',
                }}
              />
              {r.name} ({unitLabel})
            </span>
          ) : null,
        )}
        {hover && data[hover.i]?.y != null && (
          <span className="simple-chart-hover">
            {formatTime(data[hover.i]!.t)} · {formatY(data[hover.i]!.y!)}{' '}
            {unitLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export const SimpleLineChart = memo(SimpleLineChartInner);
