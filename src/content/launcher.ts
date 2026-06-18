// On-page quick-start launcher.
//
// A small Echoly button injected on supported pages when the user is signed in,
// there's a dubbable video, and no session is active — so they can start dubbing
// without opening the popup. Clicking sends START_REQUEST (the same start path as
// the popup). While the launcher is plausibly useful it also pings the background
// every KEEPALIVE_MS, keeping the MV3 service worker warm (P2) so the first
// connect is off the cold-start path.
//
// Visibility is DERIVED state: signedIn && hasVideo && !sm.session && !starting.
// The host (content/index.ts) calls refresh() on session start/stop; a periodic
// tick re-evaluates for SPA navigation + sign-in changes.
//
// Pre-warm (R1): on mouseenter/focus of the launcher button, when the active tier
// is REALTIME and no session is running, the launcher sends PREPARE_INTENT to the
// background. The background resolves the bearer + language, then relays
// CONTENT_PREPARE_INTENT to this content tab, where the content-script handler
// calls app.webrtc.prepareIntent() — the same path the popup hover uses. A
// fire-once-per-arming flag prevents repeated calls on rapid mousemoves; it resets
// on mouseleave/blur so a second genuine hover may fire again (matching
// popup/index.ts:990-1006 exactly). Standard mode: guard skips — /v1/rtc/prepare
// only benefits realtime (pre-dialed provider WS + warm transport).

import type { ContentApp } from "./index";
import { TIER_REALTIME } from "@/shared/constants";

const KEEPALIVE_MS = 20_000;
// Debounce for the eligible-but-no-video DOM watch (below). Coalesces the burst of
// mutations a SPA/Shaka fires while building its player, then re-evaluates once.
const VIDEO_WATCH_DEBOUNCE_MS = 150;
const START_OPTIMISTIC_HIDE_MS = 3000;
const LAUNCHER_POS_KEY = "echolyLauncherPos";
const DRAG_THRESHOLD_PX = 5;
// Fallback height used when getBoundingClientRect returns 0×0 (e.g. jsdom).
// Keep in sync with overlay.css: 46px mark + 8px click-halo padding top/bottom.
const LAUNCHER_H = 62;
const VIEWPORT_PAD = 8;

const LAUNCHER_MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 9v6M11 6v12M15 8v8M19 11v2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

// The launcher is ALWAYS docked flush to the right viewport edge; the user can
// only slide it up/down, so the persisted position is the vertical center alone.
// (Older records also carried a `left` — it is intentionally ignored on load,
// which heals any stale mid-screen placement from the previous free-drag design.)
interface LauncherPos {
  /** Vertical center (px) when userPlaced. */
  centerY: number | null;
  userPlaced: boolean;
}

const DEFAULT_LAUNCHER_POS: LauncherPos = {
  centerY: null,
  userPlaced: false,
};

function loadLauncherPos(): LauncherPos {
  try {
    const raw = localStorage.getItem(LAUNCHER_POS_KEY);
    if (!raw) return { ...DEFAULT_LAUNCHER_POS };
    const parsed = JSON.parse(raw) as Partial<LauncherPos>;
    if (!parsed.userPlaced) return { ...DEFAULT_LAUNCHER_POS };
    return {
      centerY: typeof parsed.centerY === "number" ? parsed.centerY : null,
      userPlaced: true,
    };
  } catch {
    return { ...DEFAULT_LAUNCHER_POS };
  }
}

function saveLauncherPos(pos: LauncherPos): void {
  try {
    localStorage.setItem(LAUNCHER_POS_KEY, JSON.stringify(pos));
  } catch {
    /* quota / private mode */
  }
}

// Pure clamping helper — height is parameterized so the measured BCR value can
// be passed in; LAUNCHER_H serves as the fallback for 0×0 environments.
export function clampLauncherCenterY(
  centerY: number,
  vh: number,
  h: number = LAUNCHER_H,
): number {
  const halfH = h / 2;
  return Math.min(
    Math.max(halfH + VIEWPORT_PAD, centerY),
    vh - halfH - VIEWPORT_PAD,
  );
}

export class QuickStartLauncher {
  #app: ContentApp;
  #el: HTMLButtonElement | null = null;
  #signedIn = false;
  #starting = false;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #startResetTimer: ReturnType<typeof setTimeout> | null = null;
  #resaveTimer: ReturnType<typeof setTimeout> | null = null;
  #unbindDrag: (() => void) | null = null;
  #pos: LauncherPos = loadLauncherPos();
  #suppressClick = false;
  #destroyed = false;
  /**
   * Current translation tier from the last GET_LAUNCH_STATE reply.
   * Used to gate the pre-warm hover: only send PREPARE_INTENT when realtime.
   * Defaults to "standard" (conservative — won't send until the tier is confirmed).
   */
  #tier: string = "standard";
  /**
   * Fire-once-per-arming debounce for PREPARE_INTENT (mirrors popup/index.ts:990).
   * Set to true after firing; reset on mouseleave/blur so a second genuine hover
   * may fire again.
   */
  #prepareIntentSent = false;
  /**
   * Bound event handlers for hover pre-warm — stored so they can be removed when
   * the button is unmounted (#remove).
   */
  #onMouseEnter: (() => void) | null = null;
  #onFocus: (() => void) | null = null;
  #onMouseLeave: (() => void) | null = null;
  #onBlur: (() => void) | null = null;
  /**
   * DOM watch that mounts the launcher the INSTANT the page <video> appears,
   * instead of waiting up to KEEPALIVE_MS (20s) for the next keepalive tick — the
   * "launcher hiện chậm" fix. SPAs like Udemy/Shaka create the <video> well after
   * the content script's init() runs, so #hasVideo() is false at init and the only
   * re-checks were the 20s tick / visibilitychange / session events. Active ONLY
   * while eligible-but-waiting on a watch page; torn down on mount / session /
   * sign-out / navigation away / destroy.
   */
  #videoWatchObserver: MutationObserver | null = null;
  #videoWatchDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(app: ContentApp) {
    this.#app = app;
  }

  async init(): Promise<void> {
    await this.#refreshSignedIn();
    this.#update();
    this.#tickTimer = setInterval(() => void this.#tick(), KEEPALIVE_MS);
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("resize", this.#onResize);
  }

  /** Re-evaluate visibility now (called by the host on session start/stop). */
  refresh(): void {
    this.#update();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#stopVideoWatch();
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#startResetTimer) clearTimeout(this.#startResetTimer);
    if (this.#resaveTimer) {
      clearTimeout(this.#resaveTimer);
      this.#resaveTimer = null;
    }
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("resize", this.#onResize);
    this.#remove();
  }

  #onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.#tick();
  };

  #onResize = (): void => {
    if (!this.#el || !this.#pos.userPlaced) return;
    if (this.#pos.centerY == null) return;
    const centerY = clampLauncherCenterY(
      this.#pos.centerY,
      window.innerHeight,
      this.#measuredHeight(),
    );
    this.#pos = { centerY, userPlaced: true };
    this.#applyPos();
    // Debounce the localStorage write ~150 ms to avoid spamming storage on
    // rapid resize events (e.g. window-resize animation).
    if (this.#resaveTimer !== null) clearTimeout(this.#resaveTimer);
    this.#resaveTimer = setTimeout(() => {
      this.#resaveTimer = null;
      saveLauncherPos(this.#pos);
    }, 150);
  };

  async #tick(): Promise<void> {
    if (this.#destroyed) return;
    await this.#refreshSignedIn();
    this.#update();
  }

  async #refreshSignedIn(): Promise<void> {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: "GET_LAUNCH_STATE",
      })) as { ok: true; signedIn: boolean; tier?: string } | { ok: false } | undefined;
      this.#signedIn = !!(reply && reply.ok && reply.signedIn);
      if (reply && reply.ok && reply.tier) {
        this.#tier = reply.tier;
        // Tier changed — reset the pre-warm flag so the next hover may fire again
        // (avoids stale debounce if the user switched tier between ticks).
        this.#prepareIntentSent = false;
      }
    } catch {
      /* keep last known sign-in state */
    }
  }

  #hasVideo(): boolean {
    try {
      return !!(this.#app.adapter.findVideo() ?? this.#app.capture.findVideo());
    } catch {
      return false;
    }
  }

  #shouldShow(): boolean {
    return (
      this.#signedIn &&
      !this.#starting &&
      !this.#app.sm.session &&
      this.#hasVideo()
    );
  }

  /** True when the current URL is a page where a <video> is expected (so it is
   *  worth watching the DOM for it). Tolerant of adapters/test fakes without the
   *  method → false (no watch). */
  #isWatchPage(): boolean {
    try {
      return this.#app.adapter.isWatchUrl(location.href);
    } catch {
      return false;
    }
  }

  /** Begin watching the DOM for the page <video> appearing. Idempotent. */
  #startVideoWatch(): void {
    if (this.#videoWatchObserver || this.#destroyed) return;
    try {
      const observer = new MutationObserver(() => {
        // Coalesce the SPA's mutation burst, then re-evaluate ONCE. #update() is
        // cheap (a few checks + a querySelector) and idempotent.
        if (this.#videoWatchDebounce) clearTimeout(this.#videoWatchDebounce);
        this.#videoWatchDebounce = setTimeout(() => {
          this.#videoWatchDebounce = null;
          this.#update();
        }, VIDEO_WATCH_DEBOUNCE_MS);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      this.#videoWatchObserver = observer;
    } catch {
      this.#videoWatchObserver = null;
    }
  }

  /** Stop the DOM watch + clear its debounce. Idempotent. */
  #stopVideoWatch(): void {
    if (this.#videoWatchDebounce) {
      clearTimeout(this.#videoWatchDebounce);
      this.#videoWatchDebounce = null;
    }
    if (this.#videoWatchObserver) {
      this.#videoWatchObserver.disconnect();
      this.#videoWatchObserver = null;
    }
  }

  #update(): void {
    if (this.#destroyed) return;
    if (this.#shouldShow()) {
      this.#mount();
      // Mounted — no need to keep watching the DOM for the video.
      this.#stopVideoWatch();
    } else {
      this.#remove();
      // Eligible in every way EXCEPT the <video> hasn't appeared yet → watch the
      // DOM so we mount the moment it does (instead of up to 20s later). Any other
      // not-shown reason (signed out / live session / starting / non-watch page)
      // tears the watch down.
      if (
        this.#signedIn &&
        !this.#starting &&
        !this.#app.sm.session &&
        this.#isWatchPage() &&
        !this.#hasVideo()
      ) {
        this.#startVideoWatch();
      } else {
        this.#stopVideoWatch();
      }
    }
  }

  /** Returns the button's rendered height; falls back to LAUNCHER_H when 0
   *  (jsdom / not yet painted). */
  #measuredHeight(): number {
    if (!this.#el) return LAUNCHER_H;
    const rect = this.#el.getBoundingClientRect();
    return rect.height > 0 ? rect.height : LAUNCHER_H;
  }

  #applyPos(): void {
    if (!this.#el) return;
    // Always docked flush to the right viewport edge — only `top` is variable.
    this.#el.style.left = "auto";
    this.#el.style.right = "0";
    if (this.#pos.userPlaced && this.#pos.centerY != null) {
      const centerY = clampLauncherCenterY(
        this.#pos.centerY,
        window.innerHeight,
        this.#measuredHeight(),
      );
      this.#el.style.top = `${centerY}px`;
    } else {
      this.#el.style.top = "50%";
    }
    this.#el.style.transform = "translateY(-50%)";
  }

  /**
   * Send PREPARE_INTENT to the background when:
   *   • the resolved tier is realtime (only realtime benefits from a warm slot);
   *   • no session is already live (a warm slot while running is useless);
   *   • not already sent this hover session (fire-once-per-arming debounce).
   * The background resolves bearer + language via decideApiMode (no network on
   * hover) and relays CONTENT_PREPARE_INTENT → content handler →
   * app.webrtc.prepareIntent().  Any bg/network failure is a silent no-op.
   */
  #maybeSendPrepareIntent(): void {
    if (this.#tier !== TIER_REALTIME) return; // standard: no warm WS benefit
    if (this.#app.sm.session) return;          // already live — slot would be wasted
    if (this.#starting) return;                // start in flight — already on the hot path
    if (this.#prepareIntentSent) return;       // fire-once-per-arming debounce
    this.#prepareIntentSent = true;
    void chrome.runtime.sendMessage({ type: "PREPARE_INTENT" })?.catch?.(() => {});
  }

  #mount(): void {
    if (this.#el) return;
    const btn = document.createElement("button");
    btn.className = "ec-launcher";
    btn.type = "button";
    btn.title = "Dub with Echoly · drag up or down to move";
    btn.setAttribute("aria-label", "Start dubbing with Echoly");

    const mark = document.createElement("span");
    mark.className = "ec-launcher-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = LAUNCHER_MARK_SVG;
    btn.appendChild(mark);

    // Hover label — floating chip positioned to the left of the button.
    // Created via createElement + textContent (no innerHTML) per contract.
    const label = document.createElement("span");
    label.className = "ec-launcher-label";
    label.textContent = "Start dubbing";
    btn.appendChild(label);

    btn.addEventListener("click", this.#onClick);
    this.#bindDrag(btn);

    // ── Pre-warm hover (R1) ──────────────────────────────────────────────────
    // Mirror the popup's mouseenter/focus pattern (popup/index.ts:1001-1006).
    // Bound handlers are stored so #remove() can clean them up.
    this.#onMouseEnter = () => this.#maybeSendPrepareIntent();
    this.#onFocus = () => this.#maybeSendPrepareIntent();
    this.#onMouseLeave = () => { this.#prepareIntentSent = false; };
    this.#onBlur = () => { this.#prepareIntentSent = false; };
    btn.addEventListener("mouseenter", this.#onMouseEnter);
    btn.addEventListener("focus", this.#onFocus);
    btn.addEventListener("mouseleave", this.#onMouseLeave);
    btn.addEventListener("blur", this.#onBlur);

    document.body.appendChild(btn);
    this.#el = btn;
    this.#applyPos();
  }

  #bindDrag(btn: HTMLButtonElement): void {
    let originCenterY = 0;
    let startX = 0;
    let startY = 0;
    let lastCenterY = 0;
    let dragging = false;

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      dragging = false;
      this.#suppressClick = false;
      const rect = btn.getBoundingClientRect();
      originCenterY = rect.top + rect.height / 2;
      startX = e.clientX;
      startY = e.clientY;
      btn.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    // Vertical-only drag: the launcher never leaves the right edge — the
    // horizontal pointer delta only counts toward the click-vs-drag threshold.
    const onPointerMove = (e: PointerEvent): void => {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      this.#suppressClick = true;
      btn.classList.add("ec-launcher-dragging");
      lastCenterY = clampLauncherCenterY(
        originCenterY + dy,
        window.innerHeight,
        this.#measuredHeight(),
      );
      btn.style.top = `${lastCenterY}px`;
      btn.style.transform = "translateY(-50%)";
    };

    const onPointerEnd = (e: PointerEvent): void => {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      btn.releasePointerCapture(e.pointerId);
      btn.classList.remove("ec-launcher-dragging");
      if (dragging) {
        this.#pos = { centerY: lastCenterY, userPlaced: true };
        saveLauncherPos(this.#pos);
        this.#applyPos();
        e.preventDefault();
      }
      dragging = false;
    };

    btn.addEventListener("pointerdown", onPointerDown);
    btn.addEventListener("pointermove", onPointerMove);
    btn.addEventListener("pointerup", onPointerEnd);
    btn.addEventListener("pointercancel", onPointerEnd);

    this.#unbindDrag = () => {
      btn.removeEventListener("pointerdown", onPointerDown);
      btn.removeEventListener("pointermove", onPointerMove);
      btn.removeEventListener("pointerup", onPointerEnd);
      btn.removeEventListener("pointercancel", onPointerEnd);
    };
  }

  #remove(): void {
    this.#unbindDrag?.();
    this.#unbindDrag = null;
    if (this.#el) {
      this.#el.removeEventListener("click", this.#onClick);
      // Remove pre-warm hover listeners.
      if (this.#onMouseEnter) this.#el.removeEventListener("mouseenter", this.#onMouseEnter);
      if (this.#onFocus) this.#el.removeEventListener("focus", this.#onFocus);
      if (this.#onMouseLeave) this.#el.removeEventListener("mouseleave", this.#onMouseLeave);
      if (this.#onBlur) this.#el.removeEventListener("blur", this.#onBlur);
      this.#onMouseEnter = null;
      this.#onFocus = null;
      this.#onMouseLeave = null;
      this.#onBlur = null;
      this.#el.remove();
      this.#el = null;
    }
    // Reset the fire-once debounce so a re-mounted button starts fresh.
    this.#prepareIntentSent = false;
  }

  #onClick = (e: MouseEvent): void => {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.#starting = true;
    this.#remove();
    void chrome.runtime.sendMessage({ type: "START_REQUEST" })?.catch?.(() => {});
    if (this.#startResetTimer) clearTimeout(this.#startResetTimer);
    this.#startResetTimer = setTimeout(() => {
      this.#starting = false;
      this.#update();
    }, START_OPTIMISTIC_HIDE_MS);
  };
}
