// ────────────────────────────────────────────────────────────────────────────
// Echoly popup — passive renderer. Background owns state. Popup queries
// GET_STATE on open, subscribes to BACKGROUND_STATE_UPDATE pushes, and
// dispatches user actions via runtime messages. Ported verbatim from
// legacy/popup.js (behavior + copy identical), behind a clean TS module.
//
// The popup NEVER touches DOM outside its own document; single input is
// applyState(state), single output is runtime messages (@/shared/protocol).
// ────────────────────────────────────────────────────────────────────────────

import {
  LANGUAGES,
  REALTIME_VOICES,
  STANDARD_VOICES,
} from "@/shared/constants";
import {
  sendToBackground,
  type PopupToBgMessage,
  type PopupToBgResponse,
} from "@/shared/protocol";
import type { State } from "@/shared/types";
import {
  allowRealtime,
  capsForTier,
  fillPercent,
  fmtMin,
  keyBadge as keyBadgeReducer,
  meterLevel,
  nextResetLabel,
  tierBadge as tierBadgeReducer,
} from "@/lib/popup-format";

// ───── Popup-surface option lists ─────
// The popup renders the "Auto" voice with the longer label "Auto · clones
// speaker" (the overlay renders just "Auto"). Both derive from the SAME shared
// REALTIME_VOICES data; only the surface-specific label differs. Standard
// voices share the [id, label] form with the overlay.
interface VoiceOption {
  id: string;
  name: string;
}
const POPUP_REALTIME_VOICES: VoiceOption[] = [
  { id: "", name: "Auto · clones speaker" },
  ...REALTIME_VOICES.map((v) => ({
    id: v,
    name: v.charAt(0).toUpperCase() + v.slice(1),
  })),
];
const POPUP_STANDARD_VOICES: VoiceOption[] = STANDARD_VOICES.map(
  ([id, name]) => ({ id, name }),
);

export function initPopup(): void {
  const $ = (id: string) => document.getElementById(id);
  const tierSelect = $("tier") as HTMLSelectElement;
  const voiceSelect = $("voice") as HTMLSelectElement;
  const langSelect = $("lang") as HTMLSelectElement;
  const kymaKeyInput = $("kymaKey") as HTMLInputElement;
  const keyBadge = $("keyBadge") as HTMLElement;
  const toggleBtn = $("toggle") as HTMLButtonElement;
  const statusEl = $("status") as HTMLElement;
  const originalVolumeInput = $("originalVolume") as HTMLInputElement;
  const voiceVolumeInput = $("voiceVolume") as HTMLInputElement;
  const originalOut = $("originalOut") as HTMLOutputElement;
  const voiceOut = $("voiceOut") as HTMLOutputElement;
  const showSourceCheckbox = $("showSource") as HTMLInputElement;
  const accountBand = document.getElementById("account-band");
  const acctEmailEl = document.getElementById("acct-email");
  const acctTierEl = document.getElementById("acct-tier");
  const signOutBtn = document.getElementById("signOutBtn");
  const tierBadge = document.getElementById("tier-badge");
  const usageStdBlock = document.getElementById("usage-std");
  const usageStdLabel = document.getElementById("usage-std-label");
  const usageStdUsed = document.getElementById("usage-std-used");
  const usageStdCap = document.getElementById("usage-std-cap");
  const usageStdFill = document.getElementById("usage-std-fill");
  const usageRtBlock = document.getElementById("usage-rt");
  const usageRtUsed = document.getElementById("usage-rt-used");
  const usageRtCap = document.getElementById("usage-rt-cap");
  const usageRtFill = document.getElementById("usage-rt-fill");
  const usageHint = document.getElementById("usage-hint");

  // Local mirror of the background state (the only fields the popup reads).
  let state: Partial<State> = {
    running: false,
    connecting: false,
    paused: false,
    tier: "realtime",
    targetLanguage: "vi",
    realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man",
    originalVolume: 18,
    voiceVolume: 100,
    showSource: false,
    kymaKey: "",
    status: "Ready",
  };

  function populateLanguages() {
    for (const [code, name] of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      langSelect.appendChild(opt);
    }
  }

  // Voice list swaps between tiers. Called whenever the tier changes so the
  // dropdown only shows valid voices for the current pipeline. Tries to keep
  // the prior selection if the new tier has a matching id; otherwise falls
  // back to the first option.
  function repopulateVoices(tier: string, preferredVoiceId?: string) {
    const list =
      tier === "standard" ? POPUP_STANDARD_VOICES : POPUP_REALTIME_VOICES;
    voiceSelect.replaceChildren();
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    }
    const wanted = preferredVoiceId ?? "";
    const match = Array.from(voiceSelect.options).some(
      (o) => o.value === wanted,
    );
    voiceSelect.value = match ? wanted : list[0]!.id;
  }

  function send<T extends PopupToBgMessage["type"]>(
    message: Extract<PopupToBgMessage, { type: T }>,
  ): Promise<PopupToBgResponse[T]> {
    return sendToBackground(message);
  }

  function isBenign(msg: string | undefined): boolean {
    if (!msg) return false;
    return /message channel closed|asynchronous response|message port closed|Receiving end does not exist/i.test(
      msg,
    );
  }

  function setStateClass(name: string) {
    document.body.dataset.state = name;
  }

  function setKeyBadge(k: string) {
    const { label, cls } = keyBadgeReducer(k);
    keyBadge.classList.remove("ok", "warn");
    keyBadge.textContent = label;
    if (cls) keyBadge.classList.add(cls);
  }

  function renderTierBadge(tier: string | undefined, hasKey: boolean) {
    if (!tierBadge) return;
    const { label, dataTier } = tierBadgeReducer(tier, hasKey);
    tierBadge.dataset.tier = dataTier;
    tierBadge.textContent = label;
  }

  function renderAccountBand(
    user: State["signedInUser"] | undefined,
    kymaKey: string | undefined,
    usage: State["usage"] | undefined,
  ) {
    if (!accountBand) return;
    const hasKey = !!(kymaKey || "").trim();

    // BYOK takes top priority — even when signed in.
    if (hasKey) {
      accountBand.dataset.state = "byok";
      renderTierBadge(user?.tier || "free", true);
      return;
    }
    if (user) {
      accountBand.dataset.state = "in";
      renderTierBadge(user.tier || "free", false);
      if (acctEmailEl) acctEmailEl.textContent = user.email || "";
      if (acctTierEl) {
        const tier = user.tier || "free";
        acctTierEl.textContent =
          tier === "max" ? "Max plan" : tier === "pro" ? "Pro plan" : "Free tier";
        acctTierEl.dataset.tier = tier;
      }
      renderUsageMeters(user.tier || "free", usage);
    } else {
      accountBand.dataset.state = "out";
      renderTierBadge("free", false);
    }
  }

  function renderUsageMeters(tier: string, usage: State["usage"] | undefined) {
    if (!usageStdBlock) return;
    const c = capsForTier(tier);
    const u = usage || { standard: 0, realtime: 0 };

    // Standard meter — always shown for signed-in users.
    usageStdBlock.hidden = false;
    if (usageStdLabel) usageStdLabel.textContent = "Standard";
    if (usageStdUsed) usageStdUsed.textContent = fmtMin(u.standard);
    if (usageStdCap) usageStdCap.textContent = fmtMin(c.std);
    if (usageStdFill) {
      (usageStdFill as HTMLElement).style.width = `${fillPercent(
        u.standard,
        c.std,
      )}%`;
      (usageStdFill as HTMLElement).dataset.level = meterLevel(
        u.standard,
        c.std,
      );
    }

    // Realtime meter — Max only.
    if (c.rt > 0) {
      if (usageRtBlock) usageRtBlock.hidden = false;
      if (usageRtUsed) usageRtUsed.textContent = fmtMin(u.realtime);
      if (usageRtCap) usageRtCap.textContent = fmtMin(c.rt);
      if (usageRtFill) {
        (usageRtFill as HTMLElement).style.width = `${fillPercent(
          u.realtime,
          c.rt,
        )}%`;
        (usageRtFill as HTMLElement).dataset.level = meterLevel(
          u.realtime,
          c.rt,
        );
      }
    } else if (usageRtBlock) {
      usageRtBlock.hidden = true;
    }

    if (usageHint) {
      usageHint.hidden = false;
      usageHint.textContent = `Resets ${nextResetLabel()}`;
    }
  }

  function applyState(s: Partial<State>) {
    state = { ...state, ...s };
    renderAccountBand(state.signedInUser, state.kymaKey, state.usage ?? null);
    if (typeof state.tier === "string") {
      const allowed = state.tier === "standard" ? "standard" : "realtime";
      if (tierSelect.value !== allowed) tierSelect.value = allowed;
    }
    if (typeof state.targetLanguage === "string")
      langSelect.value = state.targetLanguage;
    // Voice list depends on tier — repopulate then select the saved id for
    // the current tier (realtimeVoice when realtime, standardVoice when standard).
    const activeVoice =
      tierSelect.value === "standard"
        ? state.standardVoice
        : state.realtimeVoice;
    repopulateVoices(tierSelect.value, activeVoice);
    if (typeof state.originalVolume === "number") {
      originalVolumeInput.value = String(state.originalVolume);
      originalOut.textContent = String(state.originalVolume);
    }
    if (typeof state.voiceVolume === "number") {
      voiceVolumeInput.value = String(state.voiceVolume);
      voiceOut.textContent = String(state.voiceVolume);
    }
    if (typeof state.showSource === "boolean")
      showSourceCheckbox.checked = state.showSource;
    if (typeof state.kymaKey === "string") {
      if (kymaKeyInput.value !== state.kymaKey)
        kymaKeyInput.value = state.kymaKey;
      setKeyBadge(state.kymaKey);
    }

    // Status + button
    if (state.connecting) {
      setStateClass("connecting");
      statusEl.textContent = state.status || "Connecting";
      toggleBtn.textContent = "Stop";
      toggleBtn.classList.add("is-live");
    } else if (state.running && state.paused) {
      setStateClass("paused");
      statusEl.textContent = "Paused.";
      toggleBtn.textContent = "Stop";
      toggleBtn.classList.add("is-live");
    } else if (state.running) {
      setStateClass("active");
      const langName =
        LANGUAGES.find(([c]) => c === state.targetLanguage)?.[1] ||
        state.targetLanguage;
      statusEl.textContent = `Translating to ${langName}.`;
      toggleBtn.textContent = "Stop";
      toggleBtn.classList.add("is-live");
    } else if (state.errorMessage) {
      setStateClass("error");
      statusEl.textContent = state.errorMessage;
      toggleBtn.textContent = "Start";
      toggleBtn.classList.remove("is-live");
    } else {
      setStateClass("idle");
      // Ready when EITHER BYOK key OR signed-in echolyhq session.
      if ((state.kymaKey || "").trim() || state.signedInUser) {
        statusEl.textContent = "Ready.";
      } else {
        statusEl.textContent = "Sign in or paste a Kyma key to start.";
      }
      toggleBtn.textContent = "Start";
      toggleBtn.classList.remove("is-live");
    }
    toggleBtn.disabled = false;
    // Gate Realtime option in the tier dropdown by user.tier === "max" || BYOK.
    // Non-Max signed-in users see Realtime grayed with a "(Max only)" hint.
    applyTierGating();
  }

  function applyTierGating() {
    if (!tierSelect) return;
    const allow = allowRealtime(state.signedInUser?.tier, state.kymaKey || "");
    for (const opt of tierSelect.options) {
      if (opt.value === "realtime") {
        opt.disabled = !allow;
        if (!allow && !opt.textContent!.includes("(Max only)")) {
          opt.textContent =
            opt.textContent!.replace(/ \(Max only\)$/, "") + " (Max only)";
        } else if (allow) {
          opt.textContent = opt.textContent!.replace(/ \(Max only\)$/, "");
        }
      }
    }
    // If the user is currently on Realtime but no longer allowed, flip them
    // to Standard so the next Start doesn't error.
    if (!allow && tierSelect.value === "realtime") {
      tierSelect.value = "standard";
      repopulateVoices("standard", state.standardVoice);
    }
  }

  function readSettings() {
    // Only write the voice key for the active tier so the other tier's saved
    // pick survives a tier toggle round-trip without being clobbered.
    const tier = tierSelect.value as "realtime" | "standard";
    const voiceKey = tier === "standard" ? "standardVoice" : "realtimeVoice";
    return {
      tier,
      targetLanguage: langSelect.value,
      [voiceKey]: voiceSelect.value,
      originalVolume: Number(originalVolumeInput.value),
      voiceVolume: Number(voiceVolumeInput.value),
      showSource: showSourceCheckbox.checked,
      kymaKey: kymaKeyInput.value.trim(),
    };
  }

  async function pushSettings() {
    try {
      const reply = await send({
        type: "UPDATE_SETTINGS",
        settings: readSettings(),
      });
      if (reply?.ok && reply.state) applyState(reply.state);
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) {
        statusEl.textContent = msg;
        setStateClass("error");
      }
    }
  }

  let volumeDebounce: ReturnType<typeof setTimeout> | null = null;
  function onVolumeChange() {
    originalOut.textContent = originalVolumeInput.value;
    voiceOut.textContent = voiceVolumeInput.value;
    if (volumeDebounce) clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => {
      void chrome.runtime
        .sendMessage({
          type: "UPDATE_VOLUME",
          originalVolume: Number(originalVolumeInput.value),
          voiceVolume: Number(voiceVolumeInput.value),
        })
        ?.catch?.(() => {});
    }, 60);
  }

  async function onToggle() {
    toggleBtn.disabled = true;
    try {
      if (state.running || state.connecting) {
        const reply = await send({ type: "STOP" });
        if (reply?.ok && reply.state) applyState(reply.state);
        else applyState({ running: false, connecting: false, paused: false });
      } else {
        const settings = readSettings();
        // BYOK Kyma key OR signed-in echolyhq.com session is enough.
        // Background.resolveApiMode picks the right one (BYOK wins).
        if (!settings.kymaKey && !state.signedInUser) {
          statusEl.textContent = "Sign in or paste a Kyma key.";
          setStateClass("error");
          toggleBtn.disabled = false;
          return;
        }
        // Realtime is Max-tier only via the server proxy. BYOK users can run
        // realtime regardless (their Kyma key, their balance).
        const userTier = state.signedInUser?.tier;
        const isRealtime = settings.tier === "realtime";
        const hasByok = !!(settings.kymaKey || "").trim();
        if (isRealtime && !hasByok && userTier !== "max") {
          statusEl.textContent =
            "Realtime is a Max-tier feature. Upgrade or paste a Kyma key.";
          setStateClass("error");
          toggleBtn.disabled = false;
          return;
        }
        const reply = await send({ type: "START", settings });
        if (!reply?.ok) {
          statusEl.textContent =
            (reply as { error?: string })?.error || "Could not start.";
          setStateClass("error");
          toggleBtn.disabled = false;
          return;
        }
        if (reply.state) applyState(reply.state);
      }
    } catch (err) {
      toggleBtn.disabled = false;
      const msg = (err as Error).message;
      if (isBenign(msg)) return;
      statusEl.textContent = msg;
      setStateClass("error");
    }
  }

  // ───── Events ─────
  tierSelect.addEventListener("change", () => {
    // Swap the voice list to match the new tier and pick the saved voice for
    // that tier (realtimeVoice when realtime, standardVoice when standard).
    // Then push settings so background restarts the session on the new pipeline.
    const tier = tierSelect.value;
    const wanted =
      tier === "standard" ? state.standardVoice : state.realtimeVoice;
    repopulateVoices(tier, wanted);
    void pushSettings();
  });
  voiceSelect.addEventListener("change", () => void pushSettings());
  langSelect.addEventListener("change", () => void pushSettings());
  showSourceCheckbox.addEventListener("change", () => void pushSettings());
  kymaKeyInput.addEventListener("input", () =>
    setKeyBadge(kymaKeyInput.value.trim()),
  );
  kymaKeyInput.addEventListener("change", () => void pushSettings());
  originalVolumeInput.addEventListener("input", onVolumeChange);
  voiceVolumeInput.addEventListener("input", onVolumeChange);
  toggleBtn.addEventListener("click", () => void onToggle());

  // Sign-out from the echolyhq.com cookie (works without opening a tab).
  signOutBtn?.addEventListener("click", async () => {
    (signOutBtn as HTMLButtonElement).disabled = true;
    try {
      const reply = await send({ type: "SIGN_OUT_ECHOLY" });
      if (reply?.ok && reply.state) applyState(reply.state);
      else applyState({ signedInUser: null, apiMode: null });
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) {
        statusEl.textContent = msg;
        setStateClass("error");
      }
    } finally {
      (signOutBtn as HTMLButtonElement).disabled = false;
    }
  });

  // Background push subscription
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BACKGROUND_STATE_UPDATE" && message.state) {
      applyState(message.state);
    }
  });

  // Init
  populateLanguages();
  repopulateVoices(
    state.tier!,
    state.tier === "standard" ? state.standardVoice : state.realtimeVoice,
  );
  void (async () => {
    try {
      const reply = await send({ type: "GET_STATE" });
      if (reply?.ok && reply.state) applyState(reply.state);
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) {
        statusEl.textContent = msg;
        setStateClass("error");
      }
    }
  })();
}
