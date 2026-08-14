/**
 * Helpers for locking onto a specific Signal K data source
 * (e.g. Navico Precision-9 for headingMagnetic).
 */

/** Flatten update source / $source into a searchable string. */
export function sourceIdentity(update: {
  source?: unknown;
  $source?: string;
}): string {
  const parts: string[] = [];
  if (typeof update.$source === 'string' && update.$source.trim()) {
    parts.push(update.$source.trim());
  }
  const src = update.source;
  if (typeof src === 'string') {
    parts.push(src);
  } else if (src && typeof src === 'object') {
    collectStrings(src, parts, 0);
  }
  return uniqueJoin(parts);
}

/** Case-insensitive substring match. Empty filter accepts every source. */
export function sourceMatchesFilter(
  identity: string,
  filter: string | null | undefined,
): boolean {
  const f = (filter ?? '').trim().toLowerCase();
  if (!f) return true;
  if (!identity) return false;
  return identity.toLowerCase().includes(f);
}

function uniqueJoin(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(' ');
}

function collectStrings(node: unknown, out: string[], depth: number): void {
  if (depth > 6 || node == null) return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (typeof node !== 'object' || Array.isArray(node)) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    // Skip bulky / irrelevant blobs
    if (k === 'timestamp' || k === 'pgns') continue;
    if (typeof v === 'string' || typeof v === 'number') {
      out.push(String(v));
    } else if (v && typeof v === 'object') {
      collectStrings(v, out, depth + 1);
    }
  }
}

/**
 * Walk Signal K /sources (or any subtree) and map every path → descriptive text
 * (product model, manufacturer, labels, n2k fields).
 *
 * Keys are stored as full paths ("can0.35") and short tails ("35") so $source
 * lookups work whether the server uses can0.35 or a CAN-name form.
 */
export function buildSourceNameMap(root: unknown): Map<string, string> {
  const out = new Map<string, string>();
  walkSources(root, [], out);
  return out;
}

function walkSources(
  node: unknown,
  path: string[],
  out: Map<string, string>,
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const o = node as Record<string, unknown>;

  const tags: string[] = [];
  collectStrings(o, tags, 0);

  // Prefer compact product-ish names when present
  const productBits = pickProductBits(o);
  const label =
    productBits ||
    (typeof o.label === 'string' ? o.label.trim() : '') ||
    uniqueJoin(tags);

  if (label && path.length > 0) {
    const full = path.join('.');
    mergeName(out, full, label);
    // Also index by last segment (src id) and last two segments
    mergeName(out, path[path.length - 1]!, label);
    if (path.length >= 2) {
      mergeName(out, path.slice(-2).join('.'), label);
    }
  }

  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      walkSources(v, [...path, k], out);
    }
  }
}

function pickProductBits(o: Record<string, unknown>): string {
  const product =
    asRecord(o.productInformation) ??
    asRecord(asRecord(o.n2k)?.productInformation) ??
    asRecord(o.n2k) ??
    o;

  const model = firstString(product, [
    'modelId',
    'model',
    'productCode',
    'Model ID',
    'model_id',
  ]);
  const mfr = firstString(product, [
    'manufacturerName',
    'manufacturerCode',
    'Manufacturer Code',
    'manufacturer_name',
  ]);
  return uniqueJoin([mfr, model].filter(Boolean) as string[]);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function firstString(
  o: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = o[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function mergeName(map: Map<string, string>, key: string, name: string): void {
  const prev = map.get(key);
  if (!prev) {
    map.set(key, name);
    return;
  }
  // Keep the longer / more descriptive label
  if (name.length > prev.length && !prev.toLowerCase().includes(name.toLowerCase())) {
    map.set(key, uniqueJoin([prev, name]));
  } else if (!prev.toLowerCase().includes(name.toLowerCase())) {
    map.set(key, uniqueJoin([prev, name]));
  }
}

/** Resolve a rich identity for an update using the sources name map. */
export function resolveSourceIdentity(
  update: { source?: unknown; $source?: string },
  sourceNames: Map<string, string>,
): string {
  const base = sourceIdentity(update);
  const dollar =
    typeof update.$source === 'string' ? update.$source.trim() : '';
  const extras: string[] = [];

  if (dollar) {
    const direct = sourceNames.get(dollar);
    if (direct) extras.push(direct);

    // Prefix / suffix lookups: can0.35 ↔ 35 ↔ can0.35.n2k
    for (const [key, name] of sourceNames) {
      if (
        key === dollar ||
        dollar.endsWith(`.${key}`) ||
        key.endsWith(`.${dollar}`) ||
        dollar.includes(key) ||
        key.includes(dollar)
      ) {
        extras.push(name);
      }
    }
  }

  // Also try plain src from embedded source object
  const srcObj =
    update.source && typeof update.source === 'object'
      ? (update.source as Record<string, unknown>)
      : null;
  if (srcObj?.src != null) {
    const srcKey = String(srcObj.src);
    const bySrc = sourceNames.get(srcKey);
    if (bySrc) extras.push(bySrc);
    if (srcObj.label != null) {
      const combo = `${srcObj.label}.${srcKey}`;
      const byCombo = sourceNames.get(combo);
      if (byCombo) extras.push(byCombo);
    }
  }

  return uniqueJoin([base, ...extras]);
}

/**
 * Pick heading (radians) from a full-model navigation.headingMagnetic node,
 * preferring a values{} entry whose key/identity matches the filter.
 */
export function pickHeadingFromFullModel(
  node: unknown,
  filter: string,
  sourceNames: Map<string, string>,
): { value: number; sourceId: string } | null {
  if (!node || typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;

  const values = asRecord(o.values);
  if (values) {
    const matches: Array<{ value: number; sourceId: string }> = [];
    for (const [key, entry] of Object.entries(values)) {
      const e = asRecord(entry);
      if (!e || typeof e.value !== 'number' || !Number.isFinite(e.value)) {
        continue;
      }
      const identity = resolveSourceIdentity(
        { $source: key, source: e },
        sourceNames,
      );
      const combined = uniqueJoin([key, identity]);
      if (sourceMatchesFilter(combined, filter) || sourceMatchesFilter(key, filter)) {
        matches.push({ value: e.value, sourceId: combined || key });
      }
    }
    if (matches.length > 0) {
      // Prefer the one whose identity best mentions the filter
      const f = filter.trim().toLowerCase();
      matches.sort((a, b) => {
        const as = a.sourceId.toLowerCase().includes(f) ? 0 : 1;
        const bs = b.sourceId.toLowerCase().includes(f) ? 0 : 1;
        return as - bs;
      });
      return matches[0]!;
    }
  }

  // Single value — only use if $source matches (or no filter)
  if (typeof o.value === 'number' && Number.isFinite(o.value)) {
    const dollar = typeof o.$source === 'string' ? o.$source : '';
    const identity = resolveSourceIdentity(
      { $source: dollar, source: o },
      sourceNames,
    );
    const combined = uniqueJoin([dollar, identity]);
    if (sourceMatchesFilter(combined, filter) || !filter.trim()) {
      return { value: o.value, sourceId: combined || dollar || 'api' };
    }
  }

  return null;
}
