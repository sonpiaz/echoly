// WXT content-script entrypoint. Emits the stable unhashed bundle at
// content-scripts/content.{js,css} (CONTENT_SCRIPT_PATH). The overlay CSS is
// imported here so WXT injects it via the manifest (cssInjectionMode:"manifest")
// exactly as legacy content.css.
//
// F9 GUARD CONTRACT: initContent() must early-return on re-injection BEFORE any
// side effects (version-keyed `window[CONTENT_GLOBAL_KEY] === ECHOLY_VERSION`).
// We keep our OWN lifecycle (module-global pageToken + own AbortController + raw
// timers) and do NOT use WXT's `ctx` (WXT's invalidation event is benign noise
// because nothing of ours subscribes to it).
import "@/content/overlay/overlay.css";
import { initContent } from "@/content";

export default defineContentScript({
  matches: [
    "https://*.youtube.com/*",
    "https://youtube.com/*",
    "https://*.coursera.org/*",
    "https://coursera.org/*",
    "https://*.udemy.com/*",
    "https://udemy.com/*",
  ],
  runAt: "document_idle",
  cssInjectionMode: "manifest",
  main() {
    initContent();
  },
});
