import { memo, useMemo } from 'react';
import type { HistoryPoint } from '../types';
import { radToDeg } from '../units';

interface Props {
  distanceM: number | null;
  bearingTrueRad: number | null;
  headingTrueRad: number | null;
  alarmRadiusM: number;
  /** When false, out-of-radius styling is suppressed */
  watchEnabled?: boolean;
  /** Position samples for heat density (already windowed) */
  history: HistoryPoint[];
  maxScaleM?: number;
  /** Active / next waypoint name (shown at centre) */
  waypointName?: string | null;
  /** Corner readouts (SailSteer-style glass cards) */
  distanceLabel?: string;
  distanceSub?: string | null;
  /** Accent for distance value when near/over alarm */
  distanceAccent?: 'default' | 'ok' | 'warn' | 'alarm';
  /** Session high distance (peak since reset / connect) */
  highDistanceLabel?: string;
  highDistanceSub?: string | null;
  bearingLabel?: string;
  bearingSub?: string | null;
}

/** Fit long waypoint names inside the centre label */
function truncateLabel(name: string, max = 16): string {
  const t = name.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

const GRID = 28;
/** Cap heatmap input — dense history doesn't improve a 28×28 grid */
const MAX_HEAT_SAMPLES = 400;

/** Map density 0–1 → cool→hot colour */
function heatColor(t: number, alpha: number): string {
  // t: 0 blue → 0.4 cyan → 0.7 yellow → 1 red
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

function boatToSvg(
  distanceM: number,
  bearingTrueRad: number,
  scale: number,
  cx: number,
  cy: number,
  plotR: number,
): { x: number; y: number } {
  // Anchor at centre; boat is opposite of bearing-to-anchor
  const brgFromAnchor = bearingTrueRad + Math.PI;
  const r = Math.min((distanceM / scale) * plotR, plotR - 4);
  return {
    x: cx + r * Math.sin(brgFromAnchor),
    y: cy - r * Math.cos(brgFromAnchor),
  };
}

function subsampleHistory(history: HistoryPoint[], max: number): HistoryPoint[] {
  if (history.length <= max) return history;
  const out: HistoryPoint[] = new Array(max);
  const last = history.length - 1;
  for (let i = 0; i < max; i++) {
    out[i] = history[Math.round((i * last) / (max - 1))];
  }
  return out;
}

/**
 * Top-down schematic: boat relative to anchor, alarm circle, dwell heatmap.
 * North-up. Boat icon rotates with heading when available.
 */
function AnchorRadarInner({
  distanceM,
  bearingTrueRad,
  headingTrueRad,
  alarmRadiusM,
  watchEnabled = true,
  history,
  maxScaleM,
  waypointName = null,
  distanceLabel,
  distanceSub,
  distanceAccent = 'default',
  highDistanceLabel,
  highDistanceSub,
  bearingLabel,
  bearingSub,
}: Props) {
  const scale = Math.max(
    maxScaleM ?? alarmRadiusM * 1.35,
    alarmRadiusM * 1.1,
    20,
  );
  // Compact viewBox: circle fills most of the SVG; small edge for cardinal labels
  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const edge = 14;
  const rOuter = size / 2 - edge;
  const plotR = rOuter;
  const rAlarm = (alarmRadiusM / scale) * plotR;

  const heatCells = useMemo(() => {
    const counts = new Float32Array(GRID * GRID);
    let max = 0;
    const samples = subsampleHistory(history, MAX_HEAT_SAMPLES);

    for (const p of samples) {
      if (p.distanceM == null || p.bearingTrueRad == null) continue;
      const { x, y } = boatToSvg(
        p.distanceM,
        p.bearingTrueRad,
        scale,
        cx,
        cy,
        plotR,
      );
      // Map svg coords to grid
      const gx = Math.floor(((x - (cx - plotR)) / (2 * plotR)) * GRID);
      const gy = Math.floor(((y - (cy - plotR)) / (2 * plotR)) * GRID);
      if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
      // Soft kernel: centre + neighbours
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
          const w = dx === 0 && dy === 0 ? 1 : 0.35;
          const i = ny * GRID + nx;
          counts[i] += w;
          if (counts[i] > max) max = counts[i];
        }
      }
    }

    if (max <= 0) return [] as Array<{ x: number; y: number; w: number; t: number }>;

    const cellW = (2 * plotR) / GRID;
    const cells: Array<{ x: number; y: number; w: number; t: number }> = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const c = counts[gy * GRID + gx];
        if (c <= 0) continue;
        const t = c / max;
        // Only draw meaningful density
        if (t < 0.05) continue;
        const x = cx - plotR + gx * cellW;
        const y = cy - plotR + gy * cellW;
        cells.push({ x, y, w: cellW, t });
      }
    }
    return cells;
  }, [history, scale, cx, cy, plotR]);

  let boatX = cx;
  let boatY = cy;
  if (distanceM != null && bearingTrueRad != null) {
    const pos = boatToSvg(distanceM, bearingTrueRad, scale, cx, cy, plotR);
    boatX = pos.x;
    boatY = pos.y;
  }

  const headingDeg = headingTrueRad != null ? radToDeg(headingTrueRad) : 0;
  const over =
    watchEnabled &&
    distanceM != null &&
    alarmRadiusM > 0 &&
    distanceM > alarmRadiusM;

  const centreLabel = waypointName ? truncateLabel(waypointName) : null;
  // ~5.6px per char at 9.5px font + horizontal padding
  const labelW = centreLabel
    ? Math.min(96, Math.max(36, centreLabel.length * 5.6 + 12))
    : 0;

  // Recent trail (last ~40 points) for motion path
  const trail = useMemo(() => {
    const pts = history
      .filter((p) => p.distanceM != null && p.bearingTrueRad != null)
      .slice(-40);
    return pts.map((p) =>
      boatToSvg(p.distanceM!, p.bearingTrueRad!, scale, cx, cy, plotR),
    );
  }, [history, scale, cx, cy, plotR]);

  return (
    <div className={`radar-wrap ${over ? 'radar-alarm' : ''}`}>
      <div className="radar-frame">
        {distanceLabel != null && (
          <div
            className={`radar-quad radar-quad-dist accent-${distanceAccent} info-tip`}
            data-tip={[
              `Distance to anchor: ${distanceLabel}`,
              distanceSub,
              waypointName ? `Waypoint: ${waypointName}` : null,
              over
                ? 'Status: OUTSIDE swing circle (alarm radius).'
                : distanceM != null
                  ? 'Status: inside swing circle.'
                  : 'Set a waypoint / drop anchor in the plotter.',
            ]
              .filter(Boolean)
              .join('\n')}
            title={[
              `Distance to anchor: ${distanceLabel}`,
              distanceSub,
              waypointName ? `Waypoint: ${waypointName}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            tabIndex={0}
          >
            <span className="radar-quad-label">Distance</span>
            <span className="radar-quad-value">{distanceLabel}</span>
            {distanceSub ? (
              <span className="radar-quad-sub">{distanceSub}</span>
            ) : null}
          </div>
        )}
        {highDistanceLabel != null && (
          <div
            className="radar-quad radar-quad-high info-tip"
            data-tip={[
              `Session high distance: ${highDistanceLabel}`,
              highDistanceSub,
              'Same high used for “new high distance” announce.',
              'Updates after a new peak holds ~1 s (and exceeds prior high by ≥0.2 m).',
              'Resets with session reset or data-source change.',
            ]
              .filter(Boolean)
              .join('\n')}
            title={[
              `Session high distance: ${highDistanceLabel}`,
              highDistanceSub,
            ]
              .filter(Boolean)
              .join(' · ')}
            tabIndex={0}
          >
            <span className="radar-quad-label">High</span>
            <span className="radar-quad-value">{highDistanceLabel}</span>
            {highDistanceSub ? (
              <span className="radar-quad-sub">{highDistanceSub}</span>
            ) : null}
          </div>
        )}
        <div className="radar-stage">
          <div className="radar-svg-host">
            <svg
              className="radar-svg"
              viewBox={`0 0 ${size} ${size}`}
              role="img"
              aria-label={
                waypointName
                  ? `Anchor radar for ${waypointName}, with position heatmap`
                  : 'Anchor radar with position heatmap'
              }
            >
        <defs>
          <radialGradient id="sea" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0d3a4a" />
            <stop offset="100%" stopColor="#071820" />
          </radialGradient>
          <clipPath id="radar-clip">
            <circle cx={cx} cy={cy} r={rOuter} />
          </clipPath>
        </defs>

        <circle cx={cx} cy={cy} r={rOuter} fill="url(#sea)" stroke="#1e4a5a" />

        {/* Heatmap under rings */}
        <g clipPath="url(#radar-clip)" className="heatmap-layer">
          {heatCells.map((cell, i) => (
            <rect
              key={i}
              x={cell.x}
              y={cell.y}
              width={cell.w + 0.5}
              height={cell.w + 0.5}
              fill={heatColor(cell.t, 0.15 + cell.t * 0.55)}
              rx={1}
            />
          ))}
        </g>

        {/* Range rings */}
        {[0.33, 0.66, 1].map((f) => (
          <circle
            key={f}
            cx={cx}
            cy={cy}
            r={rOuter * f}
            fill="none"
            stroke="#1a3d4a"
            strokeDasharray="4 6"
          />
        ))}

        {/* Cardinal ticks */}
        {['N', 'E', 'S', 'W'].map((lab, i) => {
          const a = (i * Math.PI) / 2;
          const x1 = cx + (rOuter - 4) * Math.sin(a);
          const y1 = cy - (rOuter - 4) * Math.cos(a);
          const x2 = cx + rOuter * Math.sin(a);
          const y2 = cy - rOuter * Math.cos(a);
          const tx = cx + (rOuter + edge * 0.55) * Math.sin(a);
          const ty = cy - (rOuter + edge * 0.55) * Math.cos(a) + 3.5;
          return (
            <g key={lab}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4a7a8a" />
              <text
                x={tx}
                y={ty}
                textAnchor="middle"
                className="radar-label"
                fill={lab === 'N' ? '#5ec8e8' : '#6a8a98'}
              >
                {lab}
              </text>
            </g>
          );
        })}

        {/* Alarm circle */}
        <circle
          cx={cx}
          cy={cy}
          r={Math.max(rAlarm, 4)}
          fill={over ? 'rgba(220,60,60,0.08)' : 'rgba(40,160,120,0.05)'}
          stroke={over ? '#e05050' : '#2a9a78'}
          strokeWidth={2}
          strokeDasharray={over ? '6 4' : undefined}
        />

        {/* Recent trail */}
        {trail.length > 1 && (
          <polyline
            points={trail.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="rgba(126,200,232,0.45)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Line boat → anchor */}
        {distanceM != null && (
          <line
            x1={boatX}
            y1={boatY}
            x2={cx}
            y2={cy}
            stroke={over ? '#e07070' : '#3a8a9a'}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        )}

        {/* Anchor + next waypoint name at centre */}
        <g transform={`translate(${cx}, ${cy})`} className="radar-centre">
          <circle r={10} fill="#0a2028" stroke="#c9a227" strokeWidth={1.5} />
          <text y={5} textAnchor="middle" fontSize="12" fill="#c9a227" aria-hidden>
            ⚓
          </text>
          {centreLabel && (
            <g className="radar-waypoint-label" aria-hidden>
              {/* Readable pill over heatmap */}
              <rect
                x={-labelW / 2}
                y={12}
                width={labelW}
                height={16}
                rx={4}
                fill="rgba(6, 18, 24, 0.82)"
                stroke="rgba(201, 162, 39, 0.35)"
                strokeWidth={0.75}
              />
              <text
                y={23.5}
                textAnchor="middle"
                className="radar-waypoint-text"
                fill="#e8d48a"
              >
                {centreLabel}
              </text>
            </g>
          )}
        </g>

        {/* Boat */}
        <g transform={`translate(${boatX}, ${boatY}) rotate(${headingDeg})`}>
          <polygon
            points="0,-14 9,12 0,7 -9,12"
            fill={over ? '#e05050' : '#4ec4a8'}
            stroke="#0a1a20"
            strokeWidth={1}
          />
        </g>
            </svg>
          </div>
        </div>
        {bearingLabel != null && (
          <div
            className="radar-quad radar-quad-brg info-tip"
            data-tip={[
              `Bearing to anchor: ${bearingLabel}`,
              bearingSub ?? null,
              'Direction from boat to anchor (preferred magnetic).',
              'Swing circle is north-up; boat icon uses heading when available.',
            ]
              .filter(Boolean)
              .join('\n')}
            title={[
              `Bearing to anchor: ${bearingLabel}`,
              bearingSub,
            ]
              .filter(Boolean)
              .join(' · ')}
            tabIndex={0}
          >
            <span className="radar-quad-label">Bearing</span>
            <span className="radar-quad-value">{bearingLabel}</span>
            {bearingSub ? (
              <span className="radar-quad-sub">{bearingSub}</span>
            ) : null}
          </div>
        )}
      </div>

      <div className="radar-legend">
        <div className="radar-legend-line">
          <span>
            Scale ±{Math.round(scale)} m · alarm {Math.round(alarmRadiusM)} m
            {history.length > 0 ? ` · ${history.length} pts` : ''}
          </span>
          {distanceM != null && (
            <span className={over ? 'text-alarm' : ''}>
              {over ? ' · OUTSIDE SWING CIRCLE' : ' · Inside swing circle'}
            </span>
          )}
        </div>
        <div className="heatmap-legend" aria-hidden>
          <span className="heat-label">Dwell</span>
          <div className="heat-bar" />
          <span className="heat-label">cold → hot</span>
        </div>
      </div>
    </div>
  );
}

export const AnchorRadar = memo(AnchorRadarInner);
