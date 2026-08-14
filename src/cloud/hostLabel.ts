/**
 * Friendly name for the configured cloud relay (Fly vs Suga).
 * Returns null when the URL is empty or not a known host.
 */
export function cloudHostLabel(cloudUrl: string | undefined | null): string | null {
  const raw = (cloudUrl || '').trim();
  if (!raw) return null;

  let host = raw;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = u.hostname;
  } catch {
    host = raw.replace(/^https?:\/\//i, '').split('/')[0] ?? raw;
  }

  const h = host.toLowerCase();
  if (h.endsWith('.fly.dev') || h.endsWith('.fly.io') || h === 'fly.dev' || h === 'fly.io') {
    return 'Fly';
  }
  if (
    h.endsWith('.suga.run') ||
    h.endsWith('.suga.app') ||
    h.includes('.suga-') ||
    h === 'suga.run' ||
    h === 'suga.app'
  ) {
    return 'Suga';
  }
  return null;
}
