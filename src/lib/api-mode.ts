// ────────────────────────────────────────────────────────────────────────────
// API-mode resolution — which Kyma-shaped endpoint + bearer the content script
// should hit. Ported verbatim from legacy/background.js:153-166 (resolveApiMode)
// and the apiMode precedence in refreshAuth (legacy/background.js:134/145).
//
// Precedence (BYOK WINS):
//  1. A non-empty trimmed `kymaKey` → BYOK (Kyma direct, the key is the bearer).
//  2. Else an Echoly session cookie + a signed-in user → proxy (token is bearer).
//  3. Else → null (START aborts: "Sign in at echolyhq.com or paste a Kyma key.")
//
// The PURE precedence decision is split out (`decideApiMode`) so it can be unit
// tested without chrome.* / fetch. `resolveApiMode` wires it to the cookie +
// user fetch (async, I/O); it mirrors the legacy short-circuit exactly: when a
// BYOK key is present we NEVER read the cookie or fetch the user.
// ────────────────────────────────────────────────────────────────────────────

import { KYMA_DIRECT_BASE, ECHOLY_PROXY_BASE } from "@/shared/constants";
import type {
  ApiMode,
  ResolvedApiMode,
  Settings,
  SignedInUser,
} from "@/shared/types";

/** Just the bearer-bearing settings slice the decision needs. */
export type ApiModeSettings = Pick<Settings, "kymaKey">;

/** The signed-in echoly context the decision needs (resolved from the cookie). */
export interface EcholyContext {
  /** The ec_session cookie value, or null/empty when not signed in. */
  token: string | null;
  /** The user fetched from auth/me, or null when the token is invalid/absent. */
  user: SignedInUser | null;
}

/**
 * PURE precedence decision. No chrome.*, no fetch — given the (already trimmed
 * or untrimmed) kyma key plus the resolved echoly context, decide the mode.
 * BYOK wins: a non-empty trimmed kymaKey short-circuits before echoly is even
 * considered. This is the unit-tested core (byok-wins / proxy / null).
 */
export function decideApiMode(
  settings: ApiModeSettings,
  echoly: EcholyContext,
): ResolvedApiMode | null {
  const kymaKey = (settings.kymaKey ?? "").trim();
  if (kymaKey) {
    return { apiBase: KYMA_DIRECT_BASE, apiKey: kymaKey, mode: "byok", user: null };
  }
  if (echoly.token && echoly.user) {
    return {
      apiBase: ECHOLY_PROXY_BASE,
      apiKey: echoly.token,
      mode: "proxy",
      user: echoly.user,
    };
  }
  return null;
}

/**
 * PURE apiMode label for the popup-visible auth snapshot (legacy refreshAuth
 * 134/145 + the no-token branch). BYOK still wins when both are present —
 * the popup shows "Signed in" but routes via Kyma direct.
 */
export function deriveApiModeLabel(
  kymaKey: string | undefined | null,
  user: SignedInUser | null,
): ApiMode {
  if ((kymaKey ?? "").trim()) return "byok";
  return user ? "proxy" : null;
}

/** Async port the resolver needs: read the cookie token, then fetch the user. */
export interface EcholyAuthPort {
  getSessionToken(): Promise<string | null>;
  fetchUser(token: string): Promise<SignedInUser | null>;
}

/**
 * Resolve which Kyma-shaped API the content script should hit
 * (legacy/background.js:153-166). BYOK short-circuits — when a key is present we
 * never read the cookie or fetch the user. Otherwise read the cookie; if a
 * token resolves a user, use proxy; else null.
 */
export async function resolveApiMode(
  settings: ApiModeSettings,
  auth: EcholyAuthPort,
): Promise<ResolvedApiMode | null> {
  const kymaKey = (settings.kymaKey ?? "").trim();
  if (kymaKey) {
    return { apiBase: KYMA_DIRECT_BASE, apiKey: kymaKey, mode: "byok", user: null };
  }
  const token = await auth.getSessionToken();
  if (token) {
    const user = await auth.fetchUser(token);
    if (user) {
      return decideApiMode(settings, { token, user });
    }
  }
  return null;
}
