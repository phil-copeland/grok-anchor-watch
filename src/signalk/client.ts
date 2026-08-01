import type { VesselData } from '../types';
import { EMPTY_VESSEL } from '../types';
import { bearingBetween, haversineM } from '../units';
import {
  SIGNALK_PATHS,
  buildStreamUrl,
  buildSubscribeMessage,
  type SignalkDelta,
} from './paths';

export type DeltaHandler = (data: VesselData) => void;
export type StatusHandler = (
  status: 'connecting' | 'connected' | 'disconnected' | 'error',
  message?: string,
) => void;

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
  private shouldRun = false;
  private serverUrl = '';
  private useTls = false;
  private reconnectAttempt = 0;
  /** True once navigation.anchor.currentRadius has been received */
  private hasAnchorRadius = false;

  constructor(onDelta: DeltaHandler, onStatus: StatusHandler) {
    this.onDelta = onDelta;
    this.onStatus = onStatus;
  }

  connect(serverUrl: string, useTls: boolean) {
    this.disconnect();
    this.shouldRun = true;
    this.serverUrl = serverUrl;
    this.useTls = useTls;
    this.reconnectAttempt = 0;
    this.open();
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
      if (this.shouldRun) {
        this.onStatus('disconnected', 'Connection closed');
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private applyDelta(msg: SignalkDelta) {
    if (!msg.updates) return;
    let changed = false;
    const now = Date.now();

    for (const update of msg.updates) {
      if (!update.values) continue;
      for (const { path, value } of update.values) {
        if (this.applyPath(path, value)) changed = true;
      }
    }

    if (changed) {
      this.deriveDistanceBearing();
      this.data = { ...this.data, updatedAt: now };
      this.onDelta(this.data);
    }
  }

  private applyPath(path: string, value: unknown): boolean {
    const d = this.data;
    const num = typeof value === 'number' ? value : null;
    const pos = value as { latitude?: number; longitude?: number } | null;

    switch (path) {
      case SIGNALK_PATHS.anchorCurrentRadius:
        if (num != null) {
          d.distanceM = num;
          this.hasAnchorRadius = true;
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

      case SIGNALK_PATHS.gcNextDistance:
        // Prefer native anchor radius; otherwise use active waypoint distance
        if (num != null && !this.hasAnchorRadius) {
          d.distanceM = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextDistance:
        if (num != null && !this.hasAnchorRadius && d.distanceM == null) {
          d.distanceM = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextBearingTrue:
        if (num != null) {
          d.bearingTrueRad = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextBearingTrue:
        if (d.bearingTrueRad == null && num != null) {
          d.bearingTrueRad = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.gcNextBearingMagnetic:
        if (num != null) {
          d.bearingMagneticRad = num;
          return true;
        }
        return false;

      case SIGNALK_PATHS.rhNextBearingMagnetic:
        if (d.bearingMagneticRad == null && num != null) {
          d.bearingMagneticRad = num;
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

      case SIGNALK_PATHS.windDirectionTrue:
        if (num != null) {
          d.windDirectionRad = num;
          d.windDirectionSource = 'directionTrue';
          return true;
        }
        return false;

      case SIGNALK_PATHS.windDirectionMagnetic:
        if (num != null && d.windDirectionSource !== 'directionTrue') {
          d.windDirectionRad = num;
          d.windDirectionSource = 'directionMagnetic';
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

      case SIGNALK_PATHS.headingTrue:
        if (num != null) {
          d.headingTrueRad = num;
          return true;
        }
        return false;

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

  /** If we have vessel + anchor positions, recompute distance/bearing. */
  private deriveDistanceBearing() {
    const d = this.data;
    if (
      d.latitude != null &&
      d.longitude != null &&
      d.anchorLat != null &&
      d.anchorLon != null
    ) {
      d.distanceM = haversineM(
        d.latitude,
        d.longitude,
        d.anchorLat,
        d.anchorLon,
      );
      d.bearingTrueRad = bearingBetween(
        d.latitude,
        d.longitude,
        d.anchorLat,
        d.anchorLon,
      );
    }
  }
}
