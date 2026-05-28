// ────────────────────────────────────────────────────────────────────────────
// Background service worker entry (legacy/background.js module top level).
//
// initBackground() wires the Store / EcholyAuth / SessionCoordinator /
// CaptionCache and registers ALL chrome listeners SYNCHRONOUSLY (invariant M-a:
// no dynamic import() before registration, no top-level await). The WXT
// entrypoint wraps this in defineBackground({type:"module", main:initBackground}).
//
// Order mirrors legacy: setAccessLevel + webRequest listener at module init,
// onMessage router, tabs.onRemoved/onUpdated for clean session teardown, then a
// final `void loadSettings()` to hydrate the persisted settings (no await).
// ────────────────────────────────────────────────────────────────────────────

import { Store } from "./store";
import { EcholyAuth } from "./auth";
import { SessionCoordinator } from "./session-coordinator";
import { CaptionCache } from "./caption-cache";
import { routeMessage, type RouterDeps } from "./router";
import type { ToBackgroundMessage } from "@/shared/protocol";

export function initBackground(): void {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  const captions = new CaptionCache();
  const deps: RouterDeps = { store, auth, session, captions };

  // Restrict storage so rogue youtube.com page scripts can't read the key.
  store.restrictStorage();

  // webRequest YouTube CC cache + GC interval (guarded; sync registration).
  captions.register();

  // Popup → background → content router. Must register synchronously so a woken
  // SW catches the wake-up message.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    routeMessage(deps, message as ToBackgroundMessage, sender, sendResponse),
  );

  // Tab close → stop session cleanly so the provider sees the /end.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === store.state.tabId) {
      void session.stop();
    }
  });

  // YT is a SPA; a URL change happens for /watch?v= switches too. Stop on any
  // URL change so the new video starts clean.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== store.state.tabId) return;
    if (!changeInfo.url) return;
    void session.stop();
  });

  // Hydrate the persisted 8 settings keys (cold start). No await — fire it.
  void store.loadSettings();
}
