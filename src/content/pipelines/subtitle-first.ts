// ────────────────────────────────────────────────────────────────────────────
// SubtitleFirstPipeline — the DEFAULT non-live Standard path: pre-fetch the YT
// caption track, batch-translate through Gemini, render MiniMax TTS in rolling
// waves, and schedule playback at exact caption timestamps (zero chase delay).
// Falls back to the chunked pipeline when no captions are available — the
// removeOverlay-nulls-root ordering in that fallback is load-bearing. Uses the
// IDENTITY guard (sm.isIdentityStale). (legacy/content.js: batchTranslateSubtitles
// 1671, renderTTSForSentence 1724, startSubtitleFirstSession 1744, translateBatch
// 1950, renderWaveTTS 1962, scheduleWindow 1990, scheduleAroundPlayhead 2011,
// cancelPendingSources 2027, updateLiveDisplay 2035, runRollingRenderer 2052.)
// ────────────────────────────────────────────────────────────────────────────

import { LANG_NAME, STANDARD_DEFAULT_VOICE } from "@/shared/constants";
import { STYLE_PROMPTS } from "@/shared/advanced";
import { parseKymaError, type ParsedKymaError } from "@/lib/kyma";
import { parseServerError } from "@/lib/server-errors";
import { computeGain } from "@/lib/audio";
import { regroupToSentences } from "@/lib/caption";
import type { Ack } from "@/shared/protocol";
import type { SubtitleFirstSession } from "../session-manager";
import type { ContentApp } from "../index";
import { fetchYouTubeCaptions, getYouTubeVideoId } from "./captions";

/** Path for the chat-completions endpoint by world.
 *  • byok  → `/chat/completions` (Kyma OpenAI-shape)
 *  • proxy → `/proxy/chat/completions` (Echoly server's metered shim — same shape)
 *  TODO: port proxy path to `/v1/chat` (zod schema-based) in a follow-up wave. */
function chatPath(apiMode: string | null | undefined): string {
  return apiMode === "proxy" ? "/proxy/chat/completions" : "/chat/completions";
}

/** Path for the TTS endpoint by world (same pattern as standard-chunked). */
function speechPath(apiMode: string | null | undefined): string {
  return apiMode === "proxy" ? "/proxy/audio/speech" : "/audio/speech";
}

/** Adapt server Response → ParsedKymaError so the toast surface is uniform. */
async function parsedFromServerError(res: Response): Promise<ParsedKymaError> {
  const parsed = await parseServerError(res);
  return {
    user: parsed.user,
    ...(parsed.cta ? { cta: parsed.cta } : {}),
    ...(parsed.ctaLabel ? { ctaLabel: parsed.ctaLabel } : {}),
  };
}

const SUBFIRST_BATCH_SIZE = 10; // sentences per translate request
const SUBFIRST_LOOKAHEAD_MS = 30_000; // render this far ahead of playhead
const SUBFIRST_RENDER_CONCURRENCY = 5; // parallel TTS workers

export class SubtitleFirstPipeline {
  constructor(private readonly app: ContentApp) {}

  async startSubtitleFirstSession(): Promise<Ack> {
    const { sm, capture, overlay } = this.app;
    const settings = sm.settings!;
    const video = capture.findVideo();
    if (!video) return { ok: false, error: "No video on this page." };
    capture.videoEl = video;
    capture.bindVolumeDriftGuard(video);

    const videoId = getYouTubeVideoId();
    if (!videoId)
      return { ok: false, error: "Could not detect YouTube video id." };

    overlay.buildOverlay(
      this.app.callbacks,
      settings.advanced?.captionPosition ?? null,
    );
    capture.bindRateChangeWarn(video);
    overlay.setStatusText("Loading captions");
    overlay.setOverlayState("connecting");

    let audioCtx: AudioContext;
    let outputGain: GainNode;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new Ctor();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      outputGain = audioCtx.createGain();
      outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
      outputGain.connect(audioCtx.destination);
    } catch (err) {
      overlay.removeOverlay();
      return {
        ok: false,
        error: "AudioContext unavailable: " + (err as Error).message,
      };
    }

    const token = sm.nextToken();
    const abortController = new AbortController();
    const newSession: SubtitleFirstSession = {
      token,
      type: "subtitle-first",
      audioCtx,
      outputGain,
      stream: null,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      abortController,
      sentences: [],
      translations: [],
      pendingSources: [],
      audioOffset: 0,
      renderCursor: 0,
      stopFlag: false,
      _onSeeked: null,
    };
    sm.session = newSession;

    // Remember play state so we can restore it on any failure below.
    const wasPlaying = !video.paused;
    newSession.wasPlaying = wasPlaying;
    const restorePlay = (): void => {
      if (wasPlaying && video.paused) {
        try {
          video.play().catch(() => {});
        } catch {
          /* ignore */
        }
      }
    };

    // Pause video while we fetch+translate+render the first ~30s of dub.
    try {
      video.pause();
    } catch {
      /* ignore */
    }

    let captionResult;
    try {
      captionResult = await fetchYouTubeCaptions(
        videoId,
        settings.targetLanguage,
        abortController.signal,
      );
    } catch {
      captionResult = null;
    }
    if (token !== sm.pageToken || newSession.stopFlag) {
      try {
        audioCtx.close();
      } catch {
        /* ignore */
      }
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    if (!captionResult || captionResult.captions.length === 0) {
      // No CC — drop subtitle-first, fall back to live chunked. Tear down the
      // audio context BEFORE handing off, but do NOT removeOverlay first
      // (removeOverlay sets root=null → the fallback toast would no-op). Let
      // startStandardSession rebuild the overlay, then surface the toast.
      try {
        audioCtx.close();
      } catch {
        /* ignore */
      }
      sm.session = null;
      sm.pageToken += 1; // invalidate the subtitle-first token before standard
      overlay.removeOverlay();
      const result = await this.app.standard.startStandardSession();
      if (result?.ok) {
        // startStandardSession rebuilt the overlay — toast lands on it. Its
        // captureWithRetry calls video.play() internally, so no restorePlay.
        overlay.showToast(
          "No captions for this video — using live mode (~5s lag)",
          5000,
        );
      } else {
        restorePlay();
      }
      return result;
    }

    const sentences = regroupToSentences(captionResult.captions);
    newSession.sentences = sentences;
    newSession.translations = new Array<string | undefined>(sentences.length);
    overlay.setStatusText(`Translating ${sentences.length} lines`);

    // First wave covers 2 sentences starting from the current PLAYHEAD (not
    // index 0 — otherwise mid-video Start renders already-past cues that
    // scheduleWindow skips). Cap of 2 (SF6) keeps the await chain under
    // Chrome's transient-activation window so video.play() isn't blocked.
    const currentTime = video.currentTime;
    const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
    let firstWaveStart = sentences.findIndex((s) => s.start >= currentTime);
    if (firstWaveStart === -1) firstWaveStart = sentences.length;
    let lookaheadEnd = sentences.findIndex(
      (s) => s.start > currentTime + lookaheadSec,
    );
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + 2);
    if (firstWaveEnd <= firstWaveStart && firstWaveStart < sentences.length) {
      firstWaveEnd = firstWaveStart + 1;
    }

    try {
      await this.translateBatch(newSession, firstWaveStart, firstWaveEnd);
    } catch (err) {
      if (token !== sm.pageToken || newSession.stopFlag) {
        try {
          audioCtx.close();
        } catch {
          /* ignore */
        }
        restorePlay();
        return { ok: false, error: "Cancelled." };
      }
      sm.session = null;
      try {
        audioCtx.close();
      } catch {
        /* ignore */
      }
      overlay.removeOverlay();
      restorePlay();
      const e = err as ParsedKymaError | Error;
      const msg =
        (e as ParsedKymaError).user || String((e as Error)?.message || e);
      return { ok: false, error: msg };
    }
    if (token !== sm.pageToken || newSession.stopFlag) {
      try {
        audioCtx.close();
      } catch {
        /* ignore */
      }
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    overlay.setStatusText("Preparing voices");
    await this.renderWaveTTS(newSession, firstWaveStart, firstWaveEnd);
    if (token !== sm.pageToken || newSession.stopFlag) {
      try {
        audioCtx.close();
      } catch {
        /* ignore */
      }
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    newSession.audioOffset = audioCtx.currentTime - video.currentTime;
    this.scheduleWindow(newSession, firstWaveStart, firstWaveEnd);
    newSession.renderCursor = firstWaveEnd;

    overlay.setStatusText("Translating");
    overlay.setOverlayState("live");
    capture.applyVolumes(settings.originalVolume, settings.voiceVolume);
    this.app.applySourceVisibility();
    this.app.startSessionTimer();

    const onYTSeeked = (): void => {
      this.cancelPendingSources(newSession);
      newSession.audioOffset = audioCtx.currentTime - video.currentTime;
      this.scheduleAroundPlayhead(newSession);
    };
    this.app.bindCommonVideoListeners(video, newSession, {
      onPlayExtra: () => {
        newSession.audioOffset = audioCtx.currentTime - video.currentTime;
      },
      onSeeked: onYTSeeked,
    });
    newSession._onSeeked = onYTSeeked;

    try {
      await video.play();
    } catch {
      /* autoplay blocked — user can click play */
    }
    void this.runRollingRenderer(newSession);
    sm.emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  /** Strict-JSON batch translate. output[i] maps to input[i]; unmapped slots
   *  fall back to the source so the timestamp isn't silent. (legacy
   *  batchTranslateSubtitles.) Throws a ParsedKymaError on non-OK. */
  private async batchTranslateSubtitles(
    sentences: { text: string }[],
    langName: string,
    kymaKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const { sm } = this.app;
    const items = sentences.map((s) => s.text);
    const stylePrefix =
      STYLE_PROMPTS[sm.settings?.advanced?.translationStyle ?? "natural"];
    const prompt =
      `${stylePrefix}` +
      `Translate these ${items.length} subtitle lines to ${langName}. ` +
      `Return ONLY a JSON object {"lines": [...]} with exactly ${items.length} ` +
      `strings in the same order. Preserve names, brand names, and technical ` +
      `terms verbatim. No commentary.\n\n` +
      `Each translated line should be CONCISE — prefer shorter natural ` +
      `phrasing over literal word-for-word, so the dub fits the same time ` +
      `slot as the original cue.\n\n` +
      `Input: ${JSON.stringify(items)}`;
    const isProxy = sm.settings?.apiMode === "proxy";
    const res = await fetch(`${sm.apiBase}${chatPath(sm.settings?.apiMode)}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + kymaKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You translate subtitles for live dubbing. Output strict JSON only.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!res.ok) {
      if (isProxy) throw await parsedFromServerError(res);
      const txt = await res.text().catch(() => "");
      throw parseKymaError(res.status, txt);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json?.choices?.[0]?.message?.content || "";
    let translations: unknown = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      translations = Array.isArray(parsed)
        ? parsed
        : (parsed as Record<string, unknown>).lines ||
          (parsed as Record<string, unknown>).translations ||
          (parsed as Record<string, unknown>).items ||
          Object.values(parsed as Record<string, unknown>)[0];
    } catch {
      translations = raw
        .split("\n")
        .map((s) => s.replace(/^\s*[-*\d.]+\s*/, "").trim())
        .filter(Boolean);
    }
    const list = Array.isArray(translations) ? (translations as unknown[]) : [];
    return items.map((src, i) => {
      const tr = list[i];
      return typeof tr === "string" && tr.trim() ? tr.trim() : src;
    });
  }

  private async renderTTSForSentence(
    text: string,
    voiceId: string,
    kymaKey: string,
    audioCtx: AudioContext,
    signal: AbortSignal,
  ): Promise<AudioBuffer> {
    const { sm } = this.app;
    const isProxy = sm.settings?.apiMode === "proxy";
    const res = await fetch(`${sm.apiBase}${speechPath(sm.settings?.apiMode)}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + kymaKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "minimax-speech-turbo",
        input: text,
        voice_id: voiceId,
        response_format: "mp3",
      }),
      signal,
    });
    if (!res.ok) {
      if (isProxy) throw await parsedFromServerError(res);
      const txt = await res.text().catch(() => "");
      throw parseKymaError(res.status, txt);
    }
    const arrayBuf = await res.arrayBuffer();
    return audioCtx.decodeAudioData(arrayBuf);
  }

  private async translateBatch(
    s: SubtitleFirstSession,
    startIdx: number,
    endIdx: number,
  ): Promise<void> {
    const { sm } = this.app;
    const settings = sm.settings!;
    const langName = LANG_NAME[settings.targetLanguage] || "Vietnamese";
    for (let i = startIdx; i < endIdx; i += SUBFIRST_BATCH_SIZE) {
      if (sm.isIdentityStale(s)) return;
      const sliceEnd = Math.min(i + SUBFIRST_BATCH_SIZE, endIdx);
      const slice = s.sentences.slice(i, sliceEnd);
      const translations = await this.batchTranslateSubtitles(
        slice,
        langName,
        s.kymaKey,
        s.abortController.signal,
      );
      if (sm.isIdentityStale(s)) return;
      for (let j = 0; j < translations.length; j++)
        s.translations[i + j] = translations[j];
    }
  }

  private async renderWaveTTS(
    s: SubtitleFirstSession,
    startIdx: number,
    endIdx: number,
  ): Promise<void> {
    const { sm } = this.app;
    const settings = sm.settings!;
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const queue: number[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      if (s.sentences[i]?._buffer) continue;
      if (!s.translations[i]) continue;
      queue.push(i);
    }
    let cursor = 0;
    const workers = Array.from(
      { length: SUBFIRST_RENDER_CONCURRENCY },
      async () => {
        while (cursor < queue.length) {
          if (sm.isIdentityStale(s)) return;
          const idx = queue[cursor++]!;
          try {
            const buf = await this.renderTTSForSentence(
              s.translations[idx]!,
              voiceId,
              s.kymaKey,
              s.audioCtx!,
              s.abortController.signal,
            );
            if (sm.isIdentityStale(s)) return;
            const sent = s.sentences[idx];
            if (sent) sent._buffer = buf;
          } catch {
            // Individual TTS failure leaves that sentence silent; rest plays.
          }
        }
      },
    );
    await Promise.all(workers);
  }

  private scheduleWindow(
    s: SubtitleFirstSession,
    startIdx: number,
    endIdx: number,
  ): void {
    const { sm } = this.app;
    if (s !== sm.session || !s.audioCtx) return;
    const now = s.audioCtx.currentTime;
    for (let i = startIdx; i < endIdx; i++) {
      const sent = s.sentences[i];
      const buf = sent?._buffer;
      if (!buf) continue;
      const at = s.audioOffset + sent!.start;
      // Already drifted >0.5s past this cue's start — skip rather than clash.
      if (at < now - 0.5) continue;
      const src = s.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(s.outputGain!);
      try {
        src.start(Math.max(at, now + 0.02));
      } catch {
        continue;
      }
      (src as AudioBufferSourceNode & { _sentenceIdx?: number })._sentenceIdx =
        i;
      s.pendingSources.push(src);
    }
    this.updateLiveDisplay(s);
  }

  private scheduleAroundPlayhead(s: SubtitleFirstSession): void {
    const { capture } = this.app;
    const video = capture.videoEl;
    if (!video) return;
    const t = video.currentTime;
    const start = s.sentences.findIndex((sent) => sent.end >= t);
    if (start === -1) return;
    const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
    let end = s.sentences.findIndex((sent) => sent.start > t + lookaheadSec);
    if (end === -1) end = s.sentences.length;
    // Do NOT advance renderCursor — let the rolling renderer pick up the gap.
    this.scheduleWindow(s, start, end);
    if (start < s.renderCursor) s.renderCursor = start;
  }

  cancelPendingSources(s: SubtitleFirstSession): void {
    for (const src of s.pendingSources) {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    s.pendingSources = [];
  }

  private updateLiveDisplay(s: SubtitleFirstSession): void {
    const { sm, capture, overlay } = this.app;
    const video = capture.videoEl;
    if (!video || !overlay.isMounted()) return;
    const t = video.currentTime;
    const idx = s.sentences.findIndex(
      (sent) => sent.start <= t && sent.end >= t,
    );
    if (idx === -1) return;
    const translated = s.translations[idx];
    const source = s.sentences[idx]!.text;
    if (translated) {
      sm.currentTargetText = translated;
      overlay.setTargetText(translated);
    }
    sm.currentSourceText = source;
    if (sm.settings?.showSource) {
      overlay.setSourceText(source.slice(-220));
    }
  }

  private async runRollingRenderer(s: SubtitleFirstSession): Promise<void> {
    const { sm, capture } = this.app;
    while (s === sm.session && !s.stopFlag) {
      await new Promise((r) => setTimeout(r, 1000));
      if (s !== sm.session || s.stopFlag) continue;
      const video = capture.videoEl;
      if (!video) continue;
      const t = video.currentTime;
      const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
      let targetIdx = s.sentences.findIndex(
        (sent) => sent.start > t + lookaheadSec,
      );
      if (targetIdx === -1) targetIdx = s.sentences.length;
      if (targetIdx <= s.renderCursor) {
        this.updateLiveDisplay(s);
        continue;
      }
      const start = s.renderCursor;
      const end = targetIdx;
      try {
        const firstUntranslated = s.translations.findIndex(
          (v, i) => i >= start && i < end && !v,
        );
        if (firstUntranslated !== -1) {
          await this.translateBatch(s, firstUntranslated, end);
        }
        if (s !== sm.session || s.stopFlag) return;
        await this.renderWaveTTS(s, start, end);
        if (s !== sm.session || s.stopFlag) return;
        this.scheduleWindow(s, start, end);
        s.renderCursor = end;
        this.updateLiveDisplay(s);
      } catch {
        // Background renderer never crashes the session; next tick retries.
      }
    }
  }
}
