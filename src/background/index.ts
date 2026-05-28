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
import { installAuthListener } from "./auth-listener";
import { SettingsClient } from "./settings-client";
import { registerAutoStart } from "./auto-start";
import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { ToBackgroundMessage } from "@/shared/protocol";

export function initBackground(): void {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  // SettingsClient is the I/O boundary to /v1/me/settings. Pulls the bearer
  // token lazily so the SW never holds a stale token after sign-out.
  const settingsClient = new SettingsClient(ECHOLY_PROXY_BASE, () =>
    auth.getSessionToken(),
  );
  const session = new SessionCoordinator(store, auth, settingsClient);
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

  // chrome.cookies.onChanged → debounced refreshAuth + auto-close the signin
  // tab when the server sets ec_session post-magic-link (sign-in UX fix).
  // Settings sync rides the same debounce so the popup sees user-customized
  // Advanced values immediately post-sign-in. Registered synchronously to
  // preserve M-a (no top-level await before any chrome.* listener registration).
  installAuthListener(store, auth, settingsClient);

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

  // Auto-start: registers its own chrome.tabs.onUpdated listener that fires
  // session.start() when (a) page finishes loading, (b) host is a YT watch
  // page, (c) advanced.autoStartHosts[host]===true, (d) user is signed in,
  // (e) no session is already running. Debounced per-tab so YT SPA URL
  // updates don't re-fire repeatedly.
  registerAutoStart(store, session);

  // Hydrate the persisted 8 settings + Advanced bundle (cold start). No await.
  void store.loadSettings();
}
