// Content-script root: version guard, SessionManager, capture, overlay, WebRtcPipeline.

import {
  CAPTION_POLL_MS,
  CONTENT_GLOBAL_KEY,
  DEFAULT_TRANSLATION_TIER,
  ECHOLY_VERSION,
  HISTORY_MAX,
  ECHOLY_PROXY_BASE,
  RTC_LIVE_DURATION_HINT_SEC,
  TIER_REALTIME,
  TIER_STANDARD,
} from "@/shared/constants";
import type { BgToContentMessage, BgToContentResponse } from "@/shared/protocol";
import type { HistoryTurn, StartSettings } from "@/shared/types";
import type { OverlayCallbacks, OverlayView } from "@/shared/ports";
import type { PlatformAdapter } from "@/shared/platform-ports";
// Agent C's concrete factory. May be unresolved during Agent D's solo run; the
// LOCKED CreateOverlay/OverlayView/OverlayCallbacks types let us build against
// it now. The orchestrator resolves this at the integration gate.
import { createOverlay, purgeEcholyOverlayRoots } from "@/content/overlay/overlay";
import { SessionManager } from "./session-manager";
import type { Session } from "./session-manager";
import { AudioCapture } from "./capture";
import { WebRtcPipeline } from "./pipelines/webrtc-pipeline";
import { SubtitleFirstPipeline } from "./pipelines/subtitle-first-pipeline";
import { isSubtitleFirstSession, isWebRtcSession } from "./session-manager";
import { TOAST_PRESS_PLAY } from "@/shared/product-copy";
import { createController } from "./controller";
import { STOP_REASON, STOP_REASON_MESSAGE, type StopReason } from "./stop-reasons";
import {
  bindSourceVideoPlayback,
  syncSourcePauseState,
} from "@/lib/rtc-media-sync";
import { shouldIgnoreSourcePlaybackEvent } from "./source-playback-guards";
import {
  bindStandardDubPlaybackSync,
  type StandardDubPlaybackSyncHandle,
} from "@/lib/dub-playback-sync";
import { alignRealtimeVodBeforePlay } from "@/lib/standard-vod-start";
import { detectAdapter } from "@/platforms/registry";
import { setActiveAdapter } from "./media-stage";

/** Extra video listeners a pipeline can opt into. */
interface ExtraVideoListeners {
  onPlayExtra?: () => void;
  onSeeked?: () => void;
  /** Called BEFORE stopSession("video-ended") so the pipeline can start the final
   *  cue while the session is still alive. WebRTC pipelines do not use this. */
  onEndedBefore?: () => void;
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
  readonly webrtc: WebRtcPipeline;
  readonly subtitleFirst: SubtitleFirstPipeline;
  readonly callbacks: OverlayCallbacks;

  /** Active platform adapter — set at session start, read throughout the session. */
  adapter: PlatformAdapter = detectAdapter(location.hostname);

  // F3 — source caption polling state.
  private lastSeenCaption = "";
  private lastSpaUrl = location.href;

  /** Detach source <video> pause/play/ended listeners (any platform). */
  private unbindSourcePlayback: (() => void) | null = null;
  /** Restores native captions if we suppressed them at session start. */
  private restoreNativeCaptions: (() => void) | null = null;
  /** Standard VOD adaptive dub/video sync only. */
  private standardDubSync: StandardDubPlaybackSyncHandle | null = null;

  constructor() {
    this.capture = new AudioCapture(this.sm, this.overlay);
    this.webrtc = new WebRtcPipeline(this);
    this.subtitleFirst = new SubtitleFirstPipeline(this);
    this.callbacks = createController(this);
  }

  // ───── History (logic side — overlay owns rendering + the marker chip) ────

  /**
   * Commit the in-flight caption turn (WebRTC done / partial finalize).
   * Skips when there's no target text, mirrors the
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
      // Source text from WebRTC data channel only (never scraped live captions).
      if (this.sm.session) return;
      const text = this.adapter.readLiveCaptionText();
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

  applySourceVisibility(): void {
    this.overlay.applySourceVisibility(!!this.sm.settings?.showSource);
  }

  applyTargetCaptionVisibility(): void {
    this.overlay.applyCaptionOnVideo(
      this.sm.settings?.showTargetCaptions !== false,
    );
  }

  private stopStandardDubSync(): void {
    this.standardDubSync?.stop();
    this.standardDubSync = null;
    this.overlay.setDubSyncReadout(null);
  }

  /** Tear down VOD sync before Standard lang/voice handover rebuilds the peer. */
  prepareStandardHandover(): void {
    this.stopStandardDubSync();
  }

  private beginStandardDubSync(video: HTMLVideoElement): void {
    this.stopStandardDubSync();
    if (this.capture.isLive(video)) return;
    this.standardDubSync = bindStandardDubPlaybackSync({
      video,
      getDubAudio: () => this.sm.session?.remoteAudio ?? null,
      isUserPaused: () => this.sm.videoPaused,
      onReadout: (r) => this.overlay.setDubSyncReadout(r),
    });
  }

  /**
   * After Standard lang/voice handover: wait for ICE + first dub, then re-sync to
   * the current playhead (video keeps playing — no SF6 pause).
   */
  async completeStandardHandover(wasPaused: boolean): Promise<void> {
    const video = this.capture.videoEl;
    const session = this.sm.session;
    if (
      !video ||
      !session ||
      !isWebRtcSession(session) ||
      !session.pc ||
      session.pipeline !== TIER_STANDARD ||
      this.capture.isLive(video)
    ) {
      return;
    }

    this.overlay.setStatusText("Preparing dub");
    const connected = await this.capture.waitForPCConnected(session.pc, 8000);
    if (!connected) {
      this.overlay.showToast("Reconnecting after switch…", 5000);
    }

    this.beginStandardDubSync(video);
    const sync = this.standardDubSync;
    if (!sync) return;

    const gotDub = await sync.waitForFirstDub();
    if (!gotDub) {
      this.overlay.showToast("Dub is slow after switch — still syncing", 6000);
    }

    sync.snapPlaybackStart();
    sync.start();

    const dub = session.remoteAudio;
    if (dub && !wasPaused) {
      void dub.play().catch(() => {});
    }

    const status = wasPaused ? "Paused" : "Translating";
    this.overlay.setStatusText(status);
    this.overlay.setOverlayState(wasPaused ? "paused" : "live");
    this.sm.emitState({ paused: wasPaused, status });
  }

  // ───── Shared session timer (wires the toast + auto-stop callbacks) ───────

  startSessionTimer(): void {
    this.sm.startSessionTimer(
      () => this.overlay.showToast("Session ends in 5 min", 6000),
      () => {
        // stopSession emits STOP_REASON_MESSAGE[AUTO_STOP_60MIN].
        this.stopSession(STOP_REASON.AUTO_STOP_60MIN);
      },
    );
  }

  // ───── Shared video listeners (pause/play/ended + optional seeked) ────────

  /** Bind source <video> pause/play/ended — platform-agnostic HTMLMediaElement events. */
  bindCommonVideoListeners(
    video: HTMLVideoElement,
    _session: Session,
    extra: ExtraVideoListeners = {},
  ): void {
    this.unbindSourcePlayback?.();
    const adapter = this.adapter;
    this.unbindSourcePlayback = bindSourceVideoPlayback(video, {
      onPause: () => {
        if (shouldIgnoreSourcePlaybackEvent(adapter)) return;
        const sess = this.sm.session;
        if (!sess) return;
        // Pausing the source video STOPS the dub session entirely (user spec):
        // the overlay returns to the Stopped state so it never lingers as "LIVE"
        // while the video is paused. Resuming does NOT auto-restart — the user
        // starts again from the popup. Same teardown as the Stop button.
        this.stopSession(STOP_REASON.VIDEO_PAUSED);
      },
      onPlay: () => {
        extra.onPlayExtra?.();
        if (shouldIgnoreSourcePlaybackEvent(adapter)) return;
        const sess = this.sm.session;
        if (!sess) return;
        syncSourcePauseState(this.sm, sess, false);
        this.overlay.setStatusText("Translating");
        this.overlay.setOverlayState("live");
        this.sm.emitState({ running: true, paused: false, status: "Translating" });
      },
      onEnded: () => {
        extra.onEndedBefore?.();
        // stopSession emits STOP_REASON_MESSAGE[VIDEO_ENDED].
        this.stopSession(STOP_REASON.VIDEO_ENDED);
      },
      onSeeked: extra.onSeeked,
    });
  }

  // ───── Start router (token-bumped inside each pipeline) ───────────────────

  async startSession(
    incomingSettings: StartSettings,
    opts?: { forceWebRtcStandard?: boolean },
  ): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const { sm, capture, overlay } = this;
    if (sm.session) return { ok: false, error: "Session already running." };
    sm.settings = { ...incomingSettings };
    sm.apiBase = sm.settings.apiBase || ECHOLY_PROXY_BASE;
    sm.history = [];
    sm.currentTargetText = "";
    sm.currentSourceText = "";
    sm.translationUtteranceOpen = false;
    sm.translationSegmentId = null;

    // Detect the active platform adapter for this page.
    this.adapter = detectAdapter(location.hostname);
    setActiveAdapter(this.adapter);

    // Suppress native captions if the platform has them.
    this.restoreNativeCaptions?.();
    this.restoreNativeCaptions = this.adapter.suppressNativeCaptions?.() ?? null;

    const tier = sm.settings.tier;
    if (tier !== TIER_REALTIME && tier !== TIER_STANDARD) {
      return { ok: false, error: "Unknown tier: " + tier };
    }

    const videoProbe = this.adapter.findVideo() ?? capture.findVideo();
    const liveProbe = videoProbe ? capture.isLive(videoProbe) : false;
    if (
      tier === TIER_STANDARD &&
      !opts?.forceWebRtcStandard &&
      this.adapter.capabilities.subtitleFirst &&
      this.adapter.getVideoId(location.href) &&
      videoProbe &&
      !liveProbe
    ) {
      return this.subtitleFirst.start(incomingSettings);
    }

    return this.startWebRtcSession(incomingSettings);
  }

  /** Standard voice fallback + Realtime — tab audio via WebRTC. */
  async startWebRtcStandard(
    incomingSettings: StartSettings,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.startWebRtcSession(incomingSettings, { forceWebRtcStandard: true });
  }

  async startWebRtcSession(
    incomingSettings: StartSettings,
    _opts?: { forceWebRtcStandard?: boolean },
  ): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const { sm, capture, overlay } = this;
    sm.settings = { ...incomingSettings };
    sm.apiBase = sm.settings.apiBase || ECHOLY_PROXY_BASE;
    const settings = sm.settings;
    const tier = settings.tier;
    if (tier !== TIER_REALTIME && tier !== TIER_STANDARD) {
      return { ok: false, error: "Unknown tier." };
    }
    const pipeline = tier === TIER_STANDARD ? "standard" : "realtime";
    const voice =
      pipeline === "standard"
        ? settings.standardVoice
        : settings.realtimeVoice || "";

    const video = this.adapter.findVideo() ?? capture.findVideo();
    if (!video) return { ok: false, error: "No playable video on this page." };
    capture.videoEl = video;
    capture.bindVolumeDriftGuard(video);
    const live = capture.isLive(video);
    const wasPlaying = !video.paused;

    let stream: MediaStream;
    try {
      overlay.buildOverlay(
        this.callbacks,
        settings.advanced?.captionPosition ?? null,
        settings.languagePicker ?? undefined,
        settings.apiMode === "proxy",
        settings.standardVoices?.map((v) => [v.id, v.label]),
        tier,
      );
      overlay.syncFromSettings(settings);
      // SF8 only for Realtime — Standard adjusts rate via dub sync (dock hint).
      if (tier === TIER_REALTIME) capture.bindRateChangeWarn(video);
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
      const durationHintSec =
        pipeline === TIER_REALTIME
          ? live
            ? RTC_LIVE_DURATION_HINT_SEC
            : isFinite(video.duration) && video.duration > 0
              ? Math.ceil(video.duration)
              : undefined
          : isFinite(video.duration) && video.duration > 0
            ? Math.ceil(video.duration)
            : undefined;
      newSession = await this.webrtc.buildSession(token, stream, {
        apiBearer: settings.apiBearer,
        targetLanguage: settings.targetLanguage,
        pipeline,
        voice,
        durationHintSec,
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
    if (pipeline === TIER_REALTIME) {
      sm.startHeartbeat(newSession.rtcSessionId, newSession.apiBearer);
    }
    this.startSessionTimer();
    capture.applyVolumes(settings.originalVolume, settings.voiceVolume);
    this.applySourceVisibility();
    overlay.syncFromSettings(settings);
    if (settings.showSource) this.startCaptionPoll();

    this.bindCommonVideoListeners(video, newSession);

    // VOD: SF6 already paused the video. Realtime → ICE + ms align; Standard →
    // TTFA gate + adaptive sync loop.
    if (!live) {
      await capture.waitForPCConnected(newSession.pc!, 3000);
      if (token !== sm.pageToken) {
        return { ok: false, error: "Cancelled before play." };
      }
      if (pipeline === TIER_STANDARD) {
        this.beginStandardDubSync(video);
        overlay.setStatusText("Preparing dub");
        await this.standardDubSync!.waitForFirstDub();
        if (token !== sm.pageToken) {
          return { ok: false, error: "Cancelled before play." };
        }
        const dub = sm.session?.remoteAudio;
        if (dub) {
          try {
            dub.pause();
          } catch {
            /* ignore */
          }
        }
      } else {
        overlay.setStatusText("Almost ready");
        await alignRealtimeVodBeforePlay(
          () => sm.session?.remoteAudio ?? null,
        );
        if (token !== sm.pageToken) {
          return { ok: false, error: "Cancelled before play." };
        }
      }
      try {
        await video.play();
        if (pipeline === TIER_STANDARD && this.standardDubSync) {
          this.standardDubSync.snapPlaybackStart();
          this.standardDubSync.start();
          const dub = sm.session?.remoteAudio;
          if (dub) void dub.play().catch(() => {});
        }
        overlay.setStatusText("Translating");
      } catch {
        overlay.setStatusText(TOAST_PRESS_PLAY);
        overlay.showToast(TOAST_PRESS_PLAY, 6000);
      }
    }

    sm.emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  // ───── Universal teardown (bumps token FIRST) ─────────────────────────────

  stopSession(reason: StopReason = STOP_REASON.DEFAULT): void {
    const { sm, capture } = this;
    this.stopStandardDubSync();
    sm.videoPaused = false;
    sm.pageToken += 1;
    sm.clearSessionTimer();
    sm.stopHeartbeat();
    this.stopCaptionPoll();
    this.unbindSourcePlayback?.();
    this.unbindSourcePlayback = null;
    if (capture.videoEl) {
      // SF3/SF8 — drop guards before resetting volume so our restore writes
      // don't re-trigger them.
      capture.unbindVolumeDriftGuard();
      capture.unbindRateChangeWarn();
      capture.videoEl.muted = false;
      capture.videoEl.volume = 1.0;
      capture.videoEl = null;
    }
    const session = sm.session;
    const rtcEnd =
      session &&
      isWebRtcSession(session) &&
      session.rtcSessionId &&
      session.apiBearer &&
      session.pipeline === TIER_REALTIME
        ? { rtcSessionId: session.rtcSessionId, apiBearer: session.apiBearer }
        : null;
    if (session) {
      if (isSubtitleFirstSession(session)) {
        // Clear interval unconditionally — before the deferred/immediate branch.
        if (session.playbackTimer) {
          clearInterval(session.playbackTimer);
          session.playbackTimer = null;
        }
        session.stopFlag = true;
        try {
          session.abortController.abort();
        } catch {
          /* ignore */
        }

        // Deferred teardown ONLY when the video ended: let the final cue ring out,
        // then close the AudioContext.  On an explicit user Stop (any other reason)
        // we cut immediately — otherwise the dub keeps speaking after Stop.
        // Only one of onended / safety-timeout may close (guard double-close).
        const currentSrc = session.currentSource;
        const ctx = session.audioCtx;
        const gain = session.outputGain;

        if (currentSrc && ctx && ctx.state !== "closed" && reason === STOP_REASON.VIDEO_ENDED) {
          // Null out so the shared teardown block below skips closing.
          session.audioCtx = null;
          session.outputGain = null;

          let safetyClosed = false;
          const safetyTimer = setTimeout(() => {
            safetyClosed = true;
            try {
              gain?.disconnect();
            } catch {
              /* ignore */
            }
            if (ctx.state !== "closed") void ctx.close().catch(() => {});
          }, 5000);

          currentSrc.onended = () => {
            if (safetyClosed) return;
            clearTimeout(safetyTimer);
            try {
              gain?.disconnect();
            } catch {
              /* ignore */
            }
            if (ctx.state !== "closed") void ctx.close().catch(() => {});
          };
          // Do NOT stop the source — let it ring out; onended fires naturally.
        } else {
          // No source ringing — stop/disconnect current source and let shared
          // teardown close the ctx normally.
          if (currentSrc) {
            try {
              currentSrc.stop();
            } catch {
              /* ignore — may already be stopped */
            }
            try {
              currentSrc.disconnect();
            } catch {
              /* ignore */
            }
          }
          session.currentSource = null;
          session.currentPlayingIdx = null;
        }
      }
      try {
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
      sm.session = null;
    }
    // Release server live-session slot (MAX_CONCURRENT_LIVE_SESSIONS). Bridge
    // #closeOnce is a second path; /end must run on normal Stop too (mock peer
    // and some teardown paths never signal remote close).
    if (rtcEnd) {
      void sm.endRtcSession(rtcEnd.rtcSessionId, rtcEnd.apiBearer);
    }
    if (sm.prevSession) {
      const prev = sm.prevSession;
      try {
        if (prev.remoteAudio) {
          prev.remoteAudio.pause();
          prev.remoteAudio.srcObject = null;
          prev.remoteAudio.remove();
        }
        if (prev.outputGain) prev.outputGain.disconnect();
        if (prev.audioCtx) prev.audioCtx.close();
        if (prev.dc) prev.dc.close();
        if (prev.pc) prev.pc.close();
        if (prev.stream) prev.stream.getTracks().forEach((tr) => tr.stop());
      } catch {
        /* best-effort teardown */
      }
      sm.prevSession = null;
    }
    sm.history = [];
    sm.currentTargetText = "";
    sm.translationUtteranceOpen = false;
    sm.translationSegmentId = null;
    if (this.restoreNativeCaptions) {
      this.restoreNativeCaptions();
      this.restoreNativeCaptions = null;
    }
    // Clear the active adapter from the media-stage module.
    setActiveAdapter(null);
    this.overlay.removeOverlay();
    sm.emitState({ running: false, paused: false, status: "Stopped" });
    if (reason !== STOP_REASON.BACKEND_STOP) {
      sm.emitEnded(STOP_REASON_MESSAGE[reason]);
    }
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
    if ("showSource" in newSettings) {
      this.applySourceVisibility();
      if (sm.settings.showSource && sm.session) this.startCaptionPoll();
      else this.stopCaptionPoll();
    }
    const langOrVoiceChanged =
      ("targetLanguage" in newSettings &&
        newSettings.targetLanguage !== prev.targetLanguage) ||
      ("realtimeVoice" in newSettings &&
        newSettings.realtimeVoice !== prev.realtimeVoice) ||
      ("standardVoice" in newSettings &&
        newSettings.standardVoice !== prev.standardVoice);
    if (langOrVoiceChanged && sm.session) {
      if (isSubtitleFirstSession(sm.session)) {
        sm.settings = { ...sm.settings!, ...newSettings } as StartSettings;
        sm.notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings });
        overlay.setStatusText("Switching language/voice on next lines");
        overlay.setOverlayState("live");
      } else {
        void this.webrtc.requestHandover(newSettings);
      }
    }
    if ("originalVolume" in newSettings || "voiceVolume" in newSettings) {
      this.capture.applyVolumes(
        sm.settings.originalVolume,
        sm.settings.voiceVolume,
      );
    }

    if (overlay.isMounted()) {
      overlay.syncFromSettings(sm.settings);
    }

    // Advanced settings — apply the side-effectful subset live.
    //  • outputDeviceId  → hot-swap setSinkId on the active <audio> element.
    //  • captionPosition → re-position the overlay (user's drag still wins on
    //                       subsequent persistence — no LAYOUT_KEY write).
    //  • captionPosition / outputDeviceId → overlay layout + setSinkId on handover.
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
          // stopSession emits STOP_REASON_MESSAGE[SPA_NAVIGATION].
          this.stopSession(STOP_REASON.SPA_NAVIGATION);
        }
      }
    }, 500);
  }

  handleUnload(): void {
    this.stopSession(STOP_REASON.UNLOAD);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// initContent — entrypoint. F9 GUARD IS THE FIRST STATEMENT.
// ────────────────────────────────────────────────────────────────────────────

export function initContent(): void {
  // ───── F9 — Idempotent version guard (MUST be first) ─────────────────────
  if (Reflect.get(window, CONTENT_GLOBAL_KEY) === ECHOLY_VERSION) return;
  // Older copy may have left UI behind; clean up before re-installing.
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
  Reflect.set(window, CONTENT_GLOBAL_KEY, ECHOLY_VERSION);

  purgeEcholyOverlayRoots();

  const app = new ContentApp();

  // Orphaned-script teardown: when the runtime handle dies, stop emitting +
  // fire the realtime /end keepalive on unload.
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
      sendResponse: (response?: object) => void,
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
            app.stopSession(STOP_REASON.BACKEND_STOP);
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
