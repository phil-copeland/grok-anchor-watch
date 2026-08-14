import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmBanner } from './components/AlarmBanner';
import { AnchorRadar } from './components/AnchorRadar';
import { ConnectionBar } from './components/ConnectionBar';
import { HistoryCharts } from './components/HistoryCharts';
import { MainControls } from './components/MainControls';
import { SailSteer } from './components/SailSteer';
import { SettingsPanel } from './components/SettingsPanel';
import { HighAnnounceBanner } from './components/HighAnnounceBanner';
import { useAlarm } from './hooks/useAlarm';
import { useCloudPublisher } from './hooks/useCloudPublisher';
import { useDistanceHighAnnounce } from './hooks/useDistanceHighAnnounce';
import { useHistory } from './hooks/useHistory';
import { useMagneticDisplay } from './hooks/useMagneticDisplay';
import { useSettings } from './hooks/useSettings';
import { useVesselData } from './hooks/useVesselData';
import { useWindHighAnnounce } from './hooks/useWindHighAnnounce';
import {
  formatYawPeriod,
  formatYawWindowLabel,
  useYaw,
} from './hooks/useYaw';
import type { HistoryRangeMinutes, VesselData } from './types';
import { formatBearing, formatDistance, radToDeg } from './units';

/** Outer-ring TWD heatmap window (same idea as wind history, fixed 30 min). */
const TWD_HEAT_WINDOW_MS = 30 * 60_000;

export default function App() {
  const { settings, setSettings, resetSettings } = useSettings();
  /** Shared sink: vessel updates → cloud publish worker (background-tab safe) */
  const liveSinkRef = useRef<((d: VesselData) => void) | null>(null);
  const {
    data,
    status,
    statusMessage,
    boatName,
    cloudHistory,
    lastBoatIngestAt,
    reconnect,
  } = useVesselData(settings, liveSinkRef);
  const live =
    status === 'connected' ||
    status === 'demo' ||
    status === 'cloud' ||
    status === 'stale';
  const { history, windowed, clearHistory, isRemote } = useHistory(
    data,
    settings.historyIntervalMs,
    settings.historyMaxPoints,
    live && settings.dataSource !== 'cloud',
    settings.historyRangeMinutes,
    cloudHistory,
  );
  /** Bumped on Reset — clears session highs & yaw for a new anchorage */
  const [sessionResetKey, setSessionResetKey] = useState(0);

  /** Magnetic display angles — native mag preferred; else true − SK/WMM variation */
  const mag = useMagneticDisplay(data);

  /** Magnetic heading + TWD stream → yaw metrics & chart (settings window) */
  const yaw = useYaw(
    data.headingTrueRad,
    history,
    settings.yawWindowMinutes,
    settings.yawChartSwings,
    sessionResetKey,
    mag.windDirectionRad,
  );
  const yawWindowLabel = formatYawWindowLabel(settings.yawWindowMinutes);

  // Push local instruments + guard radius when enabled in Settings
  const publish = useCloudPublisher(settings, live, liveSinkRef);

  /** Guard radius set on the boat (app or Signal K maxRadius) */
  const boatGuardRadiusM =
    data.alarmRadiusM != null && data.alarmRadiusM > 0
      ? data.alarmRadiusM
      : data.maxRadiusM != null && data.maxRadiusM > 0
        ? data.maxRadiusM
        : null;

  const followBoat =
    settings.dataSource === 'cloud' && settings.followBoatGuardRadius;

  const effectiveAlarmRadius =
    followBoat && boatGuardRadiusM != null
      ? boatGuardRadiusM
      : settings.alarmRadiusM || 40;

  const {
    alarming,
    showWarningBanner,
    dismissWarning,
    muted,
    setMuted,
  } = useAlarm(
    data.distanceM,
    effectiveAlarmRadius,
    settings.audioAlarm,
    settings.watchEnabled,
  );

  // High-water announcements only while Watch is on (and settings allow it)
  const announceSessionKey = `${settings.dataSource}:${sessionResetKey}`;
  const {
    announcement: windHigh,
    dismiss: dismissWindHigh,
    highMark: windHighMark,
  } = useWindHighAnnounce(
    data.windSpeedMs,
    settings.windUnit,
    live && settings.watchEnabled && settings.windHighAnnounce,
    announceSessionKey,
    settings.windHighAnnounceMinMs,
  );
  const {
    announcement: distanceHigh,
    dismiss: dismissDistanceHigh,
    highMarkM: distanceHighMarkM,
  } = useDistanceHighAnnounce(
    data.distanceM,
    settings.distanceUnit,
    live && settings.watchEnabled && settings.distanceHighAnnounce,
    announceSessionKey,
    settings.distanceHighAnnounceMinM,
  );

  const [settingsOpen, setSettingsOpen] = useState(false);

  const distanceLabel = formatDistance(
    data.distanceM,
    settings.distanceUnit,
  );
  const radiusLabel = formatDistance(
    effectiveAlarmRadius,
    settings.distanceUnit,
    0,
  );

  const distAccent =
    data.distanceM == null
      ? 'default'
      : alarming
        ? 'alarm'
        : data.distanceM != null &&
            settings.watchEnabled &&
            effectiveAlarmRadius > 0 &&
            data.distanceM > effectiveAlarmRadius * 0.95
          ? 'warn'
          : 'ok';

  const setHistoryRange = useCallback(
    (minutes: HistoryRangeMinutes) =>
      setSettings({ historyRangeMinutes: minutes }),
    [setSettings],
  );
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const toggleMute = useCallback(() => setMuted((m) => !m), [setMuted]);
  const onAlarmRadius = useCallback(
    (m: number) =>
      setSettings({ alarmRadiusM: m, followBoatGuardRadius: false }),
    [setSettings],
  );
  const onFollowBoat = useCallback(
    (follow: boolean) => {
      if (follow && boatGuardRadiusM != null) {
        setSettings({
          followBoatGuardRadius: true,
          alarmRadiusM: boatGuardRadiusM,
        });
      } else {
        setSettings({ followBoatGuardRadius: follow });
      }
    },
    [setSettings, boatGuardRadiusM],
  );
  const onWatchEnabled = useCallback(
    (enabled: boolean) => setSettings({ watchEnabled: enabled }),
    [setSettings],
  );
  /** Clear history + session highs when moving to a new anchorage */
  const onResetData = useCallback(() => {
    const ok = window.confirm(
      'Clear history, charts, and session highs for a new location?',
    );
    if (!ok) return;
    clearHistory();
    setSessionResetKey((k) => k + 1);
  }, [clearHistory]);

  const historyRangeLabel =
    settings.historyRangeMinutes >= 60
      ? `${settings.historyRangeMinutes / 60}h`
      : `${settings.historyRangeMinutes}m`;

  const yawPeriodLabel =
    formatYawPeriod(yaw.periodSec) ??
    (yaw.sampleCount < 8
      ? 'Gathering…'
      : yaw.peakToPeakDeg != null && yaw.peakToPeakDeg < 2
        ? 'Steady'
        : 'Peak ↔ peak');

  /** Absolute TWD samples for north-up dial heatmap (from wind history). */
  const twdHeatSamples = useMemo(() => {
    const now = Date.now();
    const cutoff = now - TWD_HEAT_WINDOW_MS;
    const out: number[] = [];
    for (const p of history) {
      if (p.t < cutoff) continue;
      const w = p.windDirectionRad;
      if (w == null || !Number.isFinite(w)) continue;
      out.push(radToDeg(w));
    }
    // Live sample so the heat updates between history ticks
    if (
      mag.windDirectionRad != null &&
      mag.windDirectionSource !== 'angleApparent'
    ) {
      out.push(radToDeg(mag.windDirectionRad));
    }
    return out;
  }, [history, mag.windDirectionRad, mag.windDirectionSource]);

  /** Absolute heading samples for inner-ring HDG heatmap (from heading history). */
  const hdgHeatSamples = useMemo(() => {
    const now = Date.now();
    const cutoff = now - TWD_HEAT_WINDOW_MS;
    const out: number[] = [];
    for (const p of history) {
      if (p.t < cutoff) continue;
      const h = p.headingTrueRad;
      if (h == null || !Number.isFinite(h)) continue;
      out.push(radToDeg(h));
    }
    if (data.headingTrueRad != null && Number.isFinite(data.headingTrueRad)) {
      out.push(radToDeg(data.headingTrueRad));
    }
    return out;
  }, [history, data.headingTrueRad]);

  // Legacy #/sailsteer bookmarks land on main (Yaw Watch is the right half)
  useEffect(() => {
    const h = window.location.hash.replace(/^#\/?/, '').toLowerCase();
    if (h === 'sailsteer' || h === 'exp' || h === 'experimental') {
      window.location.hash = '#/';
    }
  }, []);

  return (
    <div className={`app ${alarming ? 'app-alarming' : ''}`}>
      <ConnectionBar
        status={status}
        message={statusMessage}
        dataSource={settings.dataSource}
        boatName={boatName}
        publish={publish}
        cloudUrl={settings.cloudUrl}
        lastBoatIngestAt={lastBoatIngestAt}
        onOpenSettings={openSettings}
        onReconnect={reconnect}
      />

      <AlarmBanner
        active={alarming}
        warning={showWarningBanner}
        distanceLabel={distanceLabel}
        radiusLabel={radiusLabel}
        muted={muted}
        onToggleMute={toggleMute}
        onDismissWarning={dismissWarning}
      />

      {windHigh && (
        <HighAnnounceBanner
          variant="wind"
          title="New high wind"
          detail={`${windHigh.level} ${windHigh.unit} sustained`}
          onDismiss={dismissWindHigh}
        />
      )}
      {distanceHigh && (
        <HighAnnounceBanner
          variant="distance"
          title="New high distance"
          detail={`${formatDistance(distanceHigh.distanceM, distanceHigh.unit)} sustained`}
          onDismiss={dismissDistanceHigh}
        />
      )}

      <main className="main">
        <section className="viz-row viz-row-main">
          <div className="viz-col viz-col-left">
            <div className="panel radar-panel">
              <div className="panel-head">
                <h2>Swing circle</h2>
                <span className="muted">
                  Heatmap · last {historyRangeLabel}
                </span>
              </div>
              <AnchorRadar
                distanceM={data.distanceM}
                bearingTrueRad={data.bearingTrueRad}
                headingTrueRad={data.headingTrueRad}
                alarmRadiusM={effectiveAlarmRadius}
                watchEnabled={settings.watchEnabled}
                history={windowed}
                waypointName={data.waypointName}
                distanceLabel={distanceLabel}
                distanceSub={
                  !settings.watchEnabled
                    ? 'Watch off'
                    : data.distanceM != null
                      ? `Alarm ${radiusLabel}`
                      : 'Set waypoint / drop anchor'
                }
                distanceAccent={
                  distAccent === 'ok' ||
                  distAccent === 'warn' ||
                  distAccent === 'alarm'
                    ? distAccent
                    : 'default'
                }
                highDistanceLabel={
                  distanceHighMarkM != null
                    ? formatDistance(distanceHighMarkM, settings.distanceUnit)
                    : '—'
                }
                highDistanceSub="Session high"
                bearingLabel={formatBearing(mag.bearingRad)}
                bearingSub={mag.bearingRefLabel}
              />
            </div>
          </div>

          <div className="viz-col viz-col-right">
            <section className="panel sailsteer-panel sailsteer-panel-main">
              <div className="panel-head">
                <h2>Yaw Watch</h2>
                <span className="muted">
                  North-up · magnetic · last {yawWindowLabel} yaw
                </span>
              </div>
              <SailSteer
                headingTrueRad={data.headingTrueRad}
                windDirectionRad={mag.windDirectionRad}
                windDirectionSource={mag.windDirectionSource}
                windSpeedMs={data.windSpeedMs}
                variationLabel={mag.variationLabel}
                windConvertedFromTrue={mag.windConvertedFromTrue}
                windUnit={settings.windUnit}
                yawPeakToPeakDeg={yaw.peakToPeakDeg}
                yawPeriodLabel={yawPeriodLabel}
                yawChartSeries={yaw.chartSeriesTimed}
                yawChartExtrema={yaw.chartExtremaTimed}
                twdChartSeries={yaw.chartTwdTimed}
                twdHeatSamples={twdHeatSamples}
                hdgHeatSamples={hdgHeatSamples}
                yawWindowMinutes={settings.yawWindowMinutes}
                yawChartStatus={
                  yaw.chartSeriesTimed.length < 2
                    ? yaw.sampleCount < 8
                      ? 'Gathering heading…'
                      : 'Waiting for heading…'
                    : undefined
                }
              />
            </section>
          </div>
        </section>

        <HistoryCharts
          history={windowed}
          historyRangeMinutes={settings.historyRangeMinutes}
          alarmRadiusM={effectiveAlarmRadius}
          distanceUnit={settings.distanceUnit}
          windUnit={settings.windUnit}
          windHighMark={windHighMark}
          distanceHighMarkM={distanceHighMarkM}
          showWindChart
          onRangeChange={setHistoryRange}
          onClear={clearHistory}
          clearDisabled={isRemote}
        />

        <MainControls
          historyRangeMinutes={settings.historyRangeMinutes}
          alarmRadiusM={effectiveAlarmRadius}
          distanceUnit={settings.distanceUnit}
          boatGuardRadiusM={boatGuardRadiusM}
          followBoat={followBoat}
          showBoatFollow={settings.dataSource === 'cloud'}
          watchEnabled={settings.watchEnabled}
          onReset={onResetData}
          onHistoryRange={setHistoryRange}
          onAlarmRadius={onAlarmRadius}
          onFollowBoat={onFollowBoat}
          onWatchEnabled={onWatchEnabled}
        />

        <footer className="footer">
          <p>
            {settings.dataSource === 'cloud'
              ? 'Watching live boat data via the cloud relay. The boat agent pushes Signal K telemetry every few seconds.'
              : 'Reads Signal K for distance, bearing, depth, and wind. Use Cloud mode (or your /watch?token=… link) to monitor from your phone.'}
          </p>
        </footer>
      </main>

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={closeSettings}
        onReset={resetSettings}
        headingSourcesSeen={data.headingSourcesSeen}
      />
    </div>
  );
}
