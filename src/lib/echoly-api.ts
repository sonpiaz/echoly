// Authenticated Echoly API helpers (subtitle-first Standard).

import { parseServerError } from "@/lib/server-errors";
import { pipelineToastFromServer, isPipelineToastError } from "@/lib/pipeline-error";
import type { CaptionSentence } from "@/lib/caption-utils";

/** Backoff for the single too_many_inflight retry (transient burst admission). */
const INFLIGHT_RETRY_DELAY_MS = 1500;

/**
 * If `res` is a 429 whose body code is `too_many_inflight`, wait briefly and
 * re-run `doFetch` ONCE (callers reuse the same request id, so the server's
 * idempotency layer makes the retry double-billing-safe). Any other response
 * — or an abort during the backoff — returns the original response untouched.
 */
async function retryOnceOnInflight429(
  res: Response,
  doFetch: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  if (res.status !== 429 || signal?.aborted) return res;
  let code: string | undefined;
  try {
    const peek = (await res.clone().json()) as
      | { code?: string; error?: { code?: string } }
      | null;
    code = peek?.error?.code ?? peek?.code;
  } catch {
    return res;
  }
  if (code !== "too_many_inflight") return res;
  await new Promise((r) => setTimeout(r, INFLIGHT_RETRY_DELAY_MS));
  if (signal?.aborted) return res;
  try {
    return await doFetch();
  } catch {
    return res;
  }
}

// Re-export so existing importers that do `import { isPipelineToastError } from "@/lib/echoly-api"` keep working.
export { isPipelineToastError };

const HDR_REQUEST_ID = "x-echoly-request-id";
const HDR_SESSION_ID = "x-echoly-session-id";
const HDR_SITE_HOST = "x-echoly-site-host";
const HDR_VIDEO_TITLE = "x-echoly-video-title";

export function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Sentinel returned by renderSubtitleDubBatch / renderSubtitleDubStream when
 * the server replies that the request was already processed (idempotency replay).
 * Callers MUST check `result === ALREADY_PROCESSED` before using the array.
 *
 * Both server shapes are terminal success — callers must NOT retry:
 *   • 200 `{already_processed:true}` — post-commit replay (idempotency hit after
 *     the original request fully committed; may carry cached body or flag-only).
 *   • 409 `already_processed` — a retry raced the still-in-flight original past
 *     the idempotency point-read.
 */
export const ALREADY_PROCESSED: unique symbol = Symbol("already_processed");

export interface SubtitleDubBatchLine {
  text: string;
  audioMp3: ArrayBuffer;
}

/**
 * One server call: Gemini translate (structured) + MiniMax TTS per line.
 * POST /v1/translate/subtitles — prompts and models are server-controlled.
 *
 * Pass a stable `requestId` (same across retries of the same batch range) for
 * idempotency. If the server returns 200 `{already_processed:true}` or 409
 * `already_processed`, returns the sentinel `ALREADY_PROCESSED` — callers MUST
 * treat this as a terminal success-skip and NOT retry.
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
  /**
   * Stable request id for this batch. Reuse the SAME id on retries of the same
   * range so the server's idempotency check prevents double-billing. When omitted
   * a fresh UUID is generated (old behaviour — retained for back-compat with
   * callers that don't yet supply stable ids).
   */
  requestId?: string;
  signal?: AbortSignal;
}): Promise<SubtitleDubBatchLine[] | typeof ALREADY_PROCESSED> {
  const lines = opts.sentences.map((s) => s.text);
  const reqId = opts.requestId ?? newRequestId("sf_dub");
  const doFetch = () => fetch(`${opts.apiBase}/translate/subtitles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.bearer}`,
      "Content-Type": "application/json",
      [HDR_REQUEST_ID]: reqId,
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
  let res = await doFetch();

  // 429 too_many_inflight is TRANSIENT (burst admission, e.g. a just-stopped
  // session's batches still settling server-side). Retry ONCE after a short
  // backoff with the SAME request id (server idempotency makes this safe).
  res = await retryOnceOnInflight429(res, doFetch, opts.signal);

  // ── Idempotency replay: already processed (SOLUTION §4 WS5) ─────────────────
  // 409 already_processed: a retry raced the in-flight original past the
  // idempotency point-read. Terminal success-skip — do NOT retry.
  if (res.status === 409) {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON 409 — treat as already_processed too */
    }
    if (!body || body["code"] === "already_processed" || (body["error"] as Record<string, unknown>)?.["code"] === "already_processed") {
      return ALREADY_PROCESSED;
    }
    // Other 409 (e.g. conflict) — fall through to error handling.
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }

  if (!res.ok) {
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }

  const json = (await res.json()) as {
    already_processed?: boolean;
    lines?: { text?: string; audio?: string }[];
  };

  // 200 {already_processed:true}: post-commit replay. The server may or may not
  // include the cached body; either way this is terminal success — no provider
  // re-work, no reserve, no retry.
  if (json.already_processed === true && !json.lines) {
    return ALREADY_PROCESSED;
  }
  // 200 with already_processed + body: replay with cached lines — use them.
  // Fall through to normal line-mapping so the caller gets real audio back.

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
  if (buffered === ALREADY_PROCESSED) return; // terminal success-skip — yield nothing
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
  /**
   * Stable request id for this batch. Reuse the SAME id on retries of the same
   * range for idempotency. When omitted a fresh UUID is generated.
   */
  requestId?: string;
  signal?: AbortSignal;
}): AsyncGenerator<SubtitleDubStreamLine | typeof ALREADY_PROCESSED> {
  const lines = opts.sentences.map((s) => s.text);
  const reqId = opts.requestId ?? newRequestId("sf_dub_s");
  const openStream = () => fetch(`${opts.apiBase}/translate/subtitles/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.bearer}`,
        "Content-Type": "application/json",
        [HDR_REQUEST_ID]: reqId,
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
  let res: Response;
  try {
    res = await openStream();
    // 429 too_many_inflight: transient burst — retry once (same reqId).
    res = await retryOnceOnInflight429(res, openStream, opts.signal);
  } catch (err) {
    // Intentional Stop (AbortError) — rethrow so the caller tears down cleanly.
    if (opts.signal?.aborted || (err as Error | undefined)?.name === "AbortError") {
      throw err;
    }
    // Network/CORS failure (e.g. "Failed to fetch") — degrade to the buffered
    // path so dubbing still works instead of breaking the whole session.
    yield* bufferedFallbackLines({ ...opts, requestId: reqId });
    return;
  }

  // ── Idempotency replay: already processed ────────────────────────────────────
  // 409 already_processed: retry raced the in-flight original. Terminal success.
  if (res.status === 409) {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON 409 — treat as already_processed */
    }
    if (!body || body["code"] === "already_processed" || (body["error"] as Record<string, unknown>)?.["code"] === "already_processed") {
      yield ALREADY_PROCESSED;
      return;
    }
    // Other 409 — error path.
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }

  // Back-compat: older server without the streaming route → fall back to buffered.
  if (res.status === 404) {
    yield* bufferedFallbackLines({ ...opts, requestId: reqId });
    return;
  }

  if (!res.ok || !res.body) {
    const parsed = await parseServerError(res);
    const toast = pipelineToastFromServer(parsed);
    throw Object.assign(new Error(toast.user), toast);
  }

  // 200 {already_processed:true} on stream endpoint — the body may be a minimal JSON.
  // Peek the Content-Type: if not SSE (text/event-stream), try parsing as JSON.
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    if (body?.["already_processed"] === true) {
      yield ALREADY_PROCESSED;
      return;
    }
    // Unexpected non-SSE — fall back to buffered using the body data if lines present.
    // This shouldn't happen in practice; safest is to degrade gracefully.
    yield* bufferedFallbackLines({ ...opts, requestId: reqId });
    return;
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

