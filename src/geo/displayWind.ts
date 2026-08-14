/**
 * Resolve wind direction for UI / history / yaw chart.
 *
 * Prefer instrument magnetic TWD (matches chart plotter). Never mix with
 * converted-true in the same stream — that causes ~variation-sized jumps.
 */
import type { VesselData } from '../types';
import {
  formatVariation,
  getMagneticDeclinationRad,
  trueToMagneticRad,
} from './magneticVariation';
import { isPlausibleHeadingRad, normalizeHeadingRad } from '../units';

export type DisplayWindSource =
  | 'directionTrue'
  | 'directionMagnetic'
  | 'angleApparent'
  | null;

export interface ResolvedMagneticWind {
  rad: number | null;
  source: DisplayWindSource;
  convertedFromTrue: boolean;
  declinationRad: number | null;
  variationLabel: string | null;
  varSource: 'Signal K' | 'WMM' | null;
}

export function resolveDeclination(data: VesselData): {
  decl: number | null;
  varSource: 'Signal K' | 'WMM' | null;
  variationLabel: string | null;
} {
  const skVar =
    data.magneticVariationRad != null &&
    Number.isFinite(data.magneticVariationRad)
      ? data.magneticVariationRad
      : null;
  const wmmVar =
    skVar == null && data.latitude != null && data.longitude != null
      ? getMagneticDeclinationRad(data.latitude, data.longitude)
      : null;
  const decl = skVar ?? wmmVar;
  return {
    decl,
    varSource: skVar != null ? 'Signal K' : wmmVar != null ? 'WMM' : null,
    variationLabel: formatVariation(decl),
  };
}

/**
 * Pick one TWD for display:
 * 1) instrument magnetic (always if present — even if true is also stored)
 * 2) else true − variation
 * 3) else apparent
 */
export function resolveMagneticWindDirection(
  data: VesselData,
): ResolvedMagneticWind {
  const { decl, varSource, variationLabel } = resolveDeclination(data);

  const mag =
    data.windDirectionMagneticRad != null &&
    isPlausibleHeadingRad(data.windDirectionMagneticRad)
      ? normalizeHeadingRad(data.windDirectionMagneticRad)
      : data.windDirectionSource === 'directionMagnetic' &&
          data.windDirectionRad != null &&
          isPlausibleHeadingRad(data.windDirectionRad)
        ? normalizeHeadingRad(data.windDirectionRad)
        : null;

  if (mag != null) {
    return {
      rad: mag,
      source: 'directionMagnetic',
      convertedFromTrue: false,
      declinationRad: decl,
      variationLabel,
      varSource,
    };
  }

  const tru =
    data.windDirectionTrueRad != null &&
    isPlausibleHeadingRad(data.windDirectionTrueRad)
      ? normalizeHeadingRad(data.windDirectionTrueRad)
      : data.windDirectionSource === 'directionTrue' &&
          data.windDirectionRad != null &&
          isPlausibleHeadingRad(data.windDirectionRad)
        ? normalizeHeadingRad(data.windDirectionRad)
        : null;

  if (tru != null && decl != null) {
    return {
      rad: trueToMagneticRad(tru, decl),
      source: 'directionMagnetic',
      convertedFromTrue: true,
      declinationRad: decl,
      variationLabel,
      varSource,
    };
  }

  if (tru != null) {
    return {
      rad: tru,
      source: 'directionTrue',
      convertedFromTrue: false,
      declinationRad: decl,
      variationLabel,
      varSource,
    };
  }

  if (data.windDirectionSource === 'angleApparent' && data.windDirectionRad != null) {
    return {
      rad: data.windDirectionRad,
      source: 'angleApparent',
      convertedFromTrue: false,
      declinationRad: decl,
      variationLabel,
      varSource,
    };
  }

  return {
    rad: null,
    source: data.windDirectionSource,
    convertedFromTrue: false,
    declinationRad: decl,
    variationLabel,
    varSource,
  };
}
