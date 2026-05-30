import { describe, it, expect, vi } from "vitest";
import {
  decideApiMode,
  deriveApiModeLabel,
  resolveApiMode,
  type EcholyAuthPort,
} from "@/lib/api-mode";
import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { SignedInUser } from "@/shared/types";

const USER: SignedInUser = { email: "a@b.com", tier: "pro" };

describe("decideApiMode", () => {
  it("token + user → proxy", () => {
    expect(decideApiMode({ token: "ec-session-tok", user: USER })).toEqual({
      apiBase: ECHOLY_PROXY_BASE,
      apiKey: "ec-session-tok",
      mode: "proxy",
      user: USER,
    });
  });

  it("token but no user → null", () => {
    expect(decideApiMode({ token: "tok", user: null })).toBeNull();
  });

  it("no token → null", () => {
    expect(decideApiMode({ token: null, user: null })).toBeNull();
  });
});

describe("deriveApiModeLabel", () => {
  it("signed-in → proxy", () => {
    expect(deriveApiModeLabel(USER)).toBe("proxy");
  });
  it("signed-out → null", () => {
    expect(deriveApiModeLabel(null)).toBeNull();
  });
});

describe("resolveApiMode", () => {
  it("reads cookie + user", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue("ec-tok"),
      fetchUser: vi.fn().mockResolvedValue(USER),
    };
    const r = await resolveApiMode(auth);
    expect(r?.mode).toBe("proxy");
    expect(auth.fetchUser).toHaveBeenCalledWith("ec-tok");
  });

  it("uses cached user without refetch", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue("ec-tok"),
      fetchUser: vi.fn(),
    };
    const r = await resolveApiMode(auth, USER);
    expect(r?.user).toBe(USER);
    expect(auth.fetchUser).not.toHaveBeenCalled();
  });

  it("no token → null", async () => {
    const auth: EcholyAuthPort = {
      getSessionToken: vi.fn().mockResolvedValue(null),
      fetchUser: vi.fn(),
    };
    expect(await resolveApiMode(auth)).toBeNull();
  });
});
