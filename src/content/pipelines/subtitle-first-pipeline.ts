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
import { isPipelineToastError, renderSubtitleDubBatch, renderSubtitleDubStream } from "@/lib/echoly-api";
import { STANDARD_DEFAULT_VOICE } from "@/shared/constants";
import type { StartSettings } from "@/shared/types";
import {
  getPrefetchedCaptions,
  clearPrefetchedCaptions,
} from "@/platforms/youtube/caption-cache";
import {
  regroupToSentences,
  SUBFIRST_BATCH_SIZE,
  SUBFIRST_LOOKAHEAD_MS,
} from "@/lib/caption-utils";
import type { SubtitleFirstSession } from "../session-manager";
import type { ContentApp } from "../index";
import {
  TOAST_NO_CC_FALLBACK,
  TOAST_PRESS_PLAY,
  STATUS_BUFFERING,
} from "@/shared/product-copy";
import { STOP_REASON, STOP_REASON_MESSAGE } from "../stop-reasons";
import { currentSiteHost } from "@/shared/site-host";
import { fetchHtml5TextTrackCaptions } from "@/lib/html5-captions";

// Start a cue's dub up to this many seconds before its caption start.
const SUBFIRST_DUE_AHEAD_SEC = 0.15;
// If the video is already this far past a cue's end, skip it (re-sync) instead of
// playing it late. Bounds how far the dub can drift behind on dense captions.
const SUBFIRST_DRIFT_SKIP_SEC = 3;
// How many sentences to decode before the initial video.play() at startup
// (lower = less startup freeze; rolling renderer covers the lookahead window).
// Lines whose TTS must finish before video.play() is released on Start. This IS
// the user-visible "frozen video" window, so we gate on just the FIRST due line
// (one TTS) and let #runRollingRenderer fill the rest immediately after play;
// #playbackTick's micro-pause is the safety net if a later cue isn't ready in time.
const SUBFIRST_PREBUFFER_COUNT = 1;

// Rolling-renderer poll interval. Kept short so the buffer-ahead pump reacts
// quickly right after Start (and after a seek) instead of the playhead catching
// an un-rendered cue during the first second — the main source of early stutter.
const SUBFIRST_RENDER_TICK_MS = 350;
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
    // B4: Consume the eager prefetch result if available (YouTube-only).
    // The NavigationWatcher populated this cache when the video was detected
    // without an active session. One-shot: clear after reading so stale data
    // is never re-used on a subsequent Start.
    const prefetched = adapter.id === "youtube" ? getPrefetchedCaptions(videoId) : null;
    if (prefetched) {
      clearPrefetchedCaptions(videoId);
      captionResult = prefetched;
    } else {
      try {
        captionResult = await adapter.fetchCaptions({
          videoId,
          preferLang: sm.settings.targetLanguage,
          signal: abortController.signal,
        });
      } catch {
        captionResult = null;
      }
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      this.#teardownAudio(newSession);
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      // B3: pipeline-level HTML5 text-track fallback — try the standard mechanism
      // BEFORE concluding "no captions". Covers generic sites and any platform that
      // ships standard <track> elements even when the adapter's fetchCaptions returns
      // null/empty (Udemy, generic). Uses the same abort signal already in scope.
      const html5 = await fetchHtml5TextTrackCaptions(video, {
        preferLang: sm.settings.targetLanguage,
        signal: abortController.signal,
      });
      if (html5?.captions.length) {
        captionResult = html5;
      }
    }

    if (!captionResult?.captions.length) {
      this.#teardownAudio(newSession);
      sm.session = null;
      // NOTE: do NOT bump sm.pageToken here — startWebRtcStandard → startWebRtcSession
      // calls sm.nextToken() itself, which increments pageToken. A redundant bump here
      // would double-increment and stale out the session token from nextToken().
      overlay.removeOverlay();

      // Branch on audioCapture capability:
      // - true  (YouTube, Coursera): fall back to WebRTC Standard audio capture.
      // - false (Udemy DRM): cannot capture audio — show explicit "unsupported" toast.
      if (adapter.capabilities.audioCapture) {
        const result = await this.app.startWebRtcStandard(incomingSettings);
        if (result.ok) {
          overlay.showToast(TOAST_NO_CC_FALLBACK, 5000);
        } else {
          overlay.showToast(result.error ?? "Couldn't start live dubbing", 6000);
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

    // Capture video title once per session (title is stable per video).
    // Encode here so every batch request simply passes the pre-encoded value.
    const rawTitle = adapter.getVideoTitle?.() ?? null;
    if (rawTitle) {
      newSession.videoTitle = encodeURIComponent(rawTitle);
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

    // Resume the AudioContext BEFORE the video plays. AudioContext.resume() is
    // async; if we release the video while the context is still "suspended", the
    // first #playbackTick bails at the suspended-guard and the cue only starts on
    // a later tick — so the video visibly moves ~250ms before any dub is heard
    // ("video chạy 1 tý mới thấy tiếng"). Awaiting resume (bounded) makes the
    // first cue start in lock-step with playback. Soft-fail so it can't hang.
    if (audioCtx.state === "suspended") {
      await Promise.race([
        audioCtx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }

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

  /**
   * Continue dubbing on a NEW video without tearing down the overlay or the
   * background session. Evicts the old subtitle-first driver, builds a FRESH
   * SubtitleFirstSession (reusing audioCtx/outputGain to avoid an audio-graph
   * glitch), swaps sm.session atomically, refetches captions for the new video,
   * and restarts the playback tick + rolling renderer.
   *
   * Called from auto-next.ts after the new video element is ready.
   */
  async restart(
    settings: StartSettings,
    newVideoId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const { sm } = this.app;
    const adapter = this.app.adapter;

    // ── Evict the old driver ──────────────────────────────────────────────────
    // The old rolling-renderer while-loop guards on `sm.session === oldS` (and
    // `oldS.stopFlag`). Setting stopFlag + clearing the playback timer ensures
    // the old driver exits cleanly without a double-render race.
    const oldS = sm.session;
    if (oldS && oldS.kind === "subtitle-first") {
      const sf = oldS as SubtitleFirstSession;
      sf.stopFlag = true;
      if (sf.playbackTimer) {
        clearInterval(sf.playbackTimer);
        sf.playbackTimer = null;
      }
      // Stop the currently-playing source node so audio goes silent immediately.
      try {
        sf.currentSource?.stop();
      } catch {
        /* may already be stopped */
      }
      // Abort any in-flight caption/TTS fetches on the OLD session.
      try {
        sf.abortController.abort();
      } catch {
        /* ignore */
      }
    }

    // Reuse the audio graph from the old session so there is no teardown glitch.
    const reuseCtx =
      oldS && oldS.kind === "subtitle-first"
        ? (oldS as SubtitleFirstSession).audioCtx
        : null;
    const reuseGain =
      oldS && oldS.kind === "subtitle-first"
        ? (oldS as SubtitleFirstSession).outputGain
        : null;

    // ── Build a FRESH session object ──────────────────────────────────────────
    const token = sm.nextToken();
    const abortController = new AbortController();

    // If no reusable audio graph (shouldn't happen in practice), create a new one.
    let audioCtx: AudioContext;
    let outputGain: GainNode;
    if (reuseCtx && reuseCtx.state !== "closed" && reuseGain) {
      audioCtx = reuseCtx;
      outputGain = reuseGain;
      // Ensure it's running (might have been suspended).
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } else {
      try {
        const Ctor =
          window.AudioContext ||
          (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        audioCtx = new Ctor();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        outputGain = audioCtx.createGain();
        outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
        outputGain.connect(audioCtx.destination);
      } catch (err) {
        return {
          ok: false,
          error: `AudioContext unavailable: ${(err as Error).message}`,
        };
      }
    }

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
      apiBearer: settings.apiBearer,
      abortController,
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: null,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
      _systemPaused: false,
      _bufferWaitStartedAt: undefined,
    };

    // ── Atomic swap: old loops will see sm.session !== oldS and exit ──────────
    sm.session = newSession;

    // ── Stale guard: check pageToken at every async boundary ─────────────────
    if (sm.isSessionStale(token)) return { ok: false, error: "Cancelled." };

    // ── Fetch captions for the new video ─────────────────────────────────────
    const video = adapter.findVideo() ?? this.app.capture.findVideo();
    if (!video) {
      sm.session = null;
      return { ok: false, error: "No playable video on this page." };
    }

    let captionResult;
    // B4: Consume the eager prefetch result if available (YouTube-only).
    const prefetchedRestart = adapter.id === "youtube" ? getPrefetchedCaptions(newVideoId) : null;
    if (prefetchedRestart) {
      clearPrefetchedCaptions(newVideoId);
      captionResult = prefetchedRestart;
    } else {
      try {
        captionResult = await adapter.fetchCaptions({
          videoId: newVideoId,
          preferLang: settings.targetLanguage,
          signal: abortController.signal,
        });
      } catch {
        captionResult = null;
      }
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      // B3: pipeline-level HTML5 text-track fallback in restart() — same rescue
      // as in start() so auto-next videos with <track> elements are not abandoned.
      const html5 = await fetchHtml5TextTrackCaptions(video, {
        preferLang: settings.targetLanguage,
        signal: abortController.signal,
      });
      if (html5?.captions.length) {
        captionResult = html5;
      }
    }

    if (!captionResult?.captions.length) {
      return { ok: false, error: "No captions available for this video." };
    }

    // ── Capture video title for this new video ────────────────────────────────
    const rawTitle = adapter.getVideoTitle?.() ?? null;
    if (rawTitle) {
      newSession.videoTitle = encodeURIComponent(rawTitle);
    }

    // ── Build sentences + initial translation batch ───────────────────────────
    // regroupToSentences and SUBFIRST_LOOKAHEAD_MS are top-level static imports.
    const sentences = regroupToSentences(captionResult.captions);
    newSession.sentences = sentences;
    newSession.translations = new Array(sentences.length);

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
        return { ok: false, error: "Cancelled." };
      }
      // isPipelineToastError is a top-level static import.
      const msg = isPipelineToastError(err)
        ? err.user
        : String((err as Error).message || err);
      return { ok: false, error: msg };
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      return { ok: false, error: "Cancelled." };
    }

    newSession.renderCursor = firstWaveEnd;

    // ── Start playback driver (same as start()) ───────────────────────────────
    newSession.playbackTimer = setInterval(
      () => this.#playbackTick(newSession),
      250,
    );
    // Fire once immediately so the first cue starts without waiting 250ms.
    this.#playbackTick(newSession);
    void this.#runRollingRenderer(newSession, video);

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
      const siteHost = currentSiteHost() ?? undefined;

      // E-4: pass abortController.signal on EVERY batch so Stop halts server synthesis.
      // E-5: populate s.sentences[idx]._buffer in STRICT index order as lines arrive
      //      (the SSE generator yields line 0 first, then 1, then 2, …) so
      //      onResumeCheck's "next due cue buffered?" check behaves identically to
      //      the buffered path.
      for await (const item of renderSubtitleDubStream({
        apiBase: sm.apiBase,
        bearer: s.apiBearer,
        sentences: slice,
        targetLanguage: lang,
        voiceId,
        cueDurationsMs,
        priorLines,
        sessionId: `sf_${s.token}`,
        siteHost,
        videoTitle: s.videoTitle,
        signal: s.abortController.signal,  // E-4: always thread the signal
      })) {
        // Check stale/stopped BEFORE writing each decoded buffer so we bail
        // promptly when Stop is pressed mid-stream.
        if (sm.session !== s || s.stopFlag) return;

        // item.index is the 0-based index WITHIN the slice — map to global idx.
        const idx = i + item.index;
        s.translations[idx] = item.text;

        // E-5: write _buffer in strict index order (the generator yields in order).
        if (item.audioMp3.byteLength > 0 && s.audioCtx) {
          try {
            s.sentences[idx]!._buffer = await s.audioCtx.decodeAudioData(item.audioMp3.slice(0));
          } catch {
            /* ignore decode failure — _buffer stays undefined; playback tick skips */
          }
        }

        // Re-check after async decodeAudioData — an abort may have fired.
        if (sm.session !== s || s.stopFlag) return;
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
    // C2: emit "buffering" overlay state so the branded spinner is shown during
    // the micro-pause (matches the clock-RUNNING branch in overlay.ts).
    this.app.overlay.setOverlayState("buffering");
    this.app.overlay.setStatusText(STATUS_BUFFERING);
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
    // C2: restore "live" state when the micro-pause ends.
    this.app.overlay.setOverlayState("live");
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

    // ── Step 2: EXTERNAL pause (user) — idle on canonical userPaused flag ──
    // When the user has genuinely paused the source video, stop any in-flight
    // clip so the voice goes silent immediately; next tick picks up naturally.
    // NOTE: system-pause (_systemPaused) was already handled in Step 1; it may
    // have left video.paused===true momentarily while the buffer loads. We key
    // off sm.userPaused (canonical) rather than video.paused so a system-pause
    // never silences the dub prematurely.
    if (sm.userPaused) {
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
      // Poll on SUBFIRST_RENDER_TICK_MS so the buffer-ahead pump reacts quickly
      // after Start/seek (was 1000ms — too slow, the playhead caught un-rendered
      // cues in the first second causing early stutter).
      await new Promise((r) => setTimeout(r, SUBFIRST_RENDER_TICK_MS));
      if (sm.session !== s || s.stopFlag) continue;
      // While the user has genuinely paused the video, do NO translate/display work
      // — otherwise the dub keeps being produced and the UI looks like it is still
      // translating even though playback is suspended.
      //
      // IMPORTANT: during a system-pause (the driver issued video.pause() to wait
      // for a cue's _buffer), video.paused IS true but we MUST keep rendering so
      // the buffer actually gets produced. `sm.userPaused` is the canonical "user
      // paused" flag (all tiers); `_systemPaused` is the driver-issued micro-pause.
      // Idle only on a genuine user pause (sm.userPaused), never on a system-pause —
      // so the buffer pump continues even when the video element is technically paused.
      const sfSess = sm.session;
      const isSystemPaused =
        sfSess != null &&
        sfSess.kind === "subtitle-first" &&
        (sfSess as import("../session-manager").SubtitleFirstSession)._systemPaused === true;
      if (sm.userPaused || (video.paused && !isSystemPaused)) continue;

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
    // Stop the playing source FIRST (synchronous, instant silence) — closing the
    // AudioContext is async and would let the current cue ring out for a beat.
    this.#stopCurrent(s);
    try {
      s.audioCtx?.close();
    } catch {
      /* ignore */
    }
  }
}
