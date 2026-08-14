/** Same swing simulation as the UI demo — for testing cloud without Signal K. */

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

export class DemoSimulator {
  constructor(onTick) {
    this.onTick = onTick;
    this.timer = null;
    this.t0 = Date.now();
    this.anchorLat = 5.45;
    this.anchorLon = 100.2;
    this.rodeM = 28;
    this.maxRadiusM = 45;
  }

  start() {
    this.stop();
    this.t0 = Date.now();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const elapsed = (Date.now() - this.t0) / 1000;
    const swing = Math.sin(elapsed / 45) * 0.7 + Math.sin(elapsed / 17) * 0.3;
    const radius =
      this.rodeM * (0.55 + 0.35 * Math.abs(Math.sin(elapsed / 30))) +
      (Math.sin(elapsed / 90) > 0.95 ? 12 : 0);
    const bearingFromAnchor = swing * Math.PI + elapsed / 200;
    const dLat = (radius / 111320) * Math.cos(bearingFromAnchor);
    const dLon =
      (radius / (111320 * Math.cos(degToRad(this.anchorLat)))) *
      Math.sin(bearingFromAnchor);
    const lat = this.anchorLat + dLat;
    const lon = this.anchorLon + dLon;
    const windBase = 8 + 4 * Math.sin(elapsed / 60);
    const gust = Math.sin(elapsed / 11) > 0.85 ? 5 : 0;
    const windSpeedMs = Math.max(0.5, windBase + gust + Math.sin(elapsed / 7));
    const windDir = degToRad(
      (120 + elapsed * 0.8 + Math.sin(elapsed / 40) * 25) % 360,
    );
    const depthM = 6.5 + Math.sin(elapsed / 50) * 0.4 + Math.sin(elapsed / 8) * 0.1;
    const distanceM = haversineM(lat, lon, this.anchorLat, this.anchorLon);
    const bearingTrueRad = bearingBetween(
      lat,
      lon,
      this.anchorLat,
      this.anchorLon,
    );

    this.onTick({
      distanceM,
      bearingTrueRad,
      bearingMagneticRad: bearingTrueRad - degToRad(0.5),
      depthM,
      depthSource: 'belowTransducer',
      windSpeedMs,
      windSpeedSource: 'true',
      windDirectionRad: windDir,
      windDirectionSource: 'directionMagnetic',
      latitude: lat,
      longitude: lon,
      headingTrueRad: (() => {
        const raw =
          bearingFromAnchor + Math.PI + Math.sin(elapsed / 20) * 0.1;
        const twoPi = Math.PI * 2;
        let h = raw % twoPi;
        if (h < 0) h += twoPi;
        return h;
      })(),
      magneticVariationRad: (23 * Math.PI) / 180,
      speedOverGroundMs: 0.15 + Math.abs(Math.sin(elapsed / 25)) * 0.3,
      maxRadiusM: this.maxRadiusM,
      alarmRadiusM: this.maxRadiusM,
      anchorLat: this.anchorLat,
      anchorLon: this.anchorLon,
      waypointName: 'Anchor (demo boat)',
      updatedAt: Date.now(),
    });
  }
}
