/** chrome.storage.local keys shared between background and popup. */

/** Once true, popup shows locked (not welcome) after sign-out. Set on first successful sign-in. */
export const HAS_EVER_SIGNED_IN_KEY = "echoly_has_ever_signed_in";

export async function markHasEverSignedIn(): Promise<void> {
  try {
    await chrome.storage?.local?.set?.({ [HAS_EVER_SIGNED_IN_KEY]: true });
  } catch {
    /* storage unavailable in tests */
  }
}
