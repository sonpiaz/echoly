// Subtitle-first Standard (YouTube VOD) — CC → POST /v1/translate/subtitles → display-anchored dub.
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
  getYouTubeVideoId,
  regroupToSentences,
  SUBFIRST_BATCH_SIZE,
  SUBFIRST_LOOKAHEAD_MS,
} from "@/lib/youtube-captions";
import type { SubtitleFirstSession } from "../session-manager";
import type { ContentApp } from "../index";
import { fetchYouTubeCaptions } from "./youtube-captions-fetch";
import { TOAST_NO_CC_FALLBACK, TOAST_PRESS_PLAY } from "@/shared/product-copy";

// Start a cue's dub up to this many seconds before its caption start.
const SUBFIRST_DUE_AHEAD_SEC = 0.15;
// If the video is already this far past a cue's end, skip it (re-sync) instead of
// playing it late. Bounds how far the dub can drift behind on dense captions.
const SUBFIRST_DRIFT_SKIP_SEC = 3;

export class SubtitleFirstPipeline {
  constructor(private readonly app: ContentApp) {}

  async start(incomingSettings: StartSettings): Promise<{ ok: boolean; error?: string }> {
    const { sm, capture, overlay } = this.app;
    const video = capture.findVideo();
    if (!video) return { ok: false, error: "No playable video on this page." };

    const videoId = getYouTubeVideoId();
    if (!videoId) return { ok: false, error: "Could not detect YouTube video id." };

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
      captionResult = await fetchYouTubeCaptions(
        videoId,
        sm.settings.targetLanguage,
        abortController.signal,
      );
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
      const result = await this.app.startWebRtcStandard(incomingSettings);
      if (result.ok) {
        overlay.showToast(TOAST_NO_CC_FALLBACK, 5000);
      } else {
        restorePlay();
      }
      return result;
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
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + 2);
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
   * Play the next due cue's dub IN FULL, one at a time. Never interrupts a clip
   * that is already playing (completeness over tight sync — no truncation, so no
   * swallowed words). Cues the video has run > SUBFIRST_DRIFT_SKIP_SEC past are
   * skipped so the dub re-syncs at the next gap. Driven by the 250ms interval and
   * by each clip's onended (back-to-back, no wait).
   */
  #playbackTick(s: SubtitleFirstSession): void {
    const { sm } = this.app;
    if (sm.session !== s || s.stopFlag) return;
    const video = this.app.capture.videoEl;
    if (!video) return;
    if (!s.audioCtx || s.audioCtx.state === "closed") return;
    if (!s.outputGain) return;
    // Pausing the video pauses the dub: stop the in-flight clip so the voice goes
    // silent immediately. On resume the next cue (by video time) picks up naturally.
    if (video.paused) {
      if (s.currentSource) this.#stopCurrent(s);
      return;
    }
    // Chrome auto-suspends the AudioContext when the tab is backgrounded. Starting a
    // clip on a suspended context schedules silently and would wedge the chain
    // (cue marked played + currentSource set, but no audio). Resume and retry next tick.
    if (s.audioCtx.state === "suspended") {
      s.audioCtx.resume().catch(() => {});
      return;
    }
    // Never interrupt a playing dub — let each cue finish; its onended drives the next.
    if (s.currentSource) return;

    const t = video.currentTime;

    // Walk to the earliest unplayed cue and decide: wait, skip, or play.
    for (let i = 0; i < s.sentences.length; i++) {
      const sent = s.sentences[i]!;
      if (sent._played) continue;
      // Earliest unplayed cue hasn't started yet → nothing to play this tick.
      if (sent.start > t + SUBFIRST_DUE_AHEAD_SEC) return;
      // Video has run well past this cue → skip it (re-sync) rather than play it late.
      if (t - sent.end > SUBFIRST_DRIFT_SKIP_SEC) {
        sent._played = true;
        continue;
      }
      // Due and in-window but not decoded yet → wait for the render pump (don't skip).
      if (!sent._buffer) return;

      const src = s.audioCtx.createBufferSource();
      src.buffer = sent._buffer;
      src.connect(s.outputGain);
      try {
        // Full clip — no duration cap, so the tail (final characters) is never cut.
        src.start(s.audioCtx.currentTime);
      } catch {
        // AudioContext may have been closed in a race — bail silently.
        return;
      }

      sent._played = true;
      s.currentSource = src;
      s.currentPlayingIdx = i;
      // Show the translated text for THIS cue at the moment its dub starts, so the
      // subtitle and the voice stay in lock-step (no "audio leads text" lag).
      this.#showCue(s, i);

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
      return;
    }
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
      // While the user has paused the video, do NO translate/display work
      // — otherwise the dub keeps being produced and the UI looks like it is still
      // translating even though playback is suspended.
      if (sm.videoPaused || video.paused) continue;

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
