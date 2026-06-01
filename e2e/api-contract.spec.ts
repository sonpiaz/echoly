import { test, expect } from "@playwright/test";
import { devUserToken } from "./helpers/dev-token.ts";

const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:8787";

/** No browser — bootstrap shape vs public catalog. Parametrized over tiers. */
for (const tier of ["pro", "free"] as const) {
  test(`session bootstrap language pairs match catalog (${tier} user)`, async () => {
    const token = devUserToken(`ext-boot-${tier}-${Date.now()}@echoly.test`, tier);
    const catalogRes = await fetch(`${API}/v1/config/language-pairs`);
    const catalog = (await catalogRes.json()) as { pairs: Array<Record<string, string>> };

    const bootRes = await fetch(`${API}/v1/session/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bootRes.ok).toBeTruthy();
    const boot = (await bootRes.json()) as {
      languagePairs: { pairs: Array<Record<string, string>> };
    };
    // Every plan receives the full catalog — language pairs are no longer tier-gated.
    expect(boot.languagePairs.pairs.length).toBe(catalog.pairs.length);
  });
}
