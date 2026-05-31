// WebRtcPipeline — voice dubbing via WebRTC (any site with <video>).
// Realtime: OpenAI relay. Standard: Gemini audio-in → TTS. POST /v1/rtc/translate.

import {
  TIER_REALTIME,
  TIER_STANDARD,
  type TranslationTier,
} from "@/shared/constants";
import { resolveLangName } from "@/lib/resolve-lang-name";
import { parseServerError } from "@/lib/server-errors";
import { notifyQuotaToBackground } from "@/lib/quota-notify";
import { RTC_METADATA_CHANNEL } from "@/shared/rtc-metadata";
import { currentSiteHost } from "@/shared/site-host";
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
  | { type: "error"; message?: string }
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
      return { type: "error", message: typeof obj.message === "string" ? obj.message : undefined };
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

  constructor(private readonly app: ContentApp) {}

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
          // stopSession emits STOP_REASON_MESSAGE[CONNECTION_LOST].
          this.app.stopSession(STOP_REASON.CONNECTION_LOST);
        }, 8_000);
        return;
      }
      if (ice === "closed" || ice === "failed") {
        clearIceDisconnectTimer();
        if (newSession === sm.session) {
          this.app.stopSession(STOP_REASON.CONNECTION_LOST);
        }
      }
    });

    const offer = await pc.createOffer();
    if (token !== sm.pageToken) throw new Error("Stale session.");
    await pc.setLocalDescription(offer);

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

    const sdpHeaders: Record<string, string> = {
      Authorization: "Bearer " + opts.apiBearer,
      "Content-Type": "application/sdp",
    };
    const siteHost = currentSiteHost();
    if (siteHost) sdpHeaders["X-Echoly-Site-Host"] = siteHost;

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
      const err: CtaError = new Error(parsed.user);
      if (parsed.cta) err.cta = parsed.cta;
      if (parsed.ctaLabel) err.ctaLabel = parsed.ctaLabel;
      throw err;
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
    sm.videoPaused = wasPaused;
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
