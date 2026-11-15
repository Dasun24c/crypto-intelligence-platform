import '@cip/app/styles.css';
import { createWebPlatform, mountApp } from '@cip/app';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
mountApp(
  root,
  createWebPlatform(import.meta.env.CIP_PUBLIC_APP_VERSION ?? '0.1.0-dev', {
    // Fixture labelling and other development tools: the dev server, or an explicit dev build.
    devTools: import.meta.env.DEV || import.meta.env.CIP_PUBLIC_DEV_TOOLS === 'true',
  }),
);
