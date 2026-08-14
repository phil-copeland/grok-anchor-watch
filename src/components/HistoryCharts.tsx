import { memo, useMemo } from 'react';
import {
  HISTORY_RANGE_OPTIONS,
  type HistoryPoint,
  type HistoryRangeMinutes,
} from '../types';
import { mToFt, msToKnots } from '../units';
import {
  SimpleLineChart,
  type ChartRefLine,
  type ChartSeriesPoint,
} from './SimpleLineChart';

interface Props {
  history: HistoryPoint[];
  historyRangeMinutes: HistoryRangeMinutes;
  alarmRadiusM: number;
  distanceUnit: 'm' | 'ft' | 'nm';
  windUnit: 'kn' | 'm/s' | 'km/h' | 'mph';
  /** Session high wind in display units — reference line on wind chart */
  windHighMark?: number | null;
  /** Session high distance in metres — gold reference line on distance chart */
  distanceHighMarkM?: number | null;
  /** When false, only distance history is shown (default true) */
  showWindChart?: boolean;
  onRangeChange: (m: HistoryRangeMinutes) => void;
  onClear: () => void;
  clearDisabled?: boolean;
}

/** Enough points for a smooth SVG path; keeps draw cost bounded. */
const MAX_CHART_POINTS = 180;

function toWind(ms: number | null, unit: Props['windUnit']): number | null {
  if (ms == null) return null;
  switch (unit) {
    case 'm/s':
      return +ms.toFixed(2);
    case 'km/h':
      return +(ms * 3.6).toFixed(1);
    case 'mph':
      return +(ms * 2.236936).toFixed(1);
    default:
      return +msToKnots(ms).toFixed(1);
  }
}

function toDist(m: number | null, unit: Props['distanceUnit']): number | null {
  if (m == null) return null;
  switch (unit) {
    case 'ft':
      return +mToFt(m).toFixed(1);
    case 'nm':
      return +(m / 1852).toFixed(3);
    default:
      return +m.toFixed(1);
  }
}

function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = new Array(max);
  const last = points.length - 1;
  for (let i = 0; i < max; i++) {
    out[i] = points[Math.round((i * last) / (max - 1))];
  }
  return out;
}

function HistoryChartsInner({
  history,
  historyRangeMinutes,
  alarmRadiusM,
  distanceUnit,
  windUnit,
  windHighMark = null,
  distanceHighMarkM = null,
  showWindChart = true,
  onRangeChange,
  onClear,
  clearDisabled,
}: Props) {
  const alarmDisplay = toDist(alarmRadiusM, distanceUnit) ?? 0;
  const distanceHighDisplay =
    distanceHighMarkM != null && Number.isFinite(distanceHighMarkM)
      ? toDist(distanceHighMarkM, distanceUnit)
      : null;
  const windHighDisplay =
    windHighMark != null && Number.isFinite(windHighMark)
      ? windHighMark
      : null;

  const { distanceSeries, windSeries } = useMemo(() => {
    const sampled = downsample(history, MAX_CHART_POINTS);
    const distanceSeries: ChartSeriesPoint[] = sampled.map((p) => ({
      t: p.t,
      y: toDist(p.distanceM, distanceUnit),
    }));
    const windSeries: ChartSeriesPoint[] = showWindChart
      ? sampled.map((p) => ({
          t: p.t,
          y: toWind(p.windSpeedMs, windUnit),
        }))
      : [];
    return { distanceSeries, windSeries };
  }, [history, distanceUnit, windUnit, showWindChart]);

  const distanceRefLines = useMemo((): ChartRefLine[] => {
    const lines: ChartRefLine[] = [
      {
        value: alarmDisplay,
        name: 'Alarm',
        color: '#e05050',
        labelOnRight: true,
      },
    ];
    if (distanceHighDisplay != null && Number.isFinite(distanceHighDisplay)) {
      lines.push({
        value: distanceHighDisplay,
        name: 'High',
        color: '#e8c86a',
        dasharray: '4 3',
        labelOnRight: true,
      });
    }
    return lines;
  }, [alarmDisplay, distanceHighDisplay]);

  const windRefLines = useMemo((): ChartRefLine[] => {
    if (windHighDisplay == null || !Number.isFinite(windHighDisplay)) return [];
    return [
      {
        value: windHighDisplay,
        name: 'High',
        color: '#e05050',
        labelOnRight: true,
      },
    ];
  }, [windHighDisplay]);

  const distUnitLabel =
    distanceUnit === 'm' ? 'm' : distanceUnit === 'ft' ? 'ft' : 'nm';
  const windUnitLabel = windUnit;
  const rangeLabel =
    HISTORY_RANGE_OPTIONS.find((o) => o.minutes === historyRangeMinutes)
      ?.label ?? `${historyRangeMinutes} min`;

  return (
    <section className="history-panel">
      <div className="panel-head">
        <h2>History</h2>
        <div className="panel-actions">
          <label className="inline-control">
            <span className="muted">Window</span>
            <select
              className="control-select control-select-sm"
              value={historyRangeMinutes}
              onChange={(e) =>
                onRangeChange(Number(e.target.value) as HistoryRangeMinutes)
              }
              aria-label="History time range"
            >
              {HISTORY_RANGE_OPTIONS.map((opt) => (
                <option key={opt.minutes} value={opt.minutes}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            {history.length} samples · {rangeLabel}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClear}
            disabled={clearDisabled}
            title={
              clearDisabled
                ? 'History is stored on the cloud server'
                : 'Clear local history'
            }
          >
            Clear
          </button>
        </div>
      </div>

      {history.length < 2 ? (
        <p className="empty-history">
          Collecting samples… distance and wind history will appear here after a
          few updates.
        </p>
      ) : (
        <div
          className={`charts-grid ${showWindChart ? '' : 'charts-grid-single'}`}
        >
          <div className="chart-card">
            <h3>Distance to anchor ({distUnitLabel})</h3>
            <SimpleLineChart
              data={distanceSeries}
              color="#3ecf9a"
              unitLabel={distUnitLabel}
              seriesName="Distance"
              refLines={distanceRefLines}
              height={showWindChart ? 200 : 220}
            />
          </div>

          {showWindChart && (
            <div className="chart-card">
              <h3>Wind speed ({windUnitLabel})</h3>
              <SimpleLineChart
                data={windSeries}
                color="#7ec8e8"
                unitLabel={windUnitLabel}
                seriesName="Wind"
                refLines={windRefLines}
                height={200}
                yMin={0}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const HistoryCharts = memo(HistoryChartsInner);
