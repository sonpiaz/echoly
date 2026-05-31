// Subtitle-first Standard (VOD captions → POST /v1/translate/subtitles → display-anchored dub).
//
// Playback driver: a 250ms interval (+ each clip's onended) calls #playbackTick(),
// which plays each cue's dub IN FULL, one at a time, back-to-back. It never
// interrupts a playing clip — completeness over tight sync, so no word is ever cut
// ("swallowed"). When a clip ends it immediately plays the next due cue; cues the
// video has run more than SUBFIRST_DRIFT_SKIP_SEC past are skipped so the dub
// re-syncs at the next caption gap. No window-scheduler, no audioOffset, no
// scheduledIdx. The rolling renderer (#runRollingRenderer) only fetches/decodes
// ahead and updates the live subtitle display.

import { computeGain } from "@/lib/audio";
import { isPipelineToastError, renderSubtitleDubBatch } from "@/lib/echoly-api";
import { STANDARD_DEFAULT_VOICE } from "@/shared/constants";
import type { StartSettings } from "@/shared/types";
import {
  regroupToSentences,
  SUBFIRST_BATCH_SIZE,
  SUBFIRST_LOOKAHEAD_MS,
} from "@/lib/caption-utils";
import type { SubtitleFirstSession } from "../session-manager";
import type { ContentApp } from "../index";
import { TOAST_NO_CC_FALLBACK, TOAST_PRESS_PLAY } from "@/shared/product-copy";
import { STOP_REASON, STOP_REASON_MESSAGE } from "../stop-reasons";

// Start a cue's dub up to this many seconds before its caption start.
const SUBFIRST_DUE_AHEAD_SEC = 0.15;
// If the video is already this far past a cue's end, skip it (re-sync) instead of
// playing it late. Bounds how far the dub can drift behind on dense captions.
const SUBFIRST_DRIFT_SKIP_SEC = 3;
// How many sentences to decode before the initial video.play() at startup
// (larger = less starvation risk; +1 extra TTS round-trip vs the old cap of 2).
const SUBFIRST_PREBUFFER_COUNT = 3;
// Maximum ms the driver will keep the video paused waiting for a cue's _buffer.
// Once exceeded the micro-pause is released and the normal drift-skip logic takes
// over so we never freeze forever.
const SUBFIRST_BUFFER_WAIT_MAX_MS = 8000;

export class SubtitleFirstPipeline {
  constructor(private readonly app: ContentApp) {}

  async start(incomingSettings: StartSettings): Promise<{ ok: boolean; error?: string }> {
    const { sm, capture, overlay } = this.app;
    const adapter = this.app.adapter;
    const video = adapter.findVideo() ?? capture.findVideo();
    if (!video) return { ok: false, error: "No playable video on this page." };

    const videoId = adapter.getVideoId(location.href);
    if (!videoId) return { ok: false, error: "Could not detect video id for this page." };

    capture.videoEl = video;
    capture.bindVolumeDriftGuard(video);

    overlay.buildOverlay(
      this.app.callbacks,
      incomingSettings.advanced?.captionPosition ?? null,
      incomingSettings.languagePicker ?? undefined,
      incomingSettings.apiMode === "proxy",
      incomingSettings.standardVoices?.map((v) => [v.id, v.label]),
      "standard",
    );
    overlay.syncFromSettings(incomingSettings);
    overlay.setStatusText("Loading captions");
    overlay.setOverlayState("connecting");

    let audioCtx: AudioContext;
    let outputGain: GainNode;
    try {
      const Ctor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new Ctor();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      outputGain = audioCtx.createGain();
      outputGain.gain.value = computeGain(incomingSettings.voiceVolume ?? 100);
      outputGain.connect(audioCtx.destination);
    } catch (err) {
      overlay.removeOverlay();
      return { ok: false, error: `AudioContext unavailable: ${(err as Error).message}` };
    }

    const token = sm.nextToken();
    const abortController = new AbortController();
    const newSession: SubtitleFirstSession = {
      kind: "subtitle-first",
      token,
      audioCtx,
      outputGain,
      stream: null,
      remoteAudio: null,
      pc: null,
      dc: null,
      rtcSessionId: null,
      apiBearer: incomingSettings.apiBearer,
      abortController,
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: null,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
    };
    sm.session = newSession;
    sm.settings = { ...incomingSettings };
    sm.apiBase = sm.settings.apiBase || sm.apiBase;

    const wasPlaying = !video.paused;
    const restorePlay = () => {
      if (wasPlaying && video.paused) {
        try {
          video.play().catch(() => {});
        } catch {
          /* ignore */
        }
      }
    };

    try {
      video.pause();
    } catch {
      /* ignore */
    }

    let captionResult;
    try {
      captionResult = await adapter.fetchCaptions({
        videoId,
        preferLang: sm.settings.targetLanguage,
        signal: abortController.signal,
      });
    } catch {
      captionResult = null;
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      this.#teardownAudio(newSession);
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      this.#teardownAudio(newSession);
      sm.session = null;
      sm.pageToken += 1;
      overlay.removeOverlay();

      // Branch on audioCapture capability:
      // - true  (YouTube, Coursera): fall back to WebRTC Standard audio capture.
      // - false (Udemy DRM): cannot capture audio — show explicit "unsupported" toast.
      if (adapter.capabilities.audioCapture) {
        const result = await this.app.startWebRtcStandard(incomingSettings);
        if (result.ok) {
          overlay.showToast(TOAST_NO_CC_FALLBACK, 5000);
        } else {
          restorePlay();
        }
        return result;
      } else {
        // Udemy (or any DRM platform): no captions + no audio capture = unsupported.
        restorePlay();
        const msg = STOP_REASON_MESSAGE[STOP_REASON.NO_CC_UNSUPPORTED];
        overlay.showToast(msg, 6000);
        this.app.stopSession(STOP_REASON.NO_CC_UNSUPPORTED);
        return { ok: false, error: msg };
      }
    }

    const sentences = regroupToSentences(captionResult.captions);
    newSession.sentences = sentences;
    newSession.translations = new Array(sentences.length);
    overlay.setStatusText(`Translating ${sentences.length} lines`);

    const currentTime = video.currentTime;
    const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
    let firstWaveStart = sentences.findIndex((s) => s.start >= currentTime);
    if (firstWaveStart === -1) firstWaveStart = sentences.length;
    let lookaheadEnd = sentences.findIndex((s) => s.start > currentTime + lookaheadSec);
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + SUBFIRST_PREBUFFER_COUNT);
    if (firstWaveEnd <= firstWaveStart && firstWaveStart < sentences.length) {
      firstWaveEnd = firstWaveStart + 1;
    }

    try {
      await this.#renderBatch(newSession, firstWaveStart, firstWaveEnd);
    } catch (err) {
      if (sm.isSessionStale(token) || newSession.stopFlag) {
        this.#teardownAudio(newSession);
        restorePlay();
        return { ok: false, error: "Cancelled." };
      }
      sm.session = null;
      this.#teardownAudio(newSession);
      overlay.removeOverlay();
      restorePlay();
      const msg = isPipelineToastError(err) ? err.user : String((err as Error).message || err);
      return { ok: false, error: msg };
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      this.#teardownAudio(newSession);
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    newSession.renderCursor = firstWaveEnd;

    overlay.setStatusText("Translating");
    overlay.setOverlayState("live");
    capture.applyVolumes(sm.settings.originalVolume, sm.settings.voiceVolume);
    this.app.applySourceVisibility();
    this.app.startSessionTimer();

    const onSeeked = () => this.#onSeek(newSession, video);
    newSession._onSeeked = onSeeked;

    this.app.bindCommonVideoListeners(video, newSession, {
      onSeeked,
      // onEndedBefore fires before stopSession so the final cue (if buffered but
      // not yet _played) gets src.start() while the session is still alive.
      onEndedBefore: () => this.#playbackTick(newSession),
    });

    try {
      await video.play();
    } catch {
      overlay.setStatusText(TOAST_PRESS_PLAY);
      overlay.showToast(TOAST_PRESS_PLAY, 6000);
    }

    // Playback driver: 250ms interval is the sole mechanism that advances the
    // "which cue is playing" pointer.  timeupdate would also work but adds a
    // listener that must be cleaned up; the interval alone is sufficient and
    // simpler.  The tick is a no-op while paused (currentTime frozen, cue already
    // _played) so no special pause gate is needed.
    newSession.playbackTimer = setInterval(
      () => this.#playbackTick(newSession),
      250,
    );

    // Fire once immediately so the first cue starts without waiting 250ms.
    this.#playbackTick(newSession);

    void this.#runRollingRenderer(newSession, video);
    sm.emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  async #renderBatch(s: SubtitleFirstSession, startIdx: number, endIdx: number): Promise<void> {
    const { sm } = this.app;
    const voiceId = sm.settings?.standardVoice || STANDARD_DEFAULT_VOICE;
    const lang = sm.settings?.targetLanguage || "vi";
    for (let i = startIdx; i < endIdx; i += SUBFIRST_BATCH_SIZE) {
      if (sm.session !== s || s.stopFlag) return;
      const sliceEnd = Math.min(i + SUBFIRST_BATCH_SIZE, endIdx);
      const slice = s.sentences.slice(i, sliceEnd);
      // Per-line cue slot = gap to the next sentence (fallback cue length), min
      // 0.6s, so the server can speed-fit the dub into the slot (isochrony).
      const cueDurationsMs = slice.map((sent, k) => {
        const idx = i + k;
        const next = s.sentences[idx + 1];
        const slotSec = next ? next.start - sent.start : sent.end - sent.start;
        return Math.round(Math.max(0.6, slotSec) * 1000);
      });
      // Last few already-translated lines for cross-batch continuity (pronouns/terms).
      const priorLines = s.translations
        .slice(Math.max(0, i - 4), i)
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
      const dubbed = await renderSubtitleDubBatch({
        apiBase: sm.apiBase,
        bearer: s.apiBearer,
        sentences: slice,
        targetLanguage: lang,
        voiceId,
        cueDurationsMs,
        priorLines,
        sessionId: `sf_${s.token}`,
        siteHost: location.hostname,
        signal: s.abortController.signal,
      });
      if (sm.session !== s || s.stopFlag) return;
      for (let j = 0; j < dubbed.length; j++) {
        const idx = i + j;
        s.translations[idx] = dubbed[j]!.text;
        const mp3 = dubbed[j]!.audioMp3;
        if (mp3.byteLength > 0 && s.audioCtx) {
          try {
            s.sentences[idx]!._buffer = await s.audioCtx.decodeAudioData(mp3.slice(0));
          } catch {
            /* ignore decode failure */
          }
        }
      }
    }
  }

  /**
   * Return the earliest unplayed sentence whose playback window contains or is
   * about to contain `t`, or null if nothing is due.
   *
   * "Due" = cue start ≤ t + SUBFIRST_DUE_AHEAD_SEC  AND  cue not yet _played.
   * Walking forward stops at the first unplayed cue that hasn't started yet,
   * returning null (nothing to do this tick).
   *
   * Used identically in the system-pause resume check (step 1) and the main
   * advance/start block (step 3) so "what should play now" is computed once and
   * consistently — no risk of double-advance between the two sites.
   */
  #sentenceDueAt(s: SubtitleFirstSession, t: number): (typeof s.sentences)[number] | null {
    for (let i = 0; i < s.sentences.length; i++) {
      const sent = s.sentences[i]!;
      if (sent._played) continue;
      // Earliest unplayed cue hasn't started yet → nothing due.
      if (sent.start > t + SUBFIRST_DUE_AHEAD_SEC) return null;
      return sent;
    }
    return null;
  }

  /** System-pause: flag set SYNCHRONOUSLY before video.pause() so the DOM "pause"
   *  event arrives with _systemPaused already true (guards onPause in index.ts). */
  #enterSystemPause(s: SubtitleFirstSession): void {
    s._systemPaused = true;
    s._bufferWaitStartedAt = performance.now();
    this.app.overlay.setStatusText("Buffering…");
    try {
      this.app.capture.videoEl?.pause();
    } catch {
      /* ignore */
    }
  }

  /** Resume from system-pause: clear flags, restore status, play video. */
  #resumeSystemPause(s: SubtitleFirstSession): void {
    s._systemPaused = false;
    s._bufferWaitStartedAt = undefined;
    this.app.overlay.setStatusText("Translating");
    try {
      this.app.capture.videoEl?.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * Play the next due cue's dub IN FULL, one at a time. Never interrupts a clip
   * that is already playing (completeness over tight sync — no truncation, so no
   * swallowed words). Driven by the 250ms interval and by each clip's onended
   * (back-to-back, no wait).
   *
   * Control flow (locked per SOLUTION §3.1(b)):
   *   1. SYSTEM-PAUSE RESUME CHECK — runs BEFORE the external-pause guard so we
   *      can detect when the awaited buffer has arrived and resume the video.
   *   2. EXTERNAL pause (user) — unchanged tierD behaviour.
   *   3. Advance pointer / start the due cue (unchanged core + starvation fix).
   */
  #playbackTick(s: SubtitleFirstSession): void {
    const { sm } = this.app;
    if (sm.session !== s || s.stopFlag) return;
    const video = this.app.capture.videoEl;
    if (!video) return;
    if (!s.audioCtx || s.audioCtx.state === "closed") return;
    if (!s.outputGain) return;

    // ── Step 1: SYSTEM-PAUSE RESUME CHECK ──────────────────────────────────
    // Runs BEFORE the external-pause guard so the tick can resume the video
    // the moment the buffer is ready (≤250ms latency — no separate waiter).
    if (s._systemPaused) {
      const due = this.#sentenceDueAt(s, video.currentTime);
      if (!due) {
        // Nothing to wait for any more — resume and fall through.
        this.#resumeSystemPause(s);
      } else if (due._buffer) {
        // Buffer is ready — resume so the video plays; fall through to start it.
        this.#resumeSystemPause(s);
      } else if (s.sentences.indexOf(due) < s.renderCursor) {
        // The renderer has already PROCESSED this cue but produced no audio
        // (empty/failed MP3) — its _buffer will NEVER arrive. Waiting for it would
        // hang on "Buffering…" forever. Skip it and move on (matches the old
        // no-audio behaviour). This is the fix for the live "stuck on Buffering" hang.
        due._played = true;
        this.#resumeSystemPause(s);
      } else if (
        s._bufferWaitStartedAt !== undefined &&
        performance.now() - s._bufferWaitStartedAt > SUBFIRST_BUFFER_WAIT_MAX_MS
      ) {
        // Stall cap: renderer is genuinely stuck/slow — give up on THIS cue (skip
        // it cleanly, no stutter loop) and resume.
        due._played = true;
        this.#resumeSystemPause(s);
      } else {
        // Still rendering — keep video paused, come back next tick.
        return;
      }
      // After resumeSystemPause the video is no longer paused (or will be
      // shortly after the play() promise resolves). Fall through to step 3
      // so the cue starts immediately without waiting for the next 250ms tick.
    }

    // ── Step 2: EXTERNAL pause (user) — unchanged tierD behaviour ──────────
    // Pausing the video pauses the dub: stop the in-flight clip so the voice
    // goes silent immediately. On resume the next cue picks up naturally.
    if (video.paused) {
      if (s.currentSource) this.#stopCurrent(s);
      return;
    }

    // ── Step 3: AudioContext health + guard ────────────────────────────────
    // Chrome auto-suspends the AudioContext when the tab is backgrounded.
    // Starting a clip on a suspended context schedules silently and would wedge
    // the chain (cue marked played + currentSource set, but no audio). Resume
    // and retry next tick.
    if (s.audioCtx.state === "suspended") {
      s.audioCtx.resume().catch(() => {});
      return;
    }
    // Never interrupt a playing dub — let each cue finish; its onended drives
    // the next.
    if (s.currentSource) return;

    // ── Step 4: Advance pointer / start due cue ────────────────────────────
    const t = video.currentTime;
    // Skip past every due cue that has no PLAYABLE audio, then start the first one
    // that does. A cue has no playable audio when it is either:
    //   • genuinely stale (forward seek / very late): skip → re-sync, OR
    //   • already PASSED by the renderer without producing audio (empty/failed
    //     MP3, index < renderCursor): its buffer will NEVER arrive → skip. (Waiting
    //     on these was the live "stuck on Buffering…" hang.)
    // Only a recent, NOT-yet-rendered cue (index >= renderCursor) micro-pauses to
    // wait for the render pump. Loop (not recursion) so a long forward seek over
    // many stale cues can't blow the stack.
    let due = this.#sentenceDueAt(s, t);
    while (due && !due._buffer) {
      const dueIdx = s.sentences.indexOf(due);
      if (t - due.end > SUBFIRST_DRIFT_SKIP_SEC || dueIdx < s.renderCursor) {
        due._played = true; // skip — no audio will ever come for this cue
        due = this.#sentenceDueAt(s, t);
        continue;
      }
      // Not-yet-rendered cue → system-pause and wait for the render pump.
      this.#enterSystemPause(s);
      return;
    }
    if (!due) return; // nothing playable is due this tick
    // The while-loop only exits with a truthy due._buffer (or due === null, handled
    // above); the local narrows the optional type for src.buffer.
    const buffer = due._buffer;
    if (!buffer) return;

    const src = s.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(s.outputGain);
    try {
      // Full clip — no duration cap, so the tail (final characters) is never cut.
      src.start(s.audioCtx.currentTime);
    } catch {
      // AudioContext may have been closed in a race — bail silently.
      return;
    }

    // Mark played AT src.start() time (NOT deferred to onended) to preserve the
    // play-once invariant ("dup TTS ở cuối" fix). The micro-pause removes the
    // starvation so we don't need to defer here.
    due._played = true;
    s.currentSource = src;
    s.currentPlayingIdx = s.sentences.indexOf(due);
    // Show the translated text for THIS cue at the moment its dub starts, so the
    // subtitle and the voice stay in lock-step (no "audio leads text" lag).
    this.#showCue(s, s.sentences.indexOf(due));

    src.onended = () => {
      if (s.currentSource !== src) return;
      s.currentSource = null;
      s.currentPlayingIdx = null;
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      // Chain straight into the next due cue (back-to-back, no 250ms wait).
      this.#playbackTick(s);
    };
  }

  /** Stop and disconnect the currently-playing source node (if any). */
  #stopCurrent(s: SubtitleFirstSession): void {
    const src = s.currentSource;
    if (!src) return;
    try {
      src.stop();
    } catch {
      /* ignore — may already be stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
    s.currentSource = null;
    s.currentPlayingIdx = null;
  }

  /**
   * Seek handler — resets _played flags for cues at/after the new position so
   * they can replay, rewinds renderCursor so the pump refetches missing buffers,
   * and stops the current source.
   */
  #onSeek(s: SubtitleFirstSession, video: HTMLVideoElement): void {
    const newT = video.currentTime;
    // First cue that starts at or after the new position.
    const firstIdx = s.sentences.findIndex((x) => x.start >= newT);
    // Allow replay of cues the user seeked back into.
    for (const x of s.sentences) {
      if (x.start >= newT) x._played = false;
    }
    // Rewind render cursor so the pump refetches any buffers that were evicted or
    // never fetched for the re-entered range.
    if (firstIdx !== -1) {
      s.renderCursor = Math.min(s.renderCursor, firstIdx);
    }
    this.#stopCurrent(s);
    // Play the cue at the new position promptly rather than waiting for the next tick.
    this.#playbackTick(s);
  }

  /** Render the overlay text for a specific cue — called when its dub starts so the
   *  on-screen subtitle matches the voice exactly (driven by playback, not a timer). */
  #showCue(s: SubtitleFirstSession, idx: number): void {
    const { sm, overlay } = this.app;
    const translated = s.translations[idx];
    const source = s.sentences[idx]?.text;
    if (translated) {
      sm.currentTargetText = translated;
      overlay.setTargetText(translated);
    }
    if (sm.settings?.showSource && source) {
      sm.currentSourceText = source;
      overlay.setSourceText(source.slice(-220));
    }
  }

  async #runRollingRenderer(s: SubtitleFirstSession, video: HTMLVideoElement): Promise<void> {
    const { sm } = this.app;
    while (sm.session === s && !s.stopFlag) {
      await new Promise((r) => setTimeout(r, 1000));
      if (sm.session !== s || s.stopFlag) continue;
      // While the user has genuinely paused the video, do NO translate/display work
      // — otherwise the dub keeps being produced and the UI looks like it is still
      // translating even though playback is suspended.
      //
      // IMPORTANT: during a system-pause (the driver issued video.pause() to wait
      // for a cue's _buffer), video.paused IS true but we MUST keep rendering so
      // the buffer actually gets produced. `sm.videoPaused` is WebRTC-only and is
      // never set true for subtitle-first sessions (only syncSourcePauseState sets
      // it, which is only called from the WebRTC onPlay handler). So the only term
      // that would mistakenly block rendering here is `video.paused` — we exempt
      // it when the session is in a driver-issued system-pause.
      const sfSess = sm.session;
      const isSystemPaused =
        sfSess != null &&
        sfSess.kind === "subtitle-first" &&
        (sfSess as import("../session-manager").SubtitleFirstSession)._systemPaused === true;
      if (sm.videoPaused || (video.paused && !isSystemPaused)) continue;

      const t = video.currentTime;
      const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
      let targetIdx = s.sentences.findIndex((sent) => sent.start > t + lookaheadSec);
      if (targetIdx === -1) targetIdx = s.sentences.length;
      if (targetIdx <= s.renderCursor) continue;
      if (s.rollingInFlight) continue;

      const start = s.renderCursor;
      const end = targetIdx;
      s.rollingInFlight = true;
      try {
        const firstMissing = s.translations.findIndex(
          (v, i) => i >= start && i < end && (!v || !s.sentences[i]?._buffer),
        );
        const batchStart = firstMissing === -1 ? end : firstMissing;
        if (batchStart < end) {
          await this.#renderBatch(s, batchStart, end);
        }
        if (sm.session !== s || s.stopFlag) return;
        s.renderCursor = end;
      } catch {
        // A transient render error (network blip, 5xx) must NOT kill the rolling
        // renderer for the rest of the session. Swallow it and retry the same
        // range on the next 1s iteration (renderCursor is left unadvanced). On a
        // persistent outage the cue stays un-buffered and the playback driver's
        // stall cap (SUBFIRST_BUFFER_WAIT_MAX_MS) eventually skips it — bounded,
        // never an infinite hang.
      } finally {
        s.rollingInFlight = false;
      }
    }
  }

  #teardownAudio(s: SubtitleFirstSession): void {
    try {
      s.audioCtx?.close();
    } catch {
      /* ignore */
    }
  }
}
