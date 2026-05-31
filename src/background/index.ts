// Background service worker — Store, auth, session coordinator, message router.
// All chrome listeners register synchronously in initBackground() (MV3 invariant).

import { Store } from "./store";
import { EcholyAuth } from "./auth";
import { SessionCoordinator } from "./session-coordinator";
import { routeMessage, type RouterDeps } from "./router";
import { installAuthListener } from "./auth-listener";
import { hydrateSignedIn } from "./hydrate-signed-in";
import { SettingsClient } from "./settings-client";
import { registerAutoStart } from "./auto-start";
import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { ToBackgroundMessage } from "@/shared/protocol";
import { installYoutubeCaptionCache } from "./youtube-caption-cache";

export function initBackground(): void {
  installYoutubeCaptionCache();
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const settingsClient = new SettingsClient(ECHOLY_PROXY_BASE, () =>
    auth.getSessionToken(),
  );
  const session = new SessionCoordinator(store, auth, settingsClient);
  const deps: RouterDeps = { store, auth, session, settings: settingsClient };

  store.restrictStorage();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    routeMessage(deps, message as ToBackgroundMessage, sender, sendResponse),
  );

  installAuthListener(store, auth, settingsClient);

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === store.state.tabId) void session.stop();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== store.state.tabId || !changeInfo.url) return;
    void session.stop();
  });

  registerAutoStart(store, session);

  chrome.tabs.onActivated.addListener(() => {
    void session.refreshActiveSite().then(() => store.broadcast());
  });

  let siteRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    if (siteRefreshTimer) clearTimeout(siteRefreshTimer);
    siteRefreshTimer = setTimeout(() => {
      siteRefreshTimer = null;
      void session.refreshActiveSite().then(() => store.broadcast());
    }, 150);
  });

  void (async () => {
    await store.loadSettings();
    const token = await auth.getSessionToken();
    if (token) await hydrateSignedIn(store, settingsClient);
  })();
}
