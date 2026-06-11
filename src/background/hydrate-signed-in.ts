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
  onApplied?: () => void,
): void {
  if (hydrateTimer) clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(() => {
    hydrateTimer = null;
    void hydrateSignedIn(store, settings, onApplied);
  }, HYDRATE_DEBOUNCE_MS);
}

/** One bootstrap + optional settings fetch per burst.
 *  `onApplied` fires only when a CHANGED server bundle was applied — callers
 *  with session context use it to relay CONTENT_UPDATE_SETTINGS so subtitle
 *  styling (W6) lands live on a running tab. Single-flight note: a join on an
 *  in-flight hydrate does not run its own onApplied (the original caller's
 *  callback covers the apply). */
export async function hydrateSignedIn(
  store: Store,
  settings?: SettingsClient,
  onApplied?: () => void,
): Promise<void> {
  if (hydrateInFlight) return hydrateInFlight;
  store.setHydrating(true);
  hydrateInFlight = (async () => {
    try {
      await store.refreshAuth();
      store.broadcast();
      if (!settings || !store.state.signedInUser) return;
      const bundle = await settings.fetchBundle().catch(() => null);
      if (bundle) {
        const changed = await store.applyServerBundle(bundle);
        if (changed) {
          await store.persistAdvanced();
          store.broadcast();
          onApplied?.();
        }
      }
    } finally {
      store.setHydrating(false);
      hydrateInFlight = null;
      // Broadcast the hydrating=false so popup can reconcile.
      store.broadcast();
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
