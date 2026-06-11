// ────────────────────────────────────────────────────────────────────────────
// Echoly Web marker content script (C3 + C4).
//
// Purpose:
//  1. Mark the DOM so the web app can detect the extension and read its
//     version + id (C3):
//       document.documentElement.dataset.echolyExtension = manifest version
//       document.documentElement.dataset.echolyExtensionId = runtime id
//
//  2. Relay the page's "echoly:settings-updated" CustomEvent (fired on window
//     by the web settings form after a successful PUT) to the background as a
//     REFRESH_SETTINGS message, debounced 500ms (C4).
//
// World: ISOLATED (default — no page-JS access needed; we only touch the DOM
//         and listen to window events, both of which are accessible from
//         ISOLATED world).
// runAt: "document_start" — sets the dataset attrs before any DOMContentLoaded
//         listener on the web page, so detectExtension() always sees them.
//
// Matches: ECHOLY_WEB_ORIGIN host in prod; plus localhost/127.0.0.1 in dev.
// CRITICAL: Chrome match patterns CANNOT contain a port ("Hostname cannot
// include a port" — chrome.scripting rejects the registration and the script
// never loads). A port-less pattern matches EVERY port, so
// `http://localhost/*` covers the :4321 web dev server. toMatchPattern()
// strips any port from the configured origin for the same reason.
// Prod manifest must NOT contain localhost matches.
//
// No version bump — per hard user rule.
// ────────────────────────────────────────────────────────────────────────────

import { ECHOLY_WEB_ORIGIN, ECHOLY_BUILD_MODE } from "@/shared/echoly-config";

/** Origin → valid match pattern: scheme://hostname/* (port stripped — match
 *  patterns reject ports; a port-less pattern matches any port). */
function toMatchPattern(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return `${origin.replace(/\/$/, "")}/*`;
  }
}

/** Derive the content-script match patterns for the web origin. */
function webOriginMatches(): string[] {
  const patterns = [toMatchPattern(ECHOLY_WEB_ORIGIN)];
  if (ECHOLY_BUILD_MODE === "development") {
    patterns.push("http://localhost/*", "http://127.0.0.1/*");
  }
  return [...new Set(patterns)];
}

export default defineContentScript({
  matches: webOriginMatches(),
  runAt: "document_start",
  // ISOLATED is the default world — do NOT set "MAIN" (no page-JS access needed).
  main() {
    try {
      // C3 — stamp the DOM marker so the web page can detect the extension.
      const manifest = chrome.runtime.getManifest();
      document.documentElement.dataset.echolyExtension = manifest.version ?? "";
      document.documentElement.dataset.echolyExtensionId = chrome.runtime.id ?? "";
    } catch {
      // chrome.runtime may not be available in rare edge cases — silently ignore.
    }

    // C4 — relay echoly:settings-updated (window-dispatched CustomEvent) to bg
    // as REFRESH_SETTINGS, debounced 500ms.
    let relayTimer: ReturnType<typeof setTimeout> | null = null;

    window.addEventListener("echoly:settings-updated", () => {
      try {
        if (relayTimer !== null) clearTimeout(relayTimer);
        relayTimer = setTimeout(() => {
          relayTimer = null;
          try {
            void chrome.runtime.sendMessage({ type: "REFRESH_SETTINGS" });
          } catch {
            // Extension context may be invalidated — silently ignore.
          }
        }, 500);
      } catch {
        // Defensive: never let a listener error propagate to the page.
      }
    });
  },
});
