// ────────────────────────────────────────────────────────────────────────────
// Auth side-channel — Echoly subscription proxy mode (v0.6.1+). Ported verbatim
// from legacy/background.js:83-146 + the SIGN_OUT_ECHOLY inline block (456-477).
//
// The session lives in an HttpOnly `ec_session` cookie on echolyhq.com. The
// privileged chrome.cookies API can read it (bypassing HttpOnly); it is sent as
// `Authorization: Bearer <token>` on every auth call. The token is NEVER stored
// in chrome.storage or state — only the derived signedInUser / usage / apiMode
// live in state for rendering, recomputed on demand from the cookie.
//
// All fetches are try/caught returning null — auth is best-effort and must never
// throw into the router. Implements EcholyAuthPort for resolveApiMode.
// ────────────────────────────────────────────────────────────────────────────

import {
  ECHOLY_API_ORIGIN,
  ECHOLY_WEB_ORIGIN,
  EC_SESSION_COOKIE,
} from "@/shared/constants";
import type { SignedInUser, Usage } from "@/shared/types";
import type { EcholyAuthPort } from "@/lib/api-mode";

export class EcholyAuth implements EcholyAuthPort {
  /** Read the HttpOnly ec_session cookie (legacy getEcholySessionToken). */
  async getSessionToken(): Promise<string | null> {
    try {
      const c = await chrome.cookies.get({
        url: ECHOLY_WEB_ORIGIN,
        name: EC_SESSION_COOKIE,
      });
      return c?.value ?? null;
    } catch {
      return null;
    }
  }

  /** GET auth/me with the bearer (legacy fetchEcholyUser). */
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

  /** GET v1/usage with the bearer (legacy fetchEcholyUsage). */
  async fetchUsage(token: string): Promise<Usage | null> {
    if (!token) return null;
    try {
      const r = await fetch(`${ECHOLY_API_ORIGIN}/v1/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = (await r.json()) as {
        standard?: { used_minutes?: number };
        realtime?: { used_minutes?: number };
      };
      return {
        standard: d.standard?.used_minutes ?? 0,
        realtime: d.realtime?.used_minutes ?? 0,
      };
    } catch {
      return null;
    }
  }

  /** POST auth/sign-out (best-effort) then remove the cookie across both the web
   *  and api registrable-domain scopes (legacy SIGN_OUT_ECHOLY 456-471). */
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
    // The cookie is HttpOnly + Domain=.echolyhq.com, but chrome.cookies can
    // remove it across the entire registrable-domain scope.
    try {
      await chrome.cookies.remove({
        url: ECHOLY_WEB_ORIGIN,
        name: EC_SESSION_COOKIE,
      });
      await chrome.cookies.remove({
        url: ECHOLY_API_ORIGIN,
        name: EC_SESSION_COOKIE,
      });
    } catch {
      // best-effort
    }
  }
}
