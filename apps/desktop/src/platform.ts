import type { Platform, SecureStore } from '@cip/app';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Where versions up to Phase 8 kept the server address: the webview's local storage. A forced stop
 * could lose it, so the address now lives in a settings file the Rust side writes atomically
 * (`settings.rs`). A value found only here is copied to the file. The address is still written here
 * as well, so that an older installer, if it is put back, keeps finding it.
 */
const LEGACY_SERVER_URL_KEY = 'cip.serverUrl';

/** Visible again after being hidden this long: the machine may have slept, so the app should resync. */
const WAKE_AFTER_HIDDEN_MS = 30_000;

/** Plain-HTTP hosts that development builds accept, for a server running on this machine. */
const DEV_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

/** The refresh token lives in the OS keychain, behind Rust commands that accept only that key. */
const secureStore: SecureStore = {
  get: (key) => command<string | null>('secure_store_get', { key }),
  set: (key, value) => command<void>('secure_store_set', { key, value }),
  delete: (key) => command<void>('secure_store_delete', { key }),
};

/**
 * The desktop implementation of the platform interface (architecture §11 and §13). `appVersion` is
 * resolved with `getVersion()` before mounting, because the interface takes it as a plain string.
 */
export function createTauriPlatform(appVersion: string): Platform {
  return {
    kind: 'desktop',
    appVersion,
    getServerUrl: readServerUrl,
    async setServerUrl(url) {
      const origin = parseServerUrl(url);
      await command<void>('settings_set_server_url', { url: origin });
      writeLegacyServerUrl(origin);
    },
    secureStore,
    async notify({ title, body }) {
      const granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
      if (granted) sendNotification({ title, body });
    },
    notificationPermission: async () => ((await isPermissionGranted()) ? 'granted' : 'default'),
    async requestNotificationPermission() {
      if (await isPermissionGranted()) return 'granted';
      const answer = await requestPermission();
      return answer === 'granted' ? 'granted' : answer === 'denied' ? 'denied' : 'default';
    },
    async openExternal(url) {
      // Like the web host, anything but an https:// link is ignored (the opener capability refuses it too).
      const target = httpsUrl(url);
      if (target) await openUrl(target);
    },
    onSleepWake,
  };
}

/**
 * Shows the connection status in the tray tooltip. The platform interface has no hook for it yet;
 * once it has, the app's connection manager can report through this.
 */
export function setTrayStatus(text: string): Promise<void> {
  return command<void>('set_tray_status', { text });
}

/**
 * Validates a server address and reduces it to its origin, e.g. `https://cip.example.org`. Only
 * HTTPS is accepted, apart from plain HTTP to this machine in development builds. The error messages
 * are written to be shown next to the address field.
 */
function parseServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter the full server address, for example https://cip.example.org');
  }
  const devHttp = import.meta.env.DEV && url.protocol === 'http:' && DEV_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !devHttp) {
    throw new Error('The server address must start with https://');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('The server address must not contain a user name or password.');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Enter only the server address, without a path.');
  }
  return url.origin;
}

function httpsUrl(input: string): string | null {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The saved server address, from the settings file, or else from where an earlier version kept it
 * (copied to the settings file on the way). Null asks the user again.
 */
async function readServerUrl(): Promise<string | null> {
  const saved = await command<string | null>('settings_get_server_url', {});
  if (saved !== null) return validServerUrl(saved);
  const legacy = validServerUrl(readLegacyServerUrl());
  if (legacy === null) return null;
  try {
    await command<void>('settings_set_server_url', { url: legacy });
  } catch {
    // Not copied this time: the next start tries again.
  }
  return legacy;
}

/** Saved under other rules (by a development build, say): ask again rather than connect. */
function validServerUrl(stored: string | null): string | null {
  if (stored === null) return null;
  try {
    return parseServerUrl(stored);
  } catch {
    return null;
  }
}

function readLegacyServerUrl(): string | null {
  try {
    return localStorage.getItem(LEGACY_SERVER_URL_KEY);
  } catch {
    return null;
  }
}

function writeLegacyServerUrl(origin: string): void {
  try {
    localStorage.setItem(LEGACY_SERVER_URL_KEY, origin);
  } catch {
    // Storage unavailable: the settings file has it anyway.
  }
}

function onSleepWake(callback: () => void): () => void {
  let hiddenSince = document.visibilityState === 'hidden' ? Date.now() : null;
  const onOnline = () => callback();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince ??= Date.now();
      return;
    }
    // Date.now() keeps counting while the machine sleeps, so a long gap covers sleep as well.
    const asleep = hiddenSince !== null && Date.now() - hiddenSince >= WAKE_AFTER_HIDDEN_MS;
    hiddenSince = null;
    if (asleep) callback();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

/** Rust commands reject with a bare string; callers get an Error instead. */
async function command<T>(name: string, args: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : `${name} failed`, { cause: error });
  }
}
