// WebRtcPipeline — voice dubbing via WebRTC (any site with <video>).
// Realtime: OpenAI relay. Standard: Gemini audio-in → TTS. POST /v1/rtc/translate.

import {
  TIER_REALTIME,
  TIER_STANDARD,
  RTC_LIVE_DURATION_HINT_CAP_SEC,
  type TranslationTier,
} from "@/shared/constants";
import { resolveLangName } from "@/lib/resolve-lang-name";
import { parseServerError } from "@/lib/server-errors";
import { pipelineToastFromServer } from "@/lib/pipeline-error";
import { notifyQuotaToBackground, refreshUsageAfterExhaustion } from "@/lib/quota-notify";
import { RTC_METADATA_CHANNEL } from "@/shared/rtc-metadata";
import { currentSiteHost } from "@/shared/site-host";
import { ECHOLY_WEB_URLS } from "@/shared/echoly-config";
import { post } from "@/shared/protocol";
import { applyLiveTranslationDelta } from "@/lib/caption-live";
import { computeGain } from "@/lib/audio";
import {
  detachOutgoingPeer,
  handoverDurationHintSec,
} from "@/lib/rtc-handover";
import { alignRealtimeVodBeforePlay } from "@/lib/standard-vod-start";
import {
  isWebRtcSession,
  type WebRtcSession,
  type WebRtcSignalingPipeline,
} from "../session-manager";
import type { ContentApp } from "../index";
import { STOP_REASON } from "../stop-reasons";
import type { StartSettings } from "@/shared/types";

interface CtaError extends Error {
  cta?: string;
  ctaLabel?: string;
}

export interface WebRtcBuildOpts {
  apiBearer: string;
  targetLanguage: string;
  pipeline: WebRtcSignalingPipeline;
  voice: string;
  durationHintSec?: number;
}

type MetadataEvent =
  | { type: "error"; message?: string; code?: string; retryable?: boolean }
  | {
      type: "partial_translation";
      text: string;
      isFinal: boolean;
      segmentId: number | null;
    }
  | { type: "partial_transcript"; text: string }
  | { type: "done"; text?: string }
  | { type: "session_ack" }
  | { type: "usage" }
  | { type: "committed" };

type EventRecord = {
  type?: string;
  text?: string;
  message?: string;
  code?: string;
  retryable?: boolean;
  isFinal?: boolean;
  is_final?: boolean;
  segmentId?: number | null;
  segment_id?: number | null;
};

function asRecord(value: object | null): EventRecord | null {
  if (!value) return null;
  return value as EventRecord;
}

function parseMetadataEvent(raw: string): MetadataEvent | null {
  let parsed: object | null = null;
  try {
    parsed = JSON.parse(raw) as object | null;
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (!obj || typeof obj.type !== "string") return null;
  switch (obj.type) {
    case "error":
      return {
        type: "error",
        message: typeof obj.message === "string" ? obj.message : undefined,
        code: typeof obj.code === "string" ? obj.code : undefined,
        retryable: typeof obj.retryable === "boolean" ? obj.retryable : undefined,
      };
    case "partial_translation": {
      if (typeof obj.text !== "string" || !obj.text) return null;
      const segRaw = obj.segmentId ?? obj.segment_id;
      const segmentId =
        typeof segRaw === "number" && Number.isFinite(segRaw) ? segRaw : null;
      return {
        type: "partial_translation",
        text: obj.text,
        isFinal: obj.isFinal === true || obj.is_final === true,
        segmentId,
      };
    }
    case "partial_transcript":
      return typeof obj.text === "string" && obj.text
        ? { type: "partial_transcript", text: obj.text }
        : null;
    case "done":
      return { type: "done", text: typeof obj.text === "string" ? obj.text : undefined };
    case "session_ack":
    case "usage":
    case "committed":
      return { type: obj.type };
    default:
      return null;
  }
}

export class WebRtcPipeline {
  #handoverInFlight = false;
  /**
   * Short-lived prepare_id from the last successful prepareIntent() call.
   * Set on hover/focus intent; cleared once consumed by buildSession() or on
   * any error (graceful fallback to cold path).
   */
  #pendingPrepareId: string | null = null;

  constructor(private readonly app: ContentApp) {}

  /**
   * Fire-and-forget pre-warm intent — call on Start button hover/focus.
   * Posts to /v1/rtc/prepare to pre-allocate the media transport + provider WS.
   * Stores the returned prepare_id for the next buildSession() call.
   * Any failure is silently ignored; buildSession() falls back to the cold path.
   *
   * D-3: for pipeline=standard the server accepts the request but returns no warm
   * WS benefit — the prepare_id is still threaded through and will produce a slot
   * that is claimed (transport already allocated). On standard the benefit is
   * ~50–100 ms transport-create savings only.
   */
  async prepareIntent(opts: {
    apiBearer: string;
    pipeline: string;
    targetLanguage: string;
  }): Promise<void> {
    const { sm } = this.app;
    try {
      const res = await fetch(`${sm.apiBase}/rtc/prepare`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + opts.apiBearer,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pipeline: opts.pipeline,
          target_language: opts.targetLanguage,
        }),
      });
      if (!res.ok) {
        this.#pendingPrepareId = null;
        return;
      }
      const json = (await res.json()) as { prepare_id?: string };
      this.#pendingPrepareId = typeof json.prepare_id === "string" ? json.prepare_id : null;
    } catch {
      // Network error or JSON parse failure — ignore, cold path will be used.
      this.#pendingPrepareId = null;
    }
  }

  async buildSession(
    token: number,
    audioStream: MediaStream,
    opts: WebRtcBuildOpts,
  ): Promise<WebRtcSession> {
    const { sm, overlay } = this.app;
    const lang = opts.targetLanguage || "vi";

    overlay.setStatusText("Connecting");
    overlay.setOverlayState("connecting");

    const pc = new RTCPeerConnection();
    for (const track of audioStream.getAudioTracks()) {
      pc.addTrack(track, audioStream);
    }

    const dc = pc.createDataChannel(RTC_METADATA_CHANNEL);

    let preCtx: AudioContext | null = null;
    let preGain: GainNode | null = null;
    try {
      const Ctor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      preCtx = new Ctor();
      if (preCtx.state === "suspended") preCtx.resume().catch(() => {});
      preGain = preCtx.createGain();
      preGain.gain.value = computeGain(sm.settings?.voiceVolume ?? 100);
      preGain.connect(preCtx.destination);
    } catch {
      try {
        preCtx?.close();
      } catch {
        /* ignore */
      }
      preCtx = null;
      preGain = null;
    }

    const newSession: WebRtcSession = {
      token,
      pc,
      dc: null,
      stream: audioStream,
      remoteAudio: null,
      audioCtx: preCtx,
      outputGain: preGain,
      rtcSessionId: null,
      apiBearer: opts.apiBearer,
      pipeline: opts.pipeline,
      targetLanguage: lang,
      voice: opts.voice,
    };

    const wireMetadataChannel = (channel: RTCDataChannel): void => {
      if (channel.label !== RTC_METADATA_CHANNEL) return;
      newSession.dc = channel;
      channel.addEventListener("message", (e: MessageEvent) => {
        const raw =
          typeof e.data === "string"
            ? e.data
            : e.data instanceof ArrayBuffer
              ? new TextDecoder().decode(e.data)
              : null;
        if (sm.isSessionStale(token)) return;
        if (raw) this.handleMetadataEvent(raw, token);
        else if (e.data instanceof Blob) {
          void e.data.text().then((text) => {
            if (!sm.isSessionStale(token) && text) this.handleMetadataEvent(text, token);
          });
        }
      });
    };

    wireMetadataChannel(dc);
    pc.addEventListener("datachannel", (ev: RTCDataChannelEvent) => {
      wireMetadataChannel(ev.channel);
    });

    let dubWebAudioSrc: MediaStreamAudioSourceNode | null = null;

    pc.addEventListener("track", (event: RTCTrackEvent) => {
      if (newSession.remoteAudio) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.muted = true;
      audio.srcObject = event.streams[0]!;
      document.body.appendChild(audio);
      newSession.remoteAudio = audio;
      void audio.play().catch(() => {});

      event.track.addEventListener("unmute", () => {
        const dubVol = Math.min((sm.settings?.voiceVolume ?? 100) / 100, 1.0);
        const stream = event.streams[0];
        const useWebAudio =
          !!newSession.outputGain &&
          !!newSession.audioCtx &&
          newSession.audioCtx.state !== "closed" &&
          !!stream;

        if (useWebAudio) {
          audio.muted = true;
          try {
            dubWebAudioSrc?.disconnect();
            dubWebAudioSrc = newSession.audioCtx!.createMediaStreamSource(stream);
            dubWebAudioSrc.connect(newSession.outputGain!);
            void newSession.audioCtx!.resume().catch(() => {});
          } catch {
            newSession.audioCtx = null;
            newSession.outputGain = null;
            audio.muted = false;
            audio.volume = dubVol;
          }
        } else {
          audio.muted = false;
          audio.volume = dubVol;
        }
        void audio.play().catch(() => {});
      });

      const sinkId = sm.settings?.advanced?.outputDeviceId ?? "";
      const a = audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (sinkId && typeof a.setSinkId === "function") {
        a.setSinkId(sinkId).catch((err: Error) => {
          console.warn("[echoly] setSinkId failed; using default output", err);
        });
      }
    });

    let iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIceDisconnectTimer = (): void => {
      if (iceDisconnectTimer != null) {
        clearTimeout(iceDisconnectTimer);
        iceDisconnectTimer = null;
      }
    };
    pc.addEventListener("iceconnectionstatechange", () => {
      if (sm.isSessionStale(token)) return;
      const ice = pc.iceConnectionState;
      if (ice === "connected" || ice === "completed") {
        clearIceDisconnectTimer();
        return;
      }
      if (ice === "disconnected") {
        if (iceDisconnectTimer != null) return;
        iceDisconnectTimer = setTimeout(() => {
          iceDisconnectTimer = null;
          if (sm.isSessionStale(token)) return;
          if (newSession !== sm.session) return;
          if (pc.iceConnectionState !== "disconnected") return;
          // If the user has paused the source video, do NOT tear down the session —
          // mark it as lost so resumeSession can attempt a one-shot rebuild (§2.5).
          if (sm.userPaused) {
            this.app.lifecycle.pause("connection-lost");
            return;
          }
          // stopSession emits STOP_REASON_MESSAGE[CONNECTION_LOST].
          this.app.stopSession(STOP_REASON.CONNECTION_LOST);
        }, 8_000);
        return;
      }
      if (ice === "closed" || ice === "failed") {
        clearIceDisconnectTimer();
        if (newSession === sm.session) {
          // Peer died — if the user is paused, mark as lost for resume-rebuild
          // (§2.5); otherwise tear down immediately.
          if (sm.userPaused) {
            this.app.lifecycle.pause("connection-lost");
          } else {
            this.app.stopSession(STOP_REASON.CONNECTION_LOST);
          }
        }
      }
    });

    const offer = await pc.createOffer();
    if (token !== sm.pageToken) throw new Error("Stale session.");
    await pc.setLocalDescription(offer);

    // D — consume the pending prepare_id if one is available (pre-warm path).
    // Consume and clear before the fetch so a second concurrent buildSession()
    // doesn't also attempt to use the same (single-use) prepare_id.
    const prepareId = this.#pendingPrepareId;
    this.#pendingPrepareId = null;

    const qs = new URLSearchParams({
      targetLanguage: lang,
      pipeline: opts.pipeline,
    });
    if (opts.voice) qs.set("voice", opts.voice);
    if (
      opts.durationHintSec != null &&
      Number.isFinite(opts.durationHintSec) &&
      opts.durationHintSec > 0
    ) {
      qs.set("durationHintSec", String(Math.ceil(opts.durationHintSec)));
    }
    // Thread the prepare_id into the query string if available. The server will
    // claim the warm slot; if it's missing/expired the server falls through to
    // the standard cold answer() path (back-compat, AC11).
    if (prepareId) qs.set("prepareId", prepareId);

    const sdpHeaders: Record<string, string> = {
      Authorization: "Bearer " + opts.apiBearer,
      "Content-Type": "application/sdp",
    };
    const siteHost = currentSiteHost();
    if (siteHost) sdpHeaders["X-Echoly-Site-Host"] = siteHost;
    const rawTitle = this.app.adapter.getVideoTitle?.() ?? null;
    if (rawTitle) sdpHeaders["X-Echoly-Video-Title"] = encodeURIComponent(rawTitle);

    const sdpResp = await fetch(`${sm.apiBase}/rtc/translate?${qs}`, {
      method: "POST",
      headers: sdpHeaders,
      body: offer.sdp,
    });

    if (token !== sm.pageToken) {
      pc.close();
      throw new Error("Stale session.");
    }
    if (!sdpResp.ok) {
      pc.close();
      const parsed = await parseServerError(sdpResp);
      notifyQuotaToBackground(parsed);
      const toast = pipelineToastFromServer(parsed);
      throw Object.assign(new Error(toast.user), toast);
    }

    const rtcSessionId = sdpResp.headers.get("x-echoly-session-id") || null;
    const answerSdp = await sdpResp.text();
    if (token !== sm.pageToken) {
      pc.close();
      throw new Error("Stale session.");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    newSession.rtcSessionId = rtcSessionId;
    return newSession;
  }

  handleMetadataEvent(raw: string, token: number): void {
    const { sm, overlay } = this.app;
    if (sm.isSessionStale(token)) return;
    if (sm.videoPaused) return;
    const evt = parseMetadataEvent(raw);
    if (!evt) return;

    if (evt.type === "error") {
      const msg = evt.message?.trim() || "Translation error";
      // Expiry-like codes (quota/tier/auth) warrant a persistent toast with a CTA.
      // The server sends {type:"error", code:"quota_exhausted"} on the data-channel
      // when the server-authoritative floor timer detects credit exhaustion (D1).
      // Standard-live also emits the same frame (#onStandardSegmentTick).
      const isExpiryCode =
        evt.code === "quota_exhausted" ||
        evt.code === "tier_locked" ||
        evt.code === "unauthorized" ||
        evt.code === "forbidden";
      if (isExpiryCode) {
        const upgradeUrl = ECHOLY_WEB_URLS.accountBilling();
        overlay.showToast(msg, {
          durationMs: 10000,
          cta: upgradeUrl,
          ctaLabel: evt.code === "unauthorized" ? "Sign in" : "Upgrade",
        });
        // Notify the background so it can mark the session as not running.
        // Also post CONTENT_QUOTA without numeric fields for the session-stop
        // path; the real numbers are refreshed below via /v1/usage.
        post({ type: "CONTENT_QUOTA" });
        // quota_exhausted via data-channel: the server's frame carries no credit
        // numbers. Fetch /v1/usage once to refresh the popup meter so the user
        // sees their actual current balance (SOLUTION WS5.5 / S5-F9).
        if (evt.code === "quota_exhausted" && sm.session?.apiBearer) {
          refreshUsageAfterExhaustion(sm.session.apiBearer);
        }
      }
      overlay.setStatusText(msg);
      this.app.stopSession(STOP_REASON.SERVER_ERROR);
      return;
    }
    if (evt.type === "partial_translation") {
      if (
        evt.segmentId != null &&
        evt.segmentId !== sm.translationSegmentId
      ) {
        sm.translationSegmentId = evt.segmentId;
        sm.translationUtteranceOpen = false;
      }
      const next = applyLiveTranslationDelta(
        {
          text: sm.currentTargetText,
          utteranceOpen: sm.translationUtteranceOpen,
        },
        evt.text,
        evt.isFinal === true,
      );
      sm.currentTargetText = next.text;
      sm.translationUtteranceOpen = next.utteranceOpen;
      overlay.setTargetText(sm.currentTargetText);
      overlay.setOverlayState("live");
      return;
    }
    if (evt.type === "partial_transcript") {
      sm.currentSourceText = evt.text;
      if (sm.settings?.showSource) {
        overlay.setSourceText(evt.text.slice(-220));
      }
      return;
    }
    if (evt.type === "done") {
      if (evt.text?.trim()) sm.currentTargetText = evt.text;
      overlay.setTargetText(sm.currentTargetText);
      this.app.pushHistoryTurn();
    }
  }

  async requestHandover(partial: {
    targetLanguage?: string;
    realtimeVoice?: string;
    standardVoice?: string;
  }): Promise<void> {
    if (this.#handoverInFlight) return;
    this.#handoverInFlight = true;
    try {
      await this.#requestHandoverInner(partial);
    } finally {
      this.#handoverInFlight = false;
    }
  }

  /**
   * Continue a Realtime or Standard-WebRTC session on a new video without
   * tearing down the overlay. Keeps the background session running and the
   * overlay mounted; only the peer + capture stream are rebuilt.
   *
   * For Realtime: POST /end on the old session, detach peer, then buildSession
   * with a new token and restart the heartbeat.
   * For Standard-WebRTC: stop dub-sync, detach peer, then buildSession and
   * restart standardDubSync.
   *
   * Re-acquires the capture stream only when the <video> element reference has
   * changed (YouTube reuses the same element so the stream survives; other
   * platforms may replace it). Returns {ok:true} on success, {ok:false,error}
   * on failure — the caller handles fallback/stopSession.
   */
  async continueOnNewVideo(
    settings: StartSettings,
  ): Promise<{ ok: boolean; error?: string }> {
    const { sm, capture } = this.app;
    const session = sm.session;
    if (!session || !isWebRtcSession(session)) {
      return { ok: false, error: "No active WebRTC session." };
    }

    const pipeline = session.pipeline; // "realtime" | "standard"
    const prevVideoEl = capture.videoEl;

    // ── End the old session cleanly ──────────────────────────────────────────
    if (pipeline === TIER_REALTIME) {
      // /end the old realtime session (closes billing for the old video cleanly).
      sm.stopHeartbeat();
      if (session.rtcSessionId && session.apiBearer) {
        void sm.endRtcSession(session.rtcSessionId, session.apiBearer);
      }
    } else {
      // Standard-WebRTC auto-next: call /end on the old session so the server
      // closes billing deterministically (SOLUTION WS5.3 / S5-F2, S5-F7).
      // Without this the server relies solely on ICE disconnect detection which
      // can leave a session open for seconds. endRtcSession uses keepalive:true
      // so it survives the session teardown.
      if (session.rtcSessionId && session.apiBearer) {
        void sm.endRtcSession(session.rtcSessionId, session.apiBearer);
      }
      // Quiesce dub-sync before detaching the peer.
      this.app.prepareStandardHandover();
    }
    detachOutgoingPeer(session);

    // ── Acquire the video element + capture stream ────────────────────────────
    const video = this.app.adapter.findVideo() ?? capture.findVideo();
    if (!video) return { ok: false, error: "No playable video on this page." };

    let stream = session.stream;
    if (video !== prevVideoEl || !stream) {
      // Element changed (or stream is gone) — re-acquire.
      capture.videoEl = video;
      capture.bindVolumeDriftGuard(video);
      try {
        stream = await capture.captureWithRetry(video);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Build a new WebRTC session ────────────────────────────────────────────
    const newToken = sm.nextToken();
    if (newToken !== sm.pageToken) return { ok: false, error: "Stale." };

    const voice =
      pipeline === TIER_STANDARD
        ? settings.standardVoice
        : settings.realtimeVoice || "";

    const live = capture.isLive(video);
    const durationHintSec =
      pipeline === TIER_REALTIME
        ? live
          ? RTC_LIVE_DURATION_HINT_CAP_SEC
          : isFinite(video.duration) && video.duration > 0
            ? Math.max(1, Math.ceil(video.duration - video.currentTime))
            : undefined
        : isFinite(video.duration) && video.duration > 0
          ? Math.max(1, Math.ceil(video.duration - video.currentTime))
          : undefined;

    let newSession: WebRtcSession;
    try {
      newSession = await this.buildSession(newToken, stream!, {
        apiBearer: settings.apiBearer,
        targetLanguage: settings.targetLanguage,
        pipeline,
        voice: voice ?? "",
        durationHintSec,
      });
    } catch (err) {
      if (newToken !== sm.pageToken) return { ok: false, error: "Stale." };
      return { ok: false, error: (err as Error).message };
    }

    if (newToken !== sm.pageToken) {
      try {
        newSession.pc?.close();
      } catch {
        /* ignore */
      }
      return { ok: false, error: "Stale session after build." };
    }

    // ── Swap in the new session ───────────────────────────────────────────────
    sm.session = newSession;
    sm.settings = { ...settings };
    capture.videoEl = video;
    capture.applyVolumes(settings.originalVolume, settings.voiceVolume);

    // Reset live-text state for the new video's content.
    sm.currentTargetText = "";
    sm.currentSourceText = "";
    sm.translationUtteranceOpen = false;
    sm.translationSegmentId = null;

    // ── Per-pipeline restart ──────────────────────────────────────────────────
    if (pipeline === TIER_REALTIME) {
      sm.startHeartbeat(newSession.rtcSessionId, newSession.apiBearer);
    } else {
      // Standard-WebRTC: rebuild dub-sync for the new video.
      // beginStandardDubSync is private in ContentApp; call the internal path
      // via completeStandardHandover which also handles VOD sync setup. But we
      // skip the waitForFirstDub gate here (video is already playing) — just
      // snap + start sync after a short ICE settle.
      const connected = await capture.waitForPCConnected(newSession.pc!, 5000);
      if (newToken !== sm.pageToken) return { ok: false, error: "Stale." };
      if (!connected) {
        return { ok: false, error: "WebRTC connection failed for new video." };
      }
      // completeStandardHandover handles beginStandardDubSync + snapPlaybackStart
      // + start() + dub.play() — reuse it (wasPaused=false for a fresh video).
      await this.app.completeStandardHandover(false);
      if (newToken !== sm.pageToken) return { ok: false, error: "Stale." };
    }

    return { ok: true };
  }

  async #requestHandoverInner(partial: {
    targetLanguage?: string;
    realtimeVoice?: string;
    standardVoice?: string;
  }): Promise<void> {
    const { sm, overlay, capture } = this.app;
    const session = sm.session;
    if (!isWebRtcSession(session) || !session.stream || !session.pc) return;

    const baseSettings = sm.settings!;
    const newSettings = { ...baseSettings, ...partial };
    const pipeline: WebRtcSignalingPipeline =
      session.pipeline === "standard" ? "standard" : "realtime";
    const nextVoice =
      pipeline === "standard"
        ? newSettings.standardVoice
        : newSettings.realtimeVoice || "";
    const same =
      newSettings.targetLanguage === session.targetLanguage &&
      nextVoice === session.voice;
    if (same) return;

    const video = capture.videoEl;
    const wasPaused = video?.paused ?? false;
    const names = sm.settings?.languageNames;
    const fromLang = resolveLangName(session.targetLanguage, names);
    const toLang = resolveLangName(newSettings.targetLanguage, names);

    if (newSettings.targetLanguage !== session.targetLanguage) {
      overlay.pushHistoryMarker(`${fromLang} → ${toLang}`);
      overlay.setStatusText("Switching to " + toLang);
    } else {
      overlay.pushHistoryMarker("Switching voice");
      overlay.setStatusText("Switching voice");
    }
    sm.currentTargetText = "";
    sm.currentSourceText = "";
    sm.translationUtteranceOpen = false;
    sm.translationSegmentId = null;
    overlay.setOverlayState("connecting");

    const newToken = sm.nextToken();
    sm.settings = newSettings;
    sm.notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings });
    const tier: TranslationTier =
      pipeline === "standard" ? TIER_STANDARD : TIER_REALTIME;
    overlay.populateVoicePicker(tier, nextVoice);
    overlay.setLanguageSelection(newSettings.targetLanguage);

    if (pipeline === TIER_STANDARD) {
      this.app.prepareStandardHandover();
    }

    detachOutgoingPeer(session);

    const durationHintSec = handoverDurationHintSec(
      video,
      pipeline,
      !!video && capture.isLive(video),
    );

    let newSession: WebRtcSession;
    try {
      newSession = await this.buildSession(newToken, session.stream, {
        apiBearer: newSettings.apiBearer,
        targetLanguage: newSettings.targetLanguage,
        pipeline,
        voice: nextVoice,
        durationHintSec,
      });
      if (newToken !== sm.pageToken) {
        newSession.pc?.close();
        return;
      }
    } catch (err) {
      if (newToken !== sm.pageToken) return;
      const e = err as CtaError;
      overlay.showToast(e.message || "Switch failed", {
        durationMs: 9000,
        cta: e.cta,
        ctaLabel: e.ctaLabel,
      });
      this.app.stopSession(STOP_REASON.HANDOVER_FAILED);
      return;
    }

    sm.prevSession = null;
    sm.session = newSession;
    // Re-establish the paused STATE on the rebuilt session via the lifecycle
    // reason stack (replaces sm.videoPaused = wasPaused, now a derived getter).
    // The stack persists across the handover, so 'user' is already present if the
    // user had paused; this keeps the two in sync for any edge where the video is
    // paused without the user reason held. resume('user') here would issue a
    // video.play(), so we only ADD the reason when wasPaused — never remove.
    if (wasPaused) this.app.lifecycle.pause("user");
    capture.applyVolumes(newSettings.originalVolume, newSettings.voiceVolume);

    if (pipeline === "realtime") {
      sm.startHeartbeat(newSession.rtcSessionId, newSession.apiBearer);
      if (video && !capture.isLive(video) && !wasPaused) {
        await alignRealtimeVodBeforePlay(() => sm.session?.remoteAudio ?? null);
      }
      const dub = sm.session?.remoteAudio;
      if (dub && !wasPaused) void dub.play().catch(() => {});
      overlay.setStatusText(wasPaused ? "Paused" : "Translating");
      overlay.setOverlayState(wasPaused ? "paused" : "live");
    } else {
      await this.app.completeStandardHandover(wasPaused);
    }
  }
}
