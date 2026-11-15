/**
 * What the shared React app needs from its host (architecture §11 "Platform interface"). The web
 * build (apps/web) and the Tauri desktop build (apps/desktop) each inject an implementation at start-up;
 * nothing in packages/app imports a host API directly.
 */
export interface SecureStore {
  get(key: SecureKey): Promise<string | null>;
  set(key: SecureKey, value: string): Promise<void>;
  delete(key: SecureKey): Promise<void>;
}

/** The only secret a client stores: the desktop refresh token (web uses an httpOnly cookie). */
export type SecureKey = 'refresh_token';

export interface PlatformNotification {
  title: string;
  body: string;
}

/** Whether the host may show notifications ('unsupported': it cannot show any). */
export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface Platform {
  kind: 'web' | 'desktop';
  appVersion: string;
  /**
   * Origin of the server, e.g. `https://cip.example.org`. Web: the page's own origin (`''` means
   * same origin). Desktop: chosen on first run, then remembered.
   */
  getServerUrl(): Promise<string | null>;
  /** Desktop only: remembers the server chosen on first run. */
  setServerUrl?(url: string): Promise<void>;
  /** Desktop: the OS keychain. Web: null (the refresh token is an httpOnly cookie the app never sees). */
  secureStore: SecureStore | null;
  notify(notification: PlatformNotification): Promise<void>;
  /** Whether `notify` can show anything now (the Alert Center offers to ask when it cannot). */
  notificationPermission?: () => Promise<NotificationPermission>;
  /** Asks the user (call it from a click: browsers ignore requests made without one). */
  requestNotificationPermission?: () => Promise<NotificationPermission>;
  openExternal(url: string): Promise<void>;
  /** Calls back after the machine wakes or the network comes back; returns an unsubscribe function. */
  onSleepWake(callback: () => void): () => void;
  /**
   * Development tools such as the fixture labelling page (rulebook §12): on in the web dev server,
   * or in a build made with CIP_PUBLIC_DEV_TOOLS=true; never in production builds.
   */
  devTools?: boolean;
}
