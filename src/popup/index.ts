// ────────────────────────────────────────────────────────────────────────────
// Echoly popup — V5 passive renderer.
// Background owns state; popup queries GET_STATE on open, subscribes to
// BACKGROUND_STATE_UPDATE pushes, and dispatches user actions via runtime
// messages. The popup NEVER touches DOM outside its own document; single
// input is applyState(state), single output is runtime messages.
//
// Account states (body[data-account]):
//   "welcome" — first ever open (chrome.storage.local !hasEverSignedIn)
//   "locked"  — returning user, signed out (hasEverSignedIn=true, no session)
//   "in"      — signed in (signedInUser !== null)
//   "loading" — transient at boot, before GET_STATE resolves
// ────────────────────────────────────────────────────────────────────────────

import {
  LANG_NAME,
  LANGUAGES,
  REALTIME_VOICES,
  STANDARD_VOICES,
  type LangPair,
} from "@/shared/constants";
import {
  sendToBackground,
  type PopupToBgMessage,
  type PopupToBgResponse,
} from "@/shared/protocol";
import type { State } from "@/shared/types";
import {
  DEFAULT_ADVANCED,
  effectiveAdvanced,
  normalizeDomain,
  type AdvancedSettings,
  type CaptionPosition,
  type LatencyPreset,
  type TranslationStyle,
} from "@/shared/advanced";
import {
  capsForTier,
  fillPercent,
  fmtElapsed,
  fmtMin,
  meterLevel,
  nextResetLabel,
  shade,
} from "@/lib/popup-format";
import { attachDropdown, type DropdownItem, type DropdownHandle } from "./dropdown";
import { attachPopover } from "./popover";

// Local key under chrome.storage.local: once true, popup skips Welcome and
// shows Locked instead. Set by background on first sign-in; popup reads on
// every open. Never cleared.
const HAS_EVER_SIGNED_IN_KEY = "echoly_has_ever_signed_in";

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

interface RowMeta { primary: string; secondary: string; }
const TIER_META: Record<string, RowMeta> = {
  realtime: { primary: "Realtime", secondary: "· <1s · clones speaker" },
  standard: { primary: "Standard", secondary: "· ~5s lag · cheaper" },
};

interface VoiceMeta { swatch: string; tagline: string; }
const VOICE_META: Record<string, VoiceMeta> = {
  marin:   { swatch: "#7B5BFF", tagline: "· warm female · US" },
  cedar:   { swatch: "#2A6FDB", tagline: "· calm male · US" },
  alloy:   { swatch: "#7B5BFF", tagline: "· neutral · US" },
  ash:     { swatch: "#5A3DB8", tagline: "· clear male · US" },
  ballad:  { swatch: "#8B5BFF", tagline: "· lyrical · US" },
  coral:   { swatch: "#FF6FB1", tagline: "· bright female · US" },
  echo:    { swatch: "#2A6FDB", tagline: "· steady male · US" },
  sage:    { swatch: "#1F8A5B", tagline: "· thoughtful · US" },
  shimmer: { swatch: "#D9A441", tagline: "· airy female · US" },
  verse:   { swatch: "#E76A4A", tagline: "· expressive · US" },
  English_magnetic_voiced_man: { swatch: "#7B5BFF", tagline: "· magnetic · EN" },
  English_captivating_female1: { swatch: "#FF6FB1", tagline: "· captivating · EN" },
  English_ManWithDeepVoice:    { swatch: "#5A3DB8", tagline: "· deep · EN" },
  English_ConfidentWoman:      { swatch: "#E76A4A", tagline: "· confident · EN" },
  "Chinese (Mandarin)_News_Anchor": { swatch: "#1F8A5B", tagline: "· anchor · ZH" },
};
const DEFAULT_VOICE_META: VoiceMeta = { swatch: "#8B5BFF", tagline: "" };

export function initPopup(): void {
  const $ = (id: string) => document.getElementById(id);

  // ── Core form bindings ────────────────────────────────────────────────
  const tierSelect = $("tier") as HTMLSelectElement;
  const voiceSelect = $("voice") as HTMLSelectElement;
  const langSelect = $("lang") as HTMLSelectElement;
  const toggleBtn = $("toggle") as HTMLButtonElement;
  const statusEl = $("status") as HTMLElement;
  const originalVolumeInput = $("originalVolume") as HTMLInputElement;
  const voiceVolumeInput = $("voiceVolume") as HTMLInputElement;
  const originalOut = $("originalOut") as HTMLOutputElement;
  const voiceOut = $("voiceOut") as HTMLOutputElement;
  const showSourceCheckbox = $("showSource") as HTMLInputElement;
  const actionLabelEl = $("actionLabel");

  // ── Header chips / avatar ─────────────────────────────────────────────
  const planBadge = $("plan-badge");
  const planBadgeText = $("plan-badge-text");
  const accountTrigger = $("account-trigger");
  const accountAvatarInitial = $("account-avatar-initial");

  // ── Row labels (tier/voice/translating) ───────────────────────────────
  const tierPrimary = $("tier-primary");
  const tierSecondary = $("tier-secondary");
  const voicePrimary = $("voice-primary");
  const voiceSecondary = $("voice-secondary");
  const voiceAvatarRow = $("voice-avatar");
  const tgtName = $("tgt-name");
  const tgtFlag = $("tgt-flag");

  // ── Live summary + stats ──────────────────────────────────────────────
  const liveTargetFlag = $("live-target-flag");
  const liveSrcFlag = $("live-src-flag");
  const liveVoiceAvatar = $("live-voice-avatar");
  const liveVoiceName = $("live-voice-name");
  const elapsedEl = $("elapsed");

  // ── Usage hint row + account menu meters ──────────────────────────────
  const usageHintAmount = $("usage-hint-amount");
  const usageHintLabel = $("usage-hint-label");
  const usageHintReset = $("usage-hint-reset");

  const accountMenuPanel = $("account-menu");
  const accountMenuDim = $("account-menu-dim");
  const amAvatar = $("am-avatar");
  const amEmail = $("am-email");
  const amPlanBadge = $("am-plan-badge");
  const amPlanBadgeText = $("am-plan-badge-text");
  const amDaysLeft = $("am-days-left");
  const amReset = $("am-reset");
  const umStdUsed = $("um-std-used");
  const umStdCap = $("um-std-cap");
  const umStdFill = $("um-std-fill");
  const umStdNumbers = umStdUsed?.parentElement;
  const umRtBlock = $("um-rt");
  const umRtUsed = $("um-rt-used");
  const umRtCap = $("um-rt-cap");
  const umRtFill = $("um-rt-fill");
  const umRtNumbers = umRtUsed?.parentElement;

  // ── Advanced V2 controls (server-authoritative; popup is a dispatcher) ─
  const advReset = $("advResetBtn") as HTMLButtonElement | null;
  const advSave = $("advSaveBtn") as HTMLButtonElement | null;
  const autoStart = $("autoStart") as HTMLInputElement | null;
  const autoStartDomain = $("autoStartDomain");
  const outputDeviceSelect = $("outputDevice") as HTMLSelectElement | null;
  const advDirtyPill = $("advDirtyPill");

  // Footer version chip
  const versionEl = document.querySelector<HTMLElement>(".status-footer .version");
  try {
    const v = chrome.runtime?.getManifest?.()?.version;
    if (versionEl && v) versionEl.textContent = `v${v}`;
  } catch { /* unit-test JSDOM */ }

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
    status: "Ready",
    advanced: { ...DEFAULT_ADVANCED },
    siteOverrides: {},
    advancedVersion: 0,
    advancedDirty: false,
    currentDomain: null,
  };
  let hasEverSignedIn = false;

  // ── Helpers ───────────────────────────────────────────────────────────
  function send<T extends PopupToBgMessage["type"]>(
    message: Extract<PopupToBgMessage, { type: T }>,
  ): Promise<PopupToBgResponse[T]> {
    return sendToBackground(message);
  }
  function isBenign(msg: string | undefined): boolean {
    if (!msg) return false;
    return /message channel closed|asynchronous response|message port closed|Receiving end does not exist/i.test(msg);
  }
  function setStateClass(name: string) {
    document.body.dataset.state = name;
  }
  function setAccountClass(name: "welcome" | "locked" | "in" | "loading") {
    document.body.dataset.account = name;
  }

  function populateLanguages(subset?: readonly LangPair[]) {
    const list = subset ?? LANGUAGES;
    langSelect.replaceChildren();
    for (const [code, name] of list) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      langSelect.appendChild(opt);
    }
  }
  function repopulateVoices(tier: string, preferredVoiceId?: string) {
    const list = tier === "standard" ? POPUP_STANDARD_VOICES : POPUP_REALTIME_VOICES;
    voiceSelect.replaceChildren();
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    }
    const wanted = preferredVoiceId ?? "";
    const match = Array.from(voiceSelect.options).some((o) => o.value === wanted);
    voiceSelect.value = match ? wanted : list[0]!.id;
  }

  function setActionLabel(text: string) {
    if (actionLabelEl) actionLabelEl.textContent = text;
    else toggleBtn.textContent = text;
  }

  function setSliderFill(input: HTMLInputElement) {
    const min = Number(input.min || "0");
    const max = Number(input.max || "100");
    const val = Number(input.value || "0");
    const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
    input.style.setProperty("--v", `${pct}%`);
  }

  // ── Plan badge / avatar ───────────────────────────────────────────────
  function planFromTier(tier: string | undefined): "free" | "pro" | "max" {
    return tier === "max" ? "max" : tier === "pro" ? "pro" : "free";
  }
  function renderPlanBadge(elem: HTMLElement | null, textEl: HTMLElement | null,
                           tier: string | undefined) {
    if (!elem) return;
    const plan = planFromTier(tier);
    elem.dataset.plan = plan;
    if (textEl) textEl.textContent = plan.toUpperCase();
  }
  function renderAccountAvatar(user: State["signedInUser"] | undefined | null) {
    const initial = (user?.email?.[0] ?? "·").toUpperCase();
    if (accountAvatarInitial) accountAvatarInitial.textContent = initial;
    if (amAvatar) amAvatar.textContent = initial;
  }

  // ── Tier / Voice / Lang rows ──────────────────────────────────────────
  function activeVoiceId(): string {
    return (state.tier === "standard" ? state.standardVoice : state.realtimeVoice) ?? "";
  }
  function lookupVoiceLabel(): string {
    const tier = state.tier === "standard" ? "standard" : "realtime";
    const list = tier === "standard" ? POPUP_STANDARD_VOICES : POPUP_REALTIME_VOICES;
    const id = activeVoiceId();
    const found = list.find((v) => v.id === id) ?? list[0] ?? null;
    const raw = found?.name ?? "Voice";
    return raw.split("·")[0]!.trim() || raw;
  }
  function voiceMeta(): VoiceMeta {
    return VOICE_META[activeVoiceId()] ?? DEFAULT_VOICE_META;
  }
  function applyVoiceAvatarBackground(el: HTMLElement | null) {
    if (!el) return;
    const m = voiceMeta();
    el.style.background = `linear-gradient(135deg, ${m.swatch}, ${shade(m.swatch, -18)})`;
  }
  function renderTierRow() {
    const meta = TIER_META[tierSelect.value] ?? TIER_META.realtime!;
    if (tierPrimary) tierPrimary.textContent = meta.primary;
    if (tierSecondary) {
      // Realtime gating: only Max-tier users can use realtime
      const isPaid = state.signedInUser?.tier === "max";
      const gated = tierSelect.value === "realtime" && !isPaid && !!state.signedInUser;
      tierSecondary.textContent = gated ? "· Max only" : meta.secondary;
      tierSecondary.dataset.gated = gated ? "true" : "false";
    }
  }
  function renderVoiceRow() {
    const name = lookupVoiceLabel();
    const meta = voiceMeta();
    if (voicePrimary) voicePrimary.textContent = name;
    if (voiceSecondary) voiceSecondary.textContent = meta.tagline;
    if (voiceAvatarRow) {
      voiceAvatarRow.textContent = (name[0] || "·").toUpperCase();
      applyVoiceAvatarBackground(voiceAvatarRow);
    }
  }
  function renderTargetLang(code: string) {
    const c = (code || "vi").slice(0, 2);
    if (tgtName) tgtName.textContent = LANG_NAME[c] ?? c;
    if (tgtFlag) tgtFlag.textContent = c.toUpperCase();
  }
  function updateLiveSummary() {
    const code = (state.targetLanguage || "vi").slice(0, 2);
    if (liveTargetFlag) liveTargetFlag.textContent = code.toUpperCase();
    if (liveSrcFlag) liveSrcFlag.textContent = "??";
    const voiceName = lookupVoiceLabel();
    if (liveVoiceName) liveVoiceName.textContent = voiceName;
    if (liveVoiceAvatar) {
      liveVoiceAvatar.textContent = voiceName.charAt(0).toUpperCase() || "·";
      applyVoiceAvatarBackground(liveVoiceAvatar);
    }
  }

  // ── Elapsed timer ─────────────────────────────────────────────────────
  let elapsedInterval: ReturnType<typeof setInterval> | null = null;
  function paintElapsed() {
    if (!elapsedEl) return;
    const startedAt = state.sessionStartedAt ?? null;
    if (startedAt == null) {
      elapsedEl.textContent = "00:00";
      return;
    }
    elapsedEl.textContent = fmtElapsed(Math.floor((Date.now() - startedAt) / 1000));
  }
  function startElapsedTimer() {
    paintElapsed();
    if (elapsedInterval) return;
    elapsedInterval = setInterval(paintElapsed, 1000);
  }
  function stopElapsedTimer() {
    if (elapsedInterval !== null) { clearInterval(elapsedInterval); elapsedInterval = null; }
    if (elapsedEl) elapsedEl.textContent = "00:00";
  }

  // ── Usage hint + account menu meters ──────────────────────────────────
  function renderUsageHint(tier: string | undefined,
                          usage: State["usage"] | undefined) {
    const caps = capsForTier(tier);
    const used = usage ?? { standard: 0, realtime: 0 };
    // Show Realtime remaining if the tier has rt allowance, else Standard.
    const isRt = caps.rt > 0;
    const remaining = isRt
      ? Math.max(0, caps.rt - used.realtime)
      : Math.max(0, caps.std - used.standard);
    if (usageHintAmount) usageHintAmount.textContent = `${remaining} min`;
    if (usageHintLabel)
      usageHintLabel.textContent = isRt ? "Realtime left this month" : "Standard left this month";
    if (usageHintReset) usageHintReset.textContent = nextResetLabel();
  }

  function renderAccountMenu(user: State["signedInUser"] | undefined | null,
                             usage: State["usage"] | undefined | null) {
    if (!user) return;
    if (amEmail) amEmail.textContent = user.email;
    renderPlanBadge(amPlanBadge, amPlanBadgeText, user.tier);

    // Days left from subscriptionExpiresAt (optional field; hide if absent)
    const expiresAt = (user as { subscriptionExpiresAt?: number | null })
      .subscriptionExpiresAt ?? null;
    if (amDaysLeft) {
      if (expiresAt && Number.isFinite(expiresAt)) {
        const days = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
        amDaysLeft.textContent = `· ${days} days left`;
        amDaysLeft.hidden = false;
      } else {
        amDaysLeft.hidden = true;
        amDaysLeft.textContent = "";
      }
    }
    if (amReset) amReset.textContent = `resets ${nextResetLabel()}`;

    const caps = capsForTier(user.tier);
    const u = usage ?? { standard: 0, realtime: 0 };
    if (umStdUsed) umStdUsed.textContent = fmtMin(u.standard);
    if (umStdCap)  umStdCap.textContent  = fmtMin(caps.std);
    if (umStdFill) (umStdFill as HTMLElement).style.width = `${fillPercent(u.standard, caps.std)}%`;
    if (umStdNumbers)
      (umStdNumbers as HTMLElement).dataset.low = meterLevel(u.standard, caps.std) !== "ok" ? "true" : "false";
    if (umRtBlock) umRtBlock.hidden = caps.rt === 0;
    if (caps.rt > 0) {
      if (umRtUsed) umRtUsed.textContent = fmtMin(u.realtime);
      if (umRtCap)  umRtCap.textContent  = fmtMin(caps.rt);
      if (umRtFill) (umRtFill as HTMLElement).style.width = `${fillPercent(u.realtime, caps.rt)}%`;
      if (umRtNumbers)
        (umRtNumbers as HTMLElement).dataset.low = meterLevel(u.realtime, caps.rt) !== "ok" ? "true" : "false";
    }
  }

  // ── Account-state decider ─────────────────────────────────────────────
  function decideAccountState(user: State["signedInUser"] | undefined | null): "welcome" | "locked" | "in" {
    if (user) return "in";
    return hasEverSignedIn ? "locked" : "welcome";
  }

  // ── applyState ────────────────────────────────────────────────────────
  function applyState(s: Partial<State>) {
    state = { ...state, ...s };

    // Body class for account state
    const acct = decideAccountState(state.signedInUser);
    setAccountClass(acct);

    // Plan badge / avatar
    renderPlanBadge(planBadge, planBadgeText, state.signedInUser?.tier);
    renderAccountAvatar(state.signedInUser);

    // Account menu identity + meters
    renderAccountMenu(state.signedInUser, state.usage ?? null);

    // Tier picker mirror
    if (typeof state.tier === "string") {
      const allowed = state.tier === "standard" ? "standard" : "realtime";
      if (tierSelect.value !== allowed) tierSelect.value = allowed;
    }

    // Target language picker
    populateLanguages();
    if (typeof state.targetLanguage === "string") {
      langSelect.value = state.targetLanguage;
      renderTargetLang(state.targetLanguage);
    }

    // Voice list depends on tier
    const activeVoice = tierSelect.value === "standard" ? state.standardVoice : state.realtimeVoice;
    repopulateVoices(tierSelect.value, activeVoice);
    renderTierRow();
    renderVoiceRow();

    if (typeof state.originalVolume === "number") {
      originalVolumeInput.value = String(state.originalVolume);
      originalOut.textContent = String(state.originalVolume);
      setSliderFill(originalVolumeInput);
    }
    if (typeof state.voiceVolume === "number") {
      voiceVolumeInput.value = String(state.voiceVolume);
      voiceOut.textContent = String(state.voiceVolume);
      setSliderFill(voiceVolumeInput);
    }
    if (typeof state.showSource === "boolean")
      showSourceCheckbox.checked = state.showSource;

    // Status + toggle button
    if (state.connecting) {
      setStateClass("connecting");
      statusEl.textContent = state.status || "Connecting";
      setActionLabel("Stop translating");
      toggleBtn.classList.add("is-live");
    } else if (state.running && state.paused) {
      setStateClass("paused");
      statusEl.textContent = "Paused.";
      setActionLabel("Stop translating");
      toggleBtn.classList.add("is-live");
    } else if (state.running) {
      setStateClass("active");
      const langName = LANGUAGES.find(([c]) => c === state.targetLanguage)?.[1] || state.targetLanguage;
      statusEl.textContent = `Translating to ${langName}.`;
      setActionLabel("Stop translating");
      toggleBtn.classList.add("is-live");
    } else if (state.errorMessage) {
      setStateClass("error");
      statusEl.textContent = state.errorMessage;
      setActionLabel("Start translating");
      toggleBtn.classList.remove("is-live");
    } else {
      setStateClass("idle");
      if (acct === "in") statusEl.textContent = "Ready.";
      else if (acct === "locked") statusEl.textContent = "Signed out · settings read-only";
      else statusEl.textContent = "Sign in to start";
      setActionLabel("Start translating");
      toggleBtn.classList.remove("is-live");
    }

    // LIVE badge override on plan-badge: when running, show LIVE-styled chip
    if ((state.running || state.connecting) && planBadge && planBadgeText) {
      planBadge.dataset.plan = "max";
      planBadgeText.textContent = "LIVE";
    }

    updateLiveSummary();
    if (state.running || state.connecting) startElapsedTimer();
    else stopElapsedTimer();

    toggleBtn.disabled = false;
    renderUsageHint(state.signedInUser?.tier, state.usage ?? undefined);

    // Advanced section reflection — segmented buttons, output device, auto-start,
    // save-button gating, dirty pill. Reads from state.advanced (the effective
    // value, merged with the per-site override when currentDomain is set).
    renderAdvanced();
  }

  /** Compute the effective Advanced settings for the active domain. */
  function effectiveAdv(): AdvancedSettings {
    const base = state.advanced ?? DEFAULT_ADVANCED;
    const overrides = state.siteOverrides ?? {};
    return effectiveAdvanced(base, overrides, state.currentDomain ?? null);
  }

  /** Sync DOM to state.advanced. Idempotent. */
  function renderAdvanced() {
    const adv = effectiveAdv();
    // Segmented buttons (translationStyle, latencyPreset, captionPosition, noiseGate)
    for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
      const setting = seg.dataset.setting;
      if (!setting) continue;
      const buttons = Array.from(seg.querySelectorAll<HTMLButtonElement>("button"));
      let activeValue: string | null = null;
      if (setting === "translationStyle") activeValue = adv.translationStyle;
      else if (setting === "latencyPreset") activeValue = adv.latencyPreset;
      else if (setting === "captionPosition") activeValue = adv.captionPosition;
      else if (setting === "noiseGate") activeValue = adv.noiseGate ? "on" : "off";
      for (const b of buttons) {
        if (b.dataset.value === activeValue) b.setAttribute("aria-pressed", "true");
        else b.removeAttribute("aria-pressed");
      }
    }

    // Output device <select>
    if (outputDeviceSelect) {
      const wanted = adv.outputDeviceId ?? "";
      const present = Array.from(outputDeviceSelect.options).some((o) => o.value === wanted);
      // Only assign when present — otherwise the picker has not yet been
      // populated; we'll re-call renderAdvanced after enumeration finishes.
      if (present) outputDeviceSelect.value = wanted;
    }

    // Auto-start toggle (per-domain) + domain label
    const domain = state.currentDomain ?? null;
    if (autoStartDomain) autoStartDomain.textContent = domain ?? "no active site";
    if (autoStart) {
      autoStart.checked = !!(domain && adv.autoStartHosts?.[domain] === true);
      autoStart.disabled = !domain || !state.signedInUser;
    }

    // Save-for-site button enable/disable
    if (advSave) {
      const canSave = !!domain && !!state.signedInUser;
      advSave.disabled = !canSave;
    }

    // Dirty pill (status footer)
    const dirty = !!state.advancedDirty;
    document.body.dataset.advancedDirty = dirty ? "true" : "false";
    if (advDirtyPill) (advDirtyPill as HTMLElement).hidden = !dirty;
  }

  // ── Settings push ─────────────────────────────────────────────────────
  function readSettings() {
    const tier = tierSelect.value as "realtime" | "standard";
    const voiceKey = tier === "standard" ? "standardVoice" : "realtimeVoice";
    return {
      tier,
      targetLanguage: langSelect.value,
      [voiceKey]: voiceSelect.value,
      originalVolume: Number(originalVolumeInput.value),
      voiceVolume: Number(voiceVolumeInput.value),
      showSource: showSourceCheckbox.checked,
    };
  }
  async function pushSettings() {
    try {
      const reply = await send({ type: "UPDATE_SETTINGS", settings: readSettings() });
      if (reply?.ok && reply.state) applyState(reply.state);
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
    }
  }

  // ── Volume change ─────────────────────────────────────────────────────
  let volumeDebounce: ReturnType<typeof setTimeout> | null = null;
  function onVolumeChange() {
    originalOut.textContent = originalVolumeInput.value;
    voiceOut.textContent = voiceVolumeInput.value;
    setSliderFill(originalVolumeInput);
    setSliderFill(voiceVolumeInput);
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

  // ── Start/Stop toggle ─────────────────────────────────────────────────
  async function onToggle() {
    toggleBtn.disabled = true;
    try {
      if (state.running || state.connecting) {
        const reply = await send({ type: "STOP" });
        if (reply?.ok && reply.state) applyState(reply.state);
        else applyState({ running: false, connecting: false, paused: false });
      } else {
        if (!state.signedInUser) {
          statusEl.textContent = "Sign in to use Echoly.";
          setStateClass("error");
          toggleBtn.disabled = false;
          return;
        }
        if (state.tier === "realtime" && state.signedInUser.tier !== "max") {
          statusEl.textContent = "Realtime is a Max-tier feature. Upgrade to continue.";
          setStateClass("error");
          toggleBtn.disabled = false;
          return;
        }
        const reply = await send({ type: "START", settings: readSettings() });
        if (!reply?.ok) {
          statusEl.textContent = (reply as { error?: string })?.error || "Could not start.";
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

  // ── Events ────────────────────────────────────────────────────────────
  tierSelect.addEventListener("change", () => {
    const tier = tierSelect.value;
    const wanted = tier === "standard" ? state.standardVoice : state.realtimeVoice;
    repopulateVoices(tier, wanted);
    state.tier = tier as "realtime" | "standard";
    renderTierRow();
    renderVoiceRow();
    void pushSettings();
  });
  voiceSelect.addEventListener("change", () => {
    const tier = tierSelect.value === "standard" ? "standard" : "realtime";
    if (tier === "standard") state.standardVoice = voiceSelect.value;
    else state.realtimeVoice = voiceSelect.value;
    renderVoiceRow();
    void pushSettings();
  });
  langSelect.addEventListener("change", () => {
    state.targetLanguage = langSelect.value;
    renderTargetLang(langSelect.value);
    void pushSettings();
  });
  showSourceCheckbox.addEventListener("change", () => void pushSettings());
  originalVolumeInput.addEventListener("input", onVolumeChange);
  voiceVolumeInput.addEventListener("input", onVolumeChange);
  toggleBtn.addEventListener("click", () => void onToggle());

  // ── Sign-in (all `[data-ec-signin]` triggers) ─────────────────────────
  for (const link of document.querySelectorAll<HTMLElement>("[data-ec-signin]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void send({ type: "OPEN_SIGNIN" }).catch(() => {
        const href = (link as HTMLAnchorElement).href;
        if (href) window.open(href, "_blank");
      });
    });
  }

  // ── Background push subscription ──────────────────────────────────────
  chrome.runtime?.onMessage?.addListener?.((message) => {
    if (message?.type === "BACKGROUND_STATE_UPDATE" && message.state) {
      applyState(message.state);
    }
  });

  // ── Custom dropdowns (tier / voice / lang) ────────────────────────────
  const TIER_ICON_HTML = '<svg viewBox="0 0 12 12"><path d="M6.5 1L3 7h2.5L5 11l3.5-6H6L6.5 1z" fill="currentColor"/></svg>';
  function tierItems(): DropdownItem[] {
    const isPaid = state.signedInUser?.tier === "max";
    const allow = isPaid;
    return [
      { value: "realtime", primary: TIER_META.realtime!.primary,
        secondary: allow ? TIER_META.realtime!.secondary : "· Max only",
        iconHtml: TIER_ICON_HTML, disabled: !allow && !!state.signedInUser },
      { value: "standard", primary: TIER_META.standard!.primary,
        secondary: TIER_META.standard!.secondary, iconHtml: TIER_ICON_HTML },
    ];
  }
  function voiceItems(): DropdownItem[] {
    const list = tierSelect.value === "standard" ? POPUP_STANDARD_VOICES : POPUP_REALTIME_VOICES;
    return list.map((v) => {
      const meta = VOICE_META[v.id] ?? DEFAULT_VOICE_META;
      const initial = (v.name[0] || "·").toUpperCase();
      const grad = `linear-gradient(135deg, ${meta.swatch}, ${shade(meta.swatch, -18)})`;
      const primary = v.name.split("·")[0]!.trim() || v.name;
      return {
        value: v.id, primary, secondary: meta.tagline,
        iconHtml: `<span class="dropdown-voice-avatar" style="background:${grad}">${initial}</span>`,
      };
    });
  }
  function langItems(): DropdownItem[] {
    return Array.from(langSelect.options).map((o) => ({
      value: o.value,
      primary: o.textContent || o.value,
      iconHtml: `<span class="dropdown-lang-flag">${(o.value || "??").slice(0, 2).toUpperCase()}</span>`,
    }));
  }
  const dropdowns: Record<string, DropdownHandle> = {};
  const tierTrigger = $("tier-trigger");
  if (tierTrigger) dropdowns.tier = attachDropdown({
    trigger: tierTrigger, select: tierSelect, items: tierItems,
    align: "stretch", panelClass: "dropdown-panel--tier",
  });
  const voiceTrigger = $("voice-trigger");
  if (voiceTrigger) dropdowns.voice = attachDropdown({
    trigger: voiceTrigger, select: voiceSelect, items: voiceItems,
    align: "stretch", panelClass: "dropdown-panel--voice",
  });
  const langTrigger = $("lang-trigger");
  if (langTrigger) dropdowns.lang = attachDropdown({
    trigger: langTrigger, select: langSelect, items: langItems,
    align: "right", panelClass: "dropdown-panel--lang",
  });

  // ── Account menu popover ──────────────────────────────────────────────
  if (accountTrigger && accountMenuPanel) {
    attachPopover({
      trigger: accountTrigger,
      panel: accountMenuPanel,
      dim: accountMenuDim,
      onOpen: () => {
        renderAccountMenu(state.signedInUser, state.usage ?? null);
      },
    });
  }

  // ── Account-menu row handlers ─────────────────────────────────────────
  $("am-billing")?.addEventListener("click", () => {
    window.open("https://echolyhq.com/account/billing", "_blank");
  });
  $("am-invoices")?.addEventListener("click", () => {
    window.open("https://echolyhq.com/account/usage", "_blank");
  });
  $("am-help")?.addEventListener("click", () => {
    window.open("https://echolyhq.com/help", "_blank");
  });
  $("am-signout")?.addEventListener("click", async () => {
    try {
      const reply = await send({ type: "SIGN_OUT_ECHOLY" });
      if (reply?.ok && reply.state) applyState(reply.state);
      else applyState({ signedInUser: null });
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
    }
  });

  // ── Advanced settings (server-authoritative) ──────────────────────────
  // Each control dispatches an UPDATE_ADVANCED_SETTINGS patch to the SW; the
  // SW persists to PG via the server, broadcasts the new state back, and the
  // popup re-renders from applyState(reply.state). No chrome.storage.local —
  // chrome.storage is the SW's responsibility (offline cache).

  /** Send an Advanced patch and re-render on the returned state. Errors fall
   *  back to a status-line message (benign chrome runtime errors are filtered). */
  async function dispatchAdvancedPatch(patch: Partial<AdvancedSettings>) {
    try {
      const reply = await send({ type: "UPDATE_ADVANCED_SETTINGS", patch });
      if (reply?.ok && reply.state) applyState(reply.state);
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
    }
  }

  // Wire segmented controls. Each .segmented[data-setting] holds buttons
  // whose data-value matches one of the AdvancedSettings union members.
  for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
    const setting = seg.dataset.setting;
    if (!setting) continue;
    const buttons = Array.from(seg.querySelectorAll<HTMLButtonElement>("button"));
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        const value = btn.dataset.value;
        if (!value) return;
        // Optimistic press (the authoritative re-render lands in applyState
        // when the SW replies, which will idempotently set the same state).
        for (const b of buttons) b.removeAttribute("aria-pressed");
        btn.setAttribute("aria-pressed", "true");

        if (setting === "translationStyle") {
          void dispatchAdvancedPatch({ translationStyle: value as TranslationStyle });
        } else if (setting === "latencyPreset") {
          void dispatchAdvancedPatch({ latencyPreset: value as LatencyPreset });
        } else if (setting === "captionPosition") {
          void dispatchAdvancedPatch({ captionPosition: value as CaptionPosition });
        } else if (setting === "noiseGate") {
          void dispatchAdvancedPatch({ noiseGate: value === "on" });
        }
      });
    }
  }

  // Auto-start (per-domain) — dispatches a single-host autoStartHosts patch.
  if (autoStart) {
    autoStart.addEventListener("change", () => {
      const domain = state.currentDomain ?? null;
      if (!domain) {
        // Defensive: the control is disabled in this state. Revert.
        autoStart.checked = false;
        return;
      }
      void dispatchAdvancedPatch({ autoStartHosts: { [domain]: autoStart.checked } });
    });
  }

  // Output device picker.
  if (outputDeviceSelect) {
    outputDeviceSelect.addEventListener("change", () => {
      void dispatchAdvancedPatch({ outputDeviceId: outputDeviceSelect.value });
    });
  }

  // Reset to defaults — replace global advanced with DEFAULT_ADVANCED.
  advReset?.addEventListener("click", () => {
    void dispatchAdvancedPatch({ ...DEFAULT_ADVANCED });
  });

  // Save for this site — snapshot current advanced into the per-site override.
  advSave?.addEventListener("click", async () => {
    const domain = state.currentDomain ?? null;
    if (!domain || !state.signedInUser) return;
    try {
      const reply = await send({ type: "SAVE_SITE_DEFAULT", domain });
      if (reply?.ok && reply.state) {
        applyState(reply.state);
        if (advSave) {
          const original = advSave.textContent;
          advSave.textContent = "Saved";
          window.setTimeout(() => {
            if (advSave && original !== null) advSave.textContent = original;
          }, 1200);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
    }
  });

  // Output device list — ask the SW first (it owns enumeration with the right
  // permissions surface); fall back to popup-side enumeration if the SW signals
  // "enumerate in popup context" via a benign error reply.
  void populateOutputDevices();

  function populateDeviceSelect(devices: { deviceId: string; label: string }[]) {
    if (!outputDeviceSelect) return;
    const wanted = outputDeviceSelect.value || effectiveAdv().outputDeviceId || "";
    outputDeviceSelect.replaceChildren();
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "System default";
    outputDeviceSelect.appendChild(def);
    for (const d of devices) {
      if (!d.deviceId) continue;
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Device ${d.deviceId.slice(0, 6)}`;
      outputDeviceSelect.appendChild(opt);
    }
    // Re-apply the persisted selection if the device is still present.
    const stillPresent = Array.from(outputDeviceSelect.options)
      .some((o) => o.value === wanted);
    outputDeviceSelect.value = stillPresent ? wanted : "";
  }

  async function fallbackEnumerate() {
    // Popup is a top-level document with the mediaDevices API. We try to
    // enumerate without prompting — labels may be blank if no mic-permission
    // has been granted in the popup context, which is fine: deviceIds still
    // round-trip into setSinkId.
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.enumerateDevices) return;
      const devices = await mediaDevices.enumerateDevices();
      const outs = devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      populateDeviceSelect(outs);
    } catch { /* enumeration not available */ }
  }

  async function populateOutputDevices() {
    try {
      const reply = await send({ type: "LIST_AUDIO_OUTPUT_DEVICES" });
      if (reply?.ok) populateDeviceSelect(reply.devices);
      else await fallbackEnumerate();
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) {
        // Soft-fail to popup-side enumeration.
        await fallbackEnumerate();
      } else {
        await fallbackEnumerate();
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────
  setAccountClass("loading");
  populateLanguages();
  repopulateVoices(state.tier!, state.tier === "standard" ? state.standardVoice : state.realtimeVoice);
  renderTierRow();
  renderVoiceRow();
  renderTargetLang(state.targetLanguage ?? "vi");
  setSliderFill(originalVolumeInput);
  setSliderFill(voiceVolumeInput);

  // Read hasEverSignedIn from chrome.storage.local; default false.
  // Advanced settings are NOT read from chrome.storage here — the SW owns them
  // and ships the current state via GET_STATE / BACKGROUND_STATE_UPDATE.
  void (async () => {
    try {
      const r = await chrome.storage?.local?.get?.(HAS_EVER_SIGNED_IN_KEY);
      hasEverSignedIn = !!r?.[HAS_EVER_SIGNED_IN_KEY];
    } catch { /* storage unavailable */ }

    try {
      const reply = await send({ type: "GET_STATE" });
      if (reply?.ok && reply.state) applyState(reply.state);
      else applyState({});
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
      applyState({});
    }
  })();
}
