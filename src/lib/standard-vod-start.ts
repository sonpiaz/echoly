// VOD session start helpers — Standard vs Realtime playback gates after WebRTC ICE.

// NOTE: REALTIME_VOD_PLAY_ALIGN_MS is kept for callers that pass alignMs;
// the function no longer uses it as an unconditional sleep but instead as a
// ceiling on the event-driven wait so the return contract is identical.
import { REALTIME_VOD_PLAY_ALIGN_MS } from "@/shared/constants";

/**
 * Realtime VOD: event-driven wait for the remote audio track to be ready.
 *
 * Resolves as soon as the `<audio>` element returned by `getDubAudio` fires
 * `canplay` or `loadedmetadata`, OR — if `getDubAudio()` returns an element
 * that already has `readyState >= HAVE_METADATA (1)` — resolves immediately.
 *
 * Falls back to `alignMs` ceiling in case the element never arrives
 * (e.g. the track fires before we attached the listener). The fixed 80 ms
 * unconditional sleep is eliminated; the function returns as soon as the
 * track is demonstrably ready.
 *
 * Signature / return contract is identical to the old polling version:
 *   - `getDubAudio` may return null on the first call; we retry every 16 ms
 *     until we get an element OR the `alignMs` deadline passes.
 *   - Never rejects; always resolves (soft-fail on timeout).
 */
export async function alignRealtimeVodBeforePlay(
  getDubAudio: () => HTMLAudioElement | null,
  alignMs = REALTIME_VOD_PLAY_ALIGN_MS,
): Promise<void> {
  // Ceiling: resolve early on canplay/loadedmetadata (typical TTFA ~400-800ms);
  // this cap only applies on SLOW OpenAI paths where the dub track never signals
  // ready. Lowered 2000→1000ms so a slow first-connect feels far less "stuck" —
  // worst case the video resumes ~1s in (brief source audio before dub) instead
  // of being frozen up to 2s. alignMs (80ms floor) can still raise it per-caller.
  const ceiling = Math.max(alignMs, 1000);

  await new Promise<void>((resolve) => {
    const deadline = Date.now() + ceiling;
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function done() {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      resolve();
    }

    function attachListeners(audio: HTMLAudioElement): void {
      // Already has metadata — resolve immediately (track arrived before us).
      if (audio.readyState >= 1 /* HAVE_METADATA */) {
        done();
        return;
      }
      const onReady = () => {
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("loadedmetadata", onReady);
        done();
      };
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("loadedmetadata", onReady, { once: true });
    }

    function poll(): void {
      if (settled) return;
      const audio = getDubAudio();
      if (audio) {
        attachListeners(audio);
        return;
      }
      if (Date.now() >= deadline) {
        done();
        return;
      }
      // Poll every 16 ms (~1 frame) until the element appears.
      pollTimer = setTimeout(poll, 16);
    }

    // Hard ceiling — never hold longer than the old behaviour.
    timeoutTimer = setTimeout(done, ceiling);

    // Start poll immediately.
    poll();
  });
}
