// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — chrome.storage.local schema + typed accessors. ONLY the
// DEFAULT_SETTINGS keys are persisted (legacy/background.js:251-266). Access is
// restricted to TRUSTED_CONTEXTS so a rogue youtube.com page script cannot read
// the user's key (legacy/background.js:187-189). No browser.* polyfill.
// ────────────────────────────────────────────────────────────────────────────

import { DEFAULT_SETTINGS, type Settings } from "./types";

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/** Sticky; no retry needed (legacy/background.js:187-189). */
export function restrictStorageAccess(): void {
  chrome.storage.local
    .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => {});
}

/** Load the persisted settings, defaulted (legacy loadSettings). */
export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(
    DEFAULT_SETTINGS,
  )) as Settings;
  return stored;
}

/** Persist ONLY the known settings keys present in `partial`
 *  (legacy persistSettings — it filters to DEFAULT_SETTINGS keys). */
export async function saveSettings(
  partial: Partial<Settings>,
): Promise<void> {
  const persistable: Partial<Settings> = {};
  for (const k of SETTINGS_KEYS) {
    if (k in partial) {
      // narrow per-key copy preserving value types
      (persistable as Record<string, Settings[keyof Settings] | undefined>)[k] = partial[k];
    }
  }
  if (Object.keys(persistable).length) {
    await chrome.storage.local.set(persistable);
  }
}

/** Volume-only persist (legacy handleUpdateVolume — fire-and-forget, debounced
 *  by the slider drag upstream). */
export function saveVolumes(originalVolume: number, voiceVolume: number): void {
  chrome.storage.local.set({ originalVolume, voiceVolume }).catch(() => {});
}
