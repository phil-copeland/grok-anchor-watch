import type { HistoryPoint, VesselData } from '../types';
import { EMPTY_VESSEL } from '../types';

export type CloudStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'stale'
  | 'error';

export interface CloudMeta {
  lastIngestAt: number;
  online: boolean;
  ingestCount: number;
  historyPoints: number;
  staleAfterMs: number;
}

export type CloudHandler = {
  onVessel: (v: VesselData) => void;
  /** replace=true for full server snapshot; false to append live samples */
  onHistory: (h: HistoryPoint[], replace: boolean) => void;
  onMeta: (m: CloudMeta, boatName?: string) => void;
  onStatus: (s: CloudStatus, message?: string) => void;
};

function watchUrl(cloudBase: string, token: string): string {
  const base = cloudBase.replace(/\/$/, '');
  // Allow host only (example.com) or full URL
  let httpBase = base;
  if (!/^https?:\/\//i.test(httpBase)) {
    httpBase = `https://${httpBase}`;
  }
  const u = new URL(httpBase);
  const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsScheme}//${u.host}/api/v1/watch?token=${encodeURIComponent(token)}`;
}

/**
 * Phone/browser client for the cloud relay.
 */
export class CloudWatchClient {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private handlers: CloudHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private cloudBase = '';
  private token = '';
  private lastMeta: CloudMeta | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: CloudHandler) {
    this.handlers = handlers;
  }

  connect(cloudBase: string, token: string) {
    this.disconnect();
    this.shouldRun = true;
    this.cloudBase = cloudBase;
    this.token = token;
    this.reconnectAttempt = 0;
    this.open();
    this.staleTimer = setInterval(() => this.checkStale(), 5000);
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.handlers.onStatus('disconnected');
  }

  private open() {
    if (!this.shouldRun) return;
    const url = watchUrl(this.cloudBase, this.token);
    this.handlers.onStatus('connecting', url);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.handlers.onStatus('error', String(err));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatus('connected', this.cloudBase);
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          vessel?: VesselData | null;
          history?: HistoryPoint[];
          meta?: CloudMeta;
          boatName?: string;
        };
        if (msg.meta) {
          this.lastMeta = msg.meta;
          this.handlers.onMeta(msg.meta, msg.boatName);
          if (!msg.meta.online && msg.meta.lastIngestAt) {
            this.handlers.onStatus('stale', 'Boat offline / no recent push');
          }
        }
        if (msg.meta?.online) {
          this.handlers.onStatus('connected', this.cloudBase);
        }

        if (msg.type === 'snapshot') {
          if (msg.vessel) this.handlers.onVessel({ ...EMPTY_VESSEL, ...msg.vessel });
          if (msg.history) this.handlers.onHistory(msg.history, true);
        } else if (msg.type === 'update' && msg.vessel) {
          const vessel = { ...EMPTY_VESSEL, ...msg.vessel };
          this.handlers.onVessel(vessel);
          this.handlers.onHistory(
            [
              {
                t: vessel.updatedAt || Date.now(),
                distanceM: vessel.distanceM,
                windSpeedMs: vessel.windSpeedMs,
                bearingTrueRad: vessel.bearingTrueRad,
                headingTrueRad: vessel.headingTrueRad,
                windDirectionRad: vessel.windDirectionRad,
              },
            ],
            false,
          );
        }
      } catch {
        /* ignore */
      }
    };

    this.ws.onerror = () => {
      this.handlers.onStatus('error', 'Cloud WebSocket error');
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.shouldRun) {
        this.handlers.onStatus('disconnected', 'Cloud connection closed');
        this.scheduleReconnect();
      }
    };
  }

  private checkStale() {
    if (!this.lastMeta?.lastIngestAt) return;
    const age = Date.now() - this.lastMeta.lastIngestAt;
    const limit = this.lastMeta.staleAfterMs || 30_000;
    if (age > limit) {
      this.handlers.onStatus('stale', `Last boat update ${Math.round(age / 1000)}s ago`);
    }
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
