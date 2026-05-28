// Echoly background service worker — single source of truth for session state.
//
// Popup is a passive renderer: it never reads chrome.storage to decide running
// state. Content script owns the WebRTC PeerConnection lifecycle. Background
// glues them: ensureContentScript(tabId) makes Start work without a refresh,
// state.* is the canonical snapshot, BACKGROUND_STATE_UPDATE pushes to popup,
// CONTENT_UPDATE pushes to the active YT tab.

const DEFAULT_SETTINGS = {
  tier: "realtime",
  targetLanguage: "vi",
  realtimeVoice: "marin",
  // Standard tier (Minimax chunked pipeline). Default voice is Magnetic Man,
  // the male voice Son ranked highest in the 2026-05-08 listening test.
  standardVoice: "English_magnetic_voiced_man",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  kymaKey: "",
};

// YouTube CC URL cache. Populated by the webRequest listener below whenever
// YouTube itself fires a /api/timedtext request (which it does when the user
// or our content script toggles the captions button on the player). The URLs
// are signed with the full YouTube session context — Echoly can re-fetch them
// reliably where a manually-constructed plain URL returns 0-byte responses.
// Keyed by YouTube videoId. Manual-sub URLs are preferred over ASR if both are
// observed (we never overwrite a manual entry with an ASR one).
const ytCaptionCache = new Map();
const YT_CACHE_TTL_MS = 30 * 60 * 1000;  // signed URLs expire ~6h, refresh well before
const YT_CACHE_GC_MS = 5 * 60 * 1000;

if (typeof chrome.webRequest?.onCompleted?.addListener === "function") {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      try {
        if (details.statusCode !== 200) return;
        const u = new URL(details.url);
        const videoId = u.searchParams.get("v");
        if (!videoId) return;
        const isAsr = u.searchParams.get("kind") === "asr";
        const existing = ytCaptionCache.get(videoId);
        // Don't downgrade a manual-sub cache entry to an ASR one.
        if (existing && !existing.isAsr && isAsr) return;
        ytCaptionCache.set(videoId, {
          url: details.url,
          lang: u.searchParams.get("lang") || null,
          kind: u.searchParams.get("kind") || null,
          tlang: u.searchParams.get("tlang") || null,
          isAsr,
          capturedAt: Date.now(),
        });
      } catch {
        // Bad URL or odd request shape — ignore, doesn't impact other captures.
      }
    },
    {
      urls: [
        "*://*.youtube.com/api/timedtext*",
        "*://*.youtube-nocookie.com/api/timedtext*",
      ],
    },
  );

  setInterval(() => {
    const cutoff = Date.now() - YT_CACHE_TTL_MS;
    for (const [id, v] of ytCaptionCache) {
      if (v.capturedAt < cutoff) ytCaptionCache.delete(id);
    }
  }, YT_CACHE_GC_MS);
}

// ───── Subscription proxy mode resolution ──────────────────────────────────
// v0.6.1: extension can route translation API calls through Echoly's worker
// proxy when the user is signed in on echolyhq.com. The cookie is HttpOnly
// but chrome.cookies API (privileged) can read it. We send it as Authorization
// Bearer on every call. BYOK (user pastes their own Kyma key) still wins —
// when both are present we use the Kyma key for unlimited at wholesale cost.

const KYMA_DIRECT_BASE = "https://api.kymaapi.com/v1";
const ECHOLY_PROXY_BASE = "https://api.echolyhq.com/v1/proxy";

async function getEcholySessionToken() {
  try {
    const c = await chrome.cookies.get({
      url: "https://echolyhq.com",
      name: "ec_session",
    });
    return c?.value ?? null;
  } catch {
    return null;
  }
}

async function fetchEcholyUser(token) {
  if (!token) return null;
  try {
    const r = await fetch("https://api.echolyhq.com/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.signed_in ? d.user : null;
  } catch {
    return null;
  }
}

// Refresh the popup-visible auth snapshot (signedInUser + apiMode) from
// the cookie. Called on GET_STATE/GET_AUTH so the popup can render the
// signed-in banner without forcing the user to click anything.
async function fetchEcholyUsage(token) {
  if (!token) return null;
  try {
    const r = await fetch("https://api.echolyhq.com/v1/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      standard: d.standard?.used_minutes ?? 0,
      realtime: d.realtime?.used_minutes ?? 0,
    };
  } catch {
    return null;
  }
}

async function refreshAuth() {
  const token = await getEcholySessionToken();
  if (!token) {
    state.signedInUser = null;
    state.usage = null;
    state.apiMode = (state.kymaKey ?? "").trim() ? "byok" : null;
    return;
  }
  const [user, usage] = await Promise.all([
    fetchEcholyUser(token),
    fetchEcholyUsage(token),
  ]);
  state.signedInUser = user;
  state.usage = usage;
  // BYOK still wins when both present — we display "Signed in" but route
  // via Kyma direct so the user's wholesale balance is what we burn.
  state.apiMode = (state.kymaKey ?? "").trim() ? "byok" : user ? "proxy" : null;
}

// Resolve which Kyma-shaped API the content script should hit. BYOK has
// priority — that's the existing v0.5.x flow. If BYOK is empty AND the user
// is signed in on echolyhq.com, we swap to the proxy endpoint with the
// session token as the bearer. content.js stays agnostic — same fetch
// shape, just different URL + bearer value.
async function resolveApiMode(settings) {
  const kymaKey = (settings.kymaKey ?? "").trim();
  if (kymaKey) {
    return { apiBase: KYMA_DIRECT_BASE, apiKey: kymaKey, mode: "byok", user: null };
  }
  const token = await getEcholySessionToken();
  if (token) {
    const user = await fetchEcholyUser(token);
    if (user) {
      return { apiBase: ECHOLY_PROXY_BASE, apiKey: token, mode: "proxy", user };
    }
  }
  return null;
}

// In-memory state. Resets when the service worker cold-starts; that's
// intentional — the user gets a clean idle on cold start.
const state = {
  running: false,
  connecting: false,
  paused: false,
  tabId: null,
  status: "Ready",
  errorMessage: "",
  // Subscription proxy mode (v0.6.1). Populated by resolveApiMode at session
  // start AND on popup-open so the popup can render "Signed in as …".
  apiMode: null,          // "byok" | "proxy" | null
  signedInUser: null,     // { email, tier } or null
  usage: null,            // { standard: minutes, realtime: minutes } — v0.6.2
  ...DEFAULT_SETTINGS,
};

// Restrict storage access so rogue page scripts on youtube.com cannot read
// the user's Kyma key. Sticky, no retry needed.
chrome.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => {});

let lastBroadcastAt = 0;
const BROADCAST_DEBOUNCE_MS = 50;

function snapshot() {
  return { ...state };
}

function broadcastToPopup() {
  // Debounce: 1 broadcast per 50 ms. Popup re-renders are cheap but spamming
  // is wasteful while volume sliders drag.
  const now = Date.now();
  if (now - lastBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
  lastBroadcastAt = now;
  chrome.runtime
    .sendMessage({ type: "BACKGROUND_STATE_UPDATE", state: snapshot() })
    .catch(() => {});
}

async function relayToContent(tabId, message) {
  if (!tabId) throw new Error("No active tab to relay to.");
  return chrome.tabs.sendMessage(tabId, message);
}

function isYouTubeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^/]*youtube\.com\//.test(url);
}

async function activeYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  if (!isYouTubeUrl(tab.url)) throw new Error("Open a YouTube video first.");
  return tab;
}

// Ensure content script is alive in the target tab. PING first; on no-reply,
// inject. This is what makes Start work in tabs that were open before the
// extension was installed or reloaded.
async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    if (reply?.ok) return;
  } catch {
    // Not yet injected.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  // Inserting CSS via scripting API too, since content_scripts manifest entry
  // does not run on the just-injected page if the tab pre-existed extension.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  } catch {
    // CSS may already be present from manifest static match — harmless.
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  Object.assign(state, stored);
  return stored;
}

async function persistSettings(partial) {
  Object.assign(state, partial);
  const persistable = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k in partial) persistable[k] = state[k];
  }
  if (Object.keys(persistable).length) {
    await chrome.storage.local.set(persistable);
  }
}

async function handleStart(settings) {
  if (state.running || state.connecting) {
    return { ok: false, error: "Session already running." };
  }
  await persistSettings(settings || {});

  // v0.6.1: resolve subscription mode before kicking off a session. Either
  // BYOK Kyma key OR Echoly session cookie must be present.
  const mode = await resolveApiMode(state);
  if (!mode) {
    state.errorMessage = "Sign in at echolyhq.com or paste a Kyma key.";
    state.status = state.errorMessage;
    state.connecting = false;
    broadcastToPopup();
    return { ok: false, error: state.errorMessage };
  }
  state.apiMode = mode.mode;
  state.signedInUser = mode.user;

  let tab;
  try {
    tab = await activeYouTubeTab();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  state.tabId = tab.id;
  state.connecting = true;
  state.errorMessage = "";
  state.status = "Connecting";
  broadcastToPopup();

  try {
    await ensureContentScript(tab.id);
    // Inject apiBase + override kymaKey with the resolved bearer. content.js
    // is mode-agnostic — it just uses settings.apiBase and the kymaKey value
    // we hand it as the Authorization bearer for every call.
    const startSettings = {
      ...snapshot(),
      apiBase: mode.apiBase,
      kymaKey: mode.apiKey,
    };
    const reply = await relayToContent(tab.id, {
      type: "CONTENT_START",
      settings: startSettings,
    });
    if (!reply?.ok) {
      throw new Error(reply?.error || "Could not start translation.");
    }
    state.connecting = false;
    state.running = true;
    state.status = "Translating";
    broadcastToPopup();
    return { ok: true, state: snapshot() };
  } catch (err) {
    state.connecting = false;
    state.running = false;
    state.errorMessage = err.message || String(err);
    state.status = state.errorMessage;
    broadcastToPopup();
    return { ok: false, error: state.errorMessage };
  }
}

async function handleStop() {
  const tabId = state.tabId;
  state.running = false;
  state.connecting = false;
  state.paused = false;
  state.status = "Stopped";
  broadcastToPopup();
  if (tabId) {
    try {
      await relayToContent(tabId, { type: "CONTENT_STOP" });
    } catch {
      // Tab may be gone; that's fine.
    }
  }
  state.tabId = null;
  return { ok: true, state: snapshot() };
}

async function handleUpdateSettings(settings) {
  await persistSettings(settings || {});
  broadcastToPopup();
  if (state.tabId && (state.running || state.connecting)) {
    try {
      const reply = await relayToContent(state.tabId, {
        type: "CONTENT_UPDATE_SETTINGS",
        settings: snapshot(),
      });
      if (reply?.state) Object.assign(state, reply.state);
    } catch (err) {
      state.errorMessage = err.message || String(err);
      broadcastToPopup();
    }
  }
  return { ok: true, state: snapshot() };
}

async function handleUpdateVolume(originalVolume, voiceVolume) {
  if (typeof originalVolume === "number") state.originalVolume = originalVolume;
  if (typeof voiceVolume === "number") state.voiceVolume = voiceVolume;
  // Persist debounced — slider drag fires many times.
  chrome.storage.local
    .set({ originalVolume: state.originalVolume, voiceVolume: state.voiceVolume })
    .catch(() => {});

  // state.tabId can be null if the popup is open before Start, or if the
  // service worker cold-started since last Start (in-memory state lost).
  // Fall back to the active YouTube tab so the slider always reaches some
  // content script that can apply the change to videoEl directly.
  let targetTabId = state.tabId;
  if (!targetTabId) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && isYouTubeUrl(tab.url)) targetTabId = tab.id;
    } catch {
      // No active YT tab — nothing to apply against. Silent.
    }
  }

  if (targetTabId) {
    try {
      // Inject content script if the tab pre-existed our extension reload.
      // Without this the message reaches a dead receiver and the slider feels broken.
      await ensureContentScript(targetTabId);
      await relayToContent(targetTabId, {
        type: "CONTENT_UPDATE_VOLUME",
        originalVolume: state.originalVolume,
        voiceVolume: state.voiceVolume,
      });
    } catch {
      // Tab gone or script injection refused; volume will be re-applied next start.
    }
  }
  return { ok: true };
}

// Content-side push: session live state + transient events.
function handleContentEvent(message) {
  if (message.type === "CONTENT_STATE") {
    if (typeof message.running === "boolean") state.running = message.running;
    if (typeof message.paused === "boolean") state.paused = message.paused;
    if (typeof message.status === "string") state.status = message.status;
    if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
    broadcastToPopup();
  }
  if (message.type === "CONTENT_ENDED") {
    state.running = false;
    state.connecting = false;
    state.paused = false;
    state.tabId = null;
    state.status = message.reason || "Stopped";
    broadcastToPopup();
  }
}

// Popup → background → content router.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Cache-lookup from content script — needs a real response (not fire-and-forget).
  // Handled before the generic content-event branch so we don't fall through.
  if (sender.tab && message?.type === "GET_YT_CC_URL") {
    const entry = message.videoId ? ytCaptionCache.get(message.videoId) : null;
    sendResponse({ ok: !!entry, ...(entry || {}) });
    return false;
  }
  // Content-originated messages (have sender.tab).
  if (sender.tab) {
    handleContentEvent(message);
    sendResponse?.({ ok: true });
    return false;
  }

  // Popup-originated messages (no sender.tab).
  (async () => {
    try {
      switch (message?.type) {
        case "GET_STATE":
          await loadSettings();
          // Refresh auth state opportunistically so the popup can render the
          // signed-in banner without an extra round trip.
          await refreshAuth();
          sendResponse({ ok: true, state: snapshot() });
          break;
        case "GET_AUTH":
          await refreshAuth();
          sendResponse({ ok: true, state: snapshot() });
          break;
        case "SIGN_OUT_ECHOLY": {
          const token = await getEcholySessionToken();
          if (token) {
            try {
              await fetch("https://api.echolyhq.com/auth/sign-out", {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
              });
            } catch {}
          }
          // The cookie is HttpOnly + Domain=.echolyhq.com, but chrome.cookies
          // can remove it across the entire registrable-domain scope.
          try {
            await chrome.cookies.remove({ url: "https://echolyhq.com", name: "ec_session" });
            await chrome.cookies.remove({ url: "https://api.echolyhq.com", name: "ec_session" });
          } catch {}
          state.signedInUser = null;
          state.apiMode = null;
          broadcastToPopup();
          sendResponse({ ok: true, state: snapshot() });
          break;
        }
        case "START":
          sendResponse(await handleStart(message.settings));
          break;
        case "STOP":
          sendResponse(await handleStop());
          break;
        case "UPDATE_SETTINGS":
          sendResponse(await handleUpdateSettings(message.settings));
          break;
        case "UPDATE_VOLUME":
          sendResponse(await handleUpdateVolume(
            message.originalVolume,
            message.voiceVolume,
          ));
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message: " + message?.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;  // async sendResponse
});

// Tab close / navigate away → stop session cleanly so Kyma sees the /end.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    void handleStop();
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.tabId) return;
  if (!changeInfo.url) return;
  // YT is a SPA; URL change happens for /watch?v= switches too.
  // Stop on any URL change so the new video starts clean.
  void handleStop();
});

void loadSettings();
