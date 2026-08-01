/**
 * Signal K paths used by Anchor Watch.
 * Values are SI units per the Signal K schema.
 *
 * Distance / bearing to anchor may come from:
 *  - navigation.anchor.* (native anchor watch)
 *  - navigation.courseGreatCircle.nextPoint.* (active waypoint = anchor)
 *  - computed from navigation.position + navigation.anchor.position
 */
export const SIGNALK_PATHS = {
  // Anchor-specific
  anchorCurrentRadius: 'navigation.anchor.currentRadius',
  anchorMaxRadius: 'navigation.anchor.maxRadius',
  anchorPosition: 'navigation.anchor.position',

  // Active waypoint (anchor as waypoint) — great circle
  gcNextDistance: 'navigation.courseGreatCircle.nextPoint.distance',
  gcNextBearingTrue: 'navigation.courseGreatCircle.nextPoint.bearingTrue',
  gcNextBearingMagnetic:
    'navigation.courseGreatCircle.nextPoint.bearingMagnetic',
  gcNextPosition: 'navigation.courseGreatCircle.nextPoint.position',

  // Rhumbline fallback
  rhNextDistance: 'navigation.courseRhumbline.nextPoint.distance',
  rhNextBearingTrue: 'navigation.courseRhumbline.nextPoint.bearingTrue',
  rhNextBearingMagnetic:
    'navigation.courseRhumbline.nextPoint.bearingMagnetic',

  // Depth
  depthBelowTransducer: 'environment.depth.belowTransducer',
  depthBelowKeel: 'environment.depth.belowKeel',
  depthBelowSurface: 'environment.depth.belowSurface',

  // Wind
  windSpeedTrue: 'environment.wind.speedTrue',
  windSpeedApparent: 'environment.wind.speedApparent',
  windSpeedOverGround: 'environment.wind.speedOverGround',
  windDirectionTrue: 'environment.wind.directionTrue',
  windDirectionMagnetic: 'environment.wind.directionMagnetic',
  windAngleApparent: 'environment.wind.angleApparent',

  // Vessel
  position: 'navigation.position',
  headingTrue: 'navigation.headingTrue',
  headingMagnetic: 'navigation.headingMagnetic',
  speedOverGround: 'navigation.speedOverGround',
  destinationName: 'navigation.destination.commonName',
} as const;

export type SignalkPath = (typeof SIGNALK_PATHS)[keyof typeof SIGNALK_PATHS];

/** Paths to subscribe over the WebSocket stream */
export const SUBSCRIBE_PATHS: string[] = [
  SIGNALK_PATHS.anchorCurrentRadius,
  SIGNALK_PATHS.anchorMaxRadius,
  SIGNALK_PATHS.anchorPosition,
  SIGNALK_PATHS.gcNextDistance,
  SIGNALK_PATHS.gcNextBearingTrue,
  SIGNALK_PATHS.gcNextBearingMagnetic,
  SIGNALK_PATHS.gcNextPosition,
  SIGNALK_PATHS.rhNextDistance,
  SIGNALK_PATHS.rhNextBearingTrue,
  SIGNALK_PATHS.rhNextBearingMagnetic,
  SIGNALK_PATHS.depthBelowTransducer,
  SIGNALK_PATHS.depthBelowKeel,
  SIGNALK_PATHS.depthBelowSurface,
  SIGNALK_PATHS.windSpeedTrue,
  SIGNALK_PATHS.windSpeedApparent,
  SIGNALK_PATHS.windSpeedOverGround,
  SIGNALK_PATHS.windDirectionTrue,
  SIGNALK_PATHS.windDirectionMagnetic,
  SIGNALK_PATHS.windAngleApparent,
  SIGNALK_PATHS.position,
  SIGNALK_PATHS.headingTrue,
  SIGNALK_PATHS.headingMagnetic,
  SIGNALK_PATHS.speedOverGround,
  SIGNALK_PATHS.destinationName,
];

export interface SignalkDelta {
  context?: string;
  updates?: Array<{
    source?: unknown;
    timestamp?: string;
    values?: Array<{ path: string; value: unknown }>;
    meta?: Array<{ path: string; value: unknown }>;
  }>;
}

export function buildStreamUrl(serverUrl: string, useTls: boolean): string {
  const host = serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const scheme = useTls ? 'wss' : 'ws';
  return `${scheme}://${host}/signalk/v1/stream?subscribe=none`;
}

export function buildSubscribeMessage() {
  return {
    context: 'vessels.self',
    subscribe: SUBSCRIBE_PATHS.map((path) => ({
      path,
      period: 1000,
      format: 'delta' as const,
      policy: 'ideal' as const,
      minPeriod: 200,
    })),
  };
}
