interface Props {
  title: string;
  detail: string;
  variant?: 'wind' | 'distance';
  onDismiss: () => void;
}

export function HighAnnounceBanner({
  title,
  detail,
  variant = 'wind',
  onDismiss,
}: Props) {
  return (
    <div
      className={`high-announce-banner high-announce-${variant}`}
      role="status"
      aria-live="polite"
    >
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
