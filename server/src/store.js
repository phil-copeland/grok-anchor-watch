/**
 * In-memory boat state + rolling history.
 * Single-tenant by default (one boat). Easy to extend to multi-boat later.
 */

const MAX_HISTORY = 3000; // ~4h at 5s
const RETAIN_MS = 4.5 * 60 * 60 * 1000;
const STALE_MS = 30_000;

/** @typedef {{ t: number, distanceM: number|null, windSpeedMs: number|null, bearingTrueRad: number|null }} HistoryPoint */

export class BoatStore {
  constructor() {
    /** @type {object|null} */
    this.vessel = null;
    /** @type {HistoryPoint[]} */
    this.history = [];
    this.lastIngestAt = 0;
    this.ingestCount = 0;
  }

  /**
   * @param {object} vessel
   * @param {HistoryPoint|null} [sample]
   */
  ingest(vessel, sample = null) {
    const now = Date.now();
    this.vessel = {
      ...vessel,
      updatedAt: typeof vessel.updatedAt === 'number' ? vessel.updatedAt : now,
    };
    this.lastIngestAt = now;
    this.ingestCount += 1;

    const point =
      sample ??
      (vessel
        ? {
            t: now,
            distanceM: vessel.distanceM ?? null,
            windSpeedMs: vessel.windSpeedMs ?? null,
            bearingTrueRad: vessel.bearingTrueRad ?? null,
          }
        : null);

    if (point) {
      this.history.push(point);
      const cutoff = now - RETAIN_MS;
      this.history = this.history
        .filter((p) => p.t >= cutoff)
        .slice(-MAX_HISTORY);
    }

    return this.snapshot();
  }

  isOnline() {
    return this.lastIngestAt > 0 && Date.now() - this.lastIngestAt < STALE_MS;
  }

  /** @param {number} [rangeMinutes] */
  historyWindow(rangeMinutes = 240) {
    const cutoff = Date.now() - rangeMinutes * 60_000;
    return this.history.filter((p) => p.t >= cutoff);
  }

  clearHistory() {
    this.history = [];
  }

  /** Drop history older than maxAgeMs (default: keep only last minute) */
  pruneHistory(maxAgeMs = 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    this.history = this.history.filter((p) => p.t >= cutoff);
  }

  snapshot(rangeMinutes = 240) {
    return {
      vessel: this.vessel,
      history: this.historyWindow(rangeMinutes),
      meta: {
        lastIngestAt: this.lastIngestAt,
        online: this.isOnline(),
        ingestCount: this.ingestCount,
        historyPoints: this.history.length,
        staleAfterMs: STALE_MS,
      },
    };
  }
}
