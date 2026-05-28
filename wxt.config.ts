import { defineConfig } from "wxt";

// WXT config — generates an MV3 manifest byte-equivalent to legacy/manifest.json
// (0.6.3). `version` is single-sourced from package.json (fixes the old
// 0.6.1/0.6.3 content-guard drift). Content scripts emit at the stable,
// unhashed path `content-scripts/content.{js,css}` (verified §0 of SOLUTION.md)
// — pinned in src/shared/constants.ts as CONTENT_SCRIPT_PATH.
//
// Dev-only host_permissions: `wxt dev` / `wxt build --mode development` adds
// `http://localhost:{8787,4321}/*` so `chrome.cookies.get` and `fetch` against
// the local server + web work. The store build (`wxt build`, mode=production)
// emits ONLY the prod hosts — verified by inspecting `.output/chrome-mv3-prod`.
export default defineConfig({
  srcDir: "src",
  // Static assets (icons) live under src/public; WXT's publicDir default is
  // <root>/public, so point it at src/public. These are copied to the output
  // root, so manifest "icons/icon-*.png" resolves to .output/.../icons/*.
  publicDir: "src/public",
  // Optional-chain `env?.mode` (NOT a destructure) — WXT's `wxt dev` HMR
  // reload path (create-file-reloader → c12.reloadConfig) calls this factory
  // with NO argument, while `wxt build` calls it WITH `{ mode, command,
  // browser, manifestVersion }`. A bare destructure crashed on the dev path
  // with "Cannot destructure property 'mode' of 'undefined'".
  manifest: (env) => {
    const mode = env?.mode;
    return {
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
      ...(mode === "development"
        ? ["http://localhost:8787/*", "http://localhost:4321/*"]
        : []),
    ],
    // CSP — strict by default ('script-src 'self''), relaxed in dev to allow
    // the WXT/Vite HMR dev server (popup.html loads `/@vite/client`,
    // `/@id/virtual:wxt-html-plugins`, `/src/entrypoints/popup/main.ts` from
    // `http://localhost:3001` etc.). MV3 only permits `http://localhost` and
    // `http://127.0.0.1` (any port) as additional script sources for
    // extension_pages — anything else is rejected by the browser, so this
    // can't accidentally widen prod surface.
    //
    // Do NOT add `connect-src` — network egress is governed by host_permissions;
    // a connect-src would break the realtime OpenAI SDP POST and the Kyma /
    // Echoly fetches.
    content_security_policy: {
      extension_pages: mode === "development"
        ? "script-src 'self' http://localhost:* http://127.0.0.1:*; object-src 'none'"
        : "script-src 'self'; object-src 'none'",
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
    };
  },
});
