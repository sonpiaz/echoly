// Echoly auth — ec_session cookie → Bearer on API calls.

import { ECHOLY_API_ORIGIN, EC_SESSION_COOKIE } from "@/shared/constants";
import { echolySessionTokenOrigins } from "@/shared/echoly-config";
import type { SignedInUser } from "@/shared/types";
import type { EcholyAuthPort } from "@/lib/api-mode";

export class EcholyAuth implements EcholyAuthPort {
  async getSessionToken(): Promise<string | null> {
    for (const origin of echolySessionTokenOrigins()) {
      try {
        const c = await chrome.cookies.get({
          url: origin,
          name: EC_SESSION_COOKIE,
        });
        if (c?.value) return c.value;
      } catch {
        // try next origin
      }
    }
    return null;
  }

  /** Used when bootstrap is unavailable but a token exists (e.g. START). */
  async fetchUser(token: string): Promise<SignedInUser | null> {
    if (!token) return null;
    try {
      const r = await fetch(`${ECHOLY_API_ORIGIN}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = (await r.json()) as { signed_in?: boolean; user?: SignedInUser };
      return d.signed_in ? (d.user ?? null) : null;
    } catch {
      return null;
    }
  }

  async signOut(): Promise<void> {
    const token = await this.getSessionToken();
    if (token) {
      try {
        await fetch(`${ECHOLY_API_ORIGIN}/auth/sign-out`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // best-effort
      }
    }
    for (const origin of echolySessionTokenOrigins()) {
      try {
        await chrome.cookies.remove({ url: origin, name: EC_SESSION_COOKIE });
      } catch {
        // best-effort
      }
    }
  }
}
