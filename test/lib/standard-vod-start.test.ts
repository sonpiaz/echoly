import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { alignRealtimeVodBeforePlay } from "@/lib/standard-vod-start";

describe("alignRealtimeVodBeforePlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits briefly for dub element then applies align delay", async () => {
    const dub = {} as HTMLAudioElement;
    let seen = false;
    const p = alignRealtimeVodBeforePlay(() => {
      if (!seen) {
        seen = true;
        return dub;
      }
      return dub;
    }, 80);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(seen).toBe(true);
  });
});
