import { useState } from 'react';
import type { AppSettings, DataSource } from '../types';
import {
  distanceToM,
  mToDistance,
  msToWind,
  windToMs,
} from '../units';

interface Props {
  open: boolean;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onReset: () => void;
}

/**
 * Token field that, once set, shows a “saved” state instead of a live password
 * input — avoids browser autofill wiping the value and re-saving empty tokens.
 */
function SavedSecretField({
  label,
  value,
  placeholder,
  disabled,
  help,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  help?: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (value && !editing) {
    return (
      <label className="field">
        <span>{label}</span>
        <div className={`secret-saved${disabled ? ' is-disabled' : ''}`}>
          <span className="secret-mask">•••••••• saved in this browser</span>
          <div className="secret-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              Change
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => onChange('')}
            >
              Clear
            </button>
          </div>
        </div>
        {help ? <small>{help}</small> : null}
      </label>
    );
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next) {
            onChange(next);
            setEditing(false);
            setDraft('');
          } else if (value) {
            // Empty blur while changing — cancel and keep previous token
            setEditing(false);
            setDraft('');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape' && value) {
            setEditing(false);
            setDraft('');
          }
        }}
      />
      {help ? <small>{help}</small> : null}
      {value && editing ? (
        <small>Leave blank and click away to keep the saved token</small>
      ) : null}
    </label>
  );
}

export function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  onReset,
}: Props) {
  if (!open) return null;

  const source = settings.dataSource;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Data source</span>
            <select
              value={source}
              onChange={(e) =>
                onChange({ dataSource: e.target.value as DataSource })
              }
            >
              <option value="signalk">Signal K (on boat LAN)</option>
              <option value="cloud">Cloud (phone / remote)</option>
              <option value="demo">Demo simulator</option>
            </select>
          </label>

          {source === 'signalk' && (
            <>
              <label className="field">
                <span>Signal K server</span>
                <input
                  type="text"
                  value={settings.serverUrl}
                  placeholder="192.168.1.50:3000"
                  onChange={(e) =>
                    onChange({ serverUrl: e.target.value.trim() })
                  }
                />
                <small>Host:port — default Signal K is usually port 3000</small>
              </label>

              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={settings.useTls}
                  onChange={(e) => onChange({ useTls: e.target.checked })}
                />
                <span>Use TLS (wss://)</span>
              </label>
            </>
          )}

          {source === 'cloud' && (
            <>
              <label className="field">
                <span>Cloud URL</span>
                <input
                  type="text"
                  value={settings.cloudUrl}
                  placeholder="https://your-app.fly.dev"
                  autoComplete="url"
                  onChange={(e) =>
                    onChange({ cloudUrl: e.target.value.trim() })
                  }
                />
                <small>
                  Leave blank when the UI is served from the same cloud host.
                  Remembered in this browser.
                </small>
              </label>

              <SavedSecretField
                label="View token"
                value={settings.cloudViewToken}
                placeholder="VIEW_TOKEN from server"
                help="Phone link: /watch?token=… — same as server VIEW_TOKEN. Saved in this browser."
                onChange={(cloudViewToken) => onChange({ cloudViewToken })}
              />

              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={settings.followBoatGuardRadius}
                  onChange={(e) =>
                    onChange({ followBoatGuardRadius: e.target.checked })
                  }
                />
                <span>Follow boat guard radius (uncheck to use local override)</span>
              </label>
            </>
          )}

          {(source === 'signalk' || source === 'demo') && (
            <>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={settings.cloudPublishEnabled}
                  onChange={(e) =>
                    onChange({ cloudPublishEnabled: e.target.checked })
                  }
                />
                <span>Send data to cloud server (for remote phone viewing)</span>
              </label>
              <small className="field-note">
                When enabled, this browser posts instruments and the alarm
                radius to your cloud app so phones stay live. Uses a background
                worker + screen wake lock so sends continue when the tab is
                unfocused. For unattended boat use, prefer the boat-agent.
                Cloud URL and boat token are remembered in this browser.
              </small>

              <label className="field">
                <span>Cloud URL</span>
                <input
                  type="text"
                  value={settings.cloudUrl}
                  disabled={!settings.cloudPublishEnabled}
                  placeholder="https://breeze-anchor-watch.fly.dev"
                  autoComplete="url"
                  onChange={(e) =>
                    onChange({ cloudUrl: e.target.value.trim() })
                  }
                />
              </label>
              <SavedSecretField
                label="Boat publish token"
                value={settings.cloudBoatToken}
                disabled={!settings.cloudPublishEnabled}
                placeholder="BOAT_TOKEN — keep private"
                help="Same as Fly BOAT_TOKEN. Header shows last successful send time."
                onChange={(cloudBoatToken) => onChange({ cloudBoatToken })}
              />
            </>
          )}

          <label className="field">
            <span>Distance unit</span>
            <select
              value={settings.distanceUnit}
              onChange={(e) =>
                onChange({
                  distanceUnit: e.target.value as AppSettings['distanceUnit'],
                })
              }
            >
              <option value="m">Metres</option>
              <option value="ft">Feet</option>
              <option value="nm">Nautical miles</option>
            </select>
          </label>

          <label className="field">
            <span>Depth unit</span>
            <select
              value={settings.depthUnit}
              onChange={(e) =>
                onChange({
                  depthUnit: e.target.value as AppSettings['depthUnit'],
                })
              }
            >
              <option value="m">Metres</option>
              <option value="ft">Feet</option>
            </select>
          </label>

          <label className="field">
            <span>Wind unit</span>
            <select
              value={settings.windUnit}
              onChange={(e) =>
                onChange({
                  windUnit: e.target.value as AppSettings['windUnit'],
                })
              }
            >
              <option value="kn">Knots</option>
              <option value="m/s">m/s</option>
              <option value="km/h">km/h</option>
              <option value="mph">mph</option>
            </select>
          </label>

          {source !== 'cloud' && (
            <label className="field">
              <span>History sample interval (seconds)</span>
              <input
                type="number"
                min={1}
                max={60}
                value={settings.historyIntervalMs / 1000}
                onChange={(e) =>
                  onChange({
                    historyIntervalMs:
                      Math.max(1, Number(e.target.value) || 5) * 1000,
                  })
                }
              />
            </label>
          )}

          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.audioAlarm}
              onChange={(e) => onChange({ audioAlarm: e.target.checked })}
            />
            <span>Audio alarm when outside swing circle</span>
          </label>

          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.windHighAnnounce}
              onChange={(e) =>
                onChange({ windHighAnnounce: e.target.checked })
              }
            />
            <span>Announce new high wind (speech + banner)</span>
          </label>
          {settings.windHighAnnounce && (
            <label className="field">
              <span>
                Min wind before announcing ({settings.windUnit})
              </span>
              <input
                type="number"
                min={0}
                step={settings.windUnit === 'm/s' ? 0.5 : 1}
                value={
                  Math.round(
                    msToWind(
                      settings.windHighAnnounceMinMs,
                      settings.windUnit,
                    ) * 10,
                  ) / 10
                }
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value) || 0);
                  onChange({
                    windHighAnnounceMinMs: windToMs(n, settings.windUnit),
                  });
                }}
              />
              <small>
                0 = no floor. New whole-unit highs only speak once wind is at
                least this, held 1s. Works on local and remote watch.
              </small>
            </label>
          )}

          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.distanceHighAnnounce}
              onChange={(e) =>
                onChange({ distanceHighAnnounce: e.target.checked })
              }
            />
            <span>Announce new high anchor distance (speech + banner)</span>
          </label>
          {settings.distanceHighAnnounce && (
            <label className="field">
              <span>
                Min distance before announcing ({settings.distanceUnit})
              </span>
              <input
                type="number"
                min={0}
                step={settings.distanceUnit === 'nm' ? 0.001 : 0.1}
                value={
                  Math.round(
                    mToDistance(
                      settings.distanceHighAnnounceMinM,
                      settings.distanceUnit,
                    ) * 1000,
                  ) / 1000
                }
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value) || 0);
                  onChange({
                    distanceHighAnnounceMinM: distanceToM(
                      n,
                      settings.distanceUnit,
                    ),
                  });
                }}
              />
              <small>
                0 = no floor. Must also rise more than 200 mm over the previous
                high and hold 1s. Works on local and remote watch.
              </small>
            </label>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onReset}>
            Reset defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
