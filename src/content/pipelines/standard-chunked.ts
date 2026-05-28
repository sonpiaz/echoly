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
  STANDARD_DEFAULT_VOICE,
  STANDARD_RECORDER_MIMES,
} from "@/shared/constants";
import {
  LATENCY_CHUNK_MS,
  NOISE_GATE_DBFS,
  STYLE_PROMPTS,
} from "@/shared/advanced";
import { parseKymaError, type ParsedKymaError } from "@/lib/kyma";
import { parseServerError } from "@/lib/server-errors";
import {
  audioBufferToWavBlob,
  computeGain,
  computeRmsDbFs,
  downmixAndResample,
} from "@/lib/audio";
import type { Ack } from "@/shared/protocol";
import type { StandardSession } from "../session-manager";
import type { ContentApp } from "../index";

/** Hard floor — recorder corner cases (zero-byte stop, header-only blobs)
 *  emit sub-200B blobs regardless of audio content. Skipped unconditionally
 *  even when the noise gate is OFF — there's nothing to translate. */
const RECORDER_SANITY_MIN_BYTES = 200;

/** Build the audio-endpoint path for the current world.
 *  • byok  → `/audio/{understand|speech}` (Kyma direct API shape)
 *  • proxy → `/proxy/audio/{...}` (Echoly server's metered compat shim) */
function audioPath(apiMode: string | null | undefined, leaf: "understand" | "speech"): string {
  return apiMode === "proxy" ? `/proxy/audio/${leaf}` : `/audio/${leaf}`;
}

/** Adapt a server (Echoly) error response into the ParsedKymaError shape the
 *  showStandardError toast consumes. The 402 upgrade_url surfaces as the CTA. */
async function parsedFromServerError(res: Response): Promise<ParsedKymaError> {
  const parsed = await parseServerError(res);
  return {
    user: parsed.user,
    ...(parsed.cta ? { cta: parsed.cta } : {}),
    ...(parsed.ctaLabel ? { ctaLabel: parsed.ctaLabel } : {}),
  };
}

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
      overlay.buildOverlay(
        this.app.callbacks,
        settings.advanced?.captionPosition ?? null,
      );
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

    const outputDeviceId = settings.advanced?.outputDeviceId ?? "";
    const graph = this.createGraph(settings.voiceVolume ?? 100, outputDeviceId);
    if (!graph) {
      stream.getTracks().forEach((t) => t.stop());
      overlay.removeOverlay();
      return { ok: false, error: "AudioContext unavailable." };
    }
    const { audioCtx, outputGain, remoteAudio } = graph;

    const token = sm.nextToken();
    const newSession: StandardSession = {
      token,
      type: "standard",
      stream,
      audioCtx,
      outputGain,
      remoteAudio,
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

  /** Build the dub-playback audio graph. When `outputDeviceId` is set, we route
   *  the gain node through a MediaStreamAudioDestinationNode + hidden <audio>
   *  so HTMLMediaElement.setSinkId can pick the user's chosen output. On setSinkId
   *  rejection (Bluetooth removal, invalid id, browser refusal) we fall back to
   *  the default audioCtx.destination — and log the failure (the user picked a
   *  device, so silent fallback would be surprising). */
  private createGraph(
    voiceVolume: number,
    outputDeviceId: string,
  ): {
    audioCtx: AudioContext;
    outputGain: GainNode;
    remoteAudio: HTMLAudioElement | null;
  } | null {
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

      // No specific output requested → legacy direct-to-destination path.
      if (!outputDeviceId) {
        outputGain.connect(audioCtx.destination);
        return { audioCtx, outputGain, remoteAudio: null };
      }

      // Sink-id requested: route through an <audio> element so setSinkId works.
      // Wire up a stream destination AND keep the option to swing back to the
      // default destination if setSinkId rejects.
      const streamDest = audioCtx.createMediaStreamDestination();
      outputGain.connect(streamDest);
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = streamDest.stream;
      audio.style.display = "none";
      document.body.appendChild(audio);
      const a = audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (typeof a.setSinkId === "function") {
        a.setSinkId(outputDeviceId).catch((err: unknown) => {
          console.warn(
            "[echoly] setSinkId failed for Standard dub output; falling back to default",
            err,
          );
          // Fallback: stop the <audio> path and connect straight to destination.
          try {
            outputGain.disconnect(streamDest);
          } catch {
            /* ignore — disconnect may throw if not connected */
          }
          try {
            outputGain.connect(audioCtx.destination);
          } catch {
            /* ignore */
          }
          try {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
          } catch {
            /* ignore */
          }
        });
      } else {
        // Browser lacks setSinkId entirely (Firefox prior to recent versions).
        console.warn(
          "[echoly] HTMLAudioElement.setSinkId is unavailable; using system default output for Standard dub",
        );
        try {
          outputGain.disconnect(streamDest);
        } catch {
          /* ignore */
        }
        outputGain.connect(audioCtx.destination);
        try {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
        } catch {
          /* ignore */
        }
        return { audioCtx, outputGain, remoteAudio: null };
      }
      return { audioCtx, outputGain, remoteAudio: audio };
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
   *  mp3/wav/m4a; MediaRecorder emits webm/mp4). Also returns the downmixed
   *  mono Float32 buffer so the noise-gate can compute RMS without a second
   *  decode. Uses the session's shared AudioContext when given.
   *  (legacy webmBlobToWav, extended for the Advanced noise-gate.) */
  private async webmBlobToWav(
    blob: Blob,
    sharedCtx: AudioContext | null,
  ): Promise<{ wav: Blob; mono: Float32Array }> {
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
    // Mono downmix at the wav target rate — same buffer used for RMS + encode.
    const mono = downmixAndResample(audioBuf, 16000);
    return { wav: audioBufferToWavBlob(audioBuf), mono };
  }

  /** Resolve the chunk window from Advanced settings. Falls back to "smooth"
   *  when settings.advanced is missing (initial sync race / signed-out). */
  private chunkWindowMs(): number {
    const preset = this.app.sm.settings?.advanced?.latencyPreset ?? "smooth";
    return LATENCY_CHUNK_MS[preset];
  }

  /** Self-rescheduling recorder cycle: stop+start each window so each blob is a
   *  self-contained file. Skips while the video is paused. Latency preset
   *  (Advanced setting) controls the window size; read fresh per cycle so a
   *  mid-session change picks up on the next chunk. (legacy.) */
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
      const windowMs = this.chunkWindowMs();
      setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          /* already stopped */
        }
      }, windowMs);
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
    // Hard recorder-sanity floor: <200B is always a malformed/header-only blob
    // — nothing to translate, skip regardless of noiseGate setting.
    if (blob.size < RECORDER_SANITY_MIN_BYTES) return;
    const t = s.token;
    const settings = sm.settings!;
    const lang = settings.targetLanguage || "vi";
    const langName = LANG_NAME[lang] || lang;
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const kymaKey = s.kymaKey;
    const advanced = settings.advanced;
    const stylePrefix = STYLE_PROMPTS[advanced?.translationStyle ?? "natural"];

    // ── await 1: re-encode webm → WAV (also returns mono PCM for the RMS gate) ──
    let wavBlob: Blob;
    let monoSamples: Float32Array;
    try {
      const decoded = await this.webmBlobToWav(blob, s.audioCtx);
      wavBlob = decoded.wav;
      monoSamples = decoded.mono;
    } catch {
      return;
    }
    if (sm.isChunkStale(s, t)) return;

    // Advanced noise-gate: drop chunks below NOISE_GATE_DBFS RMS. The gate
    // protects against background music / room tone burning translate credit;
    // a OFF setting bypasses entirely. (Hard <200B sanity guard above handles
    // recorder corner cases independently.)
    if (advanced?.noiseGate) {
      const rms = computeRmsDbFs(monoSamples);
      if (rms < NOISE_GATE_DBFS) return;
    }

    // 1+2 COMBINED via Vertex Gemini Audio. /audio/understand takes audio + a
    // question and returns text; we prompt it to translate straight into the
    // target language (collapses Whisper+translate into one call). The Advanced
    // translationStyle prepends a tone-steer prefix (literal/natural/casual).
    const durationSec = this.chunkWindowMs() / 1000;
    const understandFd = new FormData();
    understandFd.append("file", wavBlob, "chunk.wav");
    understandFd.append("model", "gemini-3-flash-audio");
    understandFd.append("duration_sec", String(durationSec));
    understandFd.append(
      "question",
      `${stylePrefix}` +
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
    // World-switched path: byok → Kyma; proxy → Echoly server (metered shim).
    const isProxy = sm.settings?.apiMode === "proxy";
    let auResp: Response;
    try {
      auResp = await fetch(
        `${sm.apiBase}${audioPath(sm.settings?.apiMode, "understand")}`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + kymaKey },
          body: understandFd,
          signal: s.abortController.signal,
        },
      );
    } catch {
      return; // network blip OR aborted via Stop; next chunk recovers
    }
    if (sm.isChunkStale(s, t)) return;
    if (!auResp.ok) {
      const parsed = isProxy
        ? await parsedFromServerError(auResp)
        : parseKymaError(auResp.status, await auResp.text().catch(() => ""));
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
      ttsResp = await fetch(
        `${sm.apiBase}${audioPath(sm.settings?.apiMode, "speech")}`,
        {
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
        },
      );
    } catch {
      return;
    }
    if (sm.isChunkStale(s, t)) return;
    if (!ttsResp.ok) {
      const parsed = isProxy
        ? await parsedFromServerError(ttsResp)
        : parseKymaError(ttsResp.status, await ttsResp.text().catch(() => ""));
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
