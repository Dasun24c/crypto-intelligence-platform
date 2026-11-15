import type { NotificationPermission, Platform } from './platform.js';

const permission = (): NotificationPermission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/** The browser host: same-origin API, refresh token in an httpOnly cookie, Notification API. */
export function createWebPlatform(appVersion: string, opts: { devTools?: boolean } = {}): Platform {
  return {
    kind: 'web',
    appVersion,
    devTools: opts.devTools ?? false,
    getServerUrl: () => Promise.resolve(''),
    secureStore: null,
    notify({ title, body }) {
      // Permission is asked for from a click in the Alert Center (browsers ignore it otherwise).
      if (permission() === 'granted') new Notification(title, { body });
      return Promise.resolve();
    },
    notificationPermission: () => Promise.resolve(permission()),
    async requestNotificationPermission() {
      if (permission() === 'default') await Notification.requestPermission();
      return permission();
    },
    openExternal(url) {
      if (url.startsWith('https://')) window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    },
    onSleepWake(callback) {
      let hiddenAt: number | null = null;
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          hiddenAt = Date.now();
        } else if (hiddenAt !== null && Date.now() - hiddenAt >= 30_000) {
          hiddenAt = null;
          callback();
        }
      };
      window.addEventListener('online', callback);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('online', callback);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}
