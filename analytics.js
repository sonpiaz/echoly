// analytics.js — minimal PostHog client for the Echoly extension service worker.
//
// MV3 CSP (`script-src 'self'`) forbids loading posthog-js from a CDN, and the
// extension ships as plain files with no bundler — so this hand-rolled client
// POSTs events straight to the PostHog capture endpoint via fetch from the
// background service worker (which has the host permission). Every call is
// fire-and-forget and never throws: analytics must never break a dub session.
//
// Privacy: events are anonymous. A random distinct_id is stored in
// chrome.storage.local — no email, no Kyma key, no provider/routing detail is
// ever sent. Person profiles are disabled ($process_person_profile: false).

const PH_KEY = "phc_sNC4sT7s3xB9Z7wjB3RFxSTKFY5By47fMxN2XVWUoWgU";
const PH_HOST = "https://us.i.posthog.com";
const DISTINCT_ID_STORAGE_KEY = "ph_distinct_id";

let cachedDistinctId = null;

// Stable anonymous id, generated once and persisted. Falls back to an ephemeral
// id if storage is unavailable so events still land.
async function getDistinctId() {
  if (cachedDistinctId) return cachedDistinctId;
  try {
    const got = await chrome.storage.local.get(DISTINCT_ID_STORAGE_KEY);
    let id = got?.[DISTINCT_ID_STORAGE_KEY];
    if (!id) {
      id = crypto.randomUUID();
      await chrome.storage.local.set({ [DISTINCT_ID_STORAGE_KEY]: id });
    }
    cachedDistinctId = id;
    return id;
  } catch {
    cachedDistinctId = cachedDistinctId || crypto.randomUUID();
    return cachedDistinctId;
  }
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
}

// Fire-and-forget event capture. Returns a promise but callers should `void` it.
export async function track(event, properties = {}) {
  try {
    const distinct_id = await getDistinctId();
    await fetch(`${PH_HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        api_key: PH_KEY,
        event,
        distinct_id,
        properties: {
          ...properties,
          $lib: "echoly-extension",
          extension_version: extensionVersion(),
          $process_person_profile: false,
        },
      }),
    });
  } catch {
    // Swallow — analytics failures must stay invisible to the user.
  }
}
