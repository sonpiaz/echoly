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
import type { LifecycleController } from "./lifecycle";

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
   * Timestamp (performance.now()) when the current system-buffer micro-wait
   * began. Used to enforce SUBFIRST_BUFFER_WAIT_MAX_MS so we never freeze
   * forever. The micro-pause itself is now held as the controller's
   * `system-buffer` reason (replaces the old per-session `_systemPaused` flag).
   */
  _bufferWaitStartedAt?: number;
  /**
   * URL-encoded video title (`encodeURIComponent(title)`) captured at session
   * start. Sent as `x-echoly-video-title` on every subtitle-dub batch request.
   * `undefined` when the adapter returned no title.
   */
  videoTitle?: string;
  /**
   * Stable idempotency ids for in-progress rolling renderer batches, keyed by
   * `{startIdx}-{endIdx}` (the batch range). Reused across retries of the same
   * range so the server's idempotency check prevents double-billing.
   * Cleared when renderCursor advances past a batch (the batch has committed).
   */
  _batchRequestIds: Map<string, string>;

  /**
   * Maps a batch range key `"${startIdx}-${endIdx}"` to the requestId that was
   * used when that range was LAST sent to the server.  Used by the retry-boundary
   * fix: on failure, `#renderBatch` retries with the ORIGINAL requestId first so
   * the server's idempotency replay avoids re-billing already-committed lines.
   * Entries are removed once a batch completes successfully or on seek (same as
   * `_batchRequestIds`).
   */
  _sentBatchRanges: Map<string, string>;

  // ── Coalescing state (batch-coalescing rolling renderer) ─────────────────
  /**
   * Set of sentence indices waiting to be flushed as a single coalesced batch.
   * The rolling renderer accumulates cache-miss lines here instead of requesting
   * each one immediately.  Flushed when ≥3 lines pending, the earliest pending
   * line is within 8 s of the playhead, or 6 s have elapsed since the first
   * pending line was queued.
   */
  _pendingLines: Set<number>;
  /**
   * wall-clock timestamp (Date.now()) when the FIRST line was added to
   * `_pendingLines` in the current accumulation run.  Used to implement the
   * 6-second elapsed-time flush guard.  Reset to 0 when the set is flushed.
   */
  _pendingFirstQueuedAt: number;
  /**
   * Epoch counter incremented on every seek. The rolling renderer captures the
   * epoch at the start of each in-flight request; when it completes it checks
   * that the epoch has not changed before advancing renderCursor — preventing a
   * seek-updated renderCursor from being clobbered by a stale in-flight response.
   */
  _renderEpoch: number;
  /**
   * The adapter-derived video id for this session (adapter.getVideoId result).
   * Used as the first component of render-cache keys so cache entries are
   * isolated by video — auto-next to a different video is naturally separated
   * (different videoId → different key prefix). Set once in start()/restart()
   * before the first #renderBatch call.
   */
  _videoId?: string;
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

  /**
   * The single owner of video.pause()/play() + the reason-stack. Set by
   * ContentApp immediately after construction. `userPaused`/`videoPaused`/
   * `connectionLost` are DERIVED getters over this controller's reason stack —
   * there is no longer any boolean state here (back-compat for the ~9 readers).
   */
  lifecycle!: LifecycleController;

  history: HistoryTurn[] = [];
  currentTargetText = "";
  currentSourceText = "";
  translationUtteranceOpen = false;
  translationSegmentId: number | null = null;

  /**
   * DERIVED — "the source <video> is paused for a user-visible reason"
   * (user || ad). Read by the WebRTC metadata gate + the Standard drift
   * corrector closure (index.ts). No longer a settable field: every former
   * writer routes through `lifecycle.pause(reason)`/`resume(reason)`.
   */
  get videoPaused(): boolean {
    return this.lifecycle?.effectivePaused ?? false;
  }

  /**
   * DERIVED — canonical "user-visible pause" flag (all tiers): user || ad.
   * Read by the subtitle-first tick gate, the heartbeat billing freeze, and the
   * WebRTC ICE handlers. Mirrors `videoPaused` (both collapse onto
   * `lifecycle.effectivePaused`).
   */
  get userPaused(): boolean {
    return this.lifecycle?.effectivePaused ?? false;
  }

  /**
   * DERIVED — set when a WebRTC peer dies during a pause (ICE timeout /
   * media-gate 404). Held as the controller's `connection-lost` reason; triggers
   * a one-shot rebuild on the next resume instead of resuming into dead audio.
   */
  get connectionLost(): boolean {
    return this.lifecycle?.isPausedFor("connection-lost") ?? false;
  }

  captionPollTimer: ReturnType<typeof setInterval> | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  warningTimer: ReturnType<typeof setTimeout> | null = null;
  limitTimer: ReturnType<typeof setTimeout> | null = null;
  warningShown = false;

  private _onWarning: (() => void) | null = null;
  private _onLimit: (() => void) | null = null;
  /** Absolute deadline (Date.now()-epoch ms) for the warning timer. 0 = not set. */
  private _warningDeadline = 0;
  /** Absolute deadline (Date.now()-epoch ms) for the limit timer. 0 = not set. */
  private _limitDeadline = 0;
  /** Wall-clock timestamp when pauseSessionTimer() was called (0 = not paused). */
  private _pausedAt = 0;

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
      const paused = this.userPaused;
      const body = JSON.stringify({ paused });
      const headers: HeadersInit = { Authorization: "Bearer " + apiBearer, "Content-Type": "application/json" };
      // One retry with 1.5s backoff on failure (SOLUTION WS5.4): a single network
      // blip can cause the server to miss a pause=true, billing one extra interval.
      // Retry-once ensures the pause-freeze is delivered without burning the heartbeat.
      const attemptFetch = (): Promise<Response> =>
        fetch(url, { method: "POST", headers, body });
      attemptFetch().catch(() =>
        // 1.5s backoff before the single retry (not a hard loop — one attempt only).
        new Promise<void>((resolve) => setTimeout(resolve, 1500)).then(() =>
          attemptFetch().catch(() => {})
        )
      );
    }, HEARTBEAT_MS);
  }

  /**
   * POST a pause signal to the server heartbeat endpoint using `keepalive:true`
   * so the request is sent even if the page is being unloaded (tab close / nav).
   * Used when the user pauses the source video to freeze server-side billing
   * immediately rather than waiting for the next heartbeat interval.
   *
   * Fire-and-forget — errors are silently swallowed.
   */
  sendPauseKeepalive(rtcSessionId: string | null, apiBearer: string): void {
    if (!rtcSessionId || !apiBearer) return;
    const url = `${this.apiBase}/rtc/translate/${rtcSessionId}/heartbeat`;
    fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiBearer, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
      keepalive: true,
    }).catch(() => {});
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
    this._onWarning = onWarning;
    this._onLimit = onLimit;
    this._warningDeadline = Date.now() + SESSION_WARNING_MS;
    this._limitDeadline = Date.now() + SESSION_LIMIT_MS;
    this.warningTimer = setTimeout(() => {
      if (this.warningShown) return;
      this.warningShown = true;
      onWarning();
    }, SESSION_WARNING_MS);
    this.limitTimer = setTimeout(() => {
      onLimit();
    }, SESSION_LIMIT_MS);
  }

  /** Freeze the 55/60-min warn+limit timers during a user pause. Clears the live
   *  `setTimeout` handles but preserves absolute deadlines and callbacks so
   *  `resumeSessionTimer` can rearm them shifted by the paused duration. */
  pauseSessionTimer(): void {
    if (!this.warningTimer && !this.limitTimer) return;
    if (this.warningTimer) {
      clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    this._pausedAt = Date.now();
  }

  /** Re-arm the warn+limit timers after a user resume. Shifts absolute deadlines
   *  forward by the paused duration so the timer resumes from where it froze. */
  resumeSessionTimer(): void {
    if (this._onLimit === null) return;
    // Guard against a resume WITHOUT a prior pause (e.g. the connection-lost
    // recovery path resumes the dub but never called pauseSessionTimer). With
    // _pausedAt === 0, `Date.now() - _pausedAt` would be the full epoch (~55,000
    // years) and push the auto-stop deadline absurdly far out. No pause ⇒ nothing
    // to resume — leave the live timers untouched.
    if (this._pausedAt === 0) return;
    // Extend deadlines by the time spent paused.
    const pausedDuration = Date.now() - this._pausedAt;
    this._warningDeadline += pausedDuration;
    this._limitDeadline += pausedDuration;
    this._pausedAt = 0;

    const warnRemaining = Math.max(0, this._warningDeadline - Date.now());
    const limitRemaining = Math.max(0, this._limitDeadline - Date.now());

    if (!this.warningShown && this._onWarning) {
      const onWarning = this._onWarning;
      this.warningTimer = setTimeout(() => {
        if (this.warningShown) return;
        this.warningShown = true;
        onWarning();
      }, warnRemaining);
    }
    const onLimit = this._onLimit;
    this.limitTimer = setTimeout(() => {
      onLimit();
    }, limitRemaining);
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
    this._onWarning = null;
    this._onLimit = null;
    this._warningDeadline = 0;
    this._limitDeadline = 0;
    this._pausedAt = 0;
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
