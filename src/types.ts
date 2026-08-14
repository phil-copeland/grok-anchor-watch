/** Live instrument values (display units applied in the UI). SI underneath where noted. */
export interface VesselData {
  /** Distance to anchor/waypoint, metres */
  distanceM: number | null;
  /** Bearing to anchor/waypoint, radians true (geographic; swing-circle geometry) */
  bearingTrueRad: number | null;
  /** Bearing magnetic, radians — preferred for UI angle displays */
  bearingMagneticRad: number | null;
  /** Depth below transducer (or best available), metres */
  depthM: number | null;
  depthSource: 'belowTransducer' | 'belowKeel' | 'belowSurface' | null;
  /** Wind speed, m/s — prefers true, falls back to apparent */
  windSpeedMs: number | null;
  windSpeedSource: 'true' | 'apparent' | 'overGround' | null;
  /**
   * Active wind direction for display (magnetic preferred).
   * Kept for compatibility; prefer magnetic/true fields when both present.
   */
  windDirectionRad: number | null;
  windDirectionSource: 'directionTrue' | 'directionMagnetic' | 'angleApparent' | null;
  /** Raw instrument magnetic wind direction (rad), if published */
  windDirectionMagneticRad?: number | null;
  /** Raw true wind direction (rad), if published */
  windDirectionTrueRad?: number | null;
  /** Vessel position */
  latitude: number | null;
  longitude: number | null;
  /** Heading radians — magnetic only (from headingMagnetic) */
  headingTrueRad: number | null;
  /**
   * Magnetic variation (declination) from Signal K, radians, east-positive.
   * True = Magnetic + variation. Null if not published on the network.
   */
  magneticVariationRad: number | null;
  /** Which Signal K path populated heading */
  headingSource?: 'true' | 'magnetic' | null;
  /** Matched device / $source label for heading (e.g. Precision-9) */
  headingDevice?: string | null;
  /** Heading magnetic sources observed (for filter diagnostics) */
  headingSourcesSeen?: string[] | null;
  /** Most recent raw Signal K source identity for headingMagnetic (debug) */
  headingSourceLast?: string | null;
  /** SOG m/s */
  speedOverGroundMs: number | null;
  /** Anchor alarm radius from Signal K, metres */
  maxRadiusM: number | null;
  /**
   * App guard / alarm radius from the boat (metres).
   * Pushed by boat agent or local publisher so remote viewers match the boat setting.
   */
  alarmRadiusM: number | null;
  /** Optional tag from publisher: demo | signalk | browser */
  dataSourceLabel?: string | null;
  /** Anchor drop position */
  anchorLat: number | null;
  anchorLon: number | null;
  /** Active waypoint name if known */
  waypointName: string | null;
  /** Last update timestamps per field (ms) */
  updatedAt: number;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'demo'
  | 'cloud'
  | 'stale';

export type DataSource = 'signalk' | 'demo' | 'cloud';

export interface HistoryPoint {
  t: number;
  distanceM: number | null;
  windSpeedMs: number | null;
  /** Bearing boat → anchor (rad true) — for swing-circle heatmap */
  bearingTrueRad: number | null;
  /** Vessel heading true (rad) — for yaw amplitude / period */
  headingTrueRad?: number | null;
  /** Wind direction (rad) — for TWD overlay on yaw chart */
  windDirectionRad?: number | null;
}

/** Display window for charts + heatmap (minutes). */
export type HistoryRangeMinutes = 5 | 15 | 30 | 60 | 120 | 240;

export const HISTORY_RANGE_OPTIONS: ReadonlyArray<{
  minutes: HistoryRangeMinutes;
  label: string;
}> = [
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
];

export interface AppSettings {
  /** Data source: local Signal K, demo, or cloud relay */
  dataSource: DataSource;
  /** Signal K server host, e.g. 192.168.1.50 or demo.signalk.org */
  serverUrl: string;
  /** Use wss when true (Signal K) */
  useTls: boolean;
  /** Cloud relay base URL, e.g. https://anchor-watch.fly.dev */
  cloudUrl: string;
  /** Cloud view token (phone share token) */
  cloudViewToken: string;
  /** Local alarm radius (metres) — used when not following boat, or on boat itself */
  alarmRadiusM: number;
  /**
   * When false, watch mode is off: no radius alarm, banner, or audio.
   * Instruments and history keep updating. Default true.
   */
  watchEnabled: boolean;
  /**
   * When true (default in cloud mode), use the boat-pushed guard radius.
   * Turning the slider on a remote viewer sets this false (local override).
   */
  followBoatGuardRadius: boolean;
  /**
   * Optional boat publish token (BOAT_TOKEN). When set with cloudUrl and a local
   * data source, the browser also pushes telemetry (including alarm radius) to cloud.
   */
  cloudBoatToken: string;
  /**
   * When true, this browser sends telemetry to the cloud (requires cloudUrl + boat token).
   * Off by default — enable in Settings when you want remotes to see this machine.
   */
  cloudPublishEnabled: boolean;
  /** Sample history every N ms (local sources only) */
  historyIntervalMs: number;
  /** Max history points retained in memory/storage */
  historyMaxPoints: number;
  /** Chart + heatmap time window (minutes) */
  historyRangeMinutes: HistoryRangeMinutes;
  /** Prefer true wind over apparent */
  preferTrueWind: boolean;
  /** Distance unit for display */
  distanceUnit: 'm' | 'ft' | 'nm';
  /** Depth unit for display */
  depthUnit: 'm' | 'ft';
  /** Wind unit for display */
  windUnit: 'kn' | 'm/s' | 'km/h' | 'mph';
  /** Enable browser audio alarm (anchor radius) */
  audioAlarm: boolean;
  /**
   * Announce session high wind levels (speech + banner) when a new whole-unit
   * high is held for over 3 seconds. Works on local and cloud/remote UI.
   */
  windHighAnnounce: boolean;
  /**
   * Do not announce wind highs until wind reaches at least this speed (m/s).
   * 0 = no floor (announce any new high after warmup).
   */
  windHighAnnounceMinMs: number;
  /**
   * Announce session high anchor distance (speech + banner) when distance
   * exceeds the previous high by more than 200 mm and holds for over 1 second.
   * Works on local and cloud/remote UI.
   */
  distanceHighAnnounce: boolean;
  /**
   * Do not announce distance highs until distance reaches at least this (metres).
   * 0 = no floor.
   */
  distanceHighAnnounceMinM: number;
  /**
   * Trailing window (minutes) for yaw amplitude, period, and Yaw Watch chart.
   * Default 2.
   */
  yawWindowMinutes: number;
  /**
   * @deprecated Metrics use yawWindowMinutes. Kept for localStorage migration.
   */
  yawOscillations?: number;
  /**
   * How many half-swings (peak↔trough) to show on the yaw chart (3–15).
   */
  yawChartSwings: number;
  /**
   * Only accept navigation.headingMagnetic from sources whose label/$source
   * contains this text (case-insensitive), e.g. "Precision-9".
   * Empty = accept any magnetic heading source.
   */
  headingMagneticSourceFilter: string;
  /**
   * Show discovered headingMagnetic sources in Settings (and related debug UI).
   */
  debugHeadingSources: boolean;
  /**
   * @deprecated use dataSource === 'demo'
   * Kept for migration from older localStorage
   */
  demoMode?: boolean;
}

/** 4 hours @ 5s ≈ 2880 samples; keep a buffer */
export const DEFAULT_SETTINGS: AppSettings = {
  dataSource: 'signalk',
  serverUrl: 'localhost:3000',
  useTls: false,
  cloudUrl: '',
  cloudViewToken: '',
  alarmRadiusM: 40,
  watchEnabled: true,
  followBoatGuardRadius: true,
  cloudBoatToken: '',
  cloudPublishEnabled: false,
  historyIntervalMs: 5000,
  historyMaxPoints: 3000,
  historyRangeMinutes: 30,
  preferTrueWind: true,
  distanceUnit: 'm',
  depthUnit: 'm',
  windUnit: 'kn',
  audioAlarm: true,
  windHighAnnounce: true,
  windHighAnnounceMinMs: 0,
  distanceHighAnnounce: true,
  distanceHighAnnounceMinM: 0,
  yawWindowMinutes: 2,
  yawChartSwings: 7,
  /** Empty until user sets a filter (e.g. Precision-9) in Settings */
  headingMagneticSourceFilter: '',
  debugHeadingSources: false,
};

export const EMPTY_VESSEL: VesselData = {
  distanceM: null,
  bearingTrueRad: null,
  bearingMagneticRad: null,
  depthM: null,
  depthSource: null,
  windSpeedMs: null,
  windSpeedSource: null,
  windDirectionRad: null,
  windDirectionSource: null,
  windDirectionMagneticRad: null,
  windDirectionTrueRad: null,
  latitude: null,
  longitude: null,
  headingTrueRad: null,
  magneticVariationRad: null,
  headingSource: null,
  headingDevice: null,
  headingSourcesSeen: null,
  headingSourceLast: null,
  speedOverGroundMs: null,
  maxRadiusM: null,
  alarmRadiusM: null,
  anchorLat: null,
  anchorLon: null,
  waypointName: null,
  updatedAt: 0,
};
