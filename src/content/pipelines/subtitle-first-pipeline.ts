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
import { isPipelineToastError, renderSubtitleDubBatch, renderSubtitleDubStream, ALREADY_PROCESSED, newRequestId } from "@/lib/echoly-api";
import { STANDARD_DEFAULT_VOICE } from "@/shared/constants";
import {
  cacheKey,
  cacheGet,
  cacheSet,
  clearVideoCache,
} from "@/content/render-cache";
import type { StartSettings } from "@/shared/types";
import {
  getPrefetchedCaptions,
  clearPrefetchedCaptions,
} from "@/platforms/youtube/caption-cache";
import {
  regroupToSentences,
  SUBFIRST_BATCH_SIZE,
  SUBFIRST_LOOKAHEAD_MS,
  BUFFER_AHEAD_TARGET_SEC,
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
// Maximum number of concurrent #renderBatch calls in the rolling renderer (C2).
// Bounds server inflight slots and rate-limit ticks; must not exceed 3 without
// re-checking MAX_INFLIGHT_PER_USER (server) and CHAT_RATE_MAX limits.
const MAX_INFLIGHT_BATCHES = 3;

// How many sentences to include in the initial prebuffer wave sent before
// video.play() is released.  The KEY change (C1): play is released as soon as
// the FIRST sentence in this wave has a decoded _buffer — not when the whole
// wave completes.  Keeping this at 1 means the prebuffer wave is a single-line
// request, so line 0 sets its _buffer immediately and play fires at SSE line 0.
const SUBFIRST_PREBUFFER_COUNT = 1;

// Rolling-renderer poll interval. Kept short so the buffer-ahead pump reacts
// quickly right after Start (and after a seek) instead of the playhead catching
// an un-rendered cue during the first second — the main source of early stutter.
const SUBFIRST_RENDER_TICK_MS = 350;
// Maximum ms the driver will keep the video paused waiting for a cue's _buffer.
// Once exceeded the micro-pause is released and the normal drift-skip logic takes
// over so we never freeze forever.
const SUBFIRST_BUFFER_WAIT_MAX_MS = 8000;

// Auto-next (restart) caption-acquisition retry settle. restart() fires DURING the
// platform's lecture-load churn (Udemy/Shaka destroys+recreates the <video> and the
// taking-page DOM remounts), so the lecture/caption asset can be momentarily
// unavailable on the first attempt — unlike a manual Start, which runs after the
// lecture has settled (that is why stop+start works where auto-next does not). One
// short, bounded retry lets the CC path succeed instead of falling to a dead-end.
const AUTONEXT_CAPTION_RETRY_MS = 800;

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
    // The controller owns video.pause()/play() — register this video so the
    // start system-buffer pause/release below routes through it.
    this.app.lifecycle.setVideo(video);
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
    // W6 — first-frame subtitle style (the WebRTC paths apply it in
    // startSession/startWebRtcSession; this is the subtitle-first equivalent —
    // without it, custom styling never applied on the Standard VOD dub path).
    // Optional call: style is cosmetic and partial test fakes omit it — a
    // missing apply must never block session start.
    this.app.applySubtitleStyle?.(incomingSettings);
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
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _videoId: videoId,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
      _inflightRanges: new Set(),
      _resolvedAhead: new Set(),
    };
    sm.session = newSession;
    sm.settings = { ...incomingSettings };
    sm.apiBase = sm.settings.apiBase || sm.apiBase;

    const wasPlaying = !video.paused;
    // Release the start system-buffer pause on any early-exit path. resume()
    // plays iff the reason stack is now empty (idempotent if already cleared).
    const restorePlay = () => {
      if (wasPlaying) void this.app.lifecycle.resume("system-buffer");
    };

    // Controller-owned system-buffer pause held until video.play() is released
    // after the first cue renders (the user-visible "frozen video" start window).
    this.app.lifecycle.pause("system-buffer");

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
          preferLang: (sm.settings.sourceLanguage && sm.settings.sourceLanguage !== "auto")
            ? sm.settings.sourceLanguage
            : undefined,
          avoidLang: sm.settings.targetLanguage,
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
        // Source preference, NOT the target/output language (Fix D). "auto" → let
        // the fallback pick the first available <track>.
        preferLang:
          sm.settings.sourceLanguage && sm.settings.sourceLanguage !== "auto"
            ? sm.settings.sourceLanguage
            : undefined,
        signal: abortController.signal,
      });
      if (html5?.captions.length) {
        captionResult = html5;
      }
    }

    // Fresh-start timing rescue (mirrors restart()'s retry). A fresh start() right
    // after Udemy auto-advances to the next lecture (autoGoToNext → background
    // hard-nav stop → continuation-intent re-start) lands mid Shaka/lecture-load:
    // the api-2.0 caption asset / taking-page DOM isn't ready, so the FIRST attempt
    // comes back empty even though the lecture HAS captions. Without a retry, start()
    // falls to the WebRTC/DRM dead-end (a silent rt_ session — exactly the
    // next-lecture-no-dub bug). Retry the WHOLE acquisition ONCE after a short
    // settle, re-checking supersession, so CC succeeds instead.
    if (
      !captionResult?.captions.length &&
      !(sm.isSessionStale(token) || newSession.stopFlag)
    ) {
      console.info("[start] captions empty on first attempt, retrying after settle", { videoId });
      await new Promise((r) => setTimeout(r, AUTONEXT_CAPTION_RETRY_MS));
      if (!(sm.isSessionStale(token) || newSession.stopFlag)) {
        const retryPreferLang =
          sm.settings.sourceLanguage && sm.settings.sourceLanguage !== "auto"
            ? sm.settings.sourceLanguage
            : undefined;
        try {
          captionResult = await adapter.fetchCaptions({
            videoId,
            preferLang: retryPreferLang,
            avoidLang: sm.settings.targetLanguage,
            signal: abortController.signal,
          });
        } catch {
          captionResult = null;
        }
        if (!captionResult?.captions.length) {
          const html5Retry = await fetchHtml5TextTrackCaptions(video, {
            preferLang: retryPreferLang,
            signal: abortController.signal,
          });
          if (html5Retry?.captions.length) {
            captionResult = html5Retry;
          }
        }
      }
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      this.#teardownAudio(newSession);
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      this.#teardownAudio(newSession);
      sm.session = null;
      // NOTE: do NOT bump sm.pageToken here — startWebRtcStandard → startWebRtcSession
      // calls sm.nextToken() itself, which increments pageToken. A redundant bump here
      // would double-increment and stale out the session token from nextToken().
      overlay.removeOverlay();

      // Branch on whether audio can be captured for THIS video:
      // - YouTube/Coursera/Generic: static capabilities.audioCapture (true).
      // - Udemy: canCaptureAudioNow(video) probes per-lecture (DRM vs non-DRM)
      //   so a non-DRM lecture with no captions still gets the audio→STT→TTS
      //   fallback instead of an immediate "unsupported" toast.
      const canCaptureAudio =
        adapter.canCaptureAudioNow?.(video) ?? adapter.capabilities.audioCapture;
      if (canCaptureAudio) {
        // Release the start-time `system-buffer` pause BEFORE handing off to the
        // live audio→STT→TTS path. Unconditional (NOT the wasPlaying-gated
        // restorePlay()): if Start was pressed while the video was paused,
        // restorePlay() no-ops and `system-buffer` stays stuck on the lifecycle
        // reason stack forever — and startWebRtcStandard's forceWebRtcStandard path
        // skips its own SF6 pause/resume, so nothing else releases it. The stuck
        // reason keeps the source <video> paused (effectivePaused excludes
        // system-buffer, so it's invisible), so captureStream() yields a silent
        // track and the server's PCM window never fills — the 55s no-PCM stall.
        // resume() is idempotent; the no-CC dub is live-style so the controller must
        // hold no residual pause (captureWithRetry's nudgePlay drives the brief play
        // needed to acquire the track).
        void this.app.lifecycle.resume("system-buffer");
        const result = await this.app.startWebRtcStandard(incomingSettings);
        if (result.ok) {
          overlay.showToast(TOAST_NO_CC_FALLBACK, 5000);
        } else {
          overlay.showToast(result.error ?? "Couldn't start live dubbing", 6000);
          // No restorePlay() here: system-buffer is already released above, and on
          // failure the source video should keep playing — a frozen video would be
          // wrong for a live-dub attempt that simply couldn't reach the server.
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
    // The first PLAYABLE cue for currentTime (covering cue replayed from its
    // start, else the next cue) — shared with restart() + #onSeek so "where do we
    // start" is identical everywhere. null ⇒ Started AFTER the last caption.
    const firstPlayable = this.#firstPlayableCueAt(newSession, currentTime);
    if (!firstPlayable) {
      // Edge (SOLUTION §3.5): nothing playable remains — surface the no-captions /
      // press-play path rather than leaving a silent dead session.
      this.#teardownAudio(newSession);
      sm.session = null;
      restorePlay();
      overlay.removeOverlay();
      overlay.showToast(TOAST_PRESS_PLAY, 6000);
      return { ok: false, error: "No captions remaining at this position." };
    }
    const firstWaveStart = firstPlayable.index;
    let lookaheadEnd = sentences.findIndex((s) => s.start > currentTime + lookaheadSec);
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + SUBFIRST_PREBUFFER_COUNT);
    if (firstWaveEnd <= firstWaveStart && firstWaveStart < sentences.length) {
      firstWaveEnd = firstWaveStart + 1;
    }

    // C1: Release play on FIRST decoded line, not when the whole prebuffer batch
    // completes. We kick the prebuffer batch in the background and await a
    // "first cue ready" signal via a Promise that resolves as soon as
    // sentences[firstWaveStart]._buffer is set. The prebuffer batch continues
    // filling lines firstWaveStart+1 .. firstWaveEnd-1 asynchronously.
    //
    // Error handling: if the batch rejects BEFORE line 0 is decoded, we surface
    // the error and bail (same as before); if it rejects AFTER (unlikely), the
    // rolling renderer's catch-and-continue handles it.
    let prebufferError: unknown = null;
    // resolveFirstReady is called by the batch when sentences[firstWaveStart]._buffer
    // gets set. We poll via a resolved-promise chain in the batch wrapper below.
    let resolveFirstReady!: () => void;
    const firstReadyPromise = new Promise<void>((res) => { resolveFirstReady = res; });

    const prebufferPromise = this.#renderBatchNotifyFirst(
      newSession,
      firstWaveStart,
      firstWaveEnd,
      resolveFirstReady,
    ).catch((err) => {
      prebufferError = err;
      // If line 0 is still not ready, unblock the firstReadyPromise so we surface
      // the error below rather than hanging on firstReadyPromise forever.
      resolveFirstReady();
    });

    // Await first line decoded OR batch error (whichever comes first).
    await firstReadyPromise;

    // Check if batch errored before line 0 was ready.
    if (prebufferError !== null) {
      const err = prebufferError;
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
      if (isPipelineToastError(err) && err.expiryLike) {
        overlay.showToast(err.user, {
          durationMs: err.durationMs ?? 8000,
          ...(err.cta ? { cta: err.cta } : {}),
          ...(err.ctaLabel ? { ctaLabel: err.ctaLabel } : {}),
        });
      }
      return { ok: false, error: msg };
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      this.#teardownAudio(newSession);
      restorePlay();
      // Allow prebuffer to finish settling but don't await (already detached).
      void prebufferPromise;
      return { ok: false, error: "Cancelled." };
    }

    // The prebuffer batch is still running in the background (lines 1..k); the
    // rolling renderer will pick up from wherever the batch leaves off.
    // We do NOT await prebufferPromise here — that is the key C1 change.
    // renderCursor will be updated by the pipelined renderer via contiguous-fold.
    // Set it to firstWaveStart so the renderer knows where to start from.
    newSession.renderCursor = firstWaveStart;
    // Track the prebuffer range as in-flight so the renderer doesn't overlap it.
    if (firstWaveEnd > firstWaveStart) {
      newSession._inflightRanges.add(`${firstWaveStart}-${firstWaveEnd}`);
    }
    // When the prebuffer completes, fold renderCursor via the normal completion path.
    void prebufferPromise.then(() => {
      if (sm.session !== newSession || newSession.stopFlag) return;
      const rangeKey = `${firstWaveStart}-${firstWaveEnd}`;
      newSession._inflightRanges.delete(rangeKey);
      newSession._resolvedAhead.add(rangeKey);
      this.#foldResolvedAhead(newSession);
    });

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

    // Lock-step release (SOLUTION §3.3 — critic GAP-6): release video.play() via
    // the controller (resume returns the RAW play() promise) and ONLY on its
    // successful resolve start line-1's source — in this same microtask, BEFORE
    // the first 250ms #playbackTick interval fires. This guarantees line-1 plays
    // and closes the play-before-sound tail without ever starting audio over a
    // still-frozen video. On play() REJECT (autoplay-block) do NOT start the
    // source → press-play toast (the user pressing play later re-drives the tick).
    try {
      await this.app.lifecycle.resume("system-buffer");
      // play() resolved → the video is moving. Start line-1 immediately IF it is
      // actually DUE now and its buffer decoded; otherwise the 250ms interval (or
      // the post-play micro-pause stall net) picks it up. Gating on #sentenceDueAt
      // means we don't fire early when there's a gap before the first caption
      // (Start at t=0, first cue at t=10 → not due → no premature audio). Never
      // double-start (currentSource guard).
      const line1 = firstPlayable.cue;
      const due = this.#sentenceDueAt(newSession, video.currentTime);
      if (!newSession.currentSource && due === line1 && line1._buffer) {
        this.#startCue(newSession, line1);
      }
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

    // Fire once immediately so the first cue starts without waiting 250ms (a
    // no-op for line-1 which the lock-step already started; covers line-2+ and
    // the autoplay-block / un-buffered-line-1 paths).
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
    // The <video> element the auto-next ready-poll already validated
    // (readyState>=3 && currentTime>0 && !ad). Threaded in so restart() does NOT
    // re-query findVideo() mid-Shaka-recreate (which can return null/a stale,
    // detached element with a bogus currentTime). Used iff still `isConnected`.
    knownVideo?: HTMLVideoElement,
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

    // ── Render-cache: evict old video's entries when navigating to a new one ──
    // The new video has a different videoId → its sentences are at different
    // indices and the text content is different, so old entries would never
    // match. Clearing them frees memory and prevents stale-key confusion.
    if (oldS && oldS.kind === "subtitle-first") {
      const oldVid = (oldS as SubtitleFirstSession)._videoId;
      if (oldVid && oldVid !== newVideoId) {
        clearVideoCache(oldVid);
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
      _bufferWaitStartedAt: undefined,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _videoId: newVideoId,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
      _inflightRanges: new Set(),
      _resolvedAhead: new Set(),
    };

    // ── Atomic swap: old loops will see sm.session !== oldS and exit ──────────
    sm.session = newSession;

    // ── Stale guard: check pageToken at every async boundary ─────────────────
    if (sm.isSessionStale(token)) return { ok: false, error: "Cancelled." };

    // ── Fetch captions for the new video ─────────────────────────────────────
    // Prefer the auto-next-validated element (knownVideo) while it is still in the
    // DOM; only re-query if it has been detached (Shaka recreated it again) — this
    // closes the transient null/stale-element window that made restart() return
    // "No playable video" or anchor #firstPlayableCueAt at a bogus currentTime.
    const video =
      (knownVideo?.isConnected ? knownVideo : null) ??
      adapter.findVideo() ??
      this.app.capture.findVideo();
    if (!video) {
      console.info("[auto-next] restart failed", { step: "no-video", newVideoId });
      // Identity-guarded (consistent with the other failure exits): never null a
      // successor generation's session if a rapid second restart() already swapped
      // sm.session between the line-595 install and here.
      if (sm.session === newSession) sm.session = null;
      return { ok: false, error: "No playable video on this page." };
    }
    // The controller owns video.pause()/play() — point it at the new video so
    // the restart system-buffer pause/release below routes through it.
    this.app.lifecycle.setVideo(video);

    // Re-apply the user's volume config to the NEW element. On auto-next the
    // platform (Udemy/Shaka) recreates the <video>, which starts at DEFAULT full
    // volume — so the user's reduced original-audio level (and the dub-voice gain)
    // were lost across a lecture change. Mirrors webrtc.continueOnNewVideo
    // (webrtc-pipeline.ts) — restart() was the only auto-next path missing it.
    // bindVolumeDriftGuard snaps the original volume back if the player re-applies
    // its own. sm.session === newSession here, so applyVolumes finds the dub
    // outputGain; capture.videoEl is pointed at the new element first.
    this.app.capture.videoEl = video;
    this.app.capture.bindVolumeDriftGuard(video);
    this.app.capture.applyVolumes(settings.originalVolume, settings.voiceVolume);

    // ── Pause/render/resume: mirror start() to stabilise currentTime ─────────
    // The controller's system-buffer pause sets its synchronous #selfIssued flag
    // BEFORE video.pause() so the DOM "pause" event no-ops the onPause handler
    // (replaces the old _systemPaused-set-before-pause invariant).
    const wasPlaying = !video.paused;
    // Helper used by all early-exit paths that happen after the pause. It must
    // ALWAYS release the `system-buffer` reason — if the source video was already
    // paused (wasPlaying=false; e.g. paused-then-SPA-navigated), a plain resume()
    // would no-op and leave `system-buffer` STUCK on the lifecycle reason stack,
    // re-freezing the video on every controller tick (effectivePaused excludes
    // system-buffer, so it stays invisible). So: resume (play) when it was playing,
    // else dropReason (release without forcing play — preserve the user's pause).
    const restorePlay = () => {
      if (wasPlaying) void this.app.lifecycle.resume("system-buffer");
      else this.app.lifecycle.dropReason("system-buffer");
    };
    this.app.lifecycle.pause("system-buffer");

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
          preferLang: (settings.sourceLanguage && settings.sourceLanguage !== "auto")
            ? settings.sourceLanguage
            : undefined,
          avoidLang: settings.targetLanguage,
          signal: abortController.signal,
        });
      } catch {
        captionResult = null;
      }
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      // B3: pipeline-level HTML5 text-track fallback in restart() — same rescue
      // as in start() so auto-next videos with <track> elements are not abandoned.
      const html5 = await fetchHtml5TextTrackCaptions(video, {
        // Source preference, NOT the target/output language (Fix D).
        preferLang:
          settings.sourceLanguage && settings.sourceLanguage !== "auto"
            ? settings.sourceLanguage
            : undefined,
        signal: abortController.signal,
      });
      if (html5?.captions.length) {
        captionResult = html5;
      }
    }

    // Auto-next timing rescue: the first attempt can land mid lecture-load churn
    // (Shaka recreating the element, the api-2.0 lecture/caption asset not yet
    // ready) and come back empty even though the lecture HAS captions — which is
    // exactly why a manual stop+start (run after the lecture settles) works. Retry
    // the WHOLE acquisition (adapter API + HTML5 <track> fallback) ONCE after a
    // short settle, re-querying the element and re-checking supersession.
    if (
      !captionResult?.captions.length &&
      !(sm.isSessionStale(token) || newSession.stopFlag)
    ) {
      console.info("[auto-next] restart: captions empty on first attempt, retrying after settle", {
        newVideoId,
      });
      await new Promise((r) => setTimeout(r, AUTONEXT_CAPTION_RETRY_MS));
      if (!(sm.isSessionStale(token) || newSession.stopFlag)) {
        const retryVideo =
          (knownVideo?.isConnected ? knownVideo : null) ??
          adapter.findVideo() ??
          video;
        const retryPreferLang =
          settings.sourceLanguage && settings.sourceLanguage !== "auto"
            ? settings.sourceLanguage
            : undefined;
        try {
          captionResult = await adapter.fetchCaptions({
            videoId: newVideoId,
            preferLang: retryPreferLang,
            avoidLang: settings.targetLanguage,
            signal: abortController.signal,
          });
        } catch {
          captionResult = null;
        }
        if (!captionResult?.captions.length) {
          const html5Retry = await fetchHtml5TextTrackCaptions(retryVideo, {
            preferLang: retryPreferLang,
            signal: abortController.signal,
          });
          if (html5Retry?.captions.length) {
            captionResult = html5Retry;
          }
        }
      }
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult?.captions.length) {
      console.info("[auto-next] restart failed", { step: "no-captions", newVideoId });
      // Clear the pre-swapped placeholder session (line ~589 set sm.session =
      // newSession before the fetch) so a genuine no-caption failure does not
      // leave an uninitialized kind="subtitle-first" session in sm.session.
      // Identity-guarded so a superseding generation's session is never clobbered.
      if (sm.session === newSession) sm.session = null;
      restorePlay();
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
    // Same #firstPlayableCueAt anchor as start() (covering cue replayed from its
    // start, else next). null ⇒ nothing playable for this position — bail cleanly
    // (auto-next continuation: no toast, just don't leave a silent session).
    const firstPlayable = this.#firstPlayableCueAt(newSession, currentTime);
    if (!firstPlayable) {
      console.info("[auto-next] restart failed", {
        step: "no-playable-cue",
        newVideoId,
        currentTime,
      });
      restorePlay();
      if (sm.session === newSession) sm.session = null;
      return { ok: false, error: "No captions remaining at this position." };
    }
    const firstWaveStart = firstPlayable.index;
    let lookaheadEnd = sentences.findIndex((s) => s.start > currentTime + lookaheadSec);
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + SUBFIRST_PREBUFFER_COUNT);
    if (firstWaveEnd <= firstWaveStart && firstWaveStart < sentences.length) {
      firstWaveEnd = firstWaveStart + 1;
    }

    // C1 (restart path): same as start() — release play on first decoded line.
    let restartPrebufferError: unknown = null;
    let resolveRestartFirstReady!: () => void;
    const restartFirstReadyPromise = new Promise<void>((res) => { resolveRestartFirstReady = res; });

    const restartPrebufferPromise = this.#renderBatchNotifyFirst(
      newSession,
      firstWaveStart,
      firstWaveEnd,
      resolveRestartFirstReady,
    ).catch((err) => {
      restartPrebufferError = err;
      resolveRestartFirstReady();
    });

    await restartFirstReadyPromise;

    if (restartPrebufferError !== null) {
      const err = restartPrebufferError;
      if (sm.isSessionStale(token) || newSession.stopFlag) {
        restorePlay();
        return { ok: false, error: "Cancelled." };
      }
      const msg = isPipelineToastError(err)
        ? err.user
        : String((err as Error).message || err);
      if (isPipelineToastError(err) && err.expiryLike) {
        this.app.overlay.showToast(err.user, {
          durationMs: err.durationMs ?? 8000,
          ...(err.cta ? { cta: err.cta } : {}),
          ...(err.ctaLabel ? { ctaLabel: err.ctaLabel } : {}),
        });
      }
      restorePlay();
      return { ok: false, error: msg };
    }

    if (sm.isSessionStale(token) || newSession.stopFlag) {
      restorePlay();
      void restartPrebufferPromise;
      return { ok: false, error: "Cancelled." };
    }

    newSession.renderCursor = firstWaveStart;
    if (firstWaveEnd > firstWaveStart) {
      newSession._inflightRanges.add(`${firstWaveStart}-${firstWaveEnd}`);
    }
    void restartPrebufferPromise.then(() => {
      if (sm.session !== newSession || newSession.stopFlag) return;
      const rangeKey = `${firstWaveStart}-${firstWaveEnd}`;
      newSession._inflightRanges.delete(rangeKey);
      newSession._resolvedAhead.add(rangeKey);
      this.#foldResolvedAhead(newSession);
    });

    // ── Bind seeked + ended listeners (mirror start() lines 277-285) ─────────
    // These were missing from restart(), which meant post-auto-next seeks were
    // broken and the final cue's end-tick was lost.
    const onSeeked = () => this.#onSeek(newSession, video);
    newSession._onSeeked = onSeeked;
    this.app.bindCommonVideoListeners(video, newSession, {
      onSeeked,
      onEndedBefore: () => this.#playbackTick(newSession),
    });

    // Re-arm the session-expiry timers for the new video (mirror start() line 275).
    this.app.startSessionTimer();

    // ── Resume AudioContext BEFORE releasing the video (mirror start() ~293-298) ──
    // If suspended, await resume so the first cue starts in lock-step with play.
    if (audioCtx.state === "suspended") {
      await Promise.race([
        audioCtx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }

    // ── Release the restart system-buffer pause + restore playback ────────────
    // resume('system-buffer') pops the reason and (iff the stack is now empty)
    // issues the controller's video.play(); the #selfIssued guard no-ops the
    // resulting "play" DOM event. Only restore play if the video was playing
    // before the restart (preserve a deliberate user pause).
    //
    // Lock-step (SOLUTION §3.3 — same as start()): on the play() promise
    // resolving, start line-1's source immediately in this microtask (before the
    // first interval tick) so the first dubbed line of the next video is never
    // swallowed and never plays over a still-frozen frame.
    if (wasPlaying) {
      try {
        await this.app.lifecycle.resume("system-buffer");
        const line1 = firstPlayable.cue;
        const due = this.#sentenceDueAt(newSession, video.currentTime);
        if (!newSession.currentSource && due === line1 && line1._buffer) {
          this.#startCue(newSession, line1);
        }
      } catch {
        // play() rejected (autoplay-block) — surface the press-play toast, same as
        // start(). Previously restart() swallowed this silently, leaving the user
        // with a frozen video + a paused dub and no hint to press play.
        this.app.overlay.setStatusText(TOAST_PRESS_PLAY);
        this.app.overlay.showToast(TOAST_PRESS_PLAY, 6000);
      }
    } else {
      // Video was paused going in — drop the reason without playing.
      this.app.lifecycle.dropReason("system-buffer");
    }

    // ── Start playback driver (same as start()) ───────────────────────────────
    newSession.playbackTimer = setInterval(
      () => this.#playbackTick(newSession),
      250,
    );
    // Fire once immediately so the first cue starts without waiting 250ms
    // (no-op for line-1 if the lock-step already started it).
    this.#playbackTick(newSession);
    void this.#runRollingRenderer(newSession, video);

    return { ok: true };
  }

  /**
   * Called by `#renderBatch` when a line's `_buffer` is set (or a line is skipped).
   * Used by the C1 startup path to release video.play() as soon as line 0 is decoded.
   */
  #onLineDecoded?: (globalIdx: number) => void;

  async #renderBatch(s: SubtitleFirstSession, startIdx: number, endIdx: number): Promise<void> {
    const { sm } = this.app;
    const voiceId = sm.settings?.standardVoice || STANDARD_DEFAULT_VOICE;
    const lang = sm.settings?.targetLanguage || "vi";
    const videoId = s._videoId ?? "";
    for (let i = startIdx; i < endIdx; i += SUBFIRST_BATCH_SIZE) {
      if (sm.session !== s || s.stopFlag) return;
      const sliceEnd = Math.min(i + SUBFIRST_BATCH_SIZE, endIdx);
      const slice = s.sentences.slice(i, sliceEnd);

      // ── Render-cache: resolve hits before touching the network ─────────────
      // For each line in the slice, check the page-lifetime cache. A hit means
      // this line was already rendered (and paid for) in a previous session on
      // this page — replay for free. Collect only the misses for the server.
      //
      // missMap: sliceOffset (0-based within slice) → original sliceOffset
      // so we can map the server's 0-based `item.index` back to the global idx.
      const missOffsets: number[] = []; // which offsets in the slice are misses
      for (let k = 0; k < slice.length; k++) {
        const globalIdx = i + k;
        const sent = slice[k]!;
        const key = cacheKey(videoId, globalIdx, sent.text, lang, voiceId);
        const hit = cacheGet(key);
        if (hit) {
          // Cache HIT — replay immediately without a server request.
          // Stale guard: do NOT write if this session has been evicted.
          if (sm.session !== s || s.stopFlag) return;
          s.translations[globalIdx] = hit.text;
          // Prefer the pre-decoded AudioBuffer stored in the entry; fall back to
          // re-decoding from the b64 bytes (e.g. after a page reload when the
          // AudioBuffer is gone). If neither produces audio, _buffer stays
          // undefined — the playback tick will skip the cue (same as a failed
          // TTS decode).
          if (hit.buffer) {
            s.sentences[globalIdx]!._buffer = hit.buffer;
            this.#onLineDecoded?.(globalIdx);
          } else if (hit.audioB64.length > 0 && s.audioCtx) {
            try {
              const binary = atob(hit.audioB64);
              const bytes = new Uint8Array(binary.length);
              for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              const decoded = await s.audioCtx.decodeAudioData(bytes.buffer.slice(0));
              if (sm.session !== s || s.stopFlag) return; // stale guard after async
              s.sentences[globalIdx]!._buffer = decoded;
              hit.buffer = decoded; // promote into the cache entry for next time
              this.#onLineDecoded?.(globalIdx);
            } catch {
              /* ignore decode failure — _buffer stays undefined */
            }
          }
        } else {
          missOffsets.push(k);
        }
      }

      // If every line was a cache hit, skip the server entirely for this batch.
      if (missOffsets.length === 0) continue;

      // ── Build the server sub-slice (only misses) ──────────────────────────
      const missSlice = missOffsets.map((k) => slice[k]!);
      // Per-line cue slot = gap to the next sentence (fallback cue length), min
      // 0.6s, so the server can speed-fit the dub into the slot (isochrony).
      // Use the global indices so the slot math is correct for the full sentence array.
      const cueDurationsMs = missOffsets.map((k) => {
        const globalIdx = i + k;
        const sent = s.sentences[globalIdx]!;
        const next = s.sentences[globalIdx + 1];
        const slotSec = next ? next.start - sent.start : sent.end - sent.start;
        return Math.round(Math.max(0.6, slotSec) * 1000);
      });
      // Last few already-translated lines for cross-batch continuity (pronouns/terms).
      const priorLines = s.translations
        .slice(Math.max(0, i - 4), i)
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
      const siteHost = currentSiteHost() ?? undefined;

      // ── Retry-boundary fix ────────────────────────────────────────────────
      // batchKey for the current SLICE range (i..sliceEnd).
      // _sentBatchRanges records the requestId used when this range was last sent.
      // On a fresh request the key is absent → generate a new id and record it.
      // On a retry for the SAME range the same id is reused (idempotency).
      //
      // Shifted retry: if a previous batch for a WIDER range [P,Q) partially
      // committed and then failed, the next call to #renderBatch arrives here with
      // a narrower range [i, sliceEnd) that starts at the first MISSING index
      // (not P). The batchKey "i-sliceEnd" differs from "P-sliceEnd", so without
      // the _sentBatchRanges lookup it would generate a NEW requestId — re-billing
      // lines [P..i-1] that the server already committed.
      //
      // The fix: look for any existing _sentBatchRanges entry whose range CONTAINS
      // the current slice [i, sliceEnd) (i.e., parentStart ≤ i && sliceEnd ≤
      // parentEnd). If one exists, try the parent requestId first. The server
      // replays the already-committed result. Then re-examine still-missing lines
      // (cache misses) — if any remain, request ONLY those under a fresh id.
      const batchKey = `${i}-${sliceEnd}`;
      let parentReqId: string | undefined;
      for (const [rangeKey, rid] of s._sentBatchRanges) {
        const dash = rangeKey.indexOf("-");
        if (dash === -1) continue;
        const pStart = parseInt(rangeKey.slice(0, dash), 10);
        const pEnd = parseInt(rangeKey.slice(dash + 1), 10);
        if (pStart <= i && sliceEnd <= pEnd) {
          parentReqId = rid;
          break;
        }
      }

      let batchReqId = s._batchRequestIds.get(batchKey);
      if (!batchReqId) {
        // Fresh request: if a parent range exists try its id first (replay).
        batchReqId = parentReqId ?? newRequestId("sf_dub_s");
        s._batchRequestIds.set(batchKey, batchReqId);
      }

      // Record this batch in _sentBatchRanges so future shifted retries can find it.
      s._sentBatchRanges.set(batchKey, batchReqId);

      // ── Inner helper: stream one set of sentences and write results ──────────
      const streamAndWrite = async (
        sentences: typeof missSlice,
        offsets: number[],    // global-index offset for each sentence in the slice
        sliceBase: number,    // i (for batchKey derivation)
        reqId: string,
      ): Promise<"ok" | "already_processed" | "stale"> => {
        const cueDurs = offsets.map((k) => {
          const globalIdx = sliceBase + k;
          const sent = s.sentences[globalIdx]!;
          const next = s.sentences[globalIdx + 1];
          const slotSec = next ? next.start - sent.start : sent.end - sent.start;
          return Math.round(Math.max(0.6, slotSec) * 1000);
        });
        const prior = s.translations
          .slice(Math.max(0, sliceBase - 4), sliceBase)
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0);

        for await (const item of renderSubtitleDubStream({
          apiBase: sm.apiBase,
          bearer: s.apiBearer,
          sentences,
          targetLanguage: lang,
          voiceId,
          cueDurationsMs: cueDurs,
          priorLines: prior,
          sessionId: `sf_${s.token}`,
          siteHost,
          videoTitle: s.videoTitle,
          requestId: reqId,
          signal: s.abortController.signal,
        })) {
          if (sm.session !== s || s.stopFlag) return "stale";

          if (item === ALREADY_PROCESSED) {
            return "already_processed";
          }

          const missK = offsets[item.index];
          if (missK === undefined) continue;
          const globalIdx = sliceBase + missK;
          s.translations[globalIdx] = item.text;

          let decoded: AudioBuffer | undefined;
          if (item.audioMp3.byteLength > 0 && s.audioCtx) {
            try {
              decoded = await s.audioCtx.decodeAudioData(item.audioMp3.slice(0));
            } catch {
              /* ignore decode failure */
            }
          }

          if (sm.session !== s || s.stopFlag) return "stale";

          if (decoded) {
            s.sentences[globalIdx]!._buffer = decoded;
            // C1: notify the startup path that a line has been decoded.
            this.#onLineDecoded?.(globalIdx);
          }

          const sent = s.sentences[globalIdx]!;
          const key = cacheKey(videoId, globalIdx, sent.text, lang, voiceId);
          let audioB64 = "";
          if (item.audioMp3.byteLength > 0) {
            try {
              const bytes = new Uint8Array(item.audioMp3);
              let bin = "";
              for (let j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]!);
              audioB64 = btoa(bin);
            } catch { /* ignore */ }
          }
          cacheSet(key, { audioB64, text: item.text, ts: Date.now(), buffer: decoded });
        }
        return "ok";
      };

      // E-4: pass abortController.signal on EVERY batch so Stop halts server synthesis.
      // E-5: populate s.sentences[idx]._buffer in STRICT index order as lines arrive.

      // First attempt: send with batchReqId (possibly the parent requestId for
      // a retry-boundary scenario, or a fresh id for a new request).
      const result = await streamAndWrite(missSlice, missOffsets, i, batchReqId);

      if (result === "stale") return;

      if (result === "already_processed") {
        // Server replayed the original batch. Check which lines are STILL missing
        // (cache misses + no translation yet) — these are lines the server committed
        // but we never received in the original request.
        const stillMissingOffsets = missOffsets.filter((k) => {
          const globalIdx = i + k;
          return !s.translations[globalIdx] || !s.sentences[globalIdx]?._buffer;
        });
        if (stillMissingOffsets.length > 0) {
          // Re-request ONLY the unreceived lines under a FRESH requestId so we
          // pay only for what we never got, not the whole shifted tail.
          const freshId = newRequestId("sf_dub_retry");
          const freshSlice = stillMissingOffsets.map((k) => slice[k]!);
          const freshResult = await streamAndWrite(freshSlice, stillMissingOffsets, i, freshId);
          if (freshResult === "stale") return;
          // Record the fresh id for this range in case of further retries.
          s._sentBatchRanges.set(batchKey, freshId);
        }
        // Regardless of whether we had to re-request, the original batch is done.
        s._batchRequestIds.delete(batchKey);
        // already_processed is a terminal success for the outer for-loop; continue
        // to the next slice (not return) so sibling slices still render.
        continue;
      }

      // Batch completed successfully — clear its requestId so a future seek to
      // this range gets a fresh id (re-render is a distinct request).
      s._batchRequestIds.delete(batchKey);
      s._sentBatchRanges.delete(batchKey);
    }
  }

  /**
   * Wrapper around #renderBatch that calls `onFirstDecoded` the first time
   * sentences[startIdx]._buffer becomes defined (C1). This allows the start/restart
   * paths to release video.play() as soon as line 0 is decoded rather than
   * waiting for the whole batch to finish.
   *
   * Uses #onLineDecoded (a pipeline-level callback field) to get notified
   * synchronously within the same microtask that #renderBatch sets `_buffer`,
   * without any polling or timers. Safe: #onLineDecoded is set back to undefined
   * before this method returns.
   *
   * If the batch completes without any audio for startIdx (empty MP3 / TTS
   * failure), the notification fires on batch completion so callers are never
   * left hanging.
   */
  async #renderBatchNotifyFirst(
    s: SubtitleFirstSession,
    startIdx: number,
    endIdx: number,
    onFirstDecoded: () => void,
  ): Promise<void> {
    let notified = false;
    const notifyOnce = () => {
      if (!notified) {
        notified = true;
        onFirstDecoded();
      }
    };

    // Install the per-line callback to fire as soon as startIdx's buffer is set.
    // We chain with any existing callback (shouldn't happen, but be safe).
    const prevCallback = this.#onLineDecoded;
    this.#onLineDecoded = (globalIdx: number) => {
      prevCallback?.(globalIdx);
      if (globalIdx === startIdx) {
        notifyOnce();
      }
    };

    try {
      await this.#renderBatch(s, startIdx, endIdx);
    } finally {
      // Restore the previous callback and ensure notification fires.
      this.#onLineDecoded = prevCallback;
      // If line 0 produced no audio (empty/failed TTS), notify now so the
      // caller is not left hanging — it will release play (with no dub for
      // line 0, which is the same as the old behavior).
      notifyOnce();
    }
  }

  /**
   * Contiguous-fold helper (C2): while a range in _resolvedAhead starts exactly
   * at renderCursor, advance renderCursor to that range's end and remove it.
   *
   * This replaces the old `renderCursor = Math.max(renderCursor, flushEnd)` which
   * could jump past a still-pending lower range (the lost-dub bug).
   */
  #foldResolvedAhead(s: SubtitleFirstSession): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const key of s._resolvedAhead) {
        const dash = key.indexOf("-");
        if (dash === -1) continue;
        const rangeStart = parseInt(key.slice(0, dash), 10);
        const rangeEnd = parseInt(key.slice(dash + 1), 10);
        if (rangeStart === s.renderCursor) {
          s.renderCursor = rangeEnd;
          s._resolvedAhead.delete(key);
          changed = true;
          break; // restart the loop after mutation
        }
      }
    }
  }

  /**
   * Compute how many seconds of decoded audio coverage exist ahead of the
   * playhead, starting from the first unplayed cue (C4 decoded-lead scan).
   *
   * Scan rules (critical — critic C2-3):
   *   - Count (end - start) for sentence[i] when:
   *       • sentences[i]._buffer !== undefined  (actually decoded), OR
   *       • _buffer === undefined AND i < renderCursor  (rendered-empty/failed —
   *         the driver will skip, not stall, so count it to avoid false stalls)
   *   - STOP at the first i where _buffer === undefined AND i >= renderCursor
   *     (the genuine un-rendered frontier).
   *
   * This ensures one failed line does not collapse lead to 0.
   */
  #decodedLeadSec(s: SubtitleFirstSession, currentTime: number): number {
    let lead = 0;
    const sentences = s.sentences;
    for (let i = 0; i < sentences.length; i++) {
      const sent = sentences[i]!;
      // Skip already-played cues — they don't contribute to future buffer.
      if (sent._played) continue;
      // Only look at cues that are at or after the current time.
      if (sent.end <= currentTime) continue;

      if (sent._buffer !== undefined) {
        // Decoded audio — count it.
        lead += sent.end - Math.max(sent.start, currentTime);
      } else if (i < s.renderCursor) {
        // Rendered-empty or failed — the driver will skip it, so count it
        // as "covered" (does not block playback).
        lead += sent.end - Math.max(sent.start, currentTime);
      } else {
        // Genuine un-rendered frontier — stop here.
        break;
      }
    }
    return lead;
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

  /**
   * The first PLAYABLE cue for time `t` (SOLUTION §3.1). The single source of
   * truth used by start(), restart(), AND #onSeek so the "which line do we start
   * on" decision is identical at all three sites.
   *
   * Selection (in order):
   *   1. The cue COVERING `t` (s.start ≤ t ≤ s.end) when one exists → replay it
   *      from its start so the line the user Started on is never swallowed.
   *   2. Else the first cue with start ≥ t (the next upcoming line).
   *
   * Returns the chosen cue + its index, or `null` when nothing is playable (every
   * cue ends before `t` — Start AFTER the last caption). Never points past the
   * last cue while a playable cue (end ≥ t) still exists.
   */
  #firstPlayableCueAt(
    s: SubtitleFirstSession,
    t: number,
  ): { index: number; cue: (typeof s.sentences)[number] } | null {
    const sentences = s.sentences;
    for (let i = 0; i < sentences.length; i++) {
      const cue = sentences[i]!;
      // (1) Covering cue — t falls inside [start, end]. Replay from its start.
      if (cue.start <= t && t <= cue.end) return { index: i, cue };
      // (2) First cue that starts at or after t (no covering cue exists before it,
      //     since the loop is in start order and covering cues are caught above).
      if (cue.start >= t) return { index: i, cue };
    }
    // Every cue ends before t → nothing playable (Started past the last caption).
    return null;
  }

  /** System-buffer micro-pause: held as the controller's 'system-buffer' reason.
   *  The controller sets its synchronous #selfIssued flag before video.pause() so
   *  the DOM "pause" event no-ops the onPause handler (replaces _systemPaused). */
  #enterSystemPause(s: SubtitleFirstSession): void {
    // Idempotent: already waiting on this reason → just refresh the cap timer.
    s._bufferWaitStartedAt = performance.now();
    // C2: emit "buffering" overlay state so the branded spinner is shown during
    // the micro-pause (matches the clock-RUNNING branch in overlay.ts).
    this.app.overlay.setOverlayState("buffering");
    this.app.overlay.setStatusText(STATUS_BUFFERING);
    this.app.lifecycle.pause("system-buffer");
  }

  /** Resume from the system-buffer micro-pause: pop the reason (controller plays
   *  the video iff no other reason — e.g. a concurrent user pause — is held),
   *  clear the cap timer, restore status. */
  #resumeSystemPause(s: SubtitleFirstSession): void {
    s._bufferWaitStartedAt = undefined;
    // C2: restore "live" state when the micro-pause ends.
    this.app.overlay.setOverlayState("live");
    this.app.overlay.setStatusText("Translating");
    void this.app.lifecycle.resume("system-buffer");
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
    if (sm.session !== s || s.stopFlag) {
      // Superseded/stopped session — SELF-TERMINATE this driver's interval so a
      // timer leaked by a stop->start churn (set on a session that was then
      // superseded mid-restart) can't keep firing every 250ms forever (RC5,
      // single-driver invariant). Covers every leaked-timer path in one place.
      if (s.playbackTimer) {
        clearInterval(s.playbackTimer);
        s.playbackTimer = null;
      }
      return;
    }
    const video = this.app.capture.videoEl;
    if (!video) return;
    if (!s.audioCtx || s.audioCtx.state === "closed") return;
    if (!s.outputGain) return;

    // ── Step 1: SYSTEM-PAUSE RESUME CHECK ──────────────────────────────────
    // Runs BEFORE the external-pause guard so the tick can resume the video
    // the moment the buffer is ready (≤250ms latency — no separate waiter).
    // The micro-pause is the controller's 'system-buffer' reason (was _systemPaused).
    // `justResumedSystemBuffer` records whether THIS tick popped the system-buffer
    // reason — in that case video.paused may still read true for a beat while the
    // controller's play() promise resolves, yet we MUST fall through and start the
    // cue (Stage-D lock step). The autoplay-block guard below uses it to tell that
    // legitimate fall-through apart from a genuinely frozen video.
    let justResumedSystemBuffer = false;
    const wasSystemPaused = this.app.lifecycle.isPausedFor("system-buffer");
    if (wasSystemPaused) {
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
      // (If we early-returned above, the reason is still held → this is false.)
      justResumedSystemBuffer = !this.app.lifecycle.isPausedFor("system-buffer");
    }

    // ── Step 2: EXTERNAL pause (user) — idle on canonical effectivePaused flag ──
    // When the user has genuinely paused the source video, stop any in-flight
    // clip so the voice goes silent immediately; next tick picks up naturally.
    // NOTE: the system-buffer micro-pause was already handled in Step 1; it may
    // have left video.paused===true momentarily while the buffer loads. We key
    // off sm.userPaused (= lifecycle.effectivePaused) rather than video.paused so a
    // system-buffer pause never silences the dub prematurely.
    if (sm.userPaused) {
      if (s.currentSource) this.#stopCurrent(s);
      return;
    }

    // ── Step 2b: AUTOPLAY-BLOCK / external freeze guard (Stage D) ───────────
    // The video can be paused with NO pause reason held — e.g. the controller's
    // start/restart play() REJECTED (autoplay-block) so the lock-step did NOT
    // start line-1. Starting a cue now would play the dub OVER a frozen frame
    // (the A/V desync we're avoiding). Idle until the video is actually moving
    // (the user presses play → onPlay → resumeSession; the tick then advances).
    // EXCEPTION: a tick that JUST popped the system-buffer reason this pass —
    // video.paused may still read true for a beat while the play() promise
    // resolves, and we MUST fall through to start the buffered cue in lock-step.
    if (video.paused && !justResumedSystemBuffer) return;

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
    while (due) {
      const dueIdx = s.sentences.indexOf(due);
      // TIME-stale: skip regardless of whether a buffer was decoded. A forward
      // seek can leave earlier cues already buffered (the rolling renderer
      // fetched them before the seek) whose end is now well behind the new
      // playhead — playing such a cue at the wrong video position is the
      // seek-desync bug. The old `while (due && !due._buffer)` guard only skipped
      // UNbuffered stale cues, so a buffered stale one slipped through to
      // #startCue and played out of sync. The time check is buffer-agnostic.
      if (t - due.end > SUBFIRST_DRIFT_SKIP_SEC) {
        due._played = true; // skip — its audio is irrelevant at the new position
        due = this.#sentenceDueAt(s, t);
        continue;
      }
      if (!due._buffer) {
        // No audio decoded for this cue yet. Two sub-cases:
        if (dueIdx < s.renderCursor) {
          // The renderer already PROCESSED this cue but produced no audio
          // (empty/failed MP3) — its _buffer will NEVER arrive. Skip it (this was
          // the live "stuck on Buffering…" hang). NOT applied to buffered cues:
          // a buffered cue with index < renderCursor is the NORMAL ready state.
          due._played = true;
          due = this.#sentenceDueAt(s, t);
          continue;
        }
        // Recent, not-yet-rendered cue → system-pause and wait for the render pump.
        this.#enterSystemPause(s);
        return;
      }
      break; // not stale, buffer ready → start it
    }
    if (!due) return; // nothing playable is due this tick
    // The loop only breaks with a truthy due._buffer (or due === null, handled
    // above); #startCue narrows the optional type for src.buffer.
    this.#startCue(s, due);
  }

  /**
   * Create an AudioBufferSourceNode for `cue`, start it, mark it `_played`, set it
   * as the current source, show its subtitle, and chain its onended into the next
   * tick. Extracted from #playbackTick step-4 (critic GAP-6) so the dub-start
   * lock-step (start()/restart()) can play LINE-1 in the SAME microtask the
   * controller's video.play() promise resolves — never starting audio over a
   * still-frozen video. The 250ms interval + onended chain own line-2+.
   *
   * No-op (returns) when the cue has no decoded _buffer. Safe to call once per
   * cue: the caller (tick loop / lock-step) guarantees a playable buffer; the
   * _played mark preserves the play-once invariant ("dup TTS ở cuối" fix).
   */
  #startCue(s: SubtitleFirstSession, cue: (typeof s.sentences)[number]): void {
    if (!s.audioCtx || s.audioCtx.state === "closed" || !s.outputGain) return;
    const buffer = cue._buffer;
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
    cue._played = true;
    s.currentSource = src;
    const idx = s.sentences.indexOf(cue);
    s.currentPlayingIdx = idx;
    // Show the translated text for THIS cue at the moment its dub starts, so the
    // subtitle and the voice stay in lock-step (no "audio leads text" lag).
    this.#showCue(s, idx);

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
   * Re-anchor the playback driver to the current content `currentTime`. Stage C
   * (ad-end): YouTube uses ONE <video> for ad+content, so when an ad ends the
   * playhead jumps back to the content clock — a single clean re-anchor replays
   * the covering cue and refetches missing buffers. This is the SAME mechanism as
   * a user seek, exposed publicly so the AdWatcher's onAdEnd can call it once
   * AFTER the ad reason has been popped (so the `#onSeek` ad-gate no longer fires).
   */
  reAnchor(s: SubtitleFirstSession, video: HTMLVideoElement): void {
    this.#onSeek(s, video);
  }

  /**
   * Seek handler — resets _played flags for cues at/after the new position so
   * they can replay, rewinds renderCursor so the pump refetches missing buffers,
   * and stops the current source.
   *
   * Stage C: NO-OP while an ad is active. YouTube fires `seeked` on BOTH the
   * ad-in and ad-out boundaries (single <video> swap between ad and content) —
   * those are NOT user seeks; honoring them would reset `_played`/renderCursor
   * against the AD clock and corrupt the bookkeeping. The clean re-anchor against
   * the restored CONTENT time happens once on ad-end via reAnchor() (after the
   * 'ad' reason is popped, so this gate is clear by then).
   */
  #onSeek(s: SubtitleFirstSession, video: HTMLVideoElement): void {
    // Re-seed the AdWatcher FIRST so the ad gate below sees fresh state.
    // reseed() may synchronously fire onAdStart → push the 'ad' reason, making
    // the isPausedFor gate correctly no-op the rest of the seek handler when a
    // seek triggers a mid-roll ad (Fix C, subtitle-first path).
    this.app.ad?.reseed();
    if (this.app.lifecycle.isPausedFor("ad")) return;
    const newT = video.currentTime;
    // The anchor is the cue #firstPlayableCueAt would start on: the cue COVERING
    // newT (start ≤ newT ≤ end) when one exists, else the next cue. (GAP-7) The
    // reset loop MUST key off the ANCHOR cue's start — NOT newT — so that on a
    // mid-cue seek-back the covering cue (whose start is < newT) is itself reset
    // to unplayed and actually replays. Keying off newT would leave the covering
    // cue `_played` and #firstPlayableCueAt would then start on a swallowed line.
    const anchor = this.#firstPlayableCueAt(s, newT);
    if (anchor) {
      const anchorStart = anchor.cue.start;
      // Allow replay of the anchor cue and every cue after it.
      for (const x of s.sentences) {
        if (x.start >= anchorStart) x._played = false;
      }
      // Re-TARGET the render cursor to the seek anchor so the rolling renderer
      // fetches the cues at the NEW position. Must be a plain assignment, NOT
      // Math.min(): on a FORWARD seek anchor.index > renderCursor, so min() is a
      // no-op — the cursor stays at the old (lower) position, the render pump keeps
      // grinding the OLD region and never reaches the seek target, so #playbackTick
      // micro-pauses, hits the 8s stall-cap and skips forward cue-by-cue → the dub
      // goes SILENT ("click sang đoạn khác → không tiếp tục dịch"). Assigning the
      // anchor index re-targets the pump in BOTH directions; for a BACKWARD seek
      // anchor.index ≤ renderCursor so this is identical to the old min(), and the
      // renderer's firstMissing scan still skips cues that already hold a _buffer.
      s.renderCursor = anchor.index;
    }
    // Epoch guard (SOLUTION WS5.6 / S5-F9): bump the epoch so any in-flight
    // rolling-renderer completion can detect that the seek happened and must NOT
    // advance renderCursor past the seek-corrected position.
    s._renderEpoch += 1;
    // Clear in-progress batch ids on seek: the new position constitutes a new
    // range intent; stale ids would match against a different range.
    s._batchRequestIds.clear();
    s._sentBatchRanges.clear();
    // Clear coalescing state on seek — pending lines from the old position are
    // stale; the rolling renderer will re-accumulate from the new anchor.
    s._pendingLines.clear();
    s._pendingFirstQueuedAt = 0;
    // C2: clear pipelined inflight/resolved state on seek — stale completions
    // will check the epoch and no-op; these sets must be empty for the new position.
    s._inflightRanges.clear();
    s._resolvedAhead.clear();
    this.#stopCurrent(s);
    // Play the cue at the new position promptly rather than waiting for the next tick.
    this.#playbackTick(s);
  }

  /** Render the overlay text for a specific cue — called when its dub starts so the
   *  on-screen subtitle matches the voice exactly (driven by playback, not a timer). */
  #showCue(s: SubtitleFirstSession, idx: number): void {
    const { sm, overlay } = this.app;
    // Liveness guard (RC5): never let a superseded/stopped session's driver write
    // the overlay — across a stop->start churn a stale driver could otherwise leave
    // the subtitle frozen on a previous line while the live session moved on
    // ("sub k thay đổi nữa"). The live session is the only one allowed to paint.
    if (sm.session !== s || s.stopFlag) return;
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

  // ── Rolling-renderer constants ──────────────────────────────────────────────
  // C3: coalescing constants are REMOVED from the hot path — the renderer now
  // fetches as soon as lead < BUFFER_AHEAD_TARGET_SEC (from caption-utils.ts),
  // constrained only by MAX_INFLIGHT_BATCHES concurrency cap.
  // These static fields are kept for backward-compatibility with existing tests
  // that reference them directly.
  static readonly COALESCE_MIN_LINES = 3;
  static readonly COALESCE_URGENT_SEC = 8;
  static readonly COALESCE_MAX_AGE_MS = 6000;

  /**
   * Pipelined rolling renderer (C2 + C3 + C4).
   *
   * Replaces the old single-flight mutex (rollingInFlight) with a bounded-
   * concurrency model: up to MAX_INFLIGHT_BATCHES concurrent #renderBatch calls.
   *
   * Per-tick logic:
   *   1. Skip if user-paused (but not system-buffer micro-pause).
   *   2. Compute BUFFER_AHEAD_TARGET_SEC lead via #decodedLeadSec (C4).
   *      — If lead >= target: nothing to do this tick.
   *   3. Compute fetch frontier = max(renderCursor, max-end in _inflightRanges,
   *      max-end in _resolvedAhead). Issue [frontier, min(frontier+BATCH_SIZE, targetIdx))
   *      when: frontier < targetIdx AND _inflightRanges.size < MAX_INFLIGHT_BATCHES.
   *   4. Register the issued range in _inflightRanges (never advance renderCursor
   *      speculatively — that would cause the driver to skip in-flight cues).
   *   5. On completion (epoch-guarded): move range from _inflightRanges to
   *      _resolvedAhead; contiguous-fold _resolvedAhead into renderCursor.
   *
   * C3 coalesce starvation is eliminated: there is no "wait for 3 lines / 6s"
   * gate on the critical path. A single sub-tick debounce (SUBFIRST_RENDER_TICK_MS)
   * prevents issuing many 1-line batches in one tick, but never blocks when lead
   * is below target.
   */
  async #runRollingRenderer(s: SubtitleFirstSession, video: HTMLVideoElement): Promise<void> {
    const { sm } = this.app;
    while (sm.session === s && !s.stopFlag) {
      // Poll on SUBFIRST_RENDER_TICK_MS so the buffer-ahead pump reacts quickly
      // after Start/seek.
      await new Promise((r) => setTimeout(r, SUBFIRST_RENDER_TICK_MS));
      if (sm.session !== s || s.stopFlag) continue;

      // While the user has genuinely paused the video, do NO translate work.
      // IMPORTANT: system-buffer micro-pause must NOT suppress rendering —
      // the buffer must keep filling while video is paused for buffering.
      const isSystemPaused = this.app.lifecycle.isPausedFor("system-buffer");
      if (sm.userPaused || (video.paused && !isSystemPaused)) continue;

      const t = video.currentTime;
      const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
      let targetIdx = s.sentences.findIndex((sent) => sent.start > t + lookaheadSec);
      if (targetIdx === -1) targetIdx = s.sentences.length;

      // C4: compute decoded lead in seconds.
      const lead = this.#decodedLeadSec(s, t);
      const needsFetch = lead < BUFFER_AHEAD_TARGET_SEC;

      // C3: issue fetch immediately when lead is below target (no coalesce withhold).
      // Also ensure we haven't already passed targetIdx.
      if (!needsFetch) {
        // Lead is comfortable — check if there's anything left to render at all.
        // If all lines up to targetIdx are already covered, advance renderCursor.
        if (s._inflightRanges.size === 0 && s._resolvedAhead.size === 0) {
          // Nothing in flight and lead is fine — if renderCursor is behind targetIdx
          // but all lines are decoded, we can advance it.
          let allCovered = true;
          for (let i = s.renderCursor; i < targetIdx; i++) {
            const sent = s.sentences[i]!;
            if (sent._buffer === undefined) { allCovered = false; break; }
          }
          if (allCovered && s.renderCursor < targetIdx) {
            s.renderCursor = targetIdx;
          }
        }
        continue;
      }

      // C2: compute the fetch frontier.
      // frontier = max(renderCursor, max-end over _inflightRanges, max-end over _resolvedAhead).
      let frontier = s.renderCursor;
      for (const key of s._inflightRanges) {
        const dash = key.indexOf("-");
        if (dash === -1) continue;
        const end = parseInt(key.slice(dash + 1), 10);
        if (end > frontier) frontier = end;
      }
      for (const key of s._resolvedAhead) {
        const dash = key.indexOf("-");
        if (dash === -1) continue;
        const end = parseInt(key.slice(dash + 1), 10);
        if (end > frontier) frontier = end;
      }

      // Nothing to fetch beyond target.
      if (frontier >= targetIdx) continue;

      // Cap by in-flight concurrency.
      if (s._inflightRanges.size >= MAX_INFLIGHT_BATCHES) continue;

      // Issue a new batch: [frontier, min(frontier + SUBFIRST_BATCH_SIZE, targetIdx)).
      const fetchStart = frontier;
      const fetchEnd = Math.min(frontier + SUBFIRST_BATCH_SIZE, targetIdx);
      if (fetchEnd <= fetchStart) continue;

      const rangeKey = `${fetchStart}-${fetchEnd}`;
      // Don't issue a range already in flight or already resolved (idempotency).
      if (s._inflightRanges.has(rangeKey) || s._resolvedAhead.has(rangeKey)) continue;

      // Capture epoch before the async call.
      const epochAtStart = s._renderEpoch;
      s._inflightRanges.add(rangeKey);

      // Fire the batch and handle completion asynchronously (pipelining).
      // This is intentionally NOT awaited — the loop re-enters immediately to
      // potentially issue a second batch if inflight < cap.
      void (async () => {
        try {
          await this.#renderBatch(s, fetchStart, fetchEnd);
        } catch {
          // Transient error — swallow so the rolling renderer survives network blips.
          // On the next tick the lead check will re-trigger if still below target.
        } finally {
          if (sm.session !== s || s.stopFlag) {
            // Session evicted — clean up the range key silently.
            s._inflightRanges.delete(rangeKey);
            return;
          }
          // Epoch guard (C2): if a seek happened, discard and touch nothing.
          if (s._renderEpoch !== epochAtStart) {
            s._inflightRanges.delete(rangeKey);
            // _inflightRanges and _resolvedAhead were already cleared by #onSeek.
            return;
          }
          // Move range from inflight → resolvedAhead, then contiguous-fold.
          s._inflightRanges.delete(rangeKey);
          s._resolvedAhead.add(rangeKey);
          this.#foldResolvedAhead(s);
        }
      })();

      // Immediately re-check whether another batch can be issued this tick
      // (concurrent issuance within the same while-loop iteration).
      // The while loop will re-evaluate on the NEXT tick (after the await sleep).
      // To allow multiple concurrent issues per tick when lead is very low, we
      // do a tight loop here — but only up to MAX_INFLIGHT_BATCHES total.
      // After issuing one batch, re-check frontier and issue more if warranted.
      // (The loop above does this naturally since we don't await the batch.)
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
