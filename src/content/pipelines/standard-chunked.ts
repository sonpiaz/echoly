// ────────────────────────────────────────────────────────────────────────────
// StandardChunkedPipeline — the chunked STT→translate→TTS path (Gemini
// /audio/understand "translate-in-one" + MiniMax /audio/speech). Self-contained
// MediaRecorder windows; each chunk independently calls Kyma. The whole session
// shares ONE AbortController so Stop cancels in-flight fetches (no burned
// credits). processStandardChunk re-checks the identity guard AFTER EVERY await.
// (legacy/content.js: startStandardSession 1011, pickRecorderMime 1103,
// webmBlobToWav 1117, runChunkLoop 1188, processStandardChunk 1230.)
// ────────────────────────────────────────────────────────────────────────────

import {
  LANG_NAME,
  STANDARD_CHUNK_MS,
  STANDARD_DEFAULT_VOICE,
  STANDARD_MIN_CHUNK_BYTES,
  STANDARD_RECORDER_MIMES,
} from "@/shared/constants";
import { parseKymaError, type ParsedKymaError } from "@/lib/kyma";
import { audioBufferToWavBlob, computeGain } from "@/lib/audio";
import type { Ack } from "@/shared/protocol";
import type { StandardSession } from "../session-manager";
import type { ContentApp } from "../index";

export class StandardChunkedPipeline {
  constructor(private readonly app: ContentApp) {}

  /** Build + run a standard chunked session. Returns the START ack. (legacy.) */
  async startStandardSession(): Promise<Ack> {
    const { sm, capture, overlay } = this.app;
    const settings = sm.settings!;
    const video = capture.findVideo();
    if (!video) return { ok: false, error: "No YouTube video on this page." };
    capture.videoEl = video;
    capture.bindVolumeDriftGuard(video);

    let stream: MediaStream;
    try {
      overlay.buildOverlay(this.app.callbacks);
      capture.bindRateChangeWarn(video);
      overlay.setStatusText("Acquiring audio");
      stream = await capture.captureWithRetry(video);
    } catch (err) {
      overlay.removeOverlay();
      return { ok: false, error: (err as Error).message };
    }

    const recorderMime = this.pickRecorderMime();
    if (!recorderMime) {
      stream.getTracks().forEach((t) => t.stop());
      overlay.removeOverlay();
      return {
        ok: false,
        error: "Browser cannot record audio for chunked pipeline.",
      };
    }

    const graph = this.createGraph(settings.voiceVolume ?? 100);
    if (!graph) {
      stream.getTracks().forEach((t) => t.stop());
      overlay.removeOverlay();
      return { ok: false, error: "AudioContext unavailable." };
    }
    const { audioCtx, outputGain } = graph;

    const token = sm.nextToken();
    const newSession: StandardSession = {
      token,
      type: "standard",
      stream,
      audioCtx,
      outputGain,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      recorderMime,
      activeRecorder: null,
      nextPlayAt: 0,
      stopFlag: false,
      // One AbortController for the whole session — every fetch in
      // processStandardChunk hangs off this signal so Stop cancels in-flight
      // calls instead of burning ~5-10s of Kyma credits per orphaned pipeline.
      abortController: new AbortController(),
    };
    sm.session = newSession;

    overlay.setStatusText("Translating");
    overlay.setOverlayState("live");
    this.app.startSessionTimer();
    capture.applyVolumes(settings.originalVolume, settings.voiceVolume);
    this.app.applySourceVisibility();
    if (settings.showSource) this.app.startCaptionPoll();

    this.app.bindCommonVideoListeners(video, newSession);

    this.runChunkLoop(newSession);
    sm.emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  private createGraph(
    voiceVolume: number,
  ): { audioCtx: AudioContext; outputGain: GainNode } | null {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      const audioCtx = new Ctor();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const outputGain = audioCtx.createGain();
      outputGain.gain.value = computeGain(voiceVolume);
      outputGain.connect(audioCtx.destination);
      return { audioCtx, outputGain };
    } catch {
      return null;
    }
  }

  private pickRecorderMime(): string {
    if (typeof MediaRecorder === "undefined") return "";
    for (const m of STANDARD_RECORDER_MIMES) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch {
        /* probe next */
      }
    }
    return "";
  }

  /** Decode the recorder blob → 16 kHz mono 16-bit PCM WAV (Kyma whitelists
   *  mp3/wav/m4a; MediaRecorder emits webm/mp4). Uses the session's shared
   *  AudioContext when given. (legacy webmBlobToWav.) */
  private async webmBlobToWav(
    blob: Blob,
    sharedCtx: AudioContext | null,
  ): Promise<Blob> {
    const arrayBuf = await blob.arrayBuffer();
    let ownCtx: AudioContext | undefined;
    let ctx = sharedCtx;
    if (!ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ownCtx = new Ctor();
      ctx = ownCtx;
    }
    let audioBuf: AudioBuffer;
    try {
      audioBuf = await ctx.decodeAudioData(arrayBuf);
    } finally {
      if (ownCtx) ownCtx.close().catch(() => {});
    }
    return audioBufferToWavBlob(audioBuf);
  }

  /** Self-rescheduling recorder cycle: stop+start each window so each blob is a
   *  self-contained file. Skips while the video is paused. (legacy.) */
  private runChunkLoop(s: StandardSession): void {
    const { sm, capture } = this.app;
    const cycle = (): void => {
      if (s !== sm.session || s.stopFlag) return;
      // Skip recording while paused — captureStream emits silence so we'd burn
      // a call to learn nothing.
      if (capture.videoEl?.paused) {
        setTimeout(cycle, 400);
        return;
      }
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(s.stream!, { mimeType: s.recorderMime });
      } catch {
        try {
          recorder = new MediaRecorder(s.stream!);
        } catch {
          setTimeout(cycle, 1000);
          return;
        }
      }
      s.activeRecorder = recorder;
      const parts: Blob[] = [];
      recorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      });
      recorder.addEventListener("stop", () => {
        if (s !== sm.session || s.stopFlag) return;
        if (parts.length) {
          const blob = new Blob(parts, { type: s.recorderMime });
          this.processStandardChunk(s, blob).catch(() => {});
        }
        cycle();
      });
      try {
        recorder.start();
      } catch {
        setTimeout(cycle, 1000);
        return;
      }
      setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          /* already stopped */
        }
      }, STANDARD_CHUNK_MS);
    };
    cycle();
  }

  /**
   * Process one recorded chunk: re-encode → Gemini understand (translate) →
   * adaptive-speed MiniMax TTS → schedule playback. The guard is re-checked
   * after EVERY await (credit-burn protection — research 02 table row 14).
   * (legacy processStandardChunk.)
   */
  async processStandardChunk(s: StandardSession, blob: Blob): Promise<void> {
    const { sm, overlay } = this.app;
    if (s !== sm.session || s.token !== sm.pageToken) return;
    if (blob.size < STANDARD_MIN_CHUNK_BYTES) return;
    const t = s.token;
    const settings = sm.settings!;
    const lang = settings.targetLanguage || "vi";
    const langName = LANG_NAME[lang] || lang;
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const kymaKey = s.kymaKey;

    // ── await 1: re-encode webm → WAV ──
    let wavBlob: Blob;
    try {
      wavBlob = await this.webmBlobToWav(blob, s.audioCtx);
    } catch {
      return;
    }
    if (sm.isChunkStale(s, t)) return;

    // 1+2 COMBINED via Vertex Gemini Audio. /audio/understand takes audio + a
    // question and returns text; we prompt it to translate straight into the
    // target language (collapses Whisper+translate into one call).
    const durationSec = STANDARD_CHUNK_MS / 1000;
    const understandFd = new FormData();
    understandFd.append("file", wavBlob, "chunk.wav");
    understandFd.append("model", "gemini-3-flash-audio");
    understandFd.append("duration_sec", String(durationSec));
    understandFd.append(
      "question",
      `Translate the spoken English in this audio into ${langName}. ` +
        `Output ONLY the translated sentence(s) for live dubbing — no quotes, ` +
        `no labels, no commentary, no transcription of the original. ` +
        // SF7 — concise output reduces TTS-vs-source duration drift.
        `Be CONCISE — match the original speech duration. Prefer shorter ` +
        `natural phrasing; drop filler words. Preserve ` +
        `names, brand names, and technical terms verbatim. If the audio is ` +
        `silent or non-speech, output an empty string.`,
    );

    // ── await 2: /audio/understand (abort-wired) ──
    let auResp: Response;
    try {
      auResp = await fetch(`${sm.apiBase}/audio/understand`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        body: understandFd,
        signal: s.abortController.signal,
      });
    } catch {
      return; // network blip OR aborted via Stop; next chunk recovers
    }
    if (sm.isChunkStale(s, t)) return;
    if (!auResp.ok) {
      const txt = await auResp.text().catch(() => "");
      const parsed = parseKymaError(auResp.status, txt);
      this.showStandardError(parsed);
      return;
    }
    // ── await 3: parse understand JSON ──
    const au = (await auResp.json().catch(() => ({}))) as { answer?: unknown };
    const targetText = String(au?.answer || "").trim();
    if (!targetText || targetText.length < 2) return;
    // Source captions stay backed by YT's native CC via startCaptionPoll.
    sm.currentTargetText = targetText;
    overlay.setTargetText(targetText);
    overlay.setOverlayState("live");

    // SF7 — adaptive speed by queue depth to prevent cumulative drift.
    const queueDepth = Math.max(0, s.nextPlayAt - s.audioCtx!.currentTime);
    if (queueDepth > 10) {
      // Hard skip — accept content loss to claw back live-ness.
      return;
    }
    let ttsSpeed = 1.0;
    if (queueDepth > 6) ttsSpeed = 1.3;
    else if (queueDepth > 4) ttsSpeed = 1.2;
    else if (queueDepth > 2) ttsSpeed = 1.1;
    else if (queueDepth > 1) ttsSpeed = 1.05;

    // ── await 4: /audio/speech (abort-wired) ──
    let ttsResp: Response;
    try {
      ttsResp = await fetch(`${sm.apiBase}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "minimax-speech-turbo",
          input: targetText,
          voice_id: voiceId,
          response_format: "mp3",
          speed: ttsSpeed,
        }),
        signal: s.abortController.signal,
      });
    } catch {
      return;
    }
    if (sm.isChunkStale(s, t)) return;
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(() => "");
      const parsed = parseKymaError(ttsResp.status, txt);
      this.showStandardError(parsed);
      return;
    }
    // ── await 5: read TTS bytes ──
    const arrayBuf = await ttsResp.arrayBuffer();
    if (sm.isChunkStale(s, t)) return;

    // ── await 6: decode TTS mp3 ──
    let audioBuf: AudioBuffer;
    try {
      audioBuf = await s.audioCtx!.decodeAudioData(arrayBuf);
    } catch {
      return;
    }
    if (sm.isChunkStale(s, t)) return;

    // Schedule against the queue tail. Reset a stranded (past) tail to 0.
    if (s.nextPlayAt < s.audioCtx!.currentTime) s.nextPlayAt = 0;
    const startAt = Math.max(s.audioCtx!.currentTime + 0.05, s.nextPlayAt);
    const src = s.audioCtx!.createBufferSource();
    src.buffer = audioBuf;
    src.connect(s.outputGain!);
    try {
      src.start(startAt);
    } catch {
      /* scheduling edge */
    }
    s.nextPlayAt = startAt + audioBuf.duration;

    this.app.pushHistoryTurn();
  }

  private showStandardError(parsed: ParsedKymaError): void {
    const { overlay } = this.app;
    overlay.setStatusText(parsed.user || "Pipeline error");
    overlay.showToast(parsed.user, {
      durationMs: 6000,
      cta: parsed.cta,
      ctaLabel: parsed.ctaLabel,
    });
  }
}
