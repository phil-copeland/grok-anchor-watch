interface Props {
  label: string;
  value: string;
  sub?: string;
  accent?: 'default' | 'ok' | 'warn' | 'alarm' | 'wind' | 'depth';
  large?: boolean;
}

export function MetricCard({
  label,
  value,
  sub,
  accent = 'default',
  large,
}: Props) {
  return (
    <article className={`metric-card accent-${accent} ${large ? 'large' : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sub ? <span className="metric-sub">{sub}</span> : null}
    </article>
  );
}
