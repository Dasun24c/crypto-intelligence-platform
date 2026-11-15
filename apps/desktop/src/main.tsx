import '@cip/app/styles.css';

import { mountApp } from '@cip/app';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';

import { createTauriPlatform } from './platform';

async function start(root: HTMLElement): Promise<void> {
  if (!isTauri()) {
    // The Vite dev server opened in an ordinary browser: the desktop APIs do not exist there.
    showMessage(root, 'This page only runs inside the desktop app. Use apps/web in a browser.');
    return;
  }
  // Resolved once before mounting: the platform interface takes the version as a plain string.
  mountApp(root, createTauriPlatform(await getVersion()));
}

function showMessage(root: HTMLElement, text: string): void {
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.style.padding = '2rem';
  // textContent, never innerHTML: error text must not be parsed as markup.
  message.textContent = text;
  root.replaceChildren(message);
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

start(root).catch((error: unknown) => {
  showMessage(root, `The app could not start: ${error instanceof Error ? error.message : String(error)}`);
});
