/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only variables starting with CIP_PUBLIC_ reach the browser bundle (see vite.config.ts). */
  readonly CIP_PUBLIC_APP_VERSION?: string;
  /** 'true' builds the development tools (fixture labelling) into a production bundle. */
  readonly CIP_PUBLIC_DEV_TOOLS?: string;
}
