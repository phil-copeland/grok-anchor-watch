import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { CloudWatchClient } from '../cloud/client';
import { SignalKClient } from '../signalk/client';
import { AnchorSimulator } from '../signalk/simulator';
import {
  EMPTY_VESSEL,
  type AppSettings,
  type ConnectionStatus,
  type HistoryPoint,
  type VesselData,
} from '../types';

/** Coalesce high-rate Signal K / simulator deltas so React doesn't re-render every message. */
const UI_THROTTLE_MS = 1000;

/** Rolling window for wind speed smoothing (display + history samples). */
const WIND_AVG_WINDOW_MS = 2000;

interface WindSample {
  t: number;
  speedMs: number;
}

/**
 * Buffer wind speed samples and replace windSpeedMs with the mean over the last
 * ~2 s so the gauge and history don't jump on every gust sample.
 */
function averageWindSpeed(
  d: VesselData,
  buffer: WindSample[],
  now = Date.now(),
): VesselData {
  if (d.windSpeedMs == null || !Number.isFinite(d.windSpeedMs)) {
    buffer.length = 0;
    return d;
  }

  buffer.push({ t: now, speedMs: d.windSpeedMs });
  const cutoff = now - WIND_AVG_WINDOW_MS;
  let start = 0;
  while (start < buffer.length && buffer[start].t < cutoff) start += 1;
  if (start > 0) buffer.splice(0, start);

  if (buffer.length === 0) return d;

  let sum = 0;
  for (const s of buffer) sum += s.speedMs;
  return { ...d, windSpeedMs: sum / buffer.length };
}

/**
 * @param liveSinkRef optional sink for every live snapshot (used by cloud publish
 * so background tabs still get data without waiting on React re-renders).
 */
export function useVesselData(
  settings: AppSettings,
  liveSinkRef?: MutableRefObject<((d: VesselData) => void) | null>,
) {
  const [data, setData] = useState<VesselData>({ ...EMPTY_VESSEL });
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [statusMessage, setStatusMessage] = useState('');
  const [boatName, setBoatName] = useState<string | null>(null);
  /** History pushed from cloud (null when local sampling is used) */
  const [cloudHistory, setCloudHistory] = useState<HistoryPoint[] | null>(null);
  /** Server lastIngestAt for remote watch header */
  const [lastBoatIngestAt, setLastBoatIngestAt] = useState<number | null>(null);

  const clientRef = useRef<SignalKClient | null>(null);
  const simRef = useRef<AnchorSimulator | null>(null);
  const cloudRef = useRef<CloudWatchClient | null>(null);

  const pendingData = useRef<VesselData | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestData = useRef<VesselData>({ ...EMPTY_VESSEL });
  const windBuffer = useRef<WindSample[]>([]);
  const liveSinkRefStable = useRef(liveSinkRef);
  liveSinkRefStable.current = liveSinkRef;

  const flushData = useCallback(() => {
    throttleTimer.current = null;
    if (pendingData.current) {
      const next = pendingData.current;
      pendingData.current = null;
      latestData.current = next;
      setData(next);
    }
  }, []);

  /** Immediate for first paint / disconnect; throttled thereafter. */
  const pushData = useCallback(
    (d: VesselData, immediate = false) => {
      const smoothed = averageWindSpeed(d, windBuffer.current);

      latestData.current = smoothed;
      // Always notify live consumers (cloud publish worker) — not throttled
      try {
        liveSinkRefStable.current?.current?.(smoothed);
      } catch {
        /* sink errors must not break the instrument path */
      }

      if (immediate) {
        pendingData.current = null;
        if (throttleTimer.current) {
          clearTimeout(throttleTimer.current);
          throttleTimer.current = null;
        }
        setData(smoothed);
        return;
      }
      pendingData.current = smoothed;
      if (throttleTimer.current == null) {
        throttleTimer.current = setTimeout(flushData, UI_THROTTLE_MS);
      }
    },
    [flushData],
  );

  const stopAll = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    simRef.current?.stop();
    simRef.current = null;
    cloudRef.current?.disconnect();
    cloudRef.current = null;
    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
      throttleTimer.current = null;
    }
    pendingData.current = null;
    windBuffer.current = [];
  }, []);

  const onCloudHistory = useCallback((h: HistoryPoint[], replace: boolean) => {
    setCloudHistory((prev) => {
      if (replace || prev == null) {
        // Cap hard: keep only last 4.5h worth at ~5s, max 3000
        return h.length > 3000 ? h.slice(-3000) : h;
      }
      const next = [...prev, ...h];
      const cutoff = Date.now() - 4.5 * 60 * 60 * 1000;
      // Prefer time prune then length cap without scanning twice when small
      let start = 0;
      while (start < next.length && next[start].t < cutoff) start += 1;
      const trimmed = start > 0 ? next.slice(start) : next;
      return trimmed.length > 3000 ? trimmed.slice(-3000) : trimmed;
    });
  }, []);

  useEffect(() => {
    stopAll();
    setCloudHistory(null);
    setBoatName(null);
    setLastBoatIngestAt(null);
    pushData({ ...EMPTY_VESSEL }, true);

    if (settings.dataSource === 'demo') {
      setStatus('demo');
      setStatusMessage('Local simulator');
      const sim = new AnchorSimulator((d) => pushData(d));
      simRef.current = sim;
      sim.start();
      return () => {
        sim.stop();
        simRef.current = null;
      };
    }

    if (settings.dataSource === 'cloud') {
      const base = settings.cloudUrl || window.location.origin;
      const token = settings.cloudViewToken;
      if (!token) {
        setStatus('error');
        setStatusMessage('Missing cloud view token');
        return;
      }
      const cloud = new CloudWatchClient({
        onVessel: (v) => pushData(v),
        onHistory: onCloudHistory,
        onMeta: (m, name) => {
          if (name) setBoatName(name);
          if (m?.lastIngestAt) setLastBoatIngestAt(m.lastIngestAt);
        },
        onStatus: (s, msg) => {
          if (s === 'connected') setStatus('cloud');
          else if (s === 'stale') setStatus('stale');
          else if (s === 'connecting') setStatus('connecting');
          else if (s === 'error') setStatus('error');
          else setStatus('disconnected');
          if (msg) setStatusMessage(msg);
        },
      });
      cloudRef.current = cloud;
      cloud.connect(base, token);
      return () => {
        cloud.disconnect();
        cloudRef.current = null;
      };
    }

    // Signal K
    const client = new SignalKClient(
      (d) => pushData(d),
      (s, msg) => {
        setStatus(s);
        if (msg) setStatusMessage(msg);
      },
    );
    clientRef.current = client;
    client.connect(settings.serverUrl, settings.useTls);

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [
    settings.dataSource,
    settings.serverUrl,
    settings.useTls,
    settings.cloudUrl,
    settings.cloudViewToken,
    stopAll,
    pushData,
    onCloudHistory,
  ]);

  const reconnect = useCallback(() => {
    stopAll();
    pushData({ ...EMPTY_VESSEL }, true);

    if (settings.dataSource === 'demo') return;

    if (settings.dataSource === 'cloud') {
      const base = settings.cloudUrl || window.location.origin;
      const cloud = new CloudWatchClient({
        onVessel: (v) => pushData(v),
        onHistory: onCloudHistory,
        onMeta: (m, name) => {
          if (name) setBoatName(name);
          if (m?.lastIngestAt) setLastBoatIngestAt(m.lastIngestAt);
        },
        onStatus: (s, msg) => {
          if (s === 'connected') setStatus('cloud');
          else if (s === 'stale') setStatus('stale');
          else if (s === 'connecting') setStatus('connecting');
          else if (s === 'error') setStatus('error');
          else setStatus('disconnected');
          if (msg) setStatusMessage(msg);
        },
      });
      cloudRef.current = cloud;
      cloud.connect(base, settings.cloudViewToken);
      return;
    }

    const client = new SignalKClient(
      (d) => pushData(d),
      (s, msg) => {
        setStatus(s);
        if (msg) setStatusMessage(msg);
      },
    );
    clientRef.current = client;
    client.connect(settings.serverUrl, settings.useTls);
  }, [settings, stopAll, pushData, onCloudHistory]);

  // Flush any pending sample on unmount
  useEffect(() => {
    return () => {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
    };
  }, []);

  return {
    data,
    status,
    statusMessage,
    boatName,
    cloudHistory,
    lastBoatIngestAt,
    reconnect,
  };
}
