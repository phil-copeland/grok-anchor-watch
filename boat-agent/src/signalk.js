import WebSocket from 'ws';

const PATHS = [
  'navigation.anchor.currentRadius',
  'navigation.anchor.maxRadius',
  'navigation.anchor.position',
  'navigation.courseGreatCircle.nextPoint.distance',
  'navigation.courseGreatCircle.nextPoint.bearingTrue',
  'navigation.courseGreatCircle.nextPoint.bearingMagnetic',
  'navigation.courseGreatCircle.nextPoint.position',
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
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.speedOverGround',
  'navigation.destination.commonName',
];

const TWO_PI = Math.PI * 2;

/** Normalize heading to [0, 2π). */
function normalizeHeadingRad(rad) {
  if (!Number.isFinite(rad)) return rad;
  let x = rad % TWO_PI;
  if (x < 0) x += TWO_PI;
  if (x < 0) x = 0;
  if (x >= TWO_PI) x = 0;
  return x;
}

function isPlausibleHeadingRad(rad) {
  return Number.isFinite(rad) && Math.abs(rad) <= TWO_PI * 1.5;
}

function sourceMatchesLock(id, locked) {
  if (!id || !locked) return false;
  const a = String(id).toLowerCase();
  const b = String(locked).toLowerCase();
  return a.includes(b) || b.includes(a);
}

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
    windDirectionMagneticRad: null,
    windDirectionTrueRad: null,
    latitude: null,
    longitude: null,
    headingTrueRad: null,
    magneticVariationRad: null,
    headingSource: null,
    headingDevice: null,
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

function sourceIdentity(update) {
  const parts = [];
  if (typeof update?.$source === 'string' && update.$source.trim()) {
    parts.push(update.$source.trim());
  }
  const src = update?.source;
  if (typeof src === 'string') {
    parts.push(src);
  } else if (src && typeof src === 'object') {
    for (const key of [
      'label',
      'src',
      'pgn',
      'type',
      'sentence',
      'talker',
      'manufacturerCode',
      'manufacturerName',
      'modelId',
      'model',
      'productCode',
      'uniqueNumber',
      'deviceInstance',
    ]) {
      const v = src[key];
      if (v != null && String(v).trim()) parts.push(String(v).trim());
    }
  }
  return parts.join(' ');
}

function sourceMatchesFilter(identity, filter) {
  const f = (filter || '').trim().toLowerCase();
  if (!f) return true;
  if (!identity) return false;
  return identity.toLowerCase().includes(f);
}

/** Collect product/model names from /sources tree keyed by path segments. */
function buildSourceNameMap(node, path = [], out = new Map()) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  const tags = [];
  const walk = (n, d) => {
    if (d > 5 || n == null) return;
    if (typeof n === 'string' || typeof n === 'number') {
      tags.push(String(n));
      return;
    }
    if (typeof n !== 'object' || Array.isArray(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'timestamp' || k === 'pgns') continue;
      walk(v, d + 1);
    }
  };
  walk(node, 0);
  if (tags.length && path.length) {
    const label = [...new Set(tags)].join(' ');
    out.set(path.join('.'), label);
    out.set(path[path.length - 1], label);
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      buildSourceNameMap(v, [...path, k], out);
    }
  }
  return out;
}

function resolveIdentity(update, sourceNames) {
  const base = sourceIdentity(update);
  const dollar =
    typeof update?.$source === 'string' ? update.$source.trim() : '';
  const extras = [];
  if (dollar && sourceNames?.size) {
    for (const [key, name] of sourceNames) {
      if (
        key === dollar ||
        dollar.endsWith(`.${key}`) ||
        key.endsWith(`.${dollar}`) ||
        dollar.includes(key)
      ) {
        extras.push(name);
      }
    }
  }
  return [base, ...extras].filter(Boolean).join(' ');
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
   * @param {{ headingMagneticSourceFilter?: string }} [options]
   */
  constructor(host, useTls, onChange, onStatus, options = {}) {
    this.host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.useTls = useTls;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.ws = null;
    this.shouldRun = false;
    this.data = emptyVessel();
    this.hasAnchorRadius = false;
    this.hasSkDistance = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    // Empty = any source; set HEADING_SOURCE_FILTER=Precision-9 to lock Navico
    this.headingSourceFilter =
      options.headingMagneticSourceFilter ??
      process.env.HEADING_SOURCE_FILTER ??
      '';
    /** @type {Map<string,string>} */
    this.sourceNames = new Map();
    this.pollTimer = null;
    this.lockedHeadingSource = null;
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
      void this.bootstrapHeading();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        void this.pollHeadingFromApi();
      }, 3000);
    });

    this.ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(String(buf));
        if (!msg.updates) return;
        let changed = false;
        for (const u of msg.updates) {
          const identity = resolveIdentity(u, this.sourceNames);
          for (const { path, value } of u.values || []) {
            if (this.applyPath(path, value, identity)) changed = true;
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
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
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

  httpBase() {
    const scheme = this.useTls ? 'https' : 'http';
    return `${scheme}://${this.host}`;
  }

  async bootstrapHeading() {
    await this.fetchSourceNames();
    await this.pollHeadingFromApi();
  }

  async fetchSourceNames() {
    try {
      const res = await fetch(`${this.httpBase()}/signalk/v1/api/sources`);
      if (!res.ok) return;
      const json = await res.json();
      this.sourceNames = buildSourceNameMap(json);
    } catch {
      /* ignore */
    }
  }

  /**
   * Full-model headingMagnetic includes values{} per device — pick filter match.
   */
  async pollHeadingFromApi() {
    if (!this.shouldRun) return;
    try {
      if (this.sourceNames.size === 0) await this.fetchSourceNames();
      const res = await fetch(
        `${this.httpBase()}/signalk/v1/api/vessels/self/navigation/headingMagnetic`,
      );
      if (!res.ok) return;
      const json = await res.json();
      const filter = (this.headingSourceFilter || '').trim().toLowerCase();
      const values = json?.values;
      if (values && typeof values === 'object') {
        for (const [key, entry] of Object.entries(values)) {
          if (typeof entry?.value !== 'number') continue;
          const identity = resolveIdentity({ $source: key }, this.sourceNames);
          const combined = [key, identity].filter(Boolean).join(' ');
          if (
            isPlausibleHeadingRad(entry.value) &&
            (!filter || combined.toLowerCase().includes(filter))
          ) {
            this.lockedHeadingSource = combined || key;
            this.data.headingTrueRad = normalizeHeadingRad(entry.value);
            this.data.headingSource = 'magnetic';
            this.data.headingDevice = combined || key;
            this.derive();
            this.data.updatedAt = Date.now();
            this.onChange({ ...this.data });
            return;
          }
        }
      }
      if (typeof json?.value === 'number' && isPlausibleHeadingRad(json.value)) {
        const dollar = json.$source || '';
        const identity = resolveIdentity(
          { $source: dollar },
          this.sourceNames,
        );
        const combined = [dollar, identity].filter(Boolean).join(' ');
        if (!filter || combined.toLowerCase().includes(filter)) {
          if (combined) this.lockedHeadingSource = combined;
          this.data.headingTrueRad = normalizeHeadingRad(json.value);
          this.data.headingSource = 'magnetic';
          this.data.headingDevice = combined || 'api';
          this.derive();
          this.data.updatedAt = Date.now();
          this.onChange({ ...this.data });
        }
      }
    } catch {
      /* ignore */
    }
  }

  applyPath(path, value, sourceId = '') {
    const d = this.data;
    const num = typeof value === 'number' ? value : null;
    const pos = value;

    switch (path) {
      case 'navigation.anchor.currentRadius':
        if (num != null && Number.isFinite(num) && num >= 0) {
          d.distanceM = num;
          this.hasAnchorRadius = true;
          this.hasSkDistance = true;
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
      case 'navigation.courseGreatCircle.nextPoint.position':
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
      case 'navigation.courseGreatCircle.nextPoint.distance':
        if (num != null && Number.isFinite(num) && num >= 0) {
          d.distanceM = num;
          this.hasSkDistance = true;
          return true;
        }
        return false;
      case 'navigation.courseRhumbline.nextPoint.distance':
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
      case 'environment.wind.directionMagnetic':
        if (num != null && isPlausibleHeadingRad(num)) {
          const mag = normalizeHeadingRad(num);
          d.windDirectionMagneticRad = mag;
          d.windDirectionRad = mag;
          d.windDirectionSource = 'directionMagnetic';
          return true;
        }
        return false;
      case 'environment.wind.directionTrue':
        if (num != null && isPlausibleHeadingRad(num)) {
          const tru = normalizeHeadingRad(num);
          d.windDirectionTrueRad = tru;
          if (d.windDirectionSource !== 'directionMagnetic') {
            d.windDirectionRad = tru;
            d.windDirectionSource = 'directionTrue';
          }
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
      case 'navigation.magneticVariation':
        // East-positive radians (Signal K / NMEA)
        if (num != null && Number.isFinite(num) && Math.abs(num) < Math.PI) {
          d.magneticVariationRad = num;
          return true;
        }
        return false;
      case 'navigation.headingTrue':
        // Prefer magnetic only — matches boat compass display; avoids true/mag jumps
        return false;
      case 'navigation.headingMagnetic':
        if (num == null || !isPlausibleHeadingRad(num)) return false;
        if (this.lockedHeadingSource) {
          if (!sourceMatchesLock(sourceId, this.lockedHeadingSource)) {
            if (
              this.headingSourceFilter &&
              sourceMatchesFilter(sourceId, this.headingSourceFilter)
            ) {
              this.lockedHeadingSource = sourceId || this.headingSourceFilter;
            } else {
              return false;
            }
          }
        } else if (this.headingSourceFilter) {
          if (!sourceMatchesFilter(sourceId, this.headingSourceFilter)) {
            return false;
          }
          this.lockedHeadingSource = sourceId || this.headingSourceFilter;
        } else if (sourceId) {
          this.lockedHeadingSource = sourceId;
        }
        d.headingTrueRad = normalizeHeadingRad(num);
        d.headingSource = 'magnetic';
        d.headingDevice = sourceId || this.lockedHeadingSource || null;
        return true;
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
    if (!this.hasSkDistance || d.distanceM == null) {
      d.distanceM = dist;
    }
    if (d.bearingTrueRad == null) {
      d.bearingTrueRad = brg;
    }
  }
}
