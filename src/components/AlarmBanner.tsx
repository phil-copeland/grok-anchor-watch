interface Props {
  active: boolean;
  warning: boolean;
  distanceLabel: string;
  radiusLabel: string;
  muted: boolean;
  onToggleMute: () => void;
  onDismissWarning: () => void;
}

export function AlarmBanner({
  active,
  warning,
  distanceLabel,
  radiusLabel,
  muted,
  onToggleMute,
  onDismissWarning,
}: Props) {
  if (!active && !warning) return null;

  return (
    <div
      className={`alarm-banner ${active ? 'alarm-active' : 'alarm-warn'}`}
      role="alert"
    >
      <div>
        {active ? (
          <>
            <strong>ANCHOR DRAGGING / OUT OF RADIUS</strong>
            <span>
              Distance {distanceLabel} exceeds alarm {radiusLabel}
            </span>
          </>
        ) : (
          <>
            <strong>Approaching alarm radius</strong>
            <span>
              Distance {distanceLabel} · limit {radiusLabel}
            </span>
          </>
        )}
      </div>
      {active ? (
        <button type="button" className="btn btn-alarm" onClick={onToggleMute}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
      ) : (
        <button type="button" className="btn btn-alarm" onClick={onDismissWarning}>
          Dismiss
        </button>
      )}
    </div>
  );
}
