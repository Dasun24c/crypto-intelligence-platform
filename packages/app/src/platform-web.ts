import type { Platform } from './platform.js';

/** The browser host: same-origin API, refresh token in an httpOnly cookie, Notification API. */
export function createWebPlatform(appVersion: string): Platform {
  return {
    kind: 'web',
    appVersion,
    getServerUrl: () => Promise.resolve(''),
    secureStore: null,
    async notify({ title, body }) {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
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
