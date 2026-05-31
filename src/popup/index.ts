// ────────────────────────────────────────────────────────────────────────────
// Echoly popup — V5 passive renderer.
// Background owns state; popup queries GET_STATE on open, subscribes to
// BACKGROUND_STATE_UPDATE pushes, and dispatches user actions via runtime
// messages. The popup NEVER touches DOM outside its own document; single
// input is applyState(state), single output is runtime messages.
//
// Account states (body[data-account]) — two sign-in surfaces, never at once:
//   "welcome" — first open only (!hasEverSignedIn): marketing shell + one CTA
//   "locked"  — returning user, signed out: main settings shell + sign-in card
//   "in"      — signed in
//   "loading" — boot; data-loading-shell picks welcome vs main skeleton
// ────────────────────────────────────────────────────────────────────────────

import { offlineLanguagePicker } from "@/lib/offline-language-bootstrap";
import {
  DEFAULT_TRANSLATION_TIER,
  TIER_REALTIME,
  TIER_REALTIME_GATED_SECONDARY,
  TIER_REALTIME_START_GATED_SECONDARY,
  TIER_STANDARD,
  TIER_UI,
  type LangPair,
  type TranslationTier,
} from "@/shared/constants";
import { offlineStandardVoices } from "@/lib/offline-voice-bootstrap";
import { ECHOLY_WEB_URLS } from "@/shared/echoly-config";
import {
  sendToBackground,
  type PopupToBgMessage,
  type PopupToBgResponse,
} from "@/shared/protocol";
import type { State } from "@/shared/types";
import { siteDisplayLabel } from "@/shared/active-site";
import {
  DEFAULT_ADVANCED,
  effectiveAdvanced,
  normalizeDomain,
  type AdvancedSettings,
  type CaptionPosition,
} from "@/shared/advanced";
import { resolveLangName } from "@/lib/resolve-lang-name";
import {
  capsForUsage,
  daysLeftLabel,
  fillPercent,
  fmtElapsed,
  fmtMin,
  meterLevel,
  resetsAtLabel,
  shade,
} from "@/lib/popup-format";
import { applySignedLanguageGate, filterPickerForRealtime } from "@/lib/language-picker";
import { attachDropdown, type DropdownItem, type DropdownHandle } from "./dropdown";
import { attachPopover, type PopoverHandle } from "./popover";
import { tierIconHtml, tierRowIconClass } from "./tier-icons";
import {
  HAS_EVER_SIGNED_IN_KEY,
  markHasEverSignedIn,
} from "@/shared/storage-keys";

interface VoiceOption {
  id: string;
  name: string;
}
/** Realtime uses gpt-realtime-translate — output language only; voice is not configurable. */
const POPUP_REALTIME_VOICES: VoiceOption[] = [
  { id: "", name: "Auto · OpenAI output" },
];
function popupStandardVoices(
  standardVoices: State["standardVoices"],
): VoiceOption[] {
  if (standardVoices?.length) {
    return standardVoices.map((v) => ({ id: v.id, name: v.label }));
  }
  return offlineStandardVoices().map(([id, name]) => ({ id, name }));
}

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
  const showTargetCaptionsCheckbox = $("showTargetCaptions") as HTMLInputElement;
  const actionLabelEl = $("actionLabel");

  // ── Header chips / avatar ─────────────────────────────────────────────
  const planBadge = $("plan-badge");
  const planBadgeText = $("plan-badge-text");
  const accountTrigger = $("account-trigger");
  const accountAvatarInitial = $("account-avatar-initial");

  // ── Row labels (tier/voice/translating) ───────────────────────────────
  const tierPrimary = $("tier-primary");
  const tierSecondary = $("tier-secondary");
  const tierRowIcon = $("tier-row-icon");
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
    tier: DEFAULT_TRANSLATION_TIER,
    targetLanguage: "vi",
    realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man",
    originalVolume: 18,
    voiceVolume: 100,
    showSource: false,
    showTargetCaptions: true,
    status: "Ready",
    advanced: { ...DEFAULT_ADVANCED },
    siteOverrides: {},
    advancedVersion: 0,
    advancedDirty: false,
    currentDomain: null,
  };
  let hasEverSignedIn = false;
  let lastAccountClass: string | null = null;
  let lastLangPickerKey = "";
  let lastVoiceTierKey = "";
  let accountPopover: PopoverHandle | null = null;

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
    if (lastAccountClass === name) return;
    const prev = lastAccountClass;
    lastAccountClass = name;
    document.body.dataset.account = name;
    if (prev && name !== "loading") {
      document.body.classList.add("account-transition");
      window.setTimeout(
        () => document.body.classList.remove("account-transition"),
        260,
      );
    }
    if (name !== "in") accountPopover?.close();
  }

  function populateLanguages(subset?: readonly LangPair[]) {
    const list =
      subset ??
      state.languagePicker ??
      [...offlineLanguagePicker()];
    langSelect.replaceChildren();
    for (const [code, name] of list) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      langSelect.appendChild(opt);
    }
  }
  function repopulateVoices(tier: TranslationTier | string, preferredVoiceId?: string) {
    const list =
      tier === TIER_STANDARD ? popupStandardVoices(state.standardVoices ?? null) : POPUP_REALTIME_VOICES;
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
    return (state.tier === TIER_STANDARD ? state.standardVoice : state.realtimeVoice) ?? "";
  }
  function lookupVoiceLabel(): string {
    const tier: TranslationTier =
      state.tier === TIER_STANDARD ? TIER_STANDARD : TIER_REALTIME;
    const list =
      tier === TIER_STANDARD ? popupStandardVoices(state.standardVoices ?? null) : POPUP_REALTIME_VOICES;
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
  function accountAllowsRealtime(): boolean {
    return state.signedInUser?.tier === "max";
  }

  /** Signed-in user picked Realtime but plan is Free/Pro — Start stays off. */
  function isRealtimeStartGated(): boolean {
    return (
      !!state.signedInUser &&
      !accountAllowsRealtime() &&
      tierSelect.value === TIER_REALTIME
    );
  }

  function renderTierRow() {
    const tier = tierSelect.value as TranslationTier;
    const meta = TIER_UI[tier] ?? TIER_UI[TIER_STANDARD];
    if (tierPrimary) tierPrimary.textContent = meta.primary;
    if (tierRowIcon) {
      tierRowIcon.className = tierRowIconClass(tier);
      tierRowIcon.innerHTML = tierIconHtml(tier);
    }
    if (tierSecondary) {
      const gated = isRealtimeStartGated();
      tierSecondary.textContent = gated
        ? TIER_REALTIME_START_GATED_SECONDARY
        : meta.secondary;
      tierSecondary.dataset.gated = gated ? "true" : "false";
    }
  }

  function renderStartGate(): void {
    const gated = isRealtimeStartGated();
    if (gated && decideAccountState(state.signedInUser) === "in") {
      if (!state.running && !state.connecting) {
        statusEl.textContent =
          "Realtime is included with Max. Switch to Standard or upgrade.";
        setStateClass("idle");
      }
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
    if (tgtName) tgtName.textContent = resolveLangName(c, state.languageNames);
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
    const caps = capsForUsage(tier, usage ?? undefined);
    const used = usage ?? { standard: 0, realtime: 0 };
    // Show Realtime remaining if the tier has rt allowance, else Standard.
    const isRt = caps.rt > 0;
    const remaining = isRt
      ? (usage?.realtimeRemaining ??
        Math.max(0, caps.rt - used.realtime))
      : (usage?.standardRemaining ??
        Math.max(0, caps.std - used.standard));
    if (usageHintAmount) usageHintAmount.textContent = `${remaining} min`;
    if (usageHintLabel)
      usageHintLabel.textContent = isRt ? "Realtime left this month" : "Standard left this month";
    if (usageHintReset) usageHintReset.textContent = resetsAtLabel(usage?.resetsAt);
  }

  function renderAccountMenu(user: State["signedInUser"] | undefined | null,
                             usage: State["usage"] | undefined | null) {
    if (!user) return;
    if (amEmail) amEmail.textContent = user.email;
    renderPlanBadge(amPlanBadge, amPlanBadgeText, user.tier);

    if (amDaysLeft) {
      const left = daysLeftLabel(usage?.resetsAt);
      if (left) {
        amDaysLeft.hidden = false;
        amDaysLeft.textContent = left;
      } else {
        amDaysLeft.hidden = true;
        amDaysLeft.textContent = "";
      }
    }
    if (user.cancel_at_period_end) {
      if (amReset) amReset.textContent = "auto-renewal off · access until period end";
    } else if (amReset) {
      amReset.textContent = `resets ${resetsAtLabel(usage?.resetsAt ?? undefined)}`;
    }

    const caps = capsForUsage(user.tier, usage ?? undefined);
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

    const acct = decideAccountState(state.signedInUser);
    setAccountClass(acct);
    if (state.signedInUser) {
      hasEverSignedIn = true;
      void markHasEverSignedIn();
    }

    const sessionLive = !!(state.running || state.connecting);
    if (sessionLive && planBadge && planBadgeText) {
      planBadge.dataset.plan = "max";
      planBadgeText.textContent = "LIVE";
    } else {
      renderPlanBadge(planBadge, planBadgeText, state.signedInUser?.tier);
    }
    renderAccountAvatar(state.signedInUser);
    renderAccountMenu(state.signedInUser, state.usage ?? null);

    if (typeof state.tier === "string") {
      let allowed: TranslationTier =
        state.tier === TIER_STANDARD ? TIER_STANDARD : TIER_REALTIME;
      if (!accountAllowsRealtime() && allowed === TIER_REALTIME) {
        allowed = TIER_STANDARD;
      }
      const previewingGated =
        !accountAllowsRealtime() && tierSelect.value === TIER_REALTIME;
      if (!previewingGated && tierSelect.value !== allowed) {
        tierSelect.value = allowed;
      }
    }

    let effectiveLang = state.targetLanguage ?? "vi";
    const pickerKey = state.languagePicker?.map((p) => p[0]).join("\0") ?? "";
    if (pickerKey !== lastLangPickerKey) {
      lastLangPickerKey = pickerKey;
      if (state.languagePicker?.length) {
        const tierPicker =
          tierSelect.value === TIER_REALTIME
            ? filterPickerForRealtime(state.languagePicker)
            : state.languagePicker;
        const gate = applySignedLanguageGate({
          currentLang: effectiveLang,
          picker: tierPicker,
        });
        populateLanguages(gate.renderable);
        effectiveLang = gate.effectiveLang;
        if (gate.autoSwitched) {
          state.targetLanguage = effectiveLang;
          void pushSettings({ targetLanguage: effectiveLang });
        }
      } else {
        populateLanguages();
      }
    }
    langSelect.value = effectiveLang;
    renderTargetLang(effectiveLang);

    const voiceTierKey = `${tierSelect.value}:${state.standardVoice ?? ""}:${state.realtimeVoice ?? ""}:${state.standardVoices?.length ?? 0}`;
    if (voiceTierKey !== lastVoiceTierKey) {
      lastVoiceTierKey = voiceTierKey;
      const activeVoice =
        tierSelect.value === TIER_STANDARD ? state.standardVoice : state.realtimeVoice;
      repopulateVoices(tierSelect.value, activeVoice);
    }
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
    if (showTargetCaptionsCheckbox) {
      if (typeof state.showTargetCaptions === "boolean")
        showTargetCaptionsCheckbox.checked = state.showTargetCaptions;
      else showTargetCaptionsCheckbox.checked = true;
    }

    // Status + toggle button
    if (state.connecting) {
      setStateClass("connecting");
      statusEl.textContent = state.status || "Connecting";
      setActionLabel("Stop dubbing");
      toggleBtn.classList.add("is-live");
      updateLiveSummary();
    } else if (state.running && state.paused) {
      setStateClass("paused");
      statusEl.textContent = "Paused.";
      setActionLabel("Stop dubbing");
      toggleBtn.classList.add("is-live");
    } else if (state.running) {
      setStateClass("active");
      const langName = resolveLangName(
        state.targetLanguage ?? "",
        state.languageNames,
      );
      statusEl.textContent = `Dubbing to ${langName}.`;
      setActionLabel("Stop dubbing");
      toggleBtn.classList.add("is-live");
    } else if (state.errorMessage) {
      setStateClass("error");
      statusEl.textContent = state.errorMessage;
      setActionLabel("Start dubbing");
      toggleBtn.classList.remove("is-live");
    } else {
      setStateClass("idle");
      if (acct === "in") statusEl.textContent = "Ready.";
      else if (acct === "locked") statusEl.textContent = "Signed out · settings read-only";
      else statusEl.textContent = "Sign in to start";
      setActionLabel("Start dubbing");
      toggleBtn.classList.remove("is-live");
    }

    updateLiveSummary();
    // Freeze the elapsed clock while paused so the popup reflects the paused state.
    if ((state.running || state.connecting) && !state.paused) startElapsedTimer();
    else stopElapsedTimer();

    toggleBtn.disabled = false;
    if (acct === "locked") toggleBtn.disabled = true;
    else if (isRealtimeStartGated()) toggleBtn.disabled = true;
    renderStartGate();
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
    for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
      const setting = seg.dataset.setting;
      if (!setting) continue;
      const buttons = Array.from(seg.querySelectorAll<HTMLButtonElement>("button"));
      let activeValue: string | null = null;
      if (setting === "captionPosition") activeValue = adv.captionPosition;
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
    if (autoStartDomain) {
      autoStartDomain.textContent = siteDisplayLabel(domain);
    }
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
    const tier = tierSelect.value as TranslationTier;
    const voiceKey = tier === TIER_STANDARD ? "standardVoice" : "realtimeVoice";
    return {
      tier,
      targetLanguage: langSelect.value,
      [voiceKey]: voiceSelect.value,
      originalVolume: Number(originalVolumeInput.value),
      voiceVolume: Number(voiceVolumeInput.value),
      showSource: showSourceCheckbox.checked,
      showTargetCaptions: showTargetCaptionsCheckbox.checked,
    };
  }
  async function pushSettings(patch?: Partial<import("@/shared/types").Settings>) {
    try {
      const reply = await send({
        type: "UPDATE_SETTINGS",
        settings: { ...readSettings(), ...patch },
      });
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
        if (isRealtimeStartGated()) {
          statusEl.textContent =
            "Realtime is included with Max. Switch to Standard or upgrade.";
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
    const wanted =
      tier === TIER_STANDARD ? state.standardVoice : state.realtimeVoice;
    repopulateVoices(tier, wanted);
    state.tier = tier as TranslationTier;
    renderTierRow();
    renderVoiceRow();
    renderStartGate();
    if (isRealtimeStartGated()) {
      toggleBtn.disabled = true;
      return;
    }
    void pushSettings();
  });
  voiceSelect.addEventListener("change", () => {
    const tier: TranslationTier =
      tierSelect.value === TIER_STANDARD ? TIER_STANDARD : TIER_REALTIME;
    if (tier === TIER_STANDARD) state.standardVoice = voiceSelect.value;
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
  showTargetCaptionsCheckbox.addEventListener("change", () => void pushSettings());
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

  // Re-sync when the popup regains focus (user returned from the sign-in tab).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void send({ type: "GET_STATE" })
      .then((reply) => {
        if (reply?.ok && reply.state) applyState(reply.state);
      })
      .catch(() => {});
  });

  // ── Custom dropdowns (tier / voice / lang) ────────────────────────────
  function tierItems(): DropdownItem[] {
    const allow = accountAllowsRealtime();
    return [
      {
        value: TIER_STANDARD,
        primary: TIER_UI[TIER_STANDARD].primary,
        secondary: TIER_UI[TIER_STANDARD].secondary,
        iconHtml: tierIconHtml(TIER_STANDARD),
      },
      {
        value: TIER_REALTIME,
        primary: TIER_UI[TIER_REALTIME].primary,
        secondary: allow ? TIER_UI[TIER_REALTIME].secondary : TIER_REALTIME_GATED_SECONDARY,
        iconHtml: tierIconHtml(TIER_REALTIME),
      },
    ];
  }
  function voiceItems(): DropdownItem[] {
    const list =
      tierSelect.value === TIER_STANDARD
        ? popupStandardVoices(state.standardVoices ?? null)
        : POPUP_REALTIME_VOICES;
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
    accountPopover = attachPopover({
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
    window.open(ECHOLY_WEB_URLS.accountBilling(), "_blank");
  });
  $("am-invoices")?.addEventListener("click", () => {
    window.open(ECHOLY_WEB_URLS.accountUsage(), "_blank");
  });
  $("am-help")?.addEventListener("click", () => {
    window.open(ECHOLY_WEB_URLS.help(), "_blank");
  });

  for (const el of document.querySelectorAll<HTMLAnchorElement>("[data-ec-web-href]")) {
    const key = el.dataset.ecWebHref;
    if (key === "privacy") el.href = ECHOLY_WEB_URLS.privacy();
    else if (key === "terms") el.href = ECHOLY_WEB_URLS.terms();
  }
  $("am-signout")?.addEventListener("click", async () => {
    accountPopover?.close();
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

        if (setting === "captionPosition") {
          void dispatchAdvancedPatch({ captionPosition: value as CaptionPosition });
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
  // Mirror <select> values/labels from TIER_UI (HTML is first-paint fallback only).
  const tierOpts = [...tierSelect.options];
  if (tierOpts[0]) {
    tierOpts[0].value = TIER_STANDARD;
    tierOpts[0].textContent = TIER_UI[TIER_STANDARD].optionLabel;
  }
  if (tierOpts[1]) {
    tierOpts[1].value = TIER_REALTIME;
    tierOpts[1].textContent = TIER_UI[TIER_REALTIME].optionLabel;
  }
  tierSelect.value = TIER_STANDARD;
  lastAccountClass = "loading";
  document.body.dataset.account = "loading";
  document.body.dataset.loadingShell = "main";

  populateLanguages();
  repopulateVoices(
    state.tier!,
    state.tier === TIER_STANDARD ? state.standardVoice : state.realtimeVoice,
  );
  renderTierRow();
  renderVoiceRow();
  renderTargetLang(state.targetLanguage ?? "vi");
  setSliderFill(originalVolumeInput);
  setSliderFill(voiceVolumeInput);

  void (async () => {
    try {
      const r = await chrome.storage?.local?.get?.(HAS_EVER_SIGNED_IN_KEY);
      hasEverSignedIn = !!r?.[HAS_EVER_SIGNED_IN_KEY];
    } catch { /* storage unavailable */ }
    document.body.dataset.loadingShell = hasEverSignedIn ? "main" : "welcome";

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
