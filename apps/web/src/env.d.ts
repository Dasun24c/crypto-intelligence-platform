/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only variables starting with CIP_PUBLIC_ reach the browser bundle (see vite.config.ts). */
  readonly CIP_PUBLIC_APP_VERSION?: string;
}
