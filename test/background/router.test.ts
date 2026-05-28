// Layer B — message-router dispatch + content-event interaction tests, against
// the hand-rolled chrome.* mock (test/setup.ts). Asserts the EXACT channel
// semantics (popup async → true; content paths → false), the sender.tab pivot,
// the GET_YT_CC_URL cache response, and that popup intents reach the session
// coordinator / auth / store.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import {
  routeMessage,
  handleContentEvent,
  type RouterDeps,
} from "@/background/router";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { CaptionCache } from "@/background/caption-cache";
import type { ToBackgroundMessage } from "@/shared/protocol";
import type { YtCaptionEntry } from "@/shared/types";

const CONTENT_SENDER: chrome.runtime.MessageSender = {
  tab: { id: 7 } as chrome.tabs.Tab,
};
const POPUP_SENDER: chrome.runtime.MessageSender = {};

function buildDeps(): RouterDeps {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  const captions = new CaptionCache();
  return { store, auth, session, captions };
}

/** Drive routeMessage and capture the sync return + the (possibly async) response. */
function route(
  deps: RouterDeps,
  message: ToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
): { ret: boolean; response: () => unknown } {
  let captured: unknown;
  const sendResponse = vi.fn((r?: unknown) => {
    captured = r;
  });
  const ret = routeMessage(deps, message, sender, sendResponse);
  return { ret, response: () => captured };
}

describe("routeMessage — channel semantics (sender.tab pivot)", () => {
  let deps: RouterDeps;
  beforeEach(() => {
    resetChrome();
    deps = buildDeps();
  });

  it("popup message returns true (keeps channel open for async sendResponse)", () => {
    const { ret } = route(deps, { type: "STOP" }, POPUP_SENDER);
    expect(ret).toBe(true);
  });

  it("content event returns false (sync ack, no channel leak)", () => {
    const { ret, response } = route(
      deps,
      { type: "CONTENT_STATE", running: true },
      CONTENT_SENDER,
    );
    expect(ret).toBe(false);
    expect(response()).toEqual({ ok: true });
  });

  it("GET_YT_CC_URL (content) returns false and is handled before the generic branch", () => {
    const { ret } = route(
      deps,
      { type: "GET_YT_CC_URL", videoId: "abc" },
      CONTENT_SENDER,
    );
    expect(ret).toBe(false);
  });
});

describe("routeMessage — GET_YT_CC_URL cache lookup", () => {
  let deps: RouterDeps;
  beforeEach(() => {
    resetChrome();
    deps = buildDeps();
  });

  it("miss → { ok: false }", () => {
    const { response } = route(
      deps,
      { type: "GET_YT_CC_URL", videoId: "missing" },
      CONTENT_SENDER,
    );
    expect(response()).toEqual({ ok: false });
  });

  it("hit → { ok: true, ...entry } from the caption cache", () => {
    const entry: YtCaptionEntry = {
      url: "https://www.youtube.com/api/timedtext?v=vid&lang=en",
      lang: "en",
      kind: null,
      tlang: null,
      isAsr: false,
      capturedAt: 123,
    };
    // populate the cache via the webRequest record path (no statusCode noise)
    deps.captions.record({
      url: entry.url,
      statusCode: 200,
    } as chrome.webRequest.WebResponseCacheDetails);
    const { response } = route(
      deps,
      { type: "GET_YT_CC_URL", videoId: "vid" },
      CONTENT_SENDER,
    );
    const r = response() as { ok: boolean; url?: string; isAsr?: boolean };
    expect(r.ok).toBe(true);
    expect(r.url).toBe(entry.url);
    expect(r.isAsr).toBe(false);
  });
});

describe("routeMessage — popup dispatch reaches the right handler", () => {
  let deps: RouterDeps;
  let chromeMock: FakeChrome;
  beforeEach(() => {
    chromeMock = resetChrome();
    deps = buildDeps();
  });

  it("GET_STATE → loads settings + refreshes auth, replies {ok:true, state}", async () => {
    chromeMock.storage.local._data["targetLanguage"] = "ja";
    const loadSpy = vi.spyOn(deps.store, "loadSettings");
    const refreshSpy = vi.spyOn(deps.store, "refreshAuth");
    const { ret, response } = route(deps, { type: "GET_STATE" }, POPUP_SENDER);
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(response()).toBeDefined());
    const r = response() as { ok: boolean; state: { targetLanguage: string } };
    expect(r.ok).toBe(true);
    expect(r.state.targetLanguage).toBe("ja");
    expect(loadSpy).toHaveBeenCalledOnce();
    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it("START → delegates to session.start; aborts {ok:false} when no apiMode resolves", async () => {
    // no cookie (mock returns null) + empty kymaKey ⇒ resolveApiMode = null
    const startSpy = vi.spyOn(deps.session, "start");
    const { response } = route(deps, { type: "START" }, POPUP_SENDER);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(startSpy).toHaveBeenCalledOnce();
    const r = response() as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Sign in at echolyhq.com or paste a Kyma key.");
  });

  it("STOP → delegates to session.stop, returns {ok:true, state}", async () => {
    const stopSpy = vi.spyOn(deps.session, "stop");
    const { response } = route(deps, { type: "STOP" }, POPUP_SENDER);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(stopSpy).toHaveBeenCalledOnce();
    expect((response() as { ok: boolean }).ok).toBe(true);
  });

  it("UPDATE_VOLUME → delegates to session.updateVolume, acks {ok:true}", async () => {
    const volSpy = vi.spyOn(deps.session, "updateVolume");
    const { response } = route(
      deps,
      { type: "UPDATE_VOLUME", originalVolume: 30, voiceVolume: 80 },
      POPUP_SENDER,
    );
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(volSpy).toHaveBeenCalledWith(30, 80);
    expect(response()).toEqual({ ok: true });
  });

  it("SIGN_OUT_ECHOLY → calls auth.signOut + clears auth, replies state", async () => {
    deps.store.setSignedInUser({ email: "x@y.com", tier: "free" });
    deps.store.setApiMode("proxy");
    const signOutSpy = vi.spyOn(deps.auth, "signOut").mockResolvedValue();
    const { response } = route(deps, { type: "SIGN_OUT_ECHOLY" }, POPUP_SENDER);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(signOutSpy).toHaveBeenCalledOnce();
    const r = response() as { ok: boolean; state: { apiMode: unknown } };
    expect(r.ok).toBe(true);
    expect(r.state.apiMode).toBeNull();
    expect(deps.store.state.signedInUser).toBeNull();
  });

  it("unknown popup message → {ok:false, error}", async () => {
    const { response } = route(
      deps,
      { type: "BOGUS" } as unknown as ToBackgroundMessage,
      POPUP_SENDER,
    );
    await vi.waitFor(() => expect(response()).toBeDefined());
    const r = response() as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unknown message");
  });

  it("a throwing handler is caught → {ok:false, error}", async () => {
    vi.spyOn(deps.session, "stop").mockRejectedValue(new Error("boom"));
    const { response } = route(deps, { type: "STOP" }, POPUP_SENDER);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(response()).toEqual({ ok: false, error: "boom" });
  });
});

describe("handleContentEvent — state mutation from content push", () => {
  let deps: RouterDeps;
  beforeEach(() => {
    resetChrome();
    deps = buildDeps();
  });

  it("CONTENT_STATE merges only the type-guarded fields present", () => {
    deps.store.setStatus("Ready");
    handleContentEvent(deps.store, {
      type: "CONTENT_STATE",
      running: true,
      status: "Translating",
    });
    expect(deps.store.state.running).toBe(true);
    expect(deps.store.state.status).toBe("Translating");
    expect(deps.store.state.paused).toBe(false); // not sent → untouched
  });

  it("CONTENT_ENDED resets the session to idle with the given reason", () => {
    deps.store.setRunning(true);
    deps.store.setConnecting(true);
    deps.store.setTabId(7);
    handleContentEvent(deps.store, { type: "CONTENT_ENDED", reason: "limit" });
    expect(deps.store.state.running).toBe(false);
    expect(deps.store.state.connecting).toBe(false);
    expect(deps.store.state.paused).toBe(false);
    expect(deps.store.state.tabId).toBeNull();
    expect(deps.store.state.status).toBe("limit");
  });

  it("CONTENT_ENDED without reason falls back to 'Stopped'", () => {
    handleContentEvent(deps.store, { type: "CONTENT_ENDED" });
    expect(deps.store.state.status).toBe("Stopped");
  });
});
