import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../types';
import type { CloudPublishState } from '../hooks/useCloudPublisher';

interface Props {
  status: ConnectionStatus;
  message: string;
  dataSource: 'signalk' | 'demo' | 'cloud';
  boatName?: string | null;
  publish?: CloudPublishState;
  /** Cloud watch: last boat ingest time from server meta (ms) */
  lastBoatIngestAt?: number | null;
  onOpenSettings: () => void;
  onReconnect: () => void;
}

const LABELS: Record<ConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Signal K',
  error: 'Error',
  demo: 'Demo mode',
  cloud: 'Cloud live',
  stale: 'Boat stale',
};

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAge(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function ConnectionBar({
  status,
  message,
  dataSource,
  boatName,
  publish,
  lastBoatIngestAt,
  onOpenSettings,
  onReconnect,
}: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const subtitle =
    dataSource === 'cloud'
      ? boatName
        ? `Remote · ${boatName}`
        : 'Remote cloud watch'
      : dataSource === 'demo'
        ? 'Local simulator'
        : 'Signal K · NMEA instruments';

  const showReconnect =
    dataSource !== 'demo' &&
    status !== 'connected' &&
    status !== 'cloud';

  const showPublish = dataSource !== 'cloud' && publish != null;
  const showBoatAge = dataSource === 'cloud';

  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-icon" aria-hidden>
          ⚓
        </span>
        <div>
          <h1>Anchor Watch</h1>
          <p className="brand-sub">{subtitle}</p>
        </div>
      </div>

      <div className="top-actions">
        <div className={`status-pill status-${status}`} title={message}>
          <span className="status-dot" />
          <span>{LABELS[status]}</span>
          {message && status !== 'demo' && (
            <span className="status-msg">
              {message.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '')}
            </span>
          )}
        </div>

        {showPublish && (
          <div
            className={`status-pill publish-pill publish-${publish!.status}`}
            title={
              publish!.lastError ||
              (publish!.lastSentAt
                ? `Last successful send ${formatClock(publish!.lastSentAt)}`
                : 'Cloud publish')
            }
          >
            <span className="status-dot" />
            {publish!.status === 'off' && <span>Cloud send: off</span>}
            {publish!.status === 'missing-config' && (
              <span>Cloud send: set URL + token</span>
            )}
            {publish!.status === 'idle' && <span>Cloud send: starting…</span>}
            {publish!.status === 'ok' && publish!.lastSentAt && (
              <span>
                Sent {formatAge(publish!.lastSentAt, now)}
                <span className="status-msg">
                  {formatClock(publish!.lastSentAt)}
                </span>
              </span>
            )}
            {publish!.status === 'error' && (
              <span>
                Send failed
                {publish!.lastSentAt
                  ? ` · last ok ${formatAge(publish!.lastSentAt, now)}`
                  : ''}
              </span>
            )}
          </div>
        )}

        {showBoatAge && (
          <div
            className={`status-pill publish-pill ${
              lastBoatIngestAt && now - lastBoatIngestAt < 30_000
                ? 'publish-ok'
                : lastBoatIngestAt
                  ? 'publish-error'
                  : 'publish-idle'
            }`}
            title={
              lastBoatIngestAt
                ? `Last boat update ${formatClock(lastBoatIngestAt)}`
                : 'Waiting for boat telemetry'
            }
          >
            <span className="status-dot" />
            {lastBoatIngestAt ? (
              <span>
                Boat {formatAge(lastBoatIngestAt, now)}
                <span className="status-msg">
                  {formatClock(lastBoatIngestAt)}
                </span>
              </span>
            ) : (
              <span>Boat: no data yet</span>
            )}
          </div>
        )}

        {showReconnect && (
          <button type="button" className="btn btn-ghost" onClick={onReconnect}>
            Reconnect
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </header>
  );
}
