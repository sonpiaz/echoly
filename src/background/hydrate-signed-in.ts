// Single-flight signed-in hydration: bootstrap + settings, debounced 300ms.

import type { Store } from "./store";
import type { SettingsClient } from "./settings-client";

const HYDRATE_DEBOUNCE_MS = 300;

let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateInFlight: Promise<void> | null = null;

/** Coalesce GET_STATE, cookie sign-in, STOP, CONTENT_ENDED within one window. */
export function scheduleHydrateSignedIn(
  store: Store,
  settings?: SettingsClient,
): void {
  if (hydrateTimer) clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(() => {
    hydrateTimer = null;
    void hydrateSignedIn(store, settings);
  }, HYDRATE_DEBOUNCE_MS);
}

/** One bootstrap + optional settings fetch per burst. */
export async function hydrateSignedIn(
  store: Store,
  settings?: SettingsClient,
): Promise<void> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = (async () => {
    try {
      await store.refreshAuth();
      store.broadcast();
      if (!settings || !store.state.signedInUser) return;
      const bundle = await settings.fetchBundle().catch(() => null);
      if (bundle) {
        store.applyServerBundle(bundle);
        await store.persistAdvanced();
        store.broadcast();
      }
    } finally {
      hydrateInFlight = null;
    }
  })();
  return hydrateInFlight;
}

/** Test-only reset. */
export function resetHydrateSignedInState(): void {
  if (hydrateTimer) clearTimeout(hydrateTimer);
  hydrateTimer = null;
  hydrateInFlight = null;
}
