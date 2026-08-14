import type { VesselData } from '../types';
import { EMPTY_VESSEL } from '../types';
import {
  bearingBetween,
  haversineM,
  isPlausibleHeadingRad,
  normalizeHeadingRad,
} from '../units';
import {
  SIGNALK_PATHS,
  buildStreamUrl,
  buildSubscribeMessage,
  type SignalkDelta,
} from './paths';
import {
  buildSourceNameMap,
  pickHeadingFromFullModel,
  resolveSourceIdentity,
  sourceMatchesFilter,
} from './sourceFilter';

export type DeltaHandler = (data: VesselData) => void;
export type StatusHandler = (
  status: 'connecting' | 'connected' | 'disconnected' | 'error',
  message?: string,
) => void;

export interface SignalKClientOptions {
  /**
   * Only accept headingMagnetic when source identity contains this
   * (case-insensitive). Empty = any source.
   */
  headingMagneticSourceFilter?: string;
}

/**
 * Minimal Signal K WebSocket client for vessels.self deltas.
 * Merges updates into a single VesselData snapshot.
 */
export class SignalKClient {
  private ws: WebSocket | null = null;
  private data: VesselData = { ...EMPTY_VESSEL };
  private onDelta: DeltaHandler;
  private onStatus: StatusHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private shouldRun = false;
  private serverUrl = '';
  private useTls = false;
  private reconnectAttempt = 0;
  /** True once navigation.anchor.currentRadius has been received */
  /** True when SK published a live distance path (don't overwrite with haversine) */
  private hasSkDistance = false;
  private headingSourceFilter = '';
  /** $source path → product / label from REST /sources */
  private sourceNames = new Map<string, string>();
  /** Heading magnetic sources seen this session (for diagnostics) */
  private seenHeadingSources = new Set<string>();
  /** Locked $source / identity once a matching device is found */
  private lockedHeadingSource: string | null = null;

  constructor(
    onDelta: DeltaHandler,
    onStatus: StatusHandler,
    options?: SignalKClientOptions,
  ) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
    this.headingSourceFilter = (
      options?.headingMagneticSourceFilter ?? ''
    ).trim();
  }

  /** Update filter without full reconnect. */
  setHeadingSourceFilter(filter: string) {
    const next = (filter ?? '').trim();
    if (next === this.headingSourceFilter) return;
    this.headingSourceFilter = next;
    this.lockedHeadingSource = null;
    // Drop current heading so we don't keep a non-matching device
    if (this.data.headingTrueRad != null) {
      this.data = {
        ...this.data,
        headingTrueRad: null,
        headingSource: null,
        headingDevice: null,
        headingSourcesSeen: this.getSeenHeadingSources(),
        updatedAt: Date.now(),
      };
      this.onDelta(this.data);
    }
    void this.pollHeadingFromApi();
  }

  /** Sources that have published headingMagnetic (identity strings). */
  getSeenHeadingSources(): string[] {
    return [...this.seenHeadingSources].sort();
  }

  connect(serverUrl: string, useTls: boolean) {
    this.disconnect();
    this.shouldRun = true;
    this.serverUrl = serverUrl;
    this.useTls = useTls;
    this.reconnectAttempt = 0;
    this.seenHeadingSources.clear();
    this.sourceNames.clear();
    this.lockedHeadingSource = null;
    this.hasSkDistance = false;
    this.data = { ...EMPTY_VESSEL };
    this.open();
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.onStatus('disconnected');
  }

  getData(): VesselData {
    return this.data;
  }

  private httpBase(): string {
    const host = this.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const scheme = this.useTls ? 'https' : 'http';
    return `${scheme}://${host}`;
  }

  private open() {
    if (!this.shouldRun) return;
    const url = buildStreamUrl(this.serverUrl, this.useTls);
    this.onStatus('connecting', url);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.onStatus('error', String(err));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.onStatus('connected', url);
      this.ws?.send(JSON.stringify(buildSubscribeMessage()));
      void this.bootstrapSourcesAndHeading();
      // REST poll: multi-value heading + product names (deltas often lack model)
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        void this.pollHeadingFromApi();
      }, 3000);
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SignalkDelta;
        this.applyDelta(msg);
      } catch {
        /* ignore non-JSON */
      }
    };

    this.ws.onerror = () => {
      this.onStatus('error', 'WebSocket error');
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.shouldRun) {
        this.onStatus('disconnected', 'Connection closed');
        this.scheduleReconnect();
      }
    };
  }

  private async bootstrapSourcesAndHeading() {
    await this.fetchSourceNames();
    await this.pollHeadingFromApi();
  }

  private async fetchSourceNames() {
    try {
      const res = await fetch(`${this.httpBase()}/signalk/v1/api/sources`);
      if (!res.ok) return;
      const json: unknown = await res.json();
      this.sourceNames = buildSourceNameMap(json);
    } catch {
      /* REST may be blocked; delta labels still work */
    }
  }

  /**
   * Read full-model headingMagnetic (includes values{} per source) and pick
   * the entry matching the Precision-9 filter.
   */
  private async pollHeadingFromApi() {
    if (!this.shouldRun) return;
    try {
      // Refresh product map occasionally (devices appear after boot)
      if (this.sourceNames.size === 0) {
        await this.fetchSourceNames();
      }

      const res = await fetch(
        `${this.httpBase()}/signalk/v1/api/vessels/self/navigation/headingMagnetic`,
      );
      if (!res.ok) return;
      const json: unknown = await res.json();

      // Record every multi-value source key for diagnostics
      let sourcesChanged = false;
      if (json && typeof json === 'object') {
        const values = (json as { values?: Record<string, unknown> }).values;
        if (values && typeof values === 'object') {
          for (const key of Object.keys(values)) {
            const identity = resolveSourceIdentity(
              { $source: key },
              this.sourceNames,
            );
            if (this.noteHeadingSource(identity || key, key)) {
              sourcesChanged = true;
            }
          }
        }
        const dollar = (json as { $source?: string }).$source;
        if (typeof dollar === 'string') {
          const identity = resolveSourceIdentity(
            { $source: dollar },
            this.sourceNames,
          );
          if (this.noteHeadingSource(identity || dollar, dollar)) {
            sourcesChanged = true;
          }
        }
      }
      if (sourcesChanged) {
        this.emitSeenSourcesOnly();
      }

      const picked = pickHeadingFromFullModel(
        json,
        this.headingSourceFilter,
        this.sourceNames,
      );
      if (!picked) {
        // Still push seen sources so UI can show what arrived
        this.emitSeenSourcesOnly();
        return;
      }

      if (
        !Number.isFinite(picked.value) ||
        !isPlausibleHeadingRad(picked.value)
      ) {
        return;
      }
      const heading = normalizeHeadingRad(picked.value);
      this.lockedHeadingSource = picked.sourceId;
      const now = Date.now();
      if (
        this.data.headingTrueRad === heading &&
        this.data.headingDevice === picked.sourceId
      ) {
        return;
      }
      this.data = {
        ...this.data,
        headingTrueRad: heading,
        headingSource: 'magnetic',
        headingDevice: picked.sourceId,
        headingSourcesSeen: this.getSeenHeadingSources(),
        updatedAt: now,
      };
      this.onDelta(this.data);
    } catch {
      /* ignore poll errors */
    }
  }

  private emitSeenSourcesOnly() {
    const seen = this.getSeenHeadingSources();
    const prev = this.data.headingSourcesSeen ?? [];
    if (
      seen.length === prev.length &&
      seen.every((s, i) => s === prev[i])
    ) {
      return;
    }
    this.data = {
      ...this.data,
      headingSourcesSeen: seen,
      updatedAt: Date.now(),
    };
    this.onDelta(this.data);
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private noteHeadingSource(identity: string, dollarSource?: string): boolean {
    const raw = [dollarSource, identity].filter(Boolean).join(' · ') || identity;
    const label = raw || '(no source on delta)';
    const before = this.seenHeadingSources.size;
    this.seenHeadingSources.add(label);
    // Also keep bare $source for filter matching convenience
    if (dollarSource) this.seenHeadingSources.add(dollarSource);
    if (identity && identity !== label) this.seenHeadingSources.add(identity);

    this.data.headingSourceLast = label;

    if (this.seenHeadingSources.size !== before) {
      // eslint-disable-next-line no-console
      console.info(
        '[anchor-watch] headingMagnetic source(s):',
        this.getSeenHeadingSources(),
      );
      // eslint-disable-next-line no-console
      console.info('[anchor-watch] headingMagnetic last source:', label);
      return true;
    }
    return false;
  }

  private applyDelta(msg: SignalkDelta) {
    if (!msg.updates) return;
    let changed = false;
    let sourcesChanged = false;
    const now = Date.now();

    for (const update of msg.updates) {
      if (!update.values) continue;
      const identity = resolveSourceIdentity(update, this.sourceNames);
      for (const { path, value } of update.values) {
        if (path === SIGNALK_PATHS.headingMagnetic) {
          if (this.noteHeadingSource(identity, update.$source)) {
            sourcesChanged = true;
          } else {
            // Always refresh "last" even when already seen
            const raw =
              [update.$source, identity].filter(Boolean).join(' · ') ||
              identity ||
              '(no source on delta)';
            if (this.data.headingSourceLast !== raw) {
              this.data.headingSourceLast = raw;
              sourcesChanged = true;
            }
          }
        }
        if (this.applyPath(path, value, identity, update.$source)) {
          changed = true;
        }
      }
    }

    if (changed || sourcesChanged) {
      if (changed) this.deriveDistanceBearing();
      this.data = {
        ...this.data,
        headingSourcesSeen: this.getSeenHeadingSources(),
        updatedAt: now,
      };
      this.onDelta(this.data);
    }
  }

  private applyPath(
    path: string,
    value: unknown,
    sourceId = '',
    dollarSource?: string,
  ): boolean {
    const d = this.data;
    const num = typeof value === 'number' ? value : null;
    const pos = value as { latitude?: number; longitude?: number } | null;

    switch (path) {
      case SIGNALK_PATHS.anchorCurrentRadius:
        if (num != null && Number.isFinite(num) && num >= 0) {
          d.distanceM = num;
          this.hasSkDistance = true;
          return true;
        }
        return false;

      case SIGNALK_PATHS.anchorMaxRadius:
        if (num != null) d.maxRadiusM = num;
        return num != null;

      case SIGNALK_PATHS.anchorPosition:
        if (pos?.latitude != null && pos?.longitude != null) {
          d.anchorLat = pos.latitude;
          d.anchorLon = pos.longitude;
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextPosition:
        // Active waypoint (= anchor) when no native anchor position
        if (
          pos?.latitude != null &&
          pos?.longitude != null &&
          d.anchorLat == null
        ) {
          d.anchorLat = pos.latitude;
          d.anchorLon = pos.longitude;
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextDistance:
        // Distance to active waypoint (your anchor as waypoint)
        if (num != null && Number.isFinite(num) && num >= 0) {
          d.distanceM = num;
          this.hasSkDistance = true;
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextDistance:
        if (
          num != null &&
          Number.isFinite(num) &&
          num >= 0 &&
          d.distanceM == null
        ) {
          d.distanceM = num;
          this.hasSkDistance = true;
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextBearingMagnetic:
        if (num != null) {
          d.bearingMagneticRad = normalizeHeadingRad(num);
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextBearingMagnetic:
        if (d.bearingMagneticRad == null && num != null) {
          d.bearingMagneticRad = normalizeHeadingRad(num);
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextBearingTrue:
        // Keep true for geographic swing-circle geometry; UI prefers magnetic
        if (num != null) {
          d.bearingTrueRad = normalizeHeadingRad(num);
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextBearingTrue:
        if (d.bearingTrueRad == null && num != null) {
          d.bearingTrueRad = normalizeHeadingRad(num);
          return true;
        }
        return false;

      case SIGNALK_PATHS.depthBelowTransducer:
        if (num != null) {
          d.depthM = num;
          d.depthSource = 'belowTransducer';
          return true;
        }
        return false;

      case SIGNALK_PATHS.depthBelowKeel:
        if (num != null && d.depthSource !== 'belowTransducer') {
          d.depthM = num;
          d.depthSource = 'belowKeel';
          return true;
        }
        return false;

      case SIGNALK_PATHS.depthBelowSurface:
        if (
          num != null &&
          d.depthSource !== 'belowTransducer' &&
          d.depthSource !== 'belowKeel'
        ) {
          d.depthM = num;
          d.depthSource = 'belowSurface';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windSpeedTrue:
        if (num != null) {
          d.windSpeedMs = num;
          d.windSpeedSource = 'true';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windSpeedOverGround:
        if (num != null && d.windSpeedSource !== 'true') {
          d.windSpeedMs = num;
          d.windSpeedSource = 'overGround';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windSpeedApparent:
        if (
          num != null &&
          d.windSpeedSource !== 'true' &&
          d.windSpeedSource !== 'overGround'
        ) {
          d.windSpeedMs = num;
          d.windSpeedSource = 'apparent';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windDirectionMagnetic:
        if (num != null && isPlausibleHeadingRad(num)) {
          const mag = normalizeHeadingRad(num);
          d.windDirectionMagneticRad = mag;
          d.windDirectionRad = mag;
          d.windDirectionSource = 'directionMagnetic';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windDirectionTrue:
        if (num != null && isPlausibleHeadingRad(num)) {
          const tru = normalizeHeadingRad(num);
          d.windDirectionTrueRad = tru;
          // Prefer magnetic for display when both are published
          if (d.windDirectionSource !== 'directionMagnetic') {
            d.windDirectionRad = tru;
            d.windDirectionSource = 'directionTrue';
          }
          return true;
        }
        return false;

      case SIGNALK_PATHS.windAngleApparent:
        if (num != null && d.windDirectionSource == null) {
          d.windDirectionRad = num;
          d.windDirectionSource = 'angleApparent';
          return true;
        }
        return false;

      case SIGNALK_PATHS.position:
        if (pos?.latitude != null && pos?.longitude != null) {
          d.latitude = pos.latitude;
          d.longitude = pos.longitude;
          return true;
        }
        return false;

      case SIGNALK_PATHS.magneticVariation:
        // East-positive radians per Signal K / NMEA convention
        if (num != null && Number.isFinite(num) && Math.abs(num) < Math.PI) {
          d.magneticVariationRad = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.headingTrue:
        return false;

      case SIGNALK_PATHS.headingMagnetic: {
        if (num == null || !isPlausibleHeadingRad(num)) return false;
        const id = sourceId || dollarSource || '';
        if (id) this.seenHeadingSources.add(id);

        // Once locked to a device, only accept that identity.
        // (Previously: without a filter, non-matching sources still fell through
        // and caused multi-compass jumps to "false" headings.)
        if (this.lockedHeadingSource) {
          const lock = this.lockedHeadingSource.toLowerCase();
          const idL = id.toLowerCase();
          const ok =
            (idL &&
              (idL.includes(lock) ||
                lock.includes(idL) ||
                (dollarSource != null &&
                  (lock.includes(dollarSource.toLowerCase()) ||
                    dollarSource.toLowerCase().includes(lock))))) ||
            false;
          if (!ok) {
            // Re-lock only when user filter explicitly matches this source
            if (
              this.headingSourceFilter &&
              sourceMatchesFilter(id, this.headingSourceFilter)
            ) {
              this.lockedHeadingSource = id || this.headingSourceFilter;
            } else {
              return false;
            }
          }
        } else if (this.headingSourceFilter) {
          if (!sourceMatchesFilter(id, this.headingSourceFilter)) {
            return false;
          }
          this.lockedHeadingSource = id || this.headingSourceFilter;
        } else if (id) {
          // No filter: stick to first source so two compasses don't alternate
          this.lockedHeadingSource = id;
        }

        d.headingTrueRad = normalizeHeadingRad(num);
        d.headingSource = 'magnetic';
        d.headingDevice = id || this.lockedHeadingSource;
        return true;
      }

      case SIGNALK_PATHS.speedOverGround:
        if (num != null) {
          d.speedOverGroundMs = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.destinationName:
        if (typeof value === 'string') {
          d.waypointName = value;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  private deriveDistanceBearing() {
    const d = this.data;
    if (
      d.latitude == null ||
      d.longitude == null ||
      d.anchorLat == null ||
      d.anchorLon == null
    ) {
      return;
    }
    const dist = haversineM(
      d.latitude,
      d.longitude,
      d.anchorLat,
      d.anchorLon,
    );
    const brg = bearingBetween(
      d.latitude,
      d.longitude,
      d.anchorLat,
      d.anchorLon,
    );
    // Only fill distance when no live SK distance (anchor radius / nextPoint)
    if (!this.hasSkDistance || d.distanceM == null) {
      d.distanceM = dist;
    }
    if (d.bearingTrueRad == null) {
      d.bearingTrueRad = brg;
    }
  }
}
