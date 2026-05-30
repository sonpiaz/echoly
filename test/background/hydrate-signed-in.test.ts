import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import {
  hydrateSignedIn,
  scheduleHydrateSignedIn,
  resetHydrateSignedInState,
} from "@/background/hydrate-signed-in";
import type { SettingsClient, SettingsBundle } from "@/background/settings-client";
const SAMPLE_BUNDLE: SettingsBundle = {
  settings: {
    captionPosition: "bottom",
    autoStartHosts: {},
    outputDeviceId: "",
  },
  siteOverrides: { "youtube.com": { captionPosition: "top" } },
  version: 3,
  updatedAt: new Date().toISOString(),
};

function makeSettingsClient(bundle: SettingsBundle | null = SAMPLE_BUNDLE): SettingsClient {
  return {
    fetchBundle: vi.fn().mockResolvedValue(bundle),
    putGlobal: vi.fn(),
    putSiteOverride: vi.fn(),
    removeSiteOverride: vi.fn(),
  } as unknown as SettingsClient;
}

describe("hydrateSignedIn", () => {
  let store: Store;

  beforeEach(() => {
    resetHydrateSignedInState();
    vi.useFakeTimers();
    store = new Store(new EcholyAuth());
    vi.spyOn(store, "refreshAuth").mockImplementation(async () => {
      store.state.signedInUser = { email: "u@e.com", tier: "max" };
    });
    vi.spyOn(store, "applyServerBundle").mockImplementation(() => {});
    vi.spyOn(store, "persistAdvanced").mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetHydrateSignedInState();
  });

  it("single-flight: concurrent calls share one refreshAuth", async () => {
    const refreshSpy = vi.spyOn(store, "refreshAuth");
    const settings = makeSettingsClient();

    await Promise.all([
      hydrateSignedIn(store, settings),
      hydrateSignedIn(store, settings),
      hydrateSignedIn(store, settings),
    ]);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(settings.fetchBundle).toHaveBeenCalledTimes(1);
    expect(store.applyServerBundle).toHaveBeenCalledTimes(1);
    const applied = vi.mocked(store.applyServerBundle).mock.calls[0]![0];
    expect(applied.version).toBe(SAMPLE_BUNDLE.version);
    expect(applied.settings).toEqual(SAMPLE_BUNDLE.settings);
    expect(applied.siteOverrides).toEqual(SAMPLE_BUNDLE.siteOverrides);
    expect(store.persistAdvanced).toHaveBeenCalledTimes(1);
  });

  it("skips settings fetch when signed out after refreshAuth", async () => {
    vi.spyOn(store, "refreshAuth").mockImplementation(async () => {
      store.state.signedInUser = null;
    });
    const settings = makeSettingsClient();

    await hydrateSignedIn(store, settings);

    expect(settings.fetchBundle).not.toHaveBeenCalled();
    expect(store.applyServerBundle).not.toHaveBeenCalled();
  });

  it("skips apply when settings client omitted", async () => {
    await hydrateSignedIn(store);
    expect(store.applyServerBundle).not.toHaveBeenCalled();
  });

  it("ignores null bundle without throwing", async () => {
    const settings = makeSettingsClient(null);
    await hydrateSignedIn(store, settings);
    expect(store.applyServerBundle).not.toHaveBeenCalled();
    expect(store.persistAdvanced).not.toHaveBeenCalled();
  });
});

describe("scheduleHydrateSignedIn", () => {
  let store: Store;

  beforeEach(() => {
    resetHydrateSignedInState();
    vi.useFakeTimers();
    store = new Store(new EcholyAuth());
    vi.spyOn(store, "refreshAuth").mockImplementation(async () => {
      store.state.signedInUser = { email: "u@e.com", tier: "pro" };
    });
    vi.spyOn(store, "applyServerBundle").mockImplementation(() => {});
    vi.spyOn(store, "persistAdvanced").mockResolvedValue();
    vi.spyOn(store, "broadcast").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    resetHydrateSignedInState();
  });

  it("debounces 300ms and broadcasts once", async () => {
    const settings = makeSettingsClient();
    scheduleHydrateSignedIn(store, settings);
    scheduleHydrateSignedIn(store, settings);
    scheduleHydrateSignedIn(store, settings);

    expect(store.refreshAuth).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(store.refreshAuth).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(store.refreshAuth).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.broadcast).toHaveBeenCalledTimes(2));
  });
});
