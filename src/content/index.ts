// ────────────────────────────────────────────────────────────────────────────
// Content-script logic root. `initContent()` runs the F9 version guard FIRST,
// bootstraps the module instances (SessionManager, AudioCapture, OverlayView,
// the three pipelines, the controller), wires the orphaned-script teardown, and
// registers the chrome.runtime.onMessage listener. We keep our OWN lifecycle
// (module-global pageToken in SessionManager + per-session AbortController + raw
// timers) and do NOT use WXT's ctx. (legacy/content.js: F9 guard 9-15,
// startSession 2087, stopSession 2239, applySettingsLive 2316, caption poll
// 477-506, history 431-445, SPA watcher 2358, unload 2369, router 2378.)
// ────────────────────────────────────────────────────────────────────────────

import {
  CAPTION_POLL_MS,
  CONTENT_GLOBAL_KEY,
  ECHOLY_VERSION,
  HISTORY_MAX,
  KYMA_BASE,
} from "@/shared/constants";
import type { BgToContentMessage, BgToContentResponse } from "@/shared/protocol";
import type { HistoryTurn, StartSettings } from "@/shared/types";
import type { OverlayCallbacks, OverlayView } from "@/shared/ports";
// Agent C's concrete factory. May be unresolved during Agent D's solo run; the
// LOCKED CreateOverlay/OverlayView/OverlayCallbacks types let us build against
// it now. The orchestrator resolves this at the integration gate.
import { createOverlay } from "@/content/overlay/overlay";
import { SessionManager } from "./session-manager";
import type {
  Session,
  StandardSession,
  SubtitleFirstSession,
} from "./session-manager";
import { AudioCapture } from "./capture";
import { RealtimePipeline } from "./pipelines/realtime";
import { StandardChunkedPipeline } from "./pipelines/standard-chunked";
import { SubtitleFirstPipeline } from "./pipelines/subtitle-first";
import { createController } from "./controller";

/** Extra video listeners a pipeline can opt into (subtitle-first uses both). */
interface ExtraVideoListeners {
  onPlayExtra?: () => void;
  onSeeked?: () => void;
}

/**
 * ContentApp — the shared orchestration object the pipelines + controller hold a
 * reference to. It owns the cross-cutting lifecycle (start router, stop, live
 * settings, caption poll, history) and the shared instances. Pipelines depend on
 * it via `import type` (erased at runtime → no circular import).
 */
export class ContentApp {
  readonly sm = new SessionManager();
  readonly overlay: OverlayView = createOverlay();
  readonly capture: AudioCapture;
  readonly realtime: RealtimePipeline;
  readonly standard: StandardChunkedPipeline;
  readonly subtitleFirst: SubtitleFirstPipeline;
  readonly callbacks: OverlayCallbacks;

  // F3 — source caption polling state.
  private lastSeenCaption = "";
  private lastSpaUrl = location.href;

  // Bound video listeners (so stopSession can detach them).
  private onYTPause: (() => void) | null = null;
  private onYTPlay: (() => void) | null = null;

  constructor() {
    this.capture = new AudioCapture(this.sm, this.overlay);
    this.realtime = new RealtimePipeline(this);
    this.standard = new StandardChunkedPipeline(this);
    this.subtitleFirst = new SubtitleFirstPipeline(this);
    this.callbacks = createController(this);
  }

  // ───── History (logic side — overlay owns rendering + the marker chip) ────

  /**
   * Commit the in-flight turn (the no-arg legacy pushHistoryTurn() — realtime
   * done-event + standard-chunk). Skips when there's no target text, mirrors the
   * logic-side history buffer, resets currentTargetText, and hands the turn to
   * the overlay (which flushes it + renders). Handover marker chips go straight
   * through overlay.pushHistoryMarker(), so this no longer takes a marker.
   */
  pushHistoryTurn(): void {
    if (!this.sm.currentTargetText) return;
    const turn: HistoryTurn = {
      target: this.sm.currentTargetText.slice(0, 280),
      source: this.sm.currentSourceText.slice(0, 220),
    };
    this.sm.history.unshift(turn);
    if (this.sm.history.length > HISTORY_MAX)
      this.sm.history.length = HISTORY_MAX;
    this.sm.currentTargetText = "";
    this.overlay.pushHistoryTurn(turn);
  }

  // ───── F3 — source caption polling ───────────────────────────────────────

  startCaptionPoll(): void {
    this.stopCaptionPoll();
    this.lastSeenCaption = "";
    this.sm.captionPollTimer = setInterval(() => {
      if (!this.sm.settings?.showSource) return;
      // Bug H1: subtitle-first owns the source pane — it writes its own
      // per-sentence source text (subtitle-first.ts ~531). Letting the YT-CC
      // poll ALSO write here causes a ~350ms flicker as the two writers alternate.
      // Realtime + chunked Standard don't write source text themselves, so the
      // poll remains the source-of-truth there.
      if (this.sm.session?.type === "subtitle-first") return;
      const text = this.readYTCaptions();
      if (!text || text === this.lastSeenCaption) return;
      this.lastSeenCaption = text;
      this.sm.currentSourceText = text;
      this.overlay.setSourceText(text.slice(-220));
    }, CAPTION_POLL_MS);
  }

  stopCaptionPoll(): void {
    if (this.sm.captionPollTimer) {
      clearInterval(this.sm.captionPollTimer);
      this.sm.captionPollTimer = null;
    }
  }

  private readYTCaptions(): string {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    return Array.from(segs)
      .map((s) => s.textContent)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  applySourceVisibility(): void {
    this.overlay.applySourceVisibility(!!this.sm.settings?.showSource);
  }

  // ───── Shared session timer (wires the toast + auto-stop callbacks) ───────

  startSessionTimer(): void {
    this.sm.startSessionTimer(
      () => this.overlay.showToast("Session ends in 5 min", 6000),
      () => {
        this.stopSession("auto-stop-60min");
        this.sm.emitEnded("Auto-stopped at 60 min — start again to continue.");
      },
    );
  }

  // ───── Shared video listeners (pause/play/ended + optional seeked) ────────

  /** Bind the common pause/play/ended listeners (all tiers) plus any extras.
   *  Stores the pause/play refs on the app + the ended ref on the session so
   *  stopSession can detach them. (legacy per-tier onYTPause/onYTPlay/onYTEnded
   *  + subtitle-first onYTSeeked.) */
  bindCommonVideoListeners(
    video: HTMLVideoElement,
    session: Session,
    extra: ExtraVideoListeners = {},
  ): void {
    this.onYTPause = () => {
      this.overlay.setStatusText("Paused");
      this.overlay.setOverlayState("paused");
      this.sm.emitState({ paused: true, status: "Paused" });
    };
    this.onYTPlay = () => {
      extra.onPlayExtra?.();
      this.overlay.setStatusText("Translating");
      this.overlay.setOverlayState("live");
      this.sm.emitState({ paused: false, status: "Translating" });
    };
    const onYTEnded = (): void => {
      this.stopSession("video-ended");
      this.sm.emitEnded("Video ended.");
    };
    video.addEventListener("pause", this.onYTPause);
    video.addEventListener("play", this.onYTPlay);
    video.addEventListener("ended", onYTEnded);
    if (extra.onSeeked) video.addEventListener("seeked", extra.onSeeked);
    session._onEnded = onYTEnded;
  }

  // ───── Start router (token-bumped inside each pipeline) ───────────────────

  async startSession(incomingSettings: StartSettings): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const { sm, capture, overlay } = this;
    if (sm.session) return { ok: false, error: "Session already running." };
    sm.settings = { ...incomingSettings };
    // Background may override the Kyma base with the Echoly proxy; fall back to
    // the BYOK constant. content stays mode-agnostic.
    sm.apiBase = sm.settings.apiBase || KYMA_BASE;
    sm.history = [];
    sm.currentTargetText = "";
    sm.currentSourceText = "";

    if (sm.settings.tier === "standard") {
      // Subtitle-first is the default Standard path (YouTube + non-live);
      // chunked is the live-stream / no-caption fallback. Live skips
      // subtitle-first because it pauses the video to render wave 1 (SF6/TC-6).
      const probeVideo = capture.findVideo();
      if (
        location.hostname.includes("youtube.com") &&
        !capture.isLive(probeVideo)
      ) {
        return this.subtitleFirst.startSubtitleFirstSession();
      }
      return this.standard.startStandardSession();
    }
    if (sm.settings.tier !== "realtime") {
      return { ok: false, error: "Unknown tier: " + sm.settings.tier };
    }

    // ── Realtime tier ──
    const video = capture.findVideo();
    if (!video) return { ok: false, error: "No YouTube video on this page." };
    capture.videoEl = video;
    capture.bindVolumeDriftGuard(video);
    const live = capture.isLive(video);
    const wasPlaying = !video.paused;

    let stream: MediaStream;
    try {
      overlay.buildOverlay(
        this.callbacks,
        sm.settings.advanced?.captionPosition ?? null,
      );
      capture.bindRateChangeWarn(video);
      overlay.setStatusText("Acquiring audio");
      stream = await capture.captureWithRetry(video);
    } catch (err) {
      overlay.removeOverlay();
      return { ok: false, error: (err as Error).message };
    }

    // Non-live sync (SF6): pause after we have capture tracks so the speaker
    // doesn't run ahead while the WebRTC channel sets up. Live skips this.
    if (!live) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      overlay.setStatusText("Connecting");
    }

    const token = sm.nextToken();
    let newSession;
    try {
      newSession = await this.realtime.buildRealtimeSession(token, stream, {
        kymaKey: sm.settings.kymaKey,
        targetLanguage: sm.settings.targetLanguage,
        realtimeVoice: sm.settings.realtimeVoice,
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      if (!live && wasPlaying) {
        try {
          video.play().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      overlay.removeOverlay();
      const e = err as Error & { cta?: string };
      const msg = e.cta ? `${e.message} (${e.cta})` : e.message;
      return { ok: false, error: msg };
    }
    if (token !== sm.pageToken) {
      // Stop arrived during build.
      try {
        newSession.pc!.close();
      } catch {
        /* ignore */
      }
      if (!live && wasPlaying) {
        try {
          video.play().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      overlay.removeOverlay();
      return { ok: false, error: "Cancelled before connect completed." };
    }

    sm.session = newSession;
    overlay.setOverlayState("live");
    overlay.setStatusText(live ? "Translating" : "Almost ready");
    sm.startHeartbeat(newSession.kymaSessionId, newSession.kymaKey);
    this.startSessionTimer();
    capture.applyVolumes(sm.settings.originalVolume, sm.settings.voiceVolume);
    this.applySourceVisibility();
    if (sm.settings.showSource) this.startCaptionPoll();

    this.bindCommonVideoListeners(video, newSession);

    // Non-live: wait for ICE before resuming playback so the first captured
    // audio has a live channel. Timeout falls through to play() anyway.
    if (!live) {
      await capture.waitForPCConnected(newSession.pc!, 3000);
      if (token !== sm.pageToken) {
        return { ok: false, error: "Cancelled before play." };
      }
      try {
        await video.play();
        overlay.setStatusText("Translating");
      } catch {
        overlay.setStatusText("Press YouTube play to start dub");
        overlay.showToast("Press YouTube play to start dub", 6000);
      }
    }

    sm.emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  // ───── Universal teardown (bumps token FIRST) ─────────────────────────────

  stopSession(_reason = "stop"): void {
    const { sm, capture } = this;
    sm.pageToken += 1;
    sm.clearSessionTimer();
    sm.stopHeartbeat();
    this.stopCaptionPoll();
    if (capture.videoEl) {
      if (this.onYTPause)
        capture.videoEl.removeEventListener("pause", this.onYTPause);
      if (this.onYTPlay)
        capture.videoEl.removeEventListener("play", this.onYTPlay);
      const cur = sm.session;
      if (cur?.type === "subtitle-first" && cur._onSeeked) {
        try {
          capture.videoEl.removeEventListener("seeked", cur._onSeeked);
        } catch {
          /* ignore */
        }
      }
      if (cur?._onEnded) {
        try {
          capture.videoEl.removeEventListener("ended", cur._onEnded);
        } catch {
          /* ignore */
        }
      }
      // SF3/SF8 — drop guards before resetting volume so our restore writes
      // don't re-trigger them.
      capture.unbindVolumeDriftGuard();
      capture.unbindRateChangeWarn();
      capture.videoEl.muted = false;
      capture.videoEl.volume = 1.0;
      capture.videoEl = null;
    }
    this.onYTPause = null;
    this.onYTPlay = null;
    const session = sm.session;
    if (session) {
      try {
        if (session.type === "standard") {
          const std = session as StandardSession;
          std.stopFlag = true;
          try {
            std.abortController.abort();
          } catch {
            /* ignore */
          }
          if (std.activeRecorder && std.activeRecorder.state !== "inactive") {
            try {
              std.activeRecorder.stop();
            } catch {
              /* ignore */
            }
          }
        }
        if (session.type === "subtitle-first") {
          const sf = session as SubtitleFirstSession;
          sf.stopFlag = true;
          try {
            sf.abortController.abort();
          } catch {
            /* ignore */
          }
          this.subtitleFirst.cancelPendingSources(sf);
        }
        if (session.remoteAudio) {
          session.remoteAudio.pause();
          session.remoteAudio.srcObject = null;
          session.remoteAudio.remove();
        }
        if (session.outputGain) session.outputGain.disconnect();
        if (session.audioCtx) session.audioCtx.close();
        if (session.dc) session.dc.close();
        if (session.pc) session.pc.close();
        if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* best-effort teardown */
      }
      // Realtime tier holds Kyma session collateral; the local tiers don't.
      if (session.kymaSessionId) {
        void sm.endKymaSession(session.kymaSessionId, session.kymaKey);
      }
      sm.session = null;
    }
    if (sm.prevSession) {
      try {
        sm.prevSession.pc?.close();
      } catch {
        /* ignore */
      }
      void sm.endKymaSession(
        sm.prevSession.kymaSessionId,
        sm.prevSession.kymaKey,
      );
      sm.prevSession = null;
    }
    sm.history = [];
    sm.currentTargetText = "";
    this.overlay.removeOverlay();
  }

  // ───── Live settings update ───────────────────────────────────────────────

  applySettingsLive(newSettings: Partial<StartSettings>): void {
    const { sm, overlay } = this;
    const prev = (sm.settings || {}) as Partial<StartSettings>;
    sm.settings = { ...prev, ...newSettings } as StartSettings;
    // Tier swap mid-session needs a full restart (different pipelines).
    if (
      "tier" in newSettings &&
      newSettings.tier !== prev.tier &&
      sm.session
    ) {
      overlay.showToast("Stop and Start to switch tiers", 5000);
    }
    // Sync the language <select> to the pushed target (legacy content.js:2325-2326).
    if (newSettings.targetLanguage) {
      overlay.setLanguageSelection(newSettings.targetLanguage);
    }
    // Voice <select> shape depends on tier — repopulate before assigning value
    // so the new id exists. We surface the active values through
    // populateVoicePicker so the dropdown shape matches the tier.
    if (
      newSettings.realtimeVoice !== undefined ||
      newSettings.standardVoice !== undefined
    ) {
      const tier = sm.settings.tier || "realtime";
      const selected =
        tier === "standard"
          ? sm.settings.standardVoice
          : sm.settings.realtimeVoice || "";
      overlay.populateVoicePicker(tier, selected);
    }
    if ("showSource" in newSettings) {
      this.applySourceVisibility();
      if (sm.settings.showSource && sm.session) this.startCaptionPoll();
      else this.stopCaptionPoll();
    }
    // Only REALTIME needs the zero-gap handover (PeerConnection tear-down +
    // rebuild). Standard chunked picks up new lang/voice on the next chunk —
    // settings already mutated above. Subtitle-first must additionally cancel
    // its in-flight TTS queue so already-rendered sentences in the OLD lang
    // don't keep playing; the rolling renderer then picks up the new lang on
    // its next batch. (Bug C1: legacy fell into the realtime handover path
    // for subtitle-first sessions and silently no-op'd.)
    const langOrVoiceChanged =
      ("targetLanguage" in newSettings &&
        newSettings.targetLanguage !== prev.targetLanguage) ||
      ("realtimeVoice" in newSettings &&
        newSettings.realtimeVoice !== prev.realtimeVoice) ||
      ("standardVoice" in newSettings &&
        newSettings.standardVoice !== prev.standardVoice);
    if (langOrVoiceChanged && sm.session) {
      // RealtimeSession is the only branch without a `type` tag (legacy shape).
      if (sm.session.type === undefined) {
        void this.realtime.requestHandover(newSettings);
      } else if (sm.session.type === "subtitle-first") {
        // Drop already-scheduled TTS (old lang/voice). The rolling renderer
        // will re-translate + re-render from the next batch with new settings.
        this.subtitleFirst.cancelPendingSources(
          sm.session as SubtitleFirstSession,
        );
        sm.currentTargetText = "";
        overlay.setTargetText("");
        overlay.setStatusText("Switching language…");
        overlay.setOverlayState("live");
      }
      // Standard chunked: settings mutation alone is enough — next chunk uses
      // them. No further action.
    }
    if ("originalVolume" in newSettings || "voiceVolume" in newSettings) {
      this.capture.applyVolumes(
        sm.settings.originalVolume,
        sm.settings.voiceVolume,
      );
    }

    // Advanced settings — apply the side-effectful subset live.
    //  • outputDeviceId  → hot-swap setSinkId on the active <audio> element.
    //  • captionPosition → re-position the overlay (user's drag still wins on
    //                       subsequent persistence — no LAYOUT_KEY write).
    //  • translationStyle / latencyPreset / noiseGate → no live action needed;
    //    the Standard pipeline reads them fresh per chunk from sm.settings.
    if ("advanced" in newSettings && newSettings.advanced) {
      const nextAdv = newSettings.advanced;
      const prevAdv = (prev as Partial<StartSettings>).advanced;
      if (
        nextAdv.outputDeviceId !== undefined &&
        nextAdv.outputDeviceId !== prevAdv?.outputDeviceId
      ) {
        this.capture.applyOutputDevice(nextAdv.outputDeviceId);
      }
      if (
        nextAdv.captionPosition !== undefined &&
        nextAdv.captionPosition !== prevAdv?.captionPosition
      ) {
        overlay.setCaptionPosition(nextAdv.captionPosition);
      }
    }
  }

  applyVolumes(originalVolume: number, voiceVolume: number): void {
    const { sm } = this;
    sm.settings = {
      ...(sm.settings || {}),
      originalVolume,
      voiceVolume,
    } as StartSettings;
    this.capture.applyVolumes(originalVolume, voiceVolume);
  }

  // ───── SPA navigation + unload hooks ──────────────────────────────────────

  startSpaWatcher(): void {
    setInterval(() => {
      if (location.href !== this.lastSpaUrl) {
        this.lastSpaUrl = location.href;
        if (this.sm.session) {
          this.stopSession("yt-navigation");
          this.sm.emitEnded("YouTube navigated.");
        }
      }
    }, 500);
  }

  handleUnload(): void {
    if (this.sm.session) {
      void this.sm.endKymaSession(
        this.sm.session.kymaSessionId,
        this.sm.session.kymaKey,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// initContent — entrypoint. F9 GUARD IS THE FIRST STATEMENT.
// ────────────────────────────────────────────────────────────────────────────

export function initContent(): void {
  // ───── F9 — Idempotent version guard (MUST be first) ─────────────────────
  const w = window as unknown as Record<string, unknown>;
  if (w[CONTENT_GLOBAL_KEY] === ECHOLY_VERSION) return;
  // Older copy may have left UI behind; clean up before re-installing.
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
  w[CONTENT_GLOBAL_KEY] = ECHOLY_VERSION;

  const app = new ContentApp();

  // Orphaned-script teardown: when the runtime handle dies, stop emitting +
  // fire the Kyma /end keepalive (legacy notifyBackground catch → handleUnload).
  app.sm.setUnloadHandler(() => app.handleUnload());

  // SPA navigation watcher + tab-unload keepalive.
  app.startSpaWatcher();
  const onUnload = (): void => app.handleUnload();
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("pagehide", onUnload);

  // ───── Background message router ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener(
    (
      msg: BgToContentMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      void (async () => {
        switch (msg?.type) {
          case "CONTENT_PING":
            sendResponse({
              ok: true,
              version: ECHOLY_VERSION,
            } satisfies BgToContentResponse["CONTENT_PING"]);
            break;
          case "CONTENT_START":
            sendResponse(await app.startSession(msg.settings));
            break;
          case "CONTENT_STOP":
            app.stopSession("backend-stop");
            sendResponse({ ok: true } satisfies BgToContentResponse["CONTENT_STOP"]);
            break;
          case "CONTENT_UPDATE_SETTINGS":
            app.applySettingsLive(msg.settings);
            sendResponse({ ok: true });
            break;
          case "CONTENT_UPDATE_VOLUME":
            app.applyVolumes(msg.originalVolume, msg.voiceVolume);
            sendResponse({ ok: true } satisfies BgToContentResponse["CONTENT_UPDATE_VOLUME"]);
            break;
          default:
            sendResponse({
              ok: false,
              error: "Unknown content message: " + (msg as { type?: string })?.type,
            });
        }
      })();
      return true;
    },
  );
}
