// Authenticated Echoly API helpers (subtitle-first Standard).

import { parseServerError } from "@/lib/server-errors";
import { pipelineToastFromServer, type PipelineToastError } from "@/lib/pipeline-error";
import type { CaptionSentence } from "@/lib/caption-utils";

const HDR_REQUEST_ID = "x-echoly-request-id";
const HDR_SESSION_ID = "x-echoly-session-id";
const HDR_SITE_HOST = "x-echoly-site-host";
const HDR_VIDEO_TITLE = "x-echoly-video-title";

function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface SubtitleDubBatchLine {
  text: string;
  audioMp3: ArrayBuffer;
}

/**
 * One server call: Gemini translate (structured) + MiniMax TTS per line.
 * POST /v1/translate/subtitles — prompts and models are server-controlled.
 */
export async function renderSubtitleDubBatch(opts: {
  apiBase: string;
  bearer: string;
  sentences: CaptionSentence[];
  targetLanguage: string;
  voiceId: string;
  /** Per-line cue slot duration (ms) so the server speed-fits the dub (isochrony). */
  cueDurationsMs?: number[];
  /** Up to ~4 previously dubbed lines for cross-batch translation context. */
  priorLines?: string[];
  /** Stable id for this dubbing session — groups all batches in server usage logs. */
  sessionId?: string;
  /** Watched site hostname (e.g. "youtube.com") — stored as site_host in usage_events. */
  siteHost?: string;
  /** Video title URL-encoded by the caller — stored as video_title in usage_events. */
  videoTitle?: string;
  signal?: AbortSignal;
}): Promise<SubtitleDubBatchLine[]> {
  const lines = opts.sentences.map((s) => s.text);
  const res = await fetch(`${opts.apiBase}/translate/subtitles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.bearer}`,
      "Content-Type": "application/json",
      [HDR_REQUEST_ID]: newRequestId("sf_dub"),
      ...(opts.sessionId ? { [HDR_SESSION_ID]: opts.sessionId } : {}),
      ...(opts.siteHost ? { [HDR_SITE_HOST]: opts.siteHost } : {}),
      ...(opts.videoTitle ? { [HDR_VIDEO_TITLE]: opts.videoTitle } : {}),
    },
    body: JSON.stringify({
      lines,
      target_language: opts.targetLanguage,
      voice_id: opts.voiceId,
      ...(opts.cueDurationsMs ? { cue_durations_ms: opts.cueDurationsMs } : {}),
      ...(opts.priorLines && opts.priorLines.length ? { prior_lines: opts.priorLines } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }
  const json = (await res.json()) as {
    lines?: { text?: string; audio?: string }[];
  };
  const out = json.lines ?? [];
  const mapped = lines.map((src, i) => {
    const row = out[i];
    const text = typeof row?.text === "string" && row.text.trim() ? row.text.trim() : src;
    let audioMp3 = new ArrayBuffer(0);
    const b64 = row?.audio;
    if (typeof b64 === "string" && b64.length > 0) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      audioMp3 = bytes.buffer;
    }
    return { text, audioMp3 };
  });
  return mapped;
}

// ── SSE streaming subtitle-dub ─────────────────────────────────────────────

/**
 * Yielded by renderSubtitleDubStream for each line as it arrives.
 * `index` is the 0-based line index within the batch (NOT the global sentence index).
 */
export interface SubtitleDubStreamLine extends SubtitleDubBatchLine {
  index: number;
  /** cue_start_ms from the server (cumulative from the batch start). */
  cueStartMs: number;
  /** cue_end_ms from the server (cumulative). */
  cueEndMs: number;
}

/**
 * Async generator that POSTs to the SSE streaming endpoint
 * `POST /v1/translate/subtitles/stream` and yields one `SubtitleDubStreamLine`
 * per line as the server emits it.
 *
 * Back-compat (AC12): if the stream route returns 404 (older server), falls
 * back transparently to `renderSubtitleDubBatch` and yields all lines at once.
 *
 * E-4: callers MUST pass `signal: s.abortController.signal` so Stop cancels
 * the stream mid-flight and the server correctly commits only the synthesised
 * lines.
 */
/** Shared buffered-path fallback for the streaming generator (404 / network error). */
async function* bufferedFallbackLines(opts: Parameters<typeof renderSubtitleDubBatch>[0]): AsyncGenerator<SubtitleDubStreamLine> {
  const buffered = await renderSubtitleDubBatch(opts);
  for (let i = 0; i < buffered.length; i++) {
    yield {
      index: i,
      text: buffered[i]!.text,
      audioMp3: buffered[i]!.audioMp3,
      cueStartMs: 0,
      cueEndMs: 0,
    };
  }
}

export async function* renderSubtitleDubStream(opts: {
  apiBase: string;
  bearer: string;
  sentences: CaptionSentence[];
  targetLanguage: string;
  voiceId: string;
  cueDurationsMs?: number[];
  priorLines?: string[];
  sessionId?: string;
  siteHost?: string;
  videoTitle?: string;
  signal?: AbortSignal;
}): AsyncGenerator<SubtitleDubStreamLine> {
  const lines = opts.sentences.map((s) => s.text);
  let res: Response;
  try {
    res = await fetch(`${opts.apiBase}/translate/subtitles/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.bearer}`,
        "Content-Type": "application/json",
        [HDR_REQUEST_ID]: newRequestId("sf_dub_s"),
        ...(opts.sessionId ? { [HDR_SESSION_ID]: opts.sessionId } : {}),
        ...(opts.siteHost ? { [HDR_SITE_HOST]: opts.siteHost } : {}),
        ...(opts.videoTitle ? { [HDR_VIDEO_TITLE]: opts.videoTitle } : {}),
      },
      body: JSON.stringify({
        lines,
        target_language: opts.targetLanguage,
        voice_id: opts.voiceId,
        ...(opts.cueDurationsMs ? { cue_durations_ms: opts.cueDurationsMs } : {}),
        ...(opts.priorLines && opts.priorLines.length ? { prior_lines: opts.priorLines } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    // Intentional Stop (AbortError) — rethrow so the caller tears down cleanly.
    if (opts.signal?.aborted || (err as Error | undefined)?.name === "AbortError") {
      throw err;
    }
    // Network/CORS failure (e.g. "Failed to fetch") — degrade to the buffered
    // path so dubbing still works instead of breaking the whole session.
    yield* bufferedFallbackLines(opts);
    return;
  }

  // Back-compat: older server without the streaming route → fall back to buffered.
  if (res.status === 404) {
    yield* bufferedFallbackLines(opts);
    return;
  }

  if (!res.ok || !res.body) {
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }

  // Parse SSE over ReadableStream (Chrome ≥116 supports streaming in content scripts).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    outer: while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // AbortError from signal cancellation or network drop — clean exit.
        break;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.startsWith("event:")) {
          currentEvent = part.slice(6).trim();
        } else if (part.startsWith("data:")) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(part.slice(5).trim()) as Record<string, unknown>;
          } catch {
            // Malformed SSE data — skip.
            currentEvent = "";
            continue;
          }

          if (currentEvent === "error") {
            throw Object.assign(new Error(String(data["message"] ?? "Stream error")), {
              code: data["code"] ?? "upstream_error",
              user: String(data["message"] ?? "Stream error"),
            });
          }

          if (currentEvent === "line") {
            const idx = typeof data["index"] === "number" ? data["index"] : 0;
            const text = typeof data["text"] === "string" ? data["text"] : "";
            const audiob64 = typeof data["audio_b64"] === "string" ? data["audio_b64"] : "";
            const cueStartMs = typeof data["cue_start_ms"] === "number" ? data["cue_start_ms"] : 0;
            const cueEndMs = typeof data["cue_end_ms"] === "number" ? data["cue_end_ms"] : 0;

            let audioMp3 = new ArrayBuffer(0);
            if (audiob64.length > 0) {
              try {
                const binary = atob(audiob64);
                const bytes = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                audioMp3 = bytes.buffer;
              } catch {
                /* ignore decode failure — audioMp3 stays empty */
              }
            }

            yield { index: idx, text, audioMp3, cueStartMs, cueEndMs };
          }

          if (currentEvent === "done") {
            // Stream is complete — break out of the outer while loop.
            break outer;
          }

          currentEvent = "";
        } else if (part === "") {
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function isPipelineToastError(err: unknown): err is PipelineToastError {
  return (
    typeof err === "object" &&
    err !== null &&
    "user" in err &&
    typeof (err as PipelineToastError).user === "string"
  );
}
