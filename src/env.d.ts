// Build-time env exposed by WXT (Vite). `WXT_*` prefix is required for
// client-visible values. Declare them so TS knows the shape of import.meta.env.

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Vite-provided: true in `wxt dev` / `--mode development`, false in prod
   *  builds. Used by auth-listener.ts to allow "localhost" cookie domains. */
  readonly DEV: boolean;
  /** Echoly API origin — defaults to https://api.echolyhq.com when unset. */
  readonly WXT_ECHOLY_API_ORIGIN?: string;
  /** Echoly web origin — defaults to https://echolyhq.com when unset. */
  readonly WXT_ECHOLY_WEB_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
