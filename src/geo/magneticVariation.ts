/**
 * Magnetic variation (declination) via World Magnetic Model (WMM).
 * Offline — no network required.
 *
 * Convention (east-positive):
 *   True = Magnetic + Variation
 *   Magnetic = True − Variation
 */
import geomagnetism from 'geomagnetism';
import { degToRad, normalizeHeadingRad, radToDeg } from '../units';

/** Cache key: ~0.1° lat/lon + calendar day */
function cacheKey(lat: number, lon: number, day: string): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)},${day}`;
}

const declCache = new Map<string, number>();
const MAX_CACHE = 32;

/**
 * Magnetic declination / variation in radians (east-positive).
 * Returns null if lat/lon invalid or the model cannot be evaluated.
 */
export function getMagneticDeclinationRad(
  latitude: number,
  longitude: number,
  at: Date = new Date(),
): number | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const day = at.toISOString().slice(0, 10);
  const key = cacheKey(latitude, longitude, day);
  const hit = declCache.get(key);
  if (hit != null) return hit;

  try {
    const model = geomagnetism.model(at, { allowOutOfBoundsModel: true });
    const info = model.point([latitude, longitude]);
    if (!info || !Number.isFinite(info.decl)) return null;
    const declRad = degToRad(info.decl);
    if (declCache.size >= MAX_CACHE) {
      const first = declCache.keys().next().value;
      if (first != null) declCache.delete(first);
    }
    declCache.set(key, declRad);
    return declRad;
  } catch {
    return null;
  }
}

/** Magnetic = True − Variation (east-positive). */
export function trueToMagneticRad(
  trueRad: number,
  declinationRad: number,
): number {
  return normalizeHeadingRad(trueRad - declinationRad);
}

/** True = Magnetic + Variation (east-positive). */
export function magneticToTrueRad(
  magneticRad: number,
  declinationRad: number,
): number {
  return normalizeHeadingRad(magneticRad + declinationRad);
}

/** Human label e.g. "23°E" or "5°W" */
export function formatVariation(declinationRad: number | null): string | null {
  if (declinationRad == null || !Number.isFinite(declinationRad)) return null;
  const deg = radToDeg(Math.abs(declinationRad));
  const rounded =
    deg >= 10 ? Math.round(deg).toString() : deg.toFixed(1).replace(/\.0$/, '');
  if (Math.abs(declinationRad) < 1e-6) return '0°';
  return declinationRad >= 0 ? `${rounded}°E` : `${rounded}°W`;
}
