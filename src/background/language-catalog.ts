// Language catalog — server SoT (CLIENT-CACHE.md).
// Signed-in: tier-filtered pairs come from GET /v1/session/bootstrap (parseCatalog).
// Signed-out: GET /v1/config/language-pairs (HTTP cache) → offline bootstrap.
// Mutations only: POST /v1/me/language-pairs/recent (recordLanguagePairRecent).

import { ECHOLY_PROXY_BASE, type LangPair } from "@/shared/constants";
import {
  OFFLINE_LANGUAGE_NAMES,
  offlineLanguagePicker,
} from "@/lib/offline-language-bootstrap";
import { langPickerFromPairs, type CatalogPair } from "@/lib/language-picker";

export interface LanguageCatalogSnapshot {
  picker: LangPair[];
  languageNames: Record<string, string>;
}

interface CatalogResponse {
  ok?: boolean;
  languages?: Record<string, string>;
  pairs?: CatalogPair[];
}

export function parseCatalog(
  raw: Record<string, object | string | number | boolean | null> | null | undefined,
): LanguageCatalogSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as CatalogResponse;
  if (!o.ok || !Array.isArray(o.pairs) || !o.languages) return null;
  const pairs = o.pairs.filter(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof (p as CatalogPair).source === "string" &&
      typeof (p as CatalogPair).target === "string",
  ) as CatalogPair[];
  if (pairs.length === 0) return null;
  const languageNames = { ...o.languages };
  for (const code of Object.keys(OFFLINE_LANGUAGE_NAMES)) {
    if (!languageNames[code]) languageNames[code] = OFFLINE_LANGUAGE_NAMES[code]!;
  }
  return {
    picker: langPickerFromPairs(pairs, languageNames),
    languageNames,
  };
}

export function offlineLanguageCatalog(): LanguageCatalogSnapshot {
  return {
    picker: [...offlineLanguagePicker()],
    languageNames: { ...OFFLINE_LANGUAGE_NAMES },
  };
}

async function fetchCatalog(
  url: string,
  headers: Record<string, string>,
  cache: RequestCache,
  signal?: AbortSignal,
): Promise<LanguageCatalogSnapshot | null> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort("language-catalog-timeout"), 5000);
  const composed = signal ? new AbortController() : ctrl;
  if (signal) {
    const linker = composed;
    signal.addEventListener("abort", () => linker.abort(signal.reason));
    ctrl.signal.addEventListener("abort", () => linker.abort(ctrl.signal.reason));
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      cache,
      signal: composed.signal,
    });
    if (!res.ok) return null;
    return parseCatalog(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Public catalog — browser HTTP cache (server Cache-Control). */
export async function fetchPublicLanguageCatalog(
  signal?: AbortSignal,
): Promise<LanguageCatalogSnapshot | null> {
  return fetchCatalog(
    `${ECHOLY_PROXY_BASE}/config/language-pairs`,
    {},
    "default",
    signal,
  );
}

/** Signed-out catalog: public config (HTTP cache) → offline bootstrap. */
export async function resolvePublicLanguageCatalog(): Promise<LanguageCatalogSnapshot> {
  const pub = await fetchPublicLanguageCatalog();
  return pub ?? offlineLanguageCatalog();
}

export async function recordLanguagePairRecent(
  token: string,
  target: string,
  source = "en",
): Promise<void> {
  try {
    await fetch(`${ECHOLY_PROXY_BASE}/me/language-pairs/recent`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source, target }),
    });
  } catch {
    /* non-fatal */
  }
}
