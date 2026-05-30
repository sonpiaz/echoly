import { describe, it, expect, vi, beforeEach } from "vitest";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import * as sessionBootstrap from "@/background/session-bootstrap";
import * as languageCatalog from "@/background/language-catalog";
import * as voiceCatalog from "@/background/voice-catalog";

vi.mock("@/background/session-bootstrap", () => ({
  fetchSessionBootstrap: vi.fn(),
}));

vi.mock("@/background/language-catalog", () => ({
  resolvePublicLanguageCatalog: vi.fn(),
}));

vi.mock("@/background/voice-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/background/voice-catalog")>();
  return {
    ...actual,
    resolveStandardVoices: vi.fn(),
  };
});

describe("Store.refreshAuth", () => {
  let store: Store;
  let auth: EcholyAuth;

  beforeEach(() => {
    auth = new EcholyAuth();
    store = new Store(auth);
    vi.spyOn(auth, "getSessionToken").mockResolvedValue("tok");
  });

  it("falls back to public catalog when bootstrap fails", async () => {
    vi.mocked(sessionBootstrap.fetchSessionBootstrap).mockResolvedValue(null);
    vi.mocked(languageCatalog.resolvePublicLanguageCatalog).mockResolvedValue({
      picker: [["vi", "Vietnamese"] as const],
      languageNames: { vi: "Vietnamese" },
    });
    vi.mocked(voiceCatalog.resolveStandardVoices).mockResolvedValue({
      voices: [["v1", "Voice"] as const],
      defaultId: "v1",
    });

    await store.refreshAuth();

    expect(store.state.signedInUser).toBeNull();
    expect(store.state.languagePicker).toHaveLength(1);
    expect(store.state.standardVoices).toHaveLength(1);
  });
});
