import { useCallback, useState } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type DataSource } from '../types';

const STORAGE_KEY = 'anchor-watch-settings';
/** Survives Reset defaults and is re-merged on every load */
const CREDS_KEY = 'anchor-watch-cloud-creds';

/** Cloud connection values that should stick once the user has set them */
interface PersistedCloudCreds {
  cloudUrl: string;
  cloudBoatToken: string;
  cloudViewToken: string;
  cloudPublishEnabled: boolean;
}

function extractCreds(s: AppSettings): PersistedCloudCreds {
  return {
    cloudUrl: s.cloudUrl,
    cloudBoatToken: s.cloudBoatToken,
    cloudViewToken: s.cloudViewToken,
    cloudPublishEnabled: s.cloudPublishEnabled,
  };
}

function loadCreds(): Partial<PersistedCloudCreds> {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedCloudCreds>;
    const out: Partial<PersistedCloudCreds> = {};
    if (typeof parsed.cloudUrl === 'string') out.cloudUrl = parsed.cloudUrl;
    if (typeof parsed.cloudBoatToken === 'string') {
      out.cloudBoatToken = parsed.cloudBoatToken;
    }
    if (typeof parsed.cloudViewToken === 'string') {
      out.cloudViewToken = parsed.cloudViewToken;
    }
    if (typeof parsed.cloudPublishEnabled === 'boolean') {
      out.cloudPublishEnabled = parsed.cloudPublishEnabled;
    }
    return out;
  } catch {
    return {};
  }
}

function applyCreds(
  settings: AppSettings,
  creds: Partial<PersistedCloudCreds>,
): AppSettings {
  return {
    ...settings,
    ...(creds.cloudUrl !== undefined ? { cloudUrl: creds.cloudUrl } : {}),
    ...(creds.cloudBoatToken !== undefined
      ? { cloudBoatToken: creds.cloudBoatToken }
      : {}),
    ...(creds.cloudViewToken !== undefined
      ? { cloudViewToken: creds.cloudViewToken }
      : {}),
    ...(creds.cloudPublishEnabled !== undefined
      ? { cloudPublishEnabled: creds.cloudPublishEnabled }
      : {}),
  };
}

function persist(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    localStorage.setItem(CREDS_KEY, JSON.stringify(extractCreds(settings)));
  } catch {
    /* quota / private mode */
  }
}

function migrate(raw: Partial<AppSettings> & { demoMode?: boolean }): AppSettings {
  const base = { ...DEFAULT_SETTINGS, ...raw };
  // Migrate old demoMode flag
  if (!raw.dataSource && raw.demoMode) {
    base.dataSource = 'demo';
  }
  if (!base.dataSource) base.dataSource = 'signalk';
  return base as AppSettings;
}

function loadSettings(): AppSettings {
  // URL query overrides (phone watch links)
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') as DataSource | null;
  const token = params.get('token');
  const cloud = params.get('cloud');
  const creds = loadCreds();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let fromStorage = raw ? migrate(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };

    // Dedicated creds store wins (survives reset / partial main-key writes)
    fromStorage = applyCreds(fromStorage, creds);

    if (mode === 'cloud' || mode === 'demo' || mode === 'signalk') {
      fromStorage.dataSource = mode;
    }
    if (token) fromStorage.cloudViewToken = token;
    if (cloud) fromStorage.cloudUrl = cloud;
    // When opened via /watch?token=… on the same origin as the server
    if (mode === 'cloud' && !fromStorage.cloudUrl) {
      fromStorage.cloudUrl = window.location.origin;
    }

    // Backfill dedicated store from older single-key saves
    persist(fromStorage);
    return fromStorage;
  } catch {
    const s = applyCreds({ ...DEFAULT_SETTINGS }, creds);
    if (mode === 'cloud') {
      s.dataSource = 'cloud';
      s.cloudUrl = cloud || s.cloudUrl || window.location.origin;
      if (token) s.cloudViewToken = token;
    }
    return s;
  }
}

export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings);

  const setSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    // Keep cloud URL / tokens / publish toggle — only reset display & watch prefs
    setSettingsState((prev) => {
      const next = applyCreds({ ...DEFAULT_SETTINGS }, extractCreds(prev));
      persist(next);
      return next;
    });
  }, []);

  return { settings, setSettings, resetSettings };
}
