import { useMemo } from 'react';
import {
  resolveDeclination,
  resolveMagneticWindDirection,
  type DisplayWindSource,
} from '../geo/displayWind';
import { trueToMagneticRad } from '../geo/magneticVariation';
import type { VesselData } from '../types';

export type { DisplayWindSource };

export interface MagneticDisplay {
  /** WMM / SK declination, east-positive radians */
  declinationRad: number | null;
  /** e.g. "23°E" */
  variationLabel: string | null;
  /** Wind direction for UI — magnetic when possible */
  windDirectionRad: number | null;
  windDirectionSource: DisplayWindSource;
  /** True when TWD was converted from true using variation */
  windConvertedFromTrue: boolean;
  /** Bearing for UI — magnetic when possible */
  bearingRad: number | null;
  /** True when bearing was converted from true using WMM/SK */
  bearingConvertedFromTrue: boolean;
  bearingRefLabel: string;
  windRefLabel: string | null;
}

/**
 * Prefer instrument magnetic wind (matches plotter). Convert true → magnetic
 * only when magnetic is not published, using SK variation or WMM.
 */
export function useMagneticDisplay(data: VesselData): MagneticDisplay {
  return useMemo(() => {
    const wind = resolveMagneticWindDirection(data);
    const { decl, varSource, variationLabel } = resolveDeclination(data);

    let windRefLabel: string | null = null;
    if (wind.source === 'angleApparent') {
      windRefLabel = 'Apparent angle (relative to bow)';
    } else if (wind.convertedFromTrue) {
      windRefLabel = variationLabel
        ? `Magnetic · from true (− ${variationLabel}${varSource ? ` ${varSource}` : ''})`
        : 'Magnetic · from true';
    } else if (wind.source === 'directionMagnetic') {
      windRefLabel = 'Magnetic · instrument';
    } else if (wind.source === 'directionTrue') {
      windRefLabel = 'True (no variation available)';
    } else if (data.windSpeedSource === 'true') {
      windRefLabel = 'True wind speed';
    } else if (data.windSpeedSource === 'apparent') {
      windRefLabel = 'Apparent wind';
    } else if (data.windSpeedSource === 'overGround') {
      windRefLabel = 'Wind over ground';
    }

    // —— Bearing ——
    let bearingRad = data.bearingMagneticRad ?? data.bearingTrueRad;
    let bearingConvertedFromTrue = false;
    if (
      data.bearingMagneticRad == null &&
      data.bearingTrueRad != null &&
      decl != null
    ) {
      bearingRad = trueToMagneticRad(data.bearingTrueRad, decl);
      bearingConvertedFromTrue = true;
    }

    let bearingRefLabel = '—';
    if (data.bearingMagneticRad != null) {
      bearingRefLabel = 'Magnetic';
    } else if (bearingConvertedFromTrue) {
      bearingRefLabel = variationLabel
        ? `Magnetic · from true (− ${variationLabel}${varSource ? ` ${varSource}` : ''})`
        : 'Magnetic · from true';
    } else if (data.bearingTrueRad != null) {
      bearingRefLabel = 'True (no variation available)';
    }

    return {
      declinationRad: wind.declinationRad,
      variationLabel: wind.variationLabel,
      windDirectionRad: wind.rad,
      windDirectionSource: wind.source,
      windConvertedFromTrue: wind.convertedFromTrue,
      bearingRad,
      bearingConvertedFromTrue,
      bearingRefLabel,
      windRefLabel,
    };
  }, [data]);
}
