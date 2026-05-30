// API-mode resolution — signed-in users route through Echoly server (ec_session).

import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { ApiMode, ResolvedApiMode, SignedInUser } from "@/shared/types";

export interface EcholyContext {
  token: string | null;
  user: SignedInUser | null;
}

export function decideApiMode(echoly: EcholyContext): ResolvedApiMode | null {
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

export function deriveApiModeLabel(user: SignedInUser | null): ApiMode {
  return user ? "proxy" : null;
}

export interface EcholyAuthPort {
  getSessionToken(): Promise<string | null>;
  fetchUser(token: string): Promise<SignedInUser | null>;
}

export async function resolveApiMode(
  auth: EcholyAuthPort,
  cachedUser?: SignedInUser | null,
): Promise<ResolvedApiMode | null> {
  const token = await auth.getSessionToken();
  if (!token) return null;
  if (cachedUser) {
    return decideApiMode({ token, user: cachedUser });
  }
  const user = await auth.fetchUser(token);
  if (user) {
    return decideApiMode({ token, user });
  }
  return null;
}
