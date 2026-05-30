import { test, expect } from "@playwright/test";
import { devUserToken } from "./helpers/dev-token.ts";

const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:8787";

/** No browser — bootstrap shape vs public catalog. */
test("session bootstrap language pairs match catalog", async () => {
  const token = devUserToken(`ext-boot-${Date.now()}@echoly.test`, "pro");
  const catalogRes = await fetch(`${API}/v1/config/language-pairs`);
  const catalog = (await catalogRes.json()) as { pairs: Array<Record<string, string>> };

  const bootRes = await fetch(`${API}/v1/session/bootstrap`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(bootRes.ok).toBeTruthy();
  const boot = (await bootRes.json()) as {
    languagePairs: { pairs: Array<Record<string, string>> };
  };
  expect(boot.languagePairs.pairs.length).toBe(catalog.pairs.length);
});
