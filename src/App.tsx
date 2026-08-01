import { useCallback, useMemo, useRef, useState } from 'react';
import { AlarmBanner } from './components/AlarmBanner';
import { AnchorRadar } from './components/AnchorRadar';
import { ConnectionBar } from './components/ConnectionBar';
import { HistoryCharts } from './components/HistoryCharts';
import { MainControls } from './components/MainControls';
import { MetricCard } from './components/MetricCard';
import { SettingsPanel } from './components/SettingsPanel';
import { WindRose } from './components/WindRose';
import { HighAnnounceBanner } from './components/HighAnnounceBanner';
import { useAlarm } from './hooks/useAlarm';
import { useCloudPublisher } from './hooks/useCloudPublisher';
import { useDistanceHighAnnounce } from './hooks/useDistanceHighAnnounce';
import { useHistory } from './hooks/useHistory';
import { useSettings } from './hooks/useSettings';
import { useVesselData } from './hooks/useVesselData';
import { useWindHighAnnounce } from './hooks/useWindHighAnnounce';
import type { HistoryRangeMinutes, VesselData } from './types';
import {
  formatBearing,
  formatDepth,
  formatDistance,
  formatLatLon,
  formatWind,
  msToKnots,
} from './units';

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
  const { windowed, clearHistory, isRemote } = useHistory(
    data,
    settings.historyIntervalMs,
    settings.historyMaxPoints,
    live && settings.dataSource !== 'cloud',
    settings.historyRangeMinutes,
    cloudHistory,
  );

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

  // High-water announcements run on every live feed, including cloud/remote phone UI
  const announceSessionKey = settings.dataSource;
  const {
    announcement: windHigh,
    dismiss: dismissWindHigh,
    highMark: windHighMark,
  } = useWindHighAnnounce(
    data.windSpeedMs,
    settings.windUnit,
    live && settings.windHighAnnounce,
    announceSessionKey,
    settings.windHighAnnounceMinMs,
  );
  const { announcement: distanceHigh, dismiss: dismissDistanceHigh } =
    useDistanceHighAnnounce(
      data.distanceM,
      settings.distanceUnit,
      live && settings.distanceHighAnnounce,
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

  const windSourceLabel = useMemo(() => {
    if (!data.windSpeedSource) return null;
    const map = {
      true: 'True wind',
      apparent: 'Apparent wind',
      overGround: 'Wind over ground',
    };
    return map[data.windSpeedSource];
  }, [data.windSpeedSource]);

  const depthSub = data.depthSource
    ? data.depthSource === 'belowTransducer'
      ? 'Below transducer'
      : data.depthSource === 'belowKeel'
        ? 'Below keel'
        : 'Below surface'
    : undefined;

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

  const historyRangeLabel =
    settings.historyRangeMinutes >= 60
      ? `${settings.historyRangeMinutes / 60}h`
      : `${settings.historyRangeMinutes}m`;

  return (
    <div className={`app ${alarming ? 'app-alarming' : ''}`}>
      <ConnectionBar
        status={status}
        message={statusMessage}
        dataSource={settings.dataSource}
        boatName={boatName}
        publish={publish}
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
        <section className="hero-metrics">
          <MetricCard
            label="Distance to anchor"
            value={distanceLabel}
            sub={
              !settings.watchEnabled
                ? 'Watch off'
                : data.waypointName
                  ? data.waypointName
                  : data.distanceM != null
                    ? `Alarm at ${radiusLabel}`
                    : 'Set waypoint / drop anchor in plotter'
            }
            accent={distAccent}
            large
          />
          <MetricCard
            label="Bearing to anchor"
            value={formatBearing(data.bearingTrueRad)}
            sub="True"
            accent="default"
            large
          />
          <MetricCard
            label="Depth"
            value={formatDepth(data.depthM, settings.depthUnit)}
            sub={depthSub}
            accent="depth"
            large
          />
          <MetricCard
            label="Wind speed"
            value={formatWind(data.windSpeedMs, settings.windUnit)}
            sub={windSourceLabel ?? undefined}
            accent="wind"
            large
          />
        </section>

        <section className="viz-row">
          <div className="panel radar-panel">
            <div className="panel-head">
              <h2>Swing circle</h2>
              <span className="muted">Heatmap · last {historyRangeLabel}</span>
            </div>
            <AnchorRadar
              distanceM={data.distanceM}
              bearingTrueRad={data.bearingTrueRad}
              headingTrueRad={data.headingTrueRad}
              alarmRadiusM={effectiveAlarmRadius}
              watchEnabled={settings.watchEnabled}
              history={windowed}
            />
          </div>

          <div className="panel wind-panel">
            <div className="panel-head">
              <h2>Wind</h2>
            </div>
            <div className="wind-panel-body">
              <WindRose
                directionRad={data.windDirectionRad}
                speedLabel={formatWind(data.windSpeedMs, settings.windUnit)}
                source={
                  data.windDirectionSource === 'angleApparent'
                    ? 'Apparent angle (relative to bow)'
                    : windSourceLabel
                }
                isAngleRelative={data.windDirectionSource === 'angleApparent'}
              />
              <div className="secondary-metrics">
                <MetricCard
                  label="SOG"
                  value={
                    data.speedOverGroundMs != null
                      ? `${msToKnots(data.speedOverGroundMs).toFixed(1)} kn`
                      : '—'
                  }
                />
                <MetricCard
                  label="Heading"
                  value={formatBearing(data.headingTrueRad)}
                  sub="True"
                />
                <MetricCard
                  label="Position"
                  value={formatLatLon(data.latitude, data.longitude)}
                />
              </div>
            </div>
          </div>
        </section>

        <HistoryCharts
          history={windowed}
          historyRangeMinutes={settings.historyRangeMinutes}
          alarmRadiusM={effectiveAlarmRadius}
          distanceUnit={settings.distanceUnit}
          windUnit={settings.windUnit}
          windHighMark={windHighMark}
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
      />
    </div>
  );
}
