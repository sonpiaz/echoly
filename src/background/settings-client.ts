// ────────────────────────────────────────────────────────────────────────────
// SettingsClient — HTTP client for the server-authoritative Advanced settings
// bundle. The server exposes /v1/me/settings (Bearer-auth, signed-in only):
//
//   GET    /v1/me/settings                 → { settings, siteOverrides, version, updatedAt }
//   PUT    /v1/me/settings                 → same; body { patch, expectedVersion? }
//   PUT    /v1/me/settings/sites/:domain   → same; body { patch, expectedVersion? }
//   DELETE /v1/me/settings/sites/:domain   → same
//
// Optimistic concurrency: the client may send `expectedVersion`. The server
// returns 409 with the CURRENT bundle when the version is stale — the client
// MUST surface this so the SW can resolve (UI re-pull) without clobbering a
// concurrent edit from a second device. Conflict is the only "soft" non-2xx;
// every other non-2xx throws a typed `SettingsHttpError`.
//
// This client is the I/O boundary — no business logic, no merging, no caching.
// It mirrors the auth.ts style (try/catch ONLY for network errors at the call
// site; the client itself throws so the SW can decide the dirty-flag policy).
// ────────────────────────────────────────────────────────────────────────────

import type {
  AdvancedPatch,
  AdvancedSettings,
  SiteOverrideMap,
} from "@/shared/advanced";

/** The server-authoritative bundle. Returned by GET and any PUT/DELETE that
 *  mutates settings. `version` is monotonically increasing per-user. */
export interface SettingsBundle {
  settings: AdvancedSettings;
  siteOverrides: SiteOverrideMap;
  version: number;
  updatedAt: string;
}

/** Typed error for non-2xx responses. `status` carries the HTTP code; `body`
 *  is the parsed JSON the server returned (often a SettingsBundle on 409, or
 *  { error: string } on 4xx/5xx). The SW inspects `.status === 409` to take
 *  the conflict-resolution path; other statuses are surfaced as-is. */
export class SettingsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "SettingsHttpError";
  }
}

/** Best-effort JSON parse — non-JSON bodies (HTML 500 pages, etc.) become
 *  the raw text. Never throws. */
async function readBody(r: Response): Promise<unknown> {
  const text = await r.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shapeBundle(raw: unknown): SettingsBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (
    !v.settings ||
    typeof v.settings !== "object" ||
    typeof v.version !== "number" ||
    typeof v.updatedAt !== "string"
  ) {
    return null;
  }
  const siteOverrides =
    v.siteOverrides && typeof v.siteOverrides === "object"
      ? (v.siteOverrides as SiteOverrideMap)
      : {};
  return {
    settings: v.settings as AdvancedSettings,
    siteOverrides,
    version: v.version,
    updatedAt: v.updatedAt,
  };
}

export class SettingsClient {
  constructor(
    private readonly apiBase: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async authedFetch(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = await this.getToken();
    if (!token) {
      throw new SettingsHttpError(401, null, "Not signed in.");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${this.apiBase}${path}`, { ...init, headers });
  }

  /** Validate-and-throw on non-2xx. On 409 the server returns the CURRENT
   *  bundle as the body — the SettingsHttpError carries it so the SW can
   *  reconcile without a second roundtrip. */
  private async parseOrThrow(r: Response): Promise<SettingsBundle> {
    const body = await readBody(r);
    if (!r.ok) {
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${r.status}`;
      throw new SettingsHttpError(r.status, body, msg);
    }
    const bundle = shapeBundle(body);
    if (!bundle) {
      throw new SettingsHttpError(r.status, body, "Malformed settings bundle.");
    }
    return bundle;
  }

  /** GET /me/settings. Returns null when the user is signed out (no token).
   *  Throws SettingsHttpError on non-2xx; throws a TypeError on network fail. */
  async fetchBundle(): Promise<SettingsBundle | null> {
    const token = await this.getToken();
    if (!token) return null;
    const r = await fetch(`${this.apiBase}/me/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) return null;
    return this.parseOrThrow(r);
  }

  /** PUT /me/settings. expectedVersion is the optimistic-concurrency token. */
  async putGlobal(
    patch: AdvancedPatch,
    expectedVersion?: number,
  ): Promise<SettingsBundle> {
    const r = await this.authedFetch("/me/settings", {
      method: "PUT",
      body: JSON.stringify({ patch, expectedVersion }),
    });
    return this.parseOrThrow(r);
  }

  /** PUT /me/settings/sites/:domain. */
  async putSiteOverride(
    domain: string,
    patch: AdvancedPatch,
    expectedVersion?: number,
  ): Promise<SettingsBundle> {
    const r = await this.authedFetch(
      `/me/settings/sites/${encodeURIComponent(domain)}`,
      {
        method: "PUT",
        body: JSON.stringify({ patch, expectedVersion }),
      },
    );
    return this.parseOrThrow(r);
  }

  /** DELETE /me/settings/sites/:domain. */
  async removeSiteOverride(domain: string): Promise<SettingsBundle> {
    const r = await this.authedFetch(
      `/me/settings/sites/${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    );
    return this.parseOrThrow(r);
  }
}
