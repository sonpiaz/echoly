// ────────────────────────────────────────────────────────────────────────────
// SessionManager — owns the module-global `pageToken` guard, the active /
// previous session, live settings, history + current text, every session timer,
// and the background channel (CONTENT_STATE / CONTENT_ENDED via post()).
//
// HARD INVARIANT (research 02 §4, SOLUTION §5.2): `pageToken` is MODULE-GLOBAL,
// NOT per-session. Stop bumps it to invalidate ALL in-flight work at once —
// including pre-session builds and the no-caption fallback. Do NOT move it onto
// the session object. Two guard idioms are exposed and are NOT interchangeable:
//   • dual-guard (realtime): isRealtimeStale(token) === (token!==pageToken &&
//     session?.token!==token) — a just-swapped handover keeps receiving its
//     own dc events during the 400ms window.
//   • identity-guard (chunked/subtitle): isIdentityStale(s) === (s!==session …)
// (legacy/content.js: pageToken 73, notifyBackground 116-127, timers 567-598.)
// ────────────────────────────────────────────────────────────────────────────

import {
  HEARTBEAT_MS,
  KYMA_BASE,
  SESSION_LIMIT_MS,
  SESSION_WARNING_MS,
} from "@/shared/constants";
import { post } from "@/shared/protocol";
import type { ContentToBgMessage } from "@/shared/protocol";
import type { HistoryTurn, Settings, StartSettings } from "@/shared/types";
import type { Caption } from "@/lib/caption";

// ───── Session shapes (one DU per tier; shared base) ────────────────────────

interface BaseSession {
  token: number;
  /** Captured tab-audio MediaStream (null for subtitle-first). */
  stream: MediaStream | null;
  remoteAudio: HTMLAudioElement | null;
  audioCtx: AudioContext | null;
  outputGain: GainNode | null;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  /** Kyma realtime session id (realtime only; null for the local tiers). */
  kymaSessionId: string | null;
  /** Resolved bearer (Kyma key OR Echoly session token) — legacy name. */
  kymaKey: string;
  /** `ended` video listener for auto-stop on natural video end (all tiers). */
  _onEnded?: () => void;
}

export interface RealtimeSession extends BaseSession {
  type?: undefined; // realtime sessions carry no `type` tag (legacy)
  targetLanguage: string;
  realtimeVoice: string;
}

export interface StandardSession extends BaseSession {
  type: "standard";
  recorderMime: string;
  activeRecorder: MediaRecorder | null;
  nextPlayAt: number;
  stopFlag: boolean;
  abortController: AbortController;
}

export interface SubtitleFirstSession extends BaseSession {
  type: "subtitle-first";
  abortController: AbortController;
  sentences: Caption[];
  translations: (string | undefined)[];
  pendingSources: AudioBufferSourceNode[];
  audioOffset: number;
  renderCursor: number;
  stopFlag: boolean;
  wasPlaying?: boolean;
  _onSeeked: (() => void) | null;
}

export type Session = RealtimeSession | StandardSession | SubtitleFirstSession;

/** Settings the content script runs against — the StartSettings snapshot the
 *  background relays, mutated IN PLACE by pipelines / applySettingsLive
 *  (research 02 §7.2 — preserve mutate-in-place semantics). */
export type LiveSettings = StartSettings;

/** Hook the SessionManager calls when the runtime handle dies (orphaned content
 *  script after a dev reload / Chrome auto-update) — wired to stopSession by
 *  initContent. (legacy handleUnload via notifyBackground catch.) */
export type UnloadHandler = () => void;

export class SessionManager {
  // ───── Module-global guard token (NOT per-session) ───────────────────────
  /** Bumped on every Stop / new session / handover to invalidate all in-flight
   *  callbacks at once. Module-global by contract. */
  pageToken = 0;

  session: Session | null = null;
  /** Held during a realtime handover until the new session is fully ready. */
  prevSession: Session | null = null;

  /** Live, mutate-in-place settings for the active (or pending) session. */
  settings: LiveSettings | null = null;
  /** Per-session resolved API base (settings.apiBase || KYMA_BASE). Realtime
   *  SDP deliberately ignores this and goes DIRECT to OpenAI. */
  apiBase: string = KYMA_BASE;

  history: HistoryTurn[] = [];
  currentTargetText = "";
  currentSourceText = "";

  // ───── Timers ────────────────────────────────────────────────────────────
  captionPollTimer: ReturnType<typeof setInterval> | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  warningTimer: ReturnType<typeof setTimeout> | null = null;
  limitTimer: ReturnType<typeof setTimeout> | null = null;
  warningShown = false;

  // ───── Background channel (runtime-alive guard) ──────────────────────────
  private runtimeAlive = true;
  private onRuntimeDead: UnloadHandler | null = null;

  /** Wire the orphaned-script teardown (initContent passes stopSession). */
  setUnloadHandler(handler: UnloadHandler): void {
    this.onRuntimeDead = handler;
  }

  /**
   * Fire-and-forget send to the background. After an extension reload the
   * runtime handle is invalidated and sendMessage throws SYNCHRONOUSLY
   * ("Extension context invalidated") — `.catch` can't catch a sync throw, so
   * the whole call is wrapped. On invalidation we stop emitting + tear down so
   * the orphaned script doesn't keep firing. (legacy notifyBackground.)
   */
  notifyBackground(msg: ContentToBgMessage): void {
    if (!this.runtimeAlive) return;
    try {
      const alive = !!chrome.runtime?.id;
      const res = alive ? chrome.runtime.sendMessage(msg) : null;
      if (res && typeof (res as Promise<unknown>).catch === "function") {
        (res as Promise<unknown>).catch(() => {});
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
          /* teardown best-effort */
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

  // ───── Guard predicates (the two idioms — NOT interchangeable) ───────────

  /**
   * Realtime DUAL-guard. A realtime callback is STALE (must bail) only when the
   * captured token no longer matches the global token AND it isn't the current
   * session's token. The `&&` lets a just-swapped handover session keep
   * receiving its own dc events during the 400ms swap window.
   * (legacy `token !== pageToken && session?.token !== token`.)
   */
  isRealtimeStale(token: number): boolean {
    return token !== this.pageToken && this.session?.token !== token;
  }

  /**
   * Chunked / subtitle-first IDENTITY-guard. A callback holding the session
   * object directly is STALE when that object is no longer the active session,
   * OR its `stopFlag` is set. (legacy `s !== session || s.stopFlag`.)
   */
  isIdentityStale(
    s: StandardSession | SubtitleFirstSession,
  ): boolean {
    return s !== this.session || s.stopFlag;
  }

  /**
   * processStandardChunk's per-await guard: stale when the chunk's session is no
   * longer active OR its captured token no longer matches the global token.
   * `t` is the token captured at the top of the chunk. (legacy
   * `s !== session || s.token !== t`.)
   */
  isChunkStale(s: StandardSession, t: number): boolean {
    return s !== this.session || s.token !== t;
  }

  /** Allocate the next guard token (used by every session start + handover). */
  nextToken(): number {
    return ++this.pageToken;
  }

  // ───── Heartbeat + session timer (60-min cap, one-shot 55-min warning) ───

  /** 30s keepalive POST for realtime sessions only (others pass null id).
   *  Two URL shapes (Wave 3):
   *    • proxy : POST ${apiBase}/rtc/translate/${sessionId}/heartbeat (Echoly)
   *    • byok  : POST ${apiBase}/realtime/translations/sessions/${id}/heartbeat (Kyma legacy) */
  startHeartbeat(kymaSessionId: string | null, kymaKey: string): void {
    this.stopHeartbeat();
    if (!kymaSessionId || !kymaKey) return;
    const isProxy = this.settings?.apiMode === "proxy";
    const url = isProxy
      ? `${this.apiBase}/rtc/translate/${kymaSessionId}/heartbeat`
      : `${this.apiBase}/realtime/translations/sessions/${kymaSessionId}/heartbeat`;
    this.heartbeatTimer = setInterval(() => {
      if (!this.session) return;
      fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
      }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** One-shot 55-min warning toast + 60-min auto-stop. `onWarning` shows the
   *  toast; `onLimit` runs the stop+emitEnded. (legacy startSessionTimer.) */
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

  // ───── End Kyma session (release collateral immediately) ─────────────────

  /** keepalive POST /end, fire-and-forget. NOT abort-wired (intentional —
   *  research 02 §4). Two URL shapes (Wave 3):
   *    • proxy : POST ${apiBase}/rtc/translate/${id}/end + body {requestId: rt_${id}}
   *              (the requestId is the exact-once idempotency key the server expects).
   *    • byok  : POST ${apiBase}/realtime/translations/sessions/${id}/end (Kyma legacy) */
  async endKymaSession(
    kymaSessionId: string | null,
    kymaKey: string,
  ): Promise<void> {
    if (!kymaSessionId || !kymaKey) return;
    const isProxy = this.settings?.apiMode === "proxy";
    const url = isProxy
      ? `${this.apiBase}/rtc/translate/${kymaSessionId}/end`
      : `${this.apiBase}/realtime/translations/sessions/${kymaSessionId}/end`;
    const init: RequestInit = {
      method: "POST",
      headers: { Authorization: "Bearer " + kymaKey },
      keepalive: true,
    };
    if (isProxy) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify({ requestId: `rt_${kymaSessionId}` });
    }
    try {
      await fetch(url, init);
    } catch {
      /* fire-and-forget */
    }
  }
}
