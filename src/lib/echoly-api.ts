// Authenticated Echoly API helpers (subtitle-first Standard).

import { parseServerError } from "@/lib/server-errors";
import { pipelineToastFromServer, type PipelineToastError } from "@/lib/pipeline-error";
import type { CaptionSentence } from "@/lib/caption-utils";

const HDR_REQUEST_ID = "x-echoly-request-id";
const HDR_SESSION_ID = "x-echoly-session-id";
const HDR_SITE_HOST = "x-echoly-site-host";

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

export function isPipelineToastError(err: unknown): err is PipelineToastError {
  return (
    typeof err === "object" &&
    err !== null &&
    "user" in err &&
    typeof (err as PipelineToastError).user === "string"
  );
}
