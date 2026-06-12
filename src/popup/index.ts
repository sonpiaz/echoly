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
import { siteDisplayLabel, platformDisplayName } from "@/shared/active-site";
import { canUseRealtime, canUseSubtitleStyling } from "@/shared/tier";
import {
  DEFAULT_ADVANCED,
  effectiveAdvanced,
  normalizeDomain,
  type AdvancedSettings,
  type CaptionPosition,
  type CaptionFontSize,
  type CaptionBgOpacity,
  type CaptionFontWeight,
} from "@/shared/advanced";
import {
  STATUS_SWITCHING_VIDEO,
  STATUS_LOADING_NEXT,
} from "@/shared/product-copy";
import { resolveLangName } from "@/lib/resolve-lang-name";
import {
  capsForUsage,
  daysLeftLabel,
  fillPercent,
  fmtCredits,
  fmtElapsed,
  meterLevel,
  renewsAtLabel,
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

// ── Popup state cache ─────────────────────────────────────────────────────────
// We persist the last-known background state snapshot in chrome.storage.local
// under this key so the popup can render optimistically before GET_STATE
// resolves (masks MV3 service-worker cold-start latency of 200–1 500 ms).
const POPUP_STATE_CACHE_KEY = "echoly_popup_state_cache";

/** Persist the popup state snapshot for optimistic re-render on next open. */
function cachePopupState(s: Partial<State>): void {
  // Persist only the fields the popup uses for rendering — omit large arrays
  // (languagePicker) and transient runtime IDs so the cache stays small.
  const slim: Partial<State> = {
    running: s.running,
    connecting: s.connecting,
    paused: s.paused,
    tier: s.tier,
    targetLanguage: s.targetLanguage,
    sourceLanguage: s.sourceLanguage,
    realtimeVoice: s.realtimeVoice,
    standardVoice: s.standardVoice,
    originalVolume: s.originalVolume,
    voiceVolume: s.voiceVolume,
    showSource: s.showSource,
    showTargetCaptions: s.showTargetCaptions,
    signedInUser: s.signedInUser,
    usage: s.usage,
    advanced: s.advanced,
    siteOverrides: s.siteOverrides,
    advancedVersion: s.advancedVersion,
    currentDomain: s.currentDomain,
    sessionStartedAt: s.sessionStartedAt,
  };
  try {
    chrome.storage?.local?.set?.({ [POPUP_STATE_CACHE_KEY]: slim }).catch(() => {});
  } catch { /* storage unavailable */ }
}

/** Load the last-cached popup state, or null if none / unreadable. */
async function loadCachedPopupState(): Promise<Partial<State> | null> {
  try {
    const r = await chrome.storage?.local?.get?.(POPUP_STATE_CACHE_KEY);
    const v = r?.[POPUP_STATE_CACHE_KEY];
    if (v && typeof v === "object") return v as Partial<State>;
  } catch { /* storage unavailable */ }
  return null;
}

interface VoiceOption {
  id: string;
  name: string;
}
/** Realtime uses gpt-realtime-translate — output language only; voice is not configurable. */
const POPUP_REALTIME_VOICES: VoiceOption[] = [
  { id: "", name: "Auto" },
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
  const srcLangSelect = $("src-lang") as HTMLSelectElement;
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

  // ── Advanced V2 controls (server-authoritative; popup is a dispatcher) ─
  const advReset = $("advResetBtn") as HTMLButtonElement | null;
  const advSave = $("advSaveBtn") as HTMLButtonElement | null;
  const subtitleStyleReset = $("subtitleStyleResetBtn") as HTMLButtonElement | null;
  const autoStart = $("autoStart") as HTMLInputElement | null;
  const autoStartDomain = $("autoStartDomain");
  const outputDeviceSelect = $("outputDevice") as HTMLSelectElement | null;
  const advDirtyPill = $("advDirtyPill");

  // ── Subtitle style controls (W6 / Pro/Max only) ───────────────────────

  // Version chips (welcome header + footer)
  try {
    const v = chrome.runtime?.getManifest?.()?.version;
    if (v) {
      for (const el of document.querySelectorAll<HTMLElement>(".version")) {
        el.textContent = `v${v}`;
      }
    }
  } catch { /* unit-test JSDOM */ }

  let state: Partial<State> = {
    running: false,
    connecting: false,
    paused: false,
    tier: DEFAULT_TRANSLATION_TIER,
    targetLanguage: "vi",
    sourceLanguage: "auto",
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
  let accountTransitionTimer: ReturnType<typeof setTimeout> | null = null;
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
      // Capture the body element now; the callback must NOT re-resolve the
      // global `document` 260ms later — in a torn-down env (tests, closed
      // popup) that global is gone, which would throw and leak past teardown.
      const body = document.body;
      body.classList.add("account-transition");
      if (accountTransitionTimer !== null) clearTimeout(accountTransitionTimer);
      accountTransitionTimer = setTimeout(() => {
        accountTransitionTimer = null;
        body.classList.remove("account-transition");
      }, 260);
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

  function populateSourceLanguages() {
    if (!srcLangSelect) return;
    const list = state.languagePicker ?? [...offlineLanguagePicker()];
    srcLangSelect.replaceChildren();
    // Prepend the "Auto-detect" sentinel first.
    const autoOpt = document.createElement("option");
    autoOpt.value = "auto";
    autoOpt.textContent = "Auto-detect";
    srcLangSelect.appendChild(autoOpt);
    for (const [code, name] of list) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      srcLangSelect.appendChild(opt);
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
    return canUseRealtime(state.signedInUser?.tier);
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
  function renderSourceLang(code: string) {
    const srcFlag = $("src-flag");
    const srcName = $("src-name");
    if (code === "auto" || !code) {
      if (srcFlag) srcFlag.textContent = "??";
      if (srcName) srcName.textContent = "Auto-detect";
    } else {
      const c = code.slice(0, 2);
      if (srcFlag) srcFlag.textContent = c.toUpperCase();
      if (srcName) srcName.textContent = resolveLangName(c, state.languageNames);
    }
  }
  function updateLiveSummary() {
    const code = (state.targetLanguage || "vi").slice(0, 2);
    if (liveTargetFlag) liveTargetFlag.textContent = code.toUpperCase();
    if (liveSrcFlag) {
      const sl = state.sourceLanguage;
      liveSrcFlag.textContent =
        !sl || sl === "auto" ? "??" : sl.slice(0, 2).toUpperCase();
    }
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
    const usedCredits = usage?.used ?? 0;
    const remaining = usage?.remaining ?? Math.max(0, caps.cap - usedCredits);
    if (usageHintAmount) usageHintAmount.textContent = `${fmtCredits(remaining)} credits`;
    if (usageHintLabel)
      usageHintLabel.textContent = "Credits left this month";
    if (usageHintReset) usageHintReset.textContent = resetsAtLabel(usage?.resetsAt);
  }

  function renderAccountMenu(user: State["signedInUser"] | undefined | null,
                             usage: State["usage"] | undefined | null) {
    if (!user) return;
    // W2: render display email (preserves dots/+ for gmail users).
    if (amEmail) amEmail.textContent = user.email_display ?? user.email;
    renderPlanBadge(amPlanBadge, amPlanBadgeText, user.tier);

    const isAnnual = user.billing_cycle === "annual";

    if (amDaysLeft) {
      if (isAnnual) {
        // Annual plan: plan line shows "· billed yearly" instead of days-left.
        amDaysLeft.hidden = false;
        amDaysLeft.textContent = "· billed yearly";
      } else {
        const left = daysLeftLabel(usage?.resetsAt);
        if (left) {
          amDaysLeft.hidden = false;
          amDaysLeft.textContent = left;
        } else {
          amDaysLeft.hidden = true;
          amDaysLeft.textContent = "";
        }
      }
    }

    if (isAnnual) {
      // Annual billing: reset row shows renewal date or cancel state.
      if (user.cancel_at_period_end) {
        const until = renewsAtLabel(user.renews_at);
        if (amReset) {
          amReset.textContent = until
            ? `auto-renewal off · access until ${until}`
            : "auto-renewal off · access until period end";
        }
      } else {
        const resetsLabel = resetsAtLabel(usage?.resetsAt ?? undefined);
        const renewsLabel = renewsAtLabel(user.renews_at);
        if (amReset) {
          amReset.textContent = renewsLabel
            ? `resets ${resetsLabel} · renews ${renewsLabel}`
            : `resets ${resetsLabel}`;
        }
      }
    } else {
      // Monthly / free: unchanged behavior.
      if (user.cancel_at_period_end) {
        if (amReset) amReset.textContent = "auto-renewal off · access until period end";
      } else if (amReset) {
        amReset.textContent = `resets ${resetsAtLabel(usage?.resetsAt ?? undefined)}`;
      }
    }

    const caps = capsForUsage(user.tier, usage ?? undefined);
    const usedCredits = usage?.used ?? 0;
    // Render unified credits meter: "4,200 / 10,000 credits"
    if (umStdUsed) umStdUsed.textContent = fmtCredits(usedCredits);
    if (umStdCap)  umStdCap.textContent  = `${fmtCredits(caps.cap)} credits`;
    if (umStdFill) (umStdFill as HTMLElement).style.width = `${fillPercent(usedCredits, caps.cap)}%`;
    if (umStdNumbers)
      (umStdNumbers as HTMLElement).dataset.low = meterLevel(usedCredits, caps.cap) !== "ok" ? "true" : "false";
  }

  // ── Account-state decider ─────────────────────────────────────────────
  function decideAccountState(user: State["signedInUser"] | undefined | null): "welcome" | "locked" | "in" {
    if (user) return "in";
    return hasEverSignedIn ? "locked" : "welcome";
  }

  // ── applyState ────────────────────────────────────────────────────────
  /**
   * When `fromCache` is true the state came from the optimistic pre-render
   * (chrome.storage cache) and should NOT be persisted back to cache — doing so
   * would create a write-loop and mask reconciliation bugs.
   */
  function applyState(s: Partial<State>, fromCache = false) {
    // W5 Cold-SW no-regress guard (AC14):
    // If the incoming state has signedInUser=null AND hydrating=true AND the popup
    // currently renders a signed-in user → do NOT regress to signed-out. The SW
    // is mid-network-fetch; a later BACKGROUND_STATE_UPDATE will carry the real user.
    const isHydrating = (s.hydrating === true) || (state.hydrating === true && !("hydrating" in s));
    if (
      s.signedInUser === null &&
      isHydrating &&
      state.signedInUser != null
    ) {
      // Accept other fields (status, etc.) but preserve the current user.
      const { signedInUser: _dropped, ...rest } = s;
      void _dropped;
      s = { ...rest, signedInUser: state.signedInUser };
    }

    state = { ...state, ...s };
    // Do NOT persist cache while hydrating — avoids poisoning the optimistic cache
    // with a transient signed-out snapshot.
    if (!fromCache && !state.hydrating) cachePopupState(state);

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

    const effectiveSrcLang = state.sourceLanguage ?? "auto";
    if (srcLangSelect) {
      srcLangSelect.value = effectiveSrcLang;
      // If the value didn't stick (option not yet populated), re-populate first.
      if (srcLangSelect.value !== effectiveSrcLang) {
        populateSourceLanguages();
        srcLangSelect.value = effectiveSrcLang;
      }
    }
    renderSourceLang(effectiveSrcLang);

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
      statusEl.textContent = state.status || "Paused.";
      setActionLabel("Stop dubbing");
      toggleBtn.classList.add("is-live");
    } else if (state.running) {
      setStateClass("active");
      // Only override with state.status when it is a transition message (switching
      // or loading the next video). Regular in-session status ("Translating") falls
      // back to the canonical "Dubbing to {lang}." label so the popup copy is stable.
      const langName = resolveLangName(
        state.targetLanguage ?? "",
        state.languageNames,
      );
      const isTransitionStatus =
        state.status === STATUS_SWITCHING_VIDEO ||
        state.status === STATUS_LOADING_NEXT;
      statusEl.textContent = isTransitionStatus
        ? state.status!
        : `Dubbing to ${langName}.`;
      setActionLabel("Stop dubbing");
      toggleBtn.classList.add("is-live");
    } else if (state.errorMessage) {
      setStateClass("error");
      statusEl.textContent = state.errorMessage;
      setActionLabel("Start dubbing");
      toggleBtn.classList.remove("is-live");
    } else {
      setStateClass("idle");
      if (acct === "in") {
        // Announce a recognized platform (YouTube/Udemy/Coursera) so the user sees
        // the active site was detected; generic sites keep the plain ready state.
        const platform = platformDisplayName(state.currentDomain ?? null);
        statusEl.textContent = platform ? `Ready · ${platform} detected` : "Ready.";
      }
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
    const canStyle = canUseSubtitleStyling(state.signedInUser?.tier);
    for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
      const setting = seg.dataset.setting;
      if (!setting) continue;
      const buttons = Array.from(seg.querySelectorAll<HTMLButtonElement>("button"));
      let activeValue: string | null = null;
      let isStyleSeg = true;
      if (setting === "captionPosition") {
        activeValue = adv.captionPosition;
        isStyleSeg = false;
      } else if (setting === "captionFontSize") {
        activeValue = adv.captionFontSize ?? DEFAULT_ADVANCED.captionFontSize;
      } else if (setting === "captionBgOpacity") {
        activeValue = adv.captionBgOpacity ?? DEFAULT_ADVANCED.captionBgOpacity;
      } else if (setting === "captionFontWeight") {
        activeValue = adv.captionFontWeight ?? DEFAULT_ADVANCED.captionFontWeight;
      } else {
        isStyleSeg = false;
      }
      for (const b of buttons) {
        if (b.dataset.value === activeValue) b.setAttribute("aria-pressed", "true");
        else b.removeAttribute("aria-pressed");
        // Style segments are Pro/Max-gated; other segments are never disabled here.
        if (isStyleSeg) b.disabled = !canStyle;
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

    // ── Subtitle style group (W6, Pro/Max gate) ───────────────────────────
    // The three style segmented controls themselves are rendered/gated in the
    // .segmented loop above; here we only flag the group + upgrade hint.
    const subtitleStyleGroup = $("subtitle-style-group");
    if (subtitleStyleGroup) {
      subtitleStyleGroup.dataset.canStyle = canStyle ? "true" : "false";
    }
    const upgradeHint = $("subtitle-style-upgrade-hint");
    if (upgradeHint) (upgradeHint as HTMLElement).hidden = canStyle;
    if (subtitleStyleReset) subtitleStyleReset.disabled = !canStyle;
  }

  // ── Settings push ─────────────────────────────────────────────────────
  function readSettings() {
    const tier = tierSelect.value as TranslationTier;
    const voiceKey = tier === TIER_STANDARD ? "standardVoice" : "realtimeVoice";
    return {
      tier,
      targetLanguage: langSelect.value,
      sourceLanguage: srcLangSelect?.value ?? "auto",
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
        // Instant stop: hit the content script DIRECTLY (bypassing the service
        // worker relay) so dub audio is silenced in ~5ms instead of waiting on a
        // possibly-cold SW. CONTENT_STOP → app.stopSession() is idempotent, so the
        // authoritative SW STOP below is a safe no-op follow-up for bg state.
        void chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(([tab]) => {
            if (tab?.id != null) {
              chrome.tabs.sendMessage(tab.id, { type: "CONTENT_STOP" }).catch(() => {});
            }
          })
          .catch(() => {});
        // Optimistic UI: reflect "stopped" immediately, reconciled by the reply.
        setStateClass("idle");
        statusEl.textContent = "Stopping…";
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
        // Optimistic feedback BEFORE the (possibly cold-SW) round-trip so the
        // user sees an immediate response instead of a frozen, disabled button.
        setStateClass("connecting");
        statusEl.textContent = "Connecting…";
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
    // P3: switching TO Realtime is a strong start-intent signal — pre-warm now
    // (not only on hover) so the cold WebRTC/OpenAI dial is off the click path.
    prepareIntentSent = false;
    maybeSendPrepareIntent();
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
  srcLangSelect?.addEventListener("change", () => {
    state.sourceLanguage = srcLangSelect.value;
    renderSourceLang(srcLangSelect.value);
    void pushSettings();
  });
  showSourceCheckbox.addEventListener("change", () => void pushSettings());
  showTargetCaptionsCheckbox.addEventListener("change", () => void pushSettings());
  originalVolumeInput.addEventListener("input", onVolumeChange);
  voiceVolumeInput.addEventListener("input", onVolumeChange);
  toggleBtn.addEventListener("click", () => void onToggle());

  // ── Pre-warm intent (Workstream D / GAP-1) ────────────────────────────
  // Send PREPARE_INTENT to the background on hover/focus of the Start button
  // so the server can pre-allocate the WebRTC transport + provider WS.
  // Guards: only when not running, realtime tier selected, button enabled.
  // Debounce with a flag so rapid mousemoves don't spam the SW.
  let prepareIntentSent = false;
  function maybeSendPrepareIntent(): void {
    if (state.running || state.connecting) return; // already live
    if (tierSelect.value !== TIER_REALTIME) return;  // realtime only
    if (toggleBtn.disabled) return;                  // gated (no Max plan)
    if (prepareIntentSent) return;                   // debounce
    prepareIntentSent = true;
    void chrome.runtime
      .sendMessage({ type: "PREPARE_INTENT" })
      ?.catch?.(() => {});
  }
  toggleBtn.addEventListener("mouseenter", maybeSendPrepareIntent);
  toggleBtn.addEventListener("focus", maybeSendPrepareIntent);
  // Reset the debounce flag when the user leaves the button (so a second
  // hover after the intent may fire again — but only once per hover session).
  toggleBtn.addEventListener("mouseleave", () => { prepareIntentSent = false; });
  toggleBtn.addEventListener("blur", () => { prepareIntentSent = false; });

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
        // Max-only: lock the option for Free/Pro (and signed-out) so it can't be
        // selected — dropdown renders aria-disabled + .is-disabled and pick() is
        // a no-op. The gated "· Max plan" secondary above is the upsell hint.
        disabled: !allow,
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
  function srcLangItems(): DropdownItem[] {
    return Array.from(srcLangSelect.options).map((o) => ({
      value: o.value,
      primary: o.textContent || o.value,
      iconHtml: `<span class="dropdown-lang-flag">${(o.value === "auto" ? "??" : (o.value || "??").slice(0, 2)).toUpperCase()}</span>`,
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
  const srcTrigger = $("src-trigger");
  if (srcTrigger && srcLangSelect) dropdowns.src = attachDropdown({
    trigger: srcTrigger, select: srcLangSelect, items: srcLangItems,
    align: "left", panelClass: "dropdown-panel--lang",
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
        } else if (setting === "captionFontSize") {
          void dispatchAdvancedPatch({ captionFontSize: value as CaptionFontSize });
        } else if (setting === "captionBgOpacity") {
          void dispatchAdvancedPatch({ captionBgOpacity: value as CaptionBgOpacity });
        } else if (setting === "captionFontWeight") {
          void dispatchAdvancedPatch({ captionFontWeight: value as CaptionFontWeight });
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

  // Subtitle style (W6) is wired through the generic .segmented loop above —
  // the three style segments dispatch captionFontSize/BgOpacity/FontWeight.

  // Card-scoped reset: only the 3 style keys (mirrors the Advanced panel's
  // panel-scoped reset; auto-save means there is no Save counterpart).
  subtitleStyleReset?.addEventListener("click", () => {
    void dispatchAdvancedPatch({
      captionFontSize: DEFAULT_ADVANCED.captionFontSize,
      captionBgOpacity: DEFAULT_ADVANCED.captionBgOpacity,
      captionFontWeight: DEFAULT_ADVANCED.captionFontWeight,
    });
  });

  // Reset to defaults — panel-scoped: resets ONLY the Advanced panel's own
  // keys. The Subtitle style card below is a separate surface and must not
  // be silently reset from here.
  advReset?.addEventListener("click", () => {
    void dispatchAdvancedPatch({
      captionPosition: DEFAULT_ADVANCED.captionPosition,
      autoStartHosts: state.currentDomain ? { [state.currentDomain]: false } : {},
      outputDeviceId: DEFAULT_ADVANCED.outputDeviceId,
    });
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
  populateSourceLanguages();
  repopulateVoices(
    state.tier!,
    state.tier === TIER_STANDARD ? state.standardVoice : state.realtimeVoice,
  );
  renderTierRow();
  renderVoiceRow();
  renderTargetLang(state.targetLanguage ?? "vi");
  renderSourceLang(state.sourceLanguage ?? "auto");
  setSliderFill(originalVolumeInput);
  setSliderFill(voiceVolumeInput);

  void (async () => {
    try {
      const r = await chrome.storage?.local?.get?.(HAS_EVER_SIGNED_IN_KEY);
      hasEverSignedIn = !!r?.[HAS_EVER_SIGNED_IN_KEY];
    } catch { /* storage unavailable */ }
    document.body.dataset.loadingShell = hasEverSignedIn ? "main" : "welcome";

    // ── Optimistic pre-render (B3) ────────────────────────────────────────
    // Paint the popup immediately from the last-cached state BEFORE the
    // GET_STATE round-trip to the background SW resolves. This masks the
    // MV3 service-worker cold-start penalty (200–1 500 ms). The optimistic
    // render is marked `fromCache=true` so it is NOT written back to cache
    // (preventing a stale-data loop). The authoritative GET_STATE reply
    // reconciles by calling applyState() a second time, which overwrites.
    const cached = await loadCachedPopupState();
    if (cached) {
      // Propagate hasEverSignedIn from the cached user so the shell renders
      // correctly (e.g. "main" vs "welcome") even before GET_STATE lands.
      if (cached.signedInUser) hasEverSignedIn = true;
      applyState(cached, /* fromCache */ true);
    }

    try {
      const reply = await send({ type: "GET_STATE" });
      if (reply?.ok && reply.state) applyState(reply.state);
      else applyState({});
      // P3: if the popup opens with Realtime already selected, pre-warm now so
      // the dial is off the click path even if the user never hovers Start.
      maybeSendPrepareIntent();
    } catch (err) {
      const msg = (err as Error).message;
      if (!isBenign(msg)) { statusEl.textContent = msg; setStateClass("error"); }
      applyState({});
    }
  })();
}
