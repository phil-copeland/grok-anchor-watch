import {
  HISTORY_RANGE_OPTIONS,
  type HistoryRangeMinutes,
} from '../types';

interface Props {
  historyRangeMinutes: HistoryRangeMinutes;
  /** Radius currently applied (boat or local) */
  alarmRadiusM: number;
  distanceUnit: 'm' | 'ft' | 'nm';
  /** Boat-pushed guard radius if known */
  boatGuardRadiusM: number | null;
  /** Following boat radius (cloud default) */
  followBoat: boolean;
  /** Show boat follow / override controls */
  showBoatFollow: boolean;
  /** Watch mode on/off (alarms + banners) */
  watchEnabled: boolean;
  /** Clear charts / session highs for a new anchorage */
  onReset: () => void;
  onHistoryRange: (m: HistoryRangeMinutes) => void;
  onAlarmRadius: (m: number) => void;
  onFollowBoat: (follow: boolean) => void;
  onWatchEnabled: (enabled: boolean) => void;
}

function formatRadius(m: number, unit: Props['distanceUnit']): string {
  if (unit === 'ft') return `${Math.round(m * 3.28084)} ft`;
  if (unit === 'nm') return `${(m / 1852).toFixed(2)} nm`;
  return `${Math.round(m)} m`;
}

export function MainControls({
  historyRangeMinutes,
  alarmRadiusM,
  distanceUnit,
  boatGuardRadiusM,
  followBoat,
  showBoatFollow,
  watchEnabled,
  onReset,
  onHistoryRange,
  onAlarmRadius,
  onFollowBoat,
  onWatchEnabled,
}: Props) {
  return (
    <section className="main-controls" aria-label="Watch controls">
      <label className="control-group">
        <span className="control-label">History</span>
        <select
          className="control-select"
          value={historyRangeMinutes}
          onChange={(e) =>
            onHistoryRange(Number(e.target.value) as HistoryRangeMinutes)
          }
          aria-label="History time range"
        >
          {HISTORY_RANGE_OPTIONS.map((opt) => (
            <option key={opt.minutes} value={opt.minutes}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="control-hint">charts &amp; heatmap</span>
      </label>

      <div className="control-group control-alarm">
        <span className="control-label">
          Alarm radius
          {!watchEnabled && (
            <span className="control-hint-inline control-hint-off">
              {' '}
              · watch off
            </span>
          )}
          {watchEnabled && showBoatFollow && followBoat && boatGuardRadiusM != null && (
            <span className="control-hint-inline"> · from boat</span>
          )}
          {watchEnabled && showBoatFollow && !followBoat && (
            <span className="control-hint-inline"> · local override</span>
          )}
        </span>
        <div className="alarm-slider-row">
          <label className="watch-switch" title="Enable or disable anchor watch alarms">
            <input
              type="checkbox"
              checked={watchEnabled}
              onChange={(e) => onWatchEnabled(e.target.checked)}
              aria-label="Watch mode"
            />
            <span className="watch-switch-track" aria-hidden />
            <span className="watch-switch-text">
              {watchEnabled ? 'Watch on' : 'Watch off'}
            </span>
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm reset-data-btn"
            onClick={onReset}
            title="Clear history, charts, and session highs for a new anchorage"
            aria-label="Reset data for new location"
          >
            Reset
          </button>
          <input
            type="range"
            min={10}
            max={200}
            step={1}
            value={alarmRadiusM}
            disabled={!watchEnabled}
            onChange={(e) => {
              const v = Number(e.target.value);
              onAlarmRadius(v);
              if (showBoatFollow) onFollowBoat(false);
            }}
            aria-label="Alarm radius in metres"
          />
          <input
            type="number"
            className="alarm-number"
            min={5}
            max={500}
            step={1}
            value={alarmRadiusM}
            disabled={!watchEnabled}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              const clamped = Math.min(500, Math.max(5, Math.round(v)));
              onAlarmRadius(clamped);
              if (showBoatFollow) onFollowBoat(false);
            }}
            aria-label="Alarm radius value"
          />
          <span className="alarm-unit">
            {formatRadius(alarmRadiusM, distanceUnit)}
          </span>
        </div>
        {showBoatFollow && (
          <div className="alarm-follow-row">
            {followBoat ? (
              <span className="control-hint">
                Using boat guard
                {boatGuardRadiusM != null
                  ? ` (${formatRadius(boatGuardRadiusM, distanceUnit)})`
                  : ' (waiting for boat…)'}
                . Move the slider to override.
              </span>
            ) : (
              <>
                <span className="control-hint">
                  Local override
                  {boatGuardRadiusM != null
                    ? ` · boat is ${formatRadius(boatGuardRadiusM, distanceUnit)}`
                    : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={boatGuardRadiusM == null}
                  onClick={() => onFollowBoat(true)}
                >
                  Use boat radius
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
