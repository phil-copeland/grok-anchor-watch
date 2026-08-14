import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  PublishWorkerInMsg,
  PublishWorkerOutMsg,
} from '../cloud/publishWorker';
import type { AppSettings, VesselData } from '../types';

export type PublishStatus = 'off' | 'idle' | 'ok' | 'error' | 'missing-config';

export interface CloudPublishState {
  /** Whether publish is configured + enabled for this session */
  active: boolean;
  status: PublishStatus;
  /** Timestamp of last successful POST (ms) */
  lastSentAt: number | null;
  /** Last error message if any */
  lastError: string | null;
}

type LiveSink = (d: VesselData) => void;

function buildIngestUrl(cloudUrl: string): string {
  const base = (cloudUrl || '').replace(/\/$/, '');
  if (!base) return '';
  const withScheme = base.startsWith('http') ? base : `https://${base}`;
  return `${withScheme}/api/v1/ingest`;
}

function buildPayload(
  d: VesselData,
  s: AppSettings,
  now = Date.now(),
): string | null {
  if (!d.updatedAt) return null;
  const vessel: VesselData = {
    ...d,
    alarmRadiusM: s.alarmRadiusM,
    updatedAt: now,
    dataSourceLabel: s.dataSource === 'demo' ? 'demo' : 'browser',
  };
  const sample = {
    t: now,
    distanceM: vessel.distanceM,
    windSpeedMs: vessel.windSpeedMs,
    bearingTrueRad: vessel.bearingTrueRad,
    headingTrueRad: vessel.headingTrueRad,
    windDirectionRad: vessel.windDirectionRad,
  };
  return JSON.stringify({ vessel, sample });
}

/**
 * When running on the boat (Signal K / demo) with publish enabled + cloud URL + boat token,
 * push live telemetry including the local guard radius so phones match.
 *
 * Background-tab friendly:
 * - Publish loop runs in a Web Worker (main-thread timers are throttled when unfocused)
 * - Live vessel snapshots are fed via liveSinkRef (not only React re-renders)
 * - Screen Wake Lock while active (where supported) reduces OS/browser freezing
 * - Flush on visibility regain
 */
export function useCloudPublisher(
  settings: AppSettings,
  live: boolean,
  /** Written by this hook; useVesselData should call it on every live snapshot */
  liveSinkRef: MutableRefObject<LiveSink | null>,
): CloudPublishState {
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const workerRef = useRef<Worker | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const canPublish =
    live &&
    settings.dataSource !== 'cloud' &&
    settings.cloudPublishEnabled &&
    Boolean(settings.cloudUrl?.trim()) &&
    Boolean(settings.cloudBoatToken?.trim());

  const missingConfig =
    settings.cloudPublishEnabled &&
    settings.dataSource !== 'cloud' &&
    (!settings.cloudUrl?.trim() || !settings.cloudBoatToken?.trim());

  // Publish worker lifecycle
  useEffect(() => {
    if (!canPublish) {
      liveSinkRef.current = null;
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'stop' } satisfies PublishWorkerInMsg);
        workerRef.current.terminate();
        workerRef.current = null;
      }
      return;
    }

    const worker = new Worker(
      new URL('../cloud/publishWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<PublishWorkerOutMsg>) => {
      const msg = ev.data;
      if (!msg || msg.type !== 'result') return;
      if (msg.ok) {
        setLastSentAt(msg.at);
        setLastError(null);
      } else {
        setLastError(msg.error || 'Publish failed');
      }
    };

    worker.onerror = () => {
      setLastError('Publish worker error');
    };

    const postConfig = () => {
      const s = settingsRef.current;
      const url = buildIngestUrl(s.cloudUrl);
      const token = s.cloudBoatToken.trim();
      const intervalMs = Math.max(2000, s.historyIntervalMs || 3000);
      if (!url || !token) return;
      worker.postMessage({
        type: 'config',
        url,
        token,
        intervalMs,
      } satisfies PublishWorkerInMsg);
    };

    postConfig();

    // Feed worker from live path (Signal K / demo) — works even when React is throttled
    liveSinkRef.current = (d: VesselData) => {
      const body = buildPayload(d, settingsRef.current);
      if (!body) return;
      worker.postMessage({
        type: 'payload',
        body,
      } satisfies PublishWorkerInMsg);
    };

    // When tab becomes visible again, flush immediately
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        worker.postMessage({ type: 'flush' } satisfies PublishWorkerInMsg);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      liveSinkRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      worker.postMessage({ type: 'stop' } satisfies PublishWorkerInMsg);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [
    canPublish,
    settings.cloudUrl,
    settings.cloudBoatToken,
    settings.historyIntervalMs,
    liveSinkRef,
  ]);

  // Screen Wake Lock — reduces background throttling on boat tablets / laptops
  useEffect(() => {
    if (!canPublish) {
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
      return;
    }

    let cancelled = false;

    const requestLock = async () => {
      if (cancelled) return;
      if (!('wakeLock' in navigator)) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release();
          return;
        }
        wakeLockRef.current = lock;
        lock.addEventListener('release', () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
        });
      } catch {
        /* permission / battery / unsupported */
      }
    };

    void requestLock();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void requestLock();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, [canPublish]);

  let status: PublishStatus = 'off';
  if (settings.dataSource === 'cloud') {
    status = 'off';
  } else if (!settings.cloudPublishEnabled) {
    status = 'off';
  } else if (missingConfig) {
    status = 'missing-config';
  } else if (lastError) {
    status = 'error';
  } else if (lastSentAt) {
    status = 'ok';
  } else if (canPublish) {
    status = 'idle';
  }

  return {
    active: canPublish,
    status,
    lastSentAt: settings.cloudPublishEnabled ? lastSentAt : null,
    lastError: settings.cloudPublishEnabled ? lastError : null,
  };
}
