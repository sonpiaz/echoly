// Store realtime-tier normalization: a non-Max account must not keep a stale/
// persisted realtime tier — refreshAuth coerces it to standard AND persists it
// so it can't resurrect on the next load. (SOLUTION ext-overlay-tier-fixes AC4.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { TIER_REALTIME, TIER_STANDARD } from "@/shared/constants";
import type { AccountTier } from "@/shared/types";
import * as sessionBootstrap from "@/background/session-bootstrap";
import * as languageCatalog from "@/background/language-catalog";
import * as voiceCatalog from "@/background/voice-catalog";

vi.mock("@/background/session-bootstrap", () => ({ fetchSessionBootstrap: vi.fn() }));
vi.mock("@/background/language-catalog", () => ({ resolvePublicLanguageCatalog: vi.fn() }));
vi.mock("@/background/voice-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/background/voice-catalog")>();
  return { ...actual, resolveStandardVoices: vi.fn() };
});

function bootstrapFor(tier: AccountTier) {
  return {
    user: { email: "u@e.com", tier },
    usage: { used: 0 },
    catalog: { picker: [["vi", "Vietnamese"] as const], languageNames: { vi: "Vietnamese" } },
    voices: { voices: [["v1", "Voice"] as const], defaultId: "v1" },
  };
}

describe("Store.refreshAuth — realtime tier normalization", () => {
  let store: Store;
  let auth: EcholyAuth;

  beforeEach(() => {
    auth = new EcholyAuth();
    store = new Store(auth);
    vi.spyOn(auth, "getSessionToken").mockResolvedValue("tok");
  });

  for (const plan of ["free", "pro"] as const) {
    it(`coerces persisted realtime → standard for a ${plan} account and persists it`, async () => {
      vi.mocked(sessionBootstrap.fetchSessionBootstrap).mockResolvedValue(bootstrapFor(plan));
      store.state.tier = TIER_REALTIME; // stale selection from a former Max plan
      const persistSpy = vi.spyOn(store, "persistSettings");

      await store.refreshAuth();

      expect(store.state.tier).toBe(TIER_STANDARD);
      expect(persistSpy).toHaveBeenCalledWith({ tier: TIER_STANDARD });
    });
  }

  it("leaves realtime intact for a max account (no coercion, no persist)", async () => {
    vi.mocked(sessionBootstrap.fetchSessionBootstrap).mockResolvedValue(bootstrapFor("max"));
    store.state.tier = TIER_REALTIME;
    const persistSpy = vi.spyOn(store, "persistSettings");

    await store.refreshAuth();

    expect(store.state.tier).toBe(TIER_REALTIME);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the selected tier is already standard (free account)", async () => {
    vi.mocked(sessionBootstrap.fetchSessionBootstrap).mockResolvedValue(bootstrapFor("free"));
    store.state.tier = TIER_STANDARD;
    const persistSpy = vi.spyOn(store, "persistSettings");

    await store.refreshAuth();

    expect(store.state.tier).toBe(TIER_STANDARD);
    expect(persistSpy).not.toHaveBeenCalled();
  });
});
