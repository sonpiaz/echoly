import { defineConfig } from "wxt";

// WXT config — generates an MV3 manifest byte-equivalent to legacy/manifest.json
// (0.6.3). `version` is single-sourced from package.json (fixes the old
// 0.6.1/0.6.3 content-guard drift). Content scripts emit at the stable,
// unhashed path `content-scripts/content.{js,css}` (verified §0 of SOLUTION.md)
// — pinned in src/shared/constants.ts as CONTENT_SCRIPT_PATH.
export default defineConfig({
  srcDir: "src",
  // Static assets (icons) live under src/public; WXT's publicDir default is
  // <root>/public, so point it at src/public. These are copied to the output
  // root, so manifest "icons/icon-*.png" resolves to .output/.../icons/*.
  publicDir: "src/public",
  manifest: {
    name: "Echoly — Live YouTube Translation",
    short_name: "Echoly",
    description:
      "Hear any YouTube video in your language. Live AI dubbing, 40+ language pairs. Free 30 min/month or bring your own Kyma key.",
    minimum_chrome_version: "116",
    permissions: ["activeTab", "scripting", "storage", "webRequest", "cookies"],
    host_permissions: [
      "https://*.youtube.com/*",
      "https://youtube.com/*",
      "https://api.kymaapi.com/*",
      "https://api.openai.com/*",
      "https://api.echolyhq.com/*",
      "https://echolyhq.com/*",
    ],
    // Strict CSP — no inline scripts, no eval. WXT relaxes this ONLY in dev;
    // the prod build emits exactly this (verified). Do NOT add connect-src
    // (network egress is governed by host_permissions; a connect-src would
    // break the realtime OpenAI SDP POST and the Kyma/Echoly fetches).
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
    },
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_title: "Echoly",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
  },
});
