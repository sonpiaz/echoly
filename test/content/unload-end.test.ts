import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "@/content/session-manager";

describe("stopSession unload — realtime /end keepalive", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("endRtcSession posts keepalive /end with session id", async () => {
    const sm = new SessionManager();
    sm.apiBase = "https://api.test/v1";
    await sm.endRtcSession("rt_signed123", "bearer_token");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/rtc/translate/rt_signed123/end");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer bearer_token");
    expect(init.keepalive).toBe(true);
  });

  it("endRtcSession no-ops without session id", async () => {
    const sm = new SessionManager();
    await sm.endRtcSession(null, "bearer");
    expect(fetch).not.toHaveBeenCalled();
  });
});
