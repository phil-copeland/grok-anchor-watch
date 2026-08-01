import WebSocket from 'ws';

const PATHS = [
  'navigation.anchor.currentRadius',
  'navigation.anchor.maxRadius',
  'navigation.anchor.position',
  'navigation.courseGreatCircle.nextPoint.distance',
  'navigation.courseGreatCircle.nextPoint.bearingTrue',
  'navigation.courseGreatCircle.nextPoint.bearingMagnetic',
  'navigation.courseRhumbline.nextPoint.distance',
  'navigation.courseRhumbline.nextPoint.bearingTrue',
  'environment.depth.belowTransducer',
  'environment.depth.belowKeel',
  'environment.depth.belowSurface',
  'environment.wind.speedTrue',
  'environment.wind.speedApparent',
  'environment.wind.speedOverGround',
  'environment.wind.directionTrue',
  'environment.wind.directionMagnetic',
  'environment.wind.angleApparent',
  'navigation.position',
  'navigation.headingTrue',
  'navigation.speedOverGround',
  'navigation.destination.commonName',
];

function emptyVessel() {
  return {
    distanceM: null,
    bearingTrueRad: null,
    bearingMagneticRad: null,
    depthM: null,
    depthSource: null,
    windSpeedMs: null,
    windSpeedSource: null,
    windDirectionRad: null,
    windDirectionSource: null,
    latitude: null,
    longitude: null,
    headingTrueRad: null,
    speedOverGroundMs: null,
    maxRadiusM: null,
    alarmRadiusM: null,
    anchorLat: null,
    anchorLon: null,
    waypointName: null,
    updatedAt: 0,
  };
}

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const Δφ = degToRad(lat2 - lat1);
  const Δλ = degToRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingBetween(lat1, lon1, lat2, lon2) {
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const Δλ = degToRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

/**
 * Minimal Signal K client (Node). Calls onChange(vessel) on updates.
 */
export class SignalKReader {
  /**
   * @param {string} host e.g. localhost:3000
   * @param {boolean} useTls
   * @param {(v: object) => void} onChange
   * @param {(s: string, msg?: string) => void} onStatus
   */
  constructor(host, useTls, onChange, onStatus) {
    this.host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.useTls = useTls;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.ws = null;
    this.shouldRun = false;
    this.data = emptyVessel();
    this.hasAnchorRadius = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  connect() {
    this.disconnect();
    this.shouldRun = true;
    this.open();
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  getVessel() {
    return { ...this.data };
  }

  open() {
    if (!this.shouldRun) return;
    const scheme = this.useTls ? 'wss' : 'ws';
    const url = `${scheme}://${this.host}/signalk/v1/stream?subscribe=none`;
    this.onStatus('connecting', url);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.onStatus('connected', url);
      this.ws.send(
        JSON.stringify({
          context: 'vessels.self',
          subscribe: PATHS.map((path) => ({
            path,
            period: 1000,
            format: 'delta',
            policy: 'ideal',
            minPeriod: 200,
          })),
        }),
      );
    });

    this.ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(String(buf));
        if (!msg.updates) return;
        let changed = false;
        for (const u of msg.updates) {
          for (const { path, value } of u.values || []) {
            if (this.applyPath(path, value)) changed = true;
          }
        }
        if (changed) {
          this.derive();
          this.data.updatedAt = Date.now();
          this.onChange({ ...this.data });
        }
      } catch {
        /* ignore */
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      if (this.shouldRun) {
        this.onStatus('disconnected');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      this.onStatus('error', 'WebSocket error');
    });
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  applyPath(path, value) {
    const d = this.data;
    const num = typeof value === 'number' ? value : null;
    const pos = value;

    switch (path) {
      case 'navigation.anchor.currentRadius':
        if (num != null) {
          d.distanceM = num;
          this.hasAnchorRadius = true;
          return true;
        }
        return false;
      case 'navigation.anchor.maxRadius':
        if (num != null) {
          d.maxRadiusM = num;
          return true;
        }
        return false;
      case 'navigation.anchor.position':
        if (pos?.latitude != null && pos?.longitude != null) {
          d.anchorLat = pos.latitude;
          d.anchorLon = pos.longitude;
          return true;
        }
        return false;
      case 'navigation.courseGreatCircle.nextPoint.distance':
        if (num != null && !this.hasAnchorRadius) {
          d.distanceM = num;
          return true;
        }
        return false;
      case 'navigation.courseRhumbline.nextPoint.distance':
        if (num != null && !this.hasAnchorRadius && d.distanceM == null) {
          d.distanceM = num;
          return true;
        }
        return false;
      case 'navigation.courseGreatCircle.nextPoint.bearingTrue':
        if (num != null) {
          d.bearingTrueRad = num;
          return true;
        }
        return false;
      case 'navigation.courseRhumbline.nextPoint.bearingTrue':
        if (d.bearingTrueRad == null && num != null) {
          d.bearingTrueRad = num;
          return true;
        }
        return false;
      case 'navigation.courseGreatCircle.nextPoint.bearingMagnetic':
      case 'navigation.courseRhumbline.nextPoint.bearingMagnetic':
        if (num != null) {
          d.bearingMagneticRad = num;
          return true;
        }
        return false;
      case 'environment.depth.belowTransducer':
        if (num != null) {
          d.depthM = num;
          d.depthSource = 'belowTransducer';
          return true;
        }
        return false;
      case 'environment.depth.belowKeel':
        if (num != null && d.depthSource !== 'belowTransducer') {
          d.depthM = num;
          d.depthSource = 'belowKeel';
          return true;
        }
        return false;
      case 'environment.depth.belowSurface':
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
      case 'environment.wind.speedTrue':
        if (num != null) {
          d.windSpeedMs = num;
          d.windSpeedSource = 'true';
          return true;
        }
        return false;
      case 'environment.wind.speedOverGround':
        if (num != null && d.windSpeedSource !== 'true') {
          d.windSpeedMs = num;
          d.windSpeedSource = 'overGround';
          return true;
        }
        return false;
      case 'environment.wind.speedApparent':
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
      case 'environment.wind.directionTrue':
        if (num != null) {
          d.windDirectionRad = num;
          d.windDirectionSource = 'directionTrue';
          return true;
        }
        return false;
      case 'environment.wind.directionMagnetic':
        if (num != null && d.windDirectionSource !== 'directionTrue') {
          d.windDirectionRad = num;
          d.windDirectionSource = 'directionMagnetic';
          return true;
        }
        return false;
      case 'environment.wind.angleApparent':
        if (num != null && d.windDirectionSource == null) {
          d.windDirectionRad = num;
          d.windDirectionSource = 'angleApparent';
          return true;
        }
        return false;
      case 'navigation.position':
        if (pos?.latitude != null && pos?.longitude != null) {
          d.latitude = pos.latitude;
          d.longitude = pos.longitude;
          return true;
        }
        return false;
      case 'navigation.headingTrue':
        if (num != null) {
          d.headingTrueRad = num;
          return true;
        }
        return false;
      case 'navigation.speedOverGround':
        if (num != null) {
          d.speedOverGroundMs = num;
          return true;
        }
        return false;
      case 'navigation.destination.commonName':
        if (typeof value === 'string') {
          d.waypointName = value;
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  derive() {
    const d = this.data;
    if (
      d.latitude != null &&
      d.longitude != null &&
      d.anchorLat != null &&
      d.anchorLon != null
    ) {
      d.distanceM = haversineM(d.latitude, d.longitude, d.anchorLat, d.anchorLon);
      d.bearingTrueRad = bearingBetween(
        d.latitude,
        d.longitude,
        d.anchorLat,
        d.anchorLon,
      );
    }
  }
}
