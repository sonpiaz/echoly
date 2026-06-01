// SessionManager — module-global pageToken guard, active WebRTC session, live
// settings, history/caption state, timers, and background channel (CONTENT_STATE / ENDED).

import {
  HEARTBEAT_MS,
  ECHOLY_PROXY_BASE,
  SESSION_LIMIT_MS,
  SESSION_WARNING_MS,
} from "@/shared/constants";
import { post } from "@/shared/protocol";
import type { ContentToBgMessage } from "@/shared/protocol";
import type { HistoryTurn, Settings, StartSettings } from "@/shared/types";

interface BaseSession {
  token: number;
  stream: MediaStream | null;
  remoteAudio: HTMLAudioElement | null;
  audioCtx: AudioContext | null;
  outputGain: GainNode | null;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  rtcSessionId: string | null;
  apiBearer: string;
  _onEnded?: () => void;
}

export type WebRtcSignalingPipeline = "realtime" | "standard";

export interface WebRtcSession extends BaseSession {
  kind?: "webrtc";
  pipeline: WebRtcSignalingPipeline;
  targetLanguage: string;
  voice: string;
}

export interface SubtitleFirstSession extends BaseSession {
  kind: "subtitle-first";
  abortController: AbortController;
  sentences: import("@/lib/caption-utils").CaptionSentence[];
  translations: string[];
  /** The currently-playing (or last-started) AudioBufferSourceNode. */
  currentSource: AudioBufferSourceNode | null;
  /** Index in sentences[] that currentSource was started for. */
  currentPlayingIdx: number | null;
  /** Handle for the 250ms playback-tick interval — cleared on stop. */
  playbackTimer: ReturnType<typeof setInterval> | null;
  renderCursor: number;
  /** Prevents overlapping rolling-tick work (duplicate renderBatch). */
  rollingInFlight: boolean;
  stopFlag: boolean;
  _onSeeked?: () => void;
  /**
   * True while the driver has issued its own video.pause() to wait for a cue's
   * _buffer to become ready. Set synchronously BEFORE video.pause() so the
   * "pause" DOM event arrives with the flag already set (guards onPause).
   */
  _systemPaused?: boolean;
  /**
   * Timestamp (performance.now()) when the current system-pause micro-wait began.
   * Used to enforce SUBFIRST_BUFFER_WAIT_MAX_MS so we never freeze forever.
   */
  _bufferWaitStartedAt?: number;
  /**
   * URL-encoded video title (`encodeURIComponent(title)`) captured at session
   * start. Sent as `x-echoly-video-title` on every subtitle-dub batch request.
   * `undefined` when the adapter returned no title.
   */
  videoTitle?: string;
}

export type Session = WebRtcSession | SubtitleFirstSession;

export function isSubtitleFirstSession(s: Session | null): s is SubtitleFirstSession {
  return s != null && s.kind === "subtitle-first";
}

export function isWebRtcSession(s: Session | null): s is WebRtcSession {
  return s != null && s.kind !== "subtitle-first";
}

export type LiveSettings = StartSettings;

export type UnloadHandler = () => void;

export class SessionManager {
  pageToken = 0;
  session: Session | null = null;
  prevSession: Session | null = null;
  settings: LiveSettings | null = null;
  apiBase: string = ECHOLY_PROXY_BASE;

  history: HistoryTurn[] = [];
  currentTargetText = "";
  currentSourceText = "";
  translationUtteranceOpen = false;
  translationSegmentId: number | null = null;
  /** True while the source <video> is paused — ignore live metadata updates. */
  videoPaused = false;

  captionPollTimer: ReturnType<typeof setInterval> | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  warningTimer: ReturnType<typeof setTimeout> | null = null;
  limitTimer: ReturnType<typeof setTimeout> | null = null;
  warningShown = false;

  private runtimeAlive = true;
  private onRuntimeDead: UnloadHandler | null = null;

  setUnloadHandler(handler: UnloadHandler): void {
    this.onRuntimeDead = handler;
  }

  notifyBackground(msg: ContentToBgMessage): void {
    if (!this.runtimeAlive) return;
    try {
      const alive = !!chrome.runtime?.id;
      const res = alive ? chrome.runtime.sendMessage(msg) : null;
      if (res && typeof (res as Promise<void>).catch === "function") {
        (res as Promise<void>).catch(() => {});
      }
    } catch (err) {
      const message = String(
        (err as { message?: string })?.message ?? err,
      );
      if (message.includes("Extension context invalidated")) {
        this.runtimeAlive = false;
        try {
          this.onRuntimeDead?.();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  emitState(partial: {
    running?: boolean;
    paused?: boolean;
    status?: string;
    errorMessage?: string;
  }): void {
    this.notifyBackground({ type: "CONTENT_STATE", ...partial });
  }

  emitEnded(reason: string): void {
    this.notifyBackground({ type: "CONTENT_ENDED", reason });
  }

  /** STALE when token !== pageToken AND token !== session.token (handover-safe). */
  isSessionStale(token: number): boolean {
    return token !== this.pageToken && this.session?.token !== token;
  }

  /** @deprecated Use isSessionStale */
  isRealtimeStale(token: number): boolean {
    return this.isSessionStale(token);
  }

  nextToken(): number {
    return ++this.pageToken;
  }

  /** Realtime pipeline only — tops up live reserve (standard uses clip commit on /end). */
  startHeartbeat(rtcSessionId: string | null, apiBearer: string): void {
    this.stopHeartbeat();
    if (!rtcSessionId || !apiBearer) return;
    const url = `${this.apiBase}/rtc/translate/${rtcSessionId}/heartbeat`;
    this.heartbeatTimer = setInterval(() => {
      if (!this.session) return;
      fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + apiBearer },
      }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startSessionTimer(onWarning: () => void, onLimit: () => void): void {
    this.clearSessionTimer();
    this.warningShown = false;
    this.warningTimer = setTimeout(() => {
      if (this.warningShown) return;
      this.warningShown = true;
      onWarning();
    }, SESSION_WARNING_MS);
    this.limitTimer = setTimeout(() => {
      onLimit();
    }, SESSION_LIMIT_MS);
  }

  clearSessionTimer(): void {
    if (this.warningTimer) {
      clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }

  async endRtcSession(
    rtcSessionId: string | null,
    apiBearer: string,
  ): Promise<void> {
    if (!rtcSessionId || !apiBearer) return;
    const url = `${this.apiBase}/rtc/translate/${rtcSessionId}/end`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiBearer,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestId: `rt_${rtcSessionId}` }),
      keepalive: true,
    };
    try {
      await fetch(url, init);
    } catch {
      /* fire-and-forget */
    }
  }
}
