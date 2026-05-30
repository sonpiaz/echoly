// VOD session start helpers — Standard vs Realtime playback gates after WebRTC ICE.

import { REALTIME_VOD_PLAY_ALIGN_MS } from "@/shared/constants";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Realtime VOD: no TTFA gate or adaptive sync — ICE is enough; a short delay
 * lets the inbound track + WebAudio graph settle before video.play().
 */
export async function alignRealtimeVodBeforePlay(
  getDubAudio: () => HTMLAudioElement | null,
  alignMs = REALTIME_VOD_PLAY_ALIGN_MS,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (getDubAudio()) break;
    await sleep(40);
  }
  if (alignMs > 0) await sleep(alignMs);
}
