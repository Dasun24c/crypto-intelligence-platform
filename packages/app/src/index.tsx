import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import type { Platform } from './platform.js';
import { Session } from './session.js';

export type { Platform, PlatformNotification, SecureKey, SecureStore } from './platform.js';
export { createWebPlatform } from './platform-web.js';

/** Starts the application in `element` with the host's platform implementation. */
export function mountApp(element: HTMLElement, platform: Platform): void {
  const session = new Session(platform);
  createRoot(element).render(
    <StrictMode>
      <App session={session} />
    </StrictMode>,
  );
}
