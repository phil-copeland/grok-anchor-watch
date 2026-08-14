/** SI unit conversions for marine displays */

export function msToKnots(ms: number): number {
  return ms * 1.943844;
}

export function knotsToMs(kn: number): number {
  return kn / 1.943844;
}

export function msToKmh(ms: number): number {
  return ms * 3.6;
}

export function kmhToMs(kmh: number): number {
  return kmh / 3.6;
}

export function msToMph(ms: number): number {
  return ms * 2.236936;
}

export function mphToMs(mph: number): number {
  return mph / 2.236936;
}

export function mToFt(m: number): number {
  return m * 3.28084;
}

export function ftToM(ft: number): number {
  return ft / 3.28084;
}

export function mToNm(m: number): number {
  return m / 1852;
}

export function nmToM(nm: number): number {
  return nm * 1852;
}

export type WindUnit = 'kn' | 'm/s' | 'km/h' | 'mph';
export type DistanceUnit = 'm' | 'ft' | 'nm';

/** Convert display wind value → m/s */
export function windToMs(value: number, unit: WindUnit): number {
  switch (unit) {
    case 'm/s':
      return value;
    case 'km/h':
      return kmhToMs(value);
    case 'mph':
      return mphToMs(value);
    default:
      return knotsToMs(value);
  }
}

/** Convert m/s → display wind value */
export function msToWind(ms: number, unit: WindUnit): number {
  switch (unit) {
    case 'm/s':
      return ms;
    case 'km/h':
      return msToKmh(ms);
    case 'mph':
      return msToMph(ms);
    default:
      return msToKnots(ms);
  }
}

/** Convert display distance value → metres */
export function distanceToM(value: number, unit: DistanceUnit): number {
  switch (unit) {
    case 'ft':
      return ftToM(value);
    case 'nm':
      return nmToM(value);
    default:
      return value;
  }
}

/** Convert metres → display distance value */
export function mToDistance(m: number, unit: DistanceUnit): number {
  switch (unit) {
    case 'ft':
      return mToFt(m);
    case 'nm':
      return mToNm(m);
    default:
      return m;
  }
}

export function radToDeg(rad: number): number {
  return ((rad * 180) / Math.PI + 360) % 360;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

const TWO_PI = 2 * Math.PI;

/** Normalize heading/bearing to [0, 2π). */
export function normalizeHeadingRad(rad: number): number {
  if (!Number.isFinite(rad)) return rad;
  let x = rad % TWO_PI;
  if (x < 0) x += TWO_PI;
  // Guard tiny float negatives after %
  if (x < 0) x = 0;
  if (x >= TWO_PI) x = 0;
  return x;
}

/**
 * Shortest signed turn from `from` → `to` in radians, (−π, π].
 * Handles 0°/360° wrap so small real turns never look like 350° jumps.
 */
export function headingDeltaRad(from: number, to: number): number {
  let d = normalizeHeadingRad(to) - normalizeHeadingRad(from);
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/** True if value looks like a Signal K heading/bearing in radians (not degrees). */
export function isPlausibleHeadingRad(rad: number): boolean {
  if (!Number.isFinite(rad)) return false;
  // Allow a little over-range before normalize (some stacks send ±π)
  return Math.abs(rad) <= TWO_PI * 1.5;
}

export function formatDistance(
  metres: number | null,
  unit: 'm' | 'ft' | 'nm',
  digits = 1,
): string {
  if (metres == null || Number.isNaN(metres)) return '—';
  switch (unit) {
    case 'ft':
      return `${mToFt(metres).toFixed(digits)} ft`;
    case 'nm':
      return `${mToNm(metres).toFixed(Math.max(digits, 2))} nm`;
    default:
      return `${metres.toFixed(digits)} m`;
  }
}

export function formatDepth(
  metres: number | null,
  unit: 'm' | 'ft',
  digits = 1,
): string {
  if (metres == null || Number.isNaN(metres)) return '—';
  if (unit === 'ft') return `${mToFt(metres).toFixed(digits)} ft`;
  return `${metres.toFixed(digits)} m`;
}

export function formatWind(
  ms: number | null,
  unit: 'kn' | 'm/s' | 'km/h' | 'mph',
  digits = 1,
): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  switch (unit) {
    case 'm/s':
      return `${ms.toFixed(digits)} m/s`;
    case 'km/h':
      return `${msToKmh(ms).toFixed(digits)} km/h`;
    case 'mph':
      return `${msToMph(ms).toFixed(digits)} mph`;
    default:
      return `${msToKnots(ms).toFixed(digits)} kn`;
  }
}

export function formatBearing(rad: number | null): string {
  if (rad == null || Number.isNaN(rad)) return '—';
  const deg = Math.round(radToDeg(rad));
  return `${deg.toString().padStart(3, '0')}°`;
}

export function formatLatLon(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns}  ${Math.abs(lon).toFixed(5)}°${ew}`;
}

/** Great-circle distance (metres) between two WGS84 points */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
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

/** Initial bearing (true, radians) from point 1 to point 2 */
export function bearingBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const Δλ = degToRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

export function cardinalFromRad(rad: number | null): string {
  if (rad == null) return '—';
  const deg = radToDeg(rad);
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  const i = Math.round(deg / 22.5) % 16;
  return dirs[i];
}
