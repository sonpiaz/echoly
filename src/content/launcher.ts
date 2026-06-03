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

import type { ContentApp } from "./index";

const KEEPALIVE_MS = 20_000;
const START_OPTIMISTIC_HIDE_MS = 3000;

export class QuickStartLauncher {
  #app: ContentApp;
  #el: HTMLButtonElement | null = null;
  #signedIn = false;
  #starting = false;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #startResetTimer: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  constructor(app: ContentApp) {
    this.#app = app;
  }

  async init(): Promise<void> {
    await this.#refreshSignedIn();
    this.#update();
    // Periodic re-evaluation (SPA nav adds/removes the video; sign-in may change)
    // — each tick's GET_LAUNCH_STATE also keeps the SW warm on supported domains.
    this.#tickTimer = setInterval(() => void this.#tick(), KEEPALIVE_MS);
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  /** Re-evaluate visibility now (called by the host on session start/stop). */
  refresh(): void {
    this.#update();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#startResetTimer) clearTimeout(this.#startResetTimer);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#remove();
  }

  #onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.#tick();
  };

  async #tick(): Promise<void> {
    if (this.#destroyed) return;
    await this.#refreshSignedIn(); // doubles as the SW keepalive ping
    this.#update();
  }

  async #refreshSignedIn(): Promise<void> {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: "GET_LAUNCH_STATE",
      })) as { ok: true; signedIn: boolean } | { ok: false } | undefined;
      this.#signedIn = !!(reply && reply.ok && reply.signedIn);
    } catch {
      // Service worker unreachable — keep the last known sign-in state.
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

  #update(): void {
    if (this.#destroyed) return;
    if (this.#shouldShow()) this.#mount();
    else this.#remove();
  }

  #mount(): void {
    if (this.#el) return;
    const btn = document.createElement("button");
    btn.className = "ec-launcher";
    btn.type = "button";
    btn.title = "Lồng tiếng với Echoly";
    btn.setAttribute("aria-label", "Bắt đầu lồng tiếng với Echoly");
    const mark = document.createElement("span");
    mark.className = "ec-launcher-mark";
    mark.setAttribute("aria-hidden", "true");
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M7 9v6M11 6v12M15 8v8M19 11v2");
    svg.appendChild(path);
    mark.appendChild(svg);
    btn.appendChild(mark);
    btn.addEventListener("click", this.#onClick);
    document.body.appendChild(btn);
    this.#el = btn;
  }

  #remove(): void {
    if (this.#el) {
      this.#el.removeEventListener("click", this.#onClick);
      this.#el.remove();
      this.#el = null;
    }
  }

  #onClick = (): void => {
    // Optimistic hide so the click feels instant; the session will mount its own
    // overlay. If the start fails (no session materialises), re-show after a beat.
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
