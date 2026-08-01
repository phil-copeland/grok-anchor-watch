import type { VesselData } from '../types';
import { EMPTY_VESSEL } from '../types';
import { bearingBetween, degToRad, haversineM } from '../units';

/**
 * Local demo simulator: boat swings on a rode around a fixed anchor,
 * with varying wind and depth — useful without a Signal K server.
 */
export class AnchorSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = Date.now();
  private onTick: (data: VesselData) => void;

  // Anchor position (demo: near a typical anchorage)
  private anchorLat = 5.45;
  private anchorLon = 100.2;
  private rodeM = 28;
  private maxRadiusM = 45;

  constructor(onTick: (data: VesselData) => void) {
    this.onTick = onTick;
  }

  start() {
    this.stop();
    this.t0 = Date.now();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    const elapsed = (Date.now() - this.t0) / 1000;

    // Swing period ~6 min; occasional larger yaw for "gust" drift
    const swing = Math.sin(elapsed / 45) * 0.7 + Math.sin(elapsed / 17) * 0.3;
    const radius =
      this.rodeM * (0.55 + 0.35 * Math.abs(Math.sin(elapsed / 30))) +
      (Math.sin(elapsed / 90) > 0.95 ? 12 : 0); // brief stretch past alarm

    const bearingFromAnchor = swing * Math.PI + elapsed / 200;
    const dLat = (radius / 111320) * Math.cos(bearingFromAnchor);
    const dLon =
      (radius / (111320 * Math.cos(degToRad(this.anchorLat)))) *
      Math.sin(bearingFromAnchor);

    const lat = this.anchorLat + dLat;
    const lon = this.anchorLon + dLon;

    const windBase = 8 + 4 * Math.sin(elapsed / 60); // m/s
    const gust = Math.sin(elapsed / 11) > 0.85 ? 5 : 0;
    const windSpeedMs = Math.max(0.5, windBase + gust + Math.sin(elapsed / 7));
    const windDir = degToRad((120 + elapsed * 0.8 + Math.sin(elapsed / 40) * 25) % 360);

    const depthM = 6.5 + Math.sin(elapsed / 50) * 0.4 + Math.sin(elapsed / 8) * 0.1;

    const distanceM = haversineM(lat, lon, this.anchorLat, this.anchorLon);
    const bearingTrueRad = bearingBetween(
      lat,
      lon,
      this.anchorLat,
      this.anchorLon,
    );

    const data: VesselData = {
      ...EMPTY_VESSEL,
      distanceM,
      bearingTrueRad,
      bearingMagneticRad: bearingTrueRad - degToRad(0.5),
      depthM,
      depthSource: 'belowTransducer',
      windSpeedMs,
      windSpeedSource: 'true',
      windDirectionRad: windDir,
      windDirectionSource: 'directionTrue',
      latitude: lat,
      longitude: lon,
      headingTrueRad: bearingFromAnchor + Math.PI + Math.sin(elapsed / 20) * 0.1,
      speedOverGroundMs: 0.15 + Math.abs(Math.sin(elapsed / 25)) * 0.3,
      maxRadiusM: this.maxRadiusM,
      alarmRadiusM: this.maxRadiusM,
      anchorLat: this.anchorLat,
      anchorLon: this.anchorLon,
      waypointName: 'Anchor (demo)',
      updatedAt: Date.now(),
    };

    this.onTick(data);
  }
}
