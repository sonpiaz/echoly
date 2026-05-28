// Layer A — pure-fn golden tests for the BYOK-wins apiMode precedence.
// Inputs/outputs captured from legacy/background.js:153-166 (resolveApiMode) +
// the apiMode label logic in refreshAuth (134/145).
import { describe, it, expect, vi } from "vitest";
import {
  decideApiMode,
  deriveApiModeLabel,
  resolveApiMode,
  type EcholyAuthPort,
} from "@/lib/api-mode";
import { KYMA_DIRECT_BASE, ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { SignedInUser } from "@/shared/types";

const USER: SignedInUser = { email: "a@b.com", tier: "pro" };

describe("decideApiMode — BYOK-wins precedence", () => {
  it("BYOK: a non-empty trimmed kymaKey wins → byok, Kyma direct, key as bearer", () => {
    const r = decideApiMode(
      { kymaKey: "sk-kyma-123" },
      { token: "ec-tok", user: USER },
    );
    expect(r).toEqual({
      apiBase: KYMA_DIRECT_BASE,
      apiKey: "sk-kyma-123",
      mode: "byok",
      user: null, // BYOK never carries a user even when one is signed in
    });
  });

  it("BYOK wins even with whitespace around the key (trims, stays byok)", () => {
    const r = decideApiMode(
      { kymaKey: "  sk-kyma-pad  " },
      { token: "ec-tok", user: USER },
    );
    expect(r?.mode).toBe("byok");
    expect(r?.apiKey).toBe("sk-kyma-pad");
  });

  it("PROXY: empty key + token + user → proxy, Echoly proxy base, token as bearer", () => {
    const r = decideApiMode(
      { kymaKey: "" },
      { token: "ec-session-tok", user: USER },
    );
    expect(r).toEqual({
      apiBase: ECHOLY_PROXY_BASE,
      apiKey: "ec-session-tok",
      mode: "proxy",
      user: USER,
    });
  });

  it("whitespace-only key does NOT count as BYOK → falls through to proxy", () => {
    const r = decideApiMode(
      { kymaKey: "   " },
      { token: "tok", user: USER },
    );
    expect(r?.mode).toBe("proxy");
  });

  it("NULL: empty key + token but NO user → null (invalid session)", () => {
    expect(decideApiMode({ kymaKey: "" }, { token: "tok", user: null })).toBeNull();
  });

  it("NULL: empty key + no token → null", () => {
    expect(decideApiMode({ kymaKey: "" }, { token: null, user: null })).toBeNull();
  });
});

describe("deriveApiModeLabel — popup-visible apiMode (refreshAuth)", () => {
  it("BYOK key present → 'byok' even when a user is signed in", () => {
    expect(deriveApiModeLabel("sk-kyma", USER)).toBe("byok");
  });
  it("no key + signed-in user → 'proxy'", () => {
    expect(deriveApiModeLabel("", USER)).toBe("proxy");
  });
  it("no key + no user → null", () => {
    expect(deriveApiModeLabel("", null)).toBeNull();
  });
  it("whitespace-only key + user → 'proxy' (trims to empty)", () => {
    expect(deriveApiModeLabel("   ", USER)).toBe("proxy");
  });
  it("nullish key + no user → null", () => {
    expect(deriveApiModeLabel(null, null)).toBeNull();
    expect(deriveApiModeLabel(undefined, null)).toBeNull();
  });
});

describe("resolveApiMode — async wiring + BYOK short-circuit", () => {
  it("BYOK short-circuits: never reads the cookie nor fetches the user", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue("ec-tok"),
      fetchUser: vi.fn().mockResolvedValue(USER),
    };
    const r = await resolveApiMode({ kymaKey: "sk-kyma" }, auth);
    expect(r?.mode).toBe("byok");
    expect(auth.getSessionToken).not.toHaveBeenCalled();
    expect(auth.fetchUser).not.toHaveBeenCalled();
  });

  it("no key + token + user → proxy (reads cookie then fetches user)", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue("ec-tok"),
      fetchUser: vi.fn().mockResolvedValue(USER),
    };
    const r = await resolveApiMode({ kymaKey: "" }, auth);
    expect(r).toEqual({
      apiBase: ECHOLY_PROXY_BASE,
      apiKey: "ec-tok",
      mode: "proxy",
      user: USER,
    });
    expect(auth.getSessionToken).toHaveBeenCalledOnce();
    expect(auth.fetchUser).toHaveBeenCalledWith("ec-tok");
  });

  it("no key + token but fetchUser returns null → null", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue("ec-tok"),
      fetchUser: vi.fn().mockResolvedValue(null),
    };
    expect(await resolveApiMode({ kymaKey: "" }, auth)).toBeNull();
  });

  it("no key + no token → null (does not fetch the user)", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue(null),
      fetchUser: vi.fn().mockResolvedValue(USER),
    };
    expect(await resolveApiMode({ kymaKey: "" }, auth)).toBeNull();
    expect(auth.fetchUser).not.toHaveBeenCalled();
  });
});
